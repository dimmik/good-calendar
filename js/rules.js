// Calendar rules: working days and holidays, paydays, event recurrence, countdowns.
import {
  ymd, mdOf, parseYmd, startOfDay, addDays, daysInMonth, dayDiff, isWeekend, withTime, plural, days, MONTHS_GEN,
} from './dates.js';
import { nextRetrograde } from './astro.js';

// ---------- Россия ----------

// Нерабочие праздничные дни РФ (ст. 112 ТК РФ)
export const RU_HOLIDAYS = {
  '01-01': 'Новый год',
  '01-02': 'Новогодние каникулы',
  '01-03': 'Новогодние каникулы',
  '01-04': 'Новогодние каникулы',
  '01-05': 'Новогодние каникулы',
  '01-06': 'Новогодние каникулы',
  '01-07': 'Рождество Христово',
  '01-08': 'Новогодние каникулы',
  '02-23': 'День защитника Отечества',
  '03-08': 'Международный женский день',
  '05-01': 'Праздник Весны и Труда',
  '05-09': 'День Победы',
  '06-12': 'День России',
  '11-04': 'День народного единства',
};

// Production calendars fixed by government decree: weekdays that became days off
// (transfers, incl. holidays falling on a weekend) and weekend days that became working days.
const RU_DECREES = {
  2025: { off: ['05-02', '05-08', '06-13', '11-03', '12-31'], work: ['11-01'] },
  2026: { off: ['01-09', '03-09', '05-11', '12-31'], work: [] },
};

function ruYear(y) {
  const holidays = new Map(Object.entries(RU_HOLIDAYS));
  const dec = RU_DECREES[y];
  if (dec) {
    return { holidays, off: new Set(dec.off), work: new Set(dec.work), observances: new Map(), official: true };
  }
  // No decree known: apply the Labour Code rule — a holiday falling on a weekend moves to
  // the next working day. January weekends are moved by a yearly decree; we can't know it.
  const off = new Set();
  for (const md of holidays.keys()) {
    if (md.startsWith('01-')) continue;
    const d = parseYmd(`${y}-${md}`);
    if (!isWeekend(d)) continue;
    let n = addDays(d, 1);
    while (isWeekend(n) || holidays.has(mdOf(n)) || off.has(mdOf(n))) n = addDays(n, 1);
    off.add(mdOf(n));
  }
  return { holidays, off, work: new Set(), observances: new Map(), official: false };
}

// ---------- Сербия ----------
// Закон о государственных и других праздниках в Республике Сербия.

/** Orthodox Easter (Gregorian date): Julian computus + 13 days, valid 1900–2099. */
export function orthodoxEaster(y) {
  const a = y % 4;
  const b = y % 7;
  const c = y % 19;
  const d = (19 * c + 15) % 30;
  const e = (2 * a + 4 * b - d + 34) % 7;
  const month = Math.floor((d + e + 114) / 31);
  const day = ((d + e + 114) % 31) + 1;
  return new Date(y, month - 1, day + 13);
}

// State holidays: when one of their days falls on a Sunday, the first next working day is off.
const RS_STATE = [
  ['01-01', 'Новый год'],
  ['01-02', 'Новый год'],
  ['02-15', 'Сретение — День государственности'],
  ['02-16', 'Сретение — День государственности'],
  ['05-01', 'Праздник труда'],
  ['05-02', 'Праздник труда'],
  ['11-11', 'День перемирия'],
];
// Religious holidays (Orthodox): days off, never moved.
const RS_RELIGIOUS = [['01-07', 'Рождество Христово (Божич)']];
const RS_EASTER = [[-2, 'Великая пятница'], [-1, 'Великая суббота'], [0, 'Пасха (Васкрс)'], [1, 'Пасхальный понедельник']];
// Marked, but working days.
const RS_OBSERVANCES = {
  '01-27': 'Савиндан',
  '04-22': 'День памяти жертв Холокоста и фашизма',
  '05-09': 'День Победы',
  '06-28': 'Видовдан',
  '10-21': 'День памяти сербских жертв Второй мировой войны',
};

function rsYear(y) {
  const holidays = new Map();
  const add = (md, name) => {
    const cur = holidays.get(md);
    holidays.set(md, cur && cur !== name ? `${cur} · ${name}` : name);
  };
  for (const [md, name] of RS_STATE) add(md, name);
  for (const [md, name] of RS_RELIGIOUS) add(md, name);
  const easter = orthodoxEaster(y);
  for (const [k, name] of RS_EASTER) add(mdOf(addDays(easter, k)), name);

  const off = new Set();
  for (const [md] of RS_STATE) {
    const d = parseYmd(`${y}-${md}`);
    if (d.getDay() !== 0) continue;
    let n = addDays(d, 1);
    while (isWeekend(n) || holidays.has(mdOf(n)) || off.has(mdOf(n))) n = addDays(n, 1);
    off.add(mdOf(n));
  }
  return { holidays, off, work: new Set(), observances: new Map(Object.entries(RS_OBSERVANCES)), official: true };
}

// ---------- Общее ----------

export const COUNTRIES = { rs: 'Сербия', ru: 'Россия', none: 'Только сб и вс' };
const YEAR_FN = { rs: rsYear, ru: ruYear };
const yearCache = new Map();

function yearData(country, y) {
  const fn = YEAR_FN[country];
  if (!fn) return null;
  const k = `${country}:${y}`;
  if (!yearCache.has(k)) yearCache.set(k, fn(y));
  return yearCache.get(k);
}

export function dayInfo(d, settings, overrides) {
  const key = ymd(d);
  const md = key.slice(5);
  const wknd = isWeekend(d);
  let holiday = null;
  let transfer = false;
  let workWeekend = false;
  let estimated = false;
  let observance = null;
  const yr = yearData(settings.country, d.getFullYear());
  if (yr) {
    holiday = yr.holidays.get(md) || null;
    transfer = !holiday && yr.off.has(md);
    workWeekend = yr.work.has(md);
    estimated = !yr.official;
    observance = yr.observances.get(md) || null;
  }
  const base = !!holiday || transfer || (wknd && !workWeekend);
  const ov = (overrides && overrides[key]) || null;
  const off = ov === 'off' ? true : ov === 'work' ? false : base;
  let kind;
  if (ov && off !== base) kind = off ? 'custom-off' : 'custom-work';
  else if (holiday) kind = 'holiday';
  else if (transfer) kind = 'transfer';
  else if (workWeekend) kind = 'work-weekend';
  else kind = wknd ? 'weekend' : 'work';
  return { key, date: startOfDay(d), off, base, holiday, observance, kind, override: ov, estimated };
}

export function kindLabel(i) {
  switch (i.kind) {
    case 'holiday': return i.holiday;
    case 'transfer': return 'Выходной (перенос)';
    case 'work-weekend': return 'Рабочий выходной';
    case 'weekend': return 'Выходной';
    case 'custom-off': return 'Выходной (ваш)';
    case 'custom-work': return 'Рабочий (ваш)';
    default: return 'Рабочий день';
  }
}

/** Calendar bound to a state, with memoised day info. Rebuild it whenever the state changes. */
export function makeCal(state) {
  const memo = new Map();
  const info = (d) => {
    const k = ymd(d);
    let r = memo.get(k);
    if (!r) {
      r = dayInfo(d, state.settings, state.overrides);
      memo.set(k, r);
    }
    return r;
  };
  return { state, info };
}

/** The run of consecutive days off containing `d`. */
export function offBlock(cal, d) {
  let a = startOfDay(d);
  let b = a;
  for (let i = 0; i < 60 && cal.info(addDays(a, -1)).off; i++) a = addDays(a, -1);
  for (let i = 0; i < 60 && cal.info(addDays(b, 1)).off; i++) b = addDays(b, 1);
  return { start: a, end: b, len: dayDiff(a, b) + 1 };
}

/** Working days in [from, to) */
export function countWorkDays(cal, from, to) {
  let n = 0;
  let d = startOfDay(from);
  const end = startOfDay(to);
  for (let i = 0; d < end && i < 800; i++, d = addDays(d, 1)) if (!cal.info(d).off) n++;
  return n;
}

export function nextHoliday(cal, from) {
  if (!YEAR_FN[cal.state.settings.country]) return null;
  const today = startOfDay(from);
  for (let i = 0; i < 400; i++) {
    const d = addDays(today, i);
    const inf = cal.info(d);
    if (inf.holiday && inf.off) return { date: d, name: inf.holiday, block: offBlock(cal, d) };
  }
  return null;
}

// ---- Paydays ----

/** Pay date for month (y, m), shifted off non-working days. May land in the previous month. */
export function paydayIn(cal, y, m, p) {
  let d = new Date(y, m, Math.min(p.day, daysInMonth(y, m)));
  const step = p.shift === 'before' ? -1 : p.shift === 'after' ? 1 : 0;
  if (step) for (let i = 0; i < 31 && cal.info(d).off; i++) d = addDays(d, step);
  return d;
}

export function paydaysInRange(cal, p, from, to) {
  const out = [];
  const a = from.getFullYear() * 12 + from.getMonth() - 1;
  const b = to.getFullYear() * 12 + to.getMonth() + 1;
  for (let idx = a; idx <= b; idx++) {
    const y = Math.floor(idx / 12);
    const m = idx % 12;
    const d = paydayIn(cal, y, m, p);
    if (d >= from && d <= to) {
      out.push({ date: d, nominal: new Date(y, m, Math.min(p.day, daysInMonth(y, m))) });
    }
  }
  out.sort((x, y) => x.date - y.date);
  return out;
}

export function nextPayday(cal, p, from) {
  const today = startOfDay(from);
  return paydaysInRange(cal, p, today, addDays(today, 75))[0] || null;
}

// ---- Events ----

export function eventDatesInRange(ev, from, to) {
  const base = parseYmd(ev.date);
  const out = [];
  if (to < base) return out;
  const f = from < base ? base : from;
  switch (ev.repeat) {
    case 'weekly': {
      for (let d = addDays(f, (base.getDay() - f.getDay() + 7) % 7); d <= to; d = addDays(d, 7)) out.push(d);
      break;
    }
    case 'monthly': {
      const a = f.getFullYear() * 12 + f.getMonth();
      const b = to.getFullYear() * 12 + to.getMonth();
      for (let idx = a; idx <= b; idx++) {
        const y = Math.floor(idx / 12);
        const m = idx % 12;
        const d = new Date(y, m, Math.min(base.getDate(), daysInMonth(y, m)));
        if (d >= f && d <= to) out.push(d);
      }
      break;
    }
    case 'yearly': {
      for (let y = f.getFullYear(); y <= to.getFullYear(); y++) {
        const m = base.getMonth();
        const d = new Date(y, m, Math.min(base.getDate(), daysInMonth(y, m)));
        if (d >= f && d <= to) out.push(d);
      }
      break;
    }
    default:
      if (base >= f && base <= to) out.push(base);
  }
  return out;
}

/** Next occurrence that is not over yet: all-day events last the whole day. */
export function nextOccurrence(ev, now) {
  const today = startOfDay(now);
  const cand = ev.repeat === 'none' || !ev.repeat
    ? [parseYmd(ev.date)].filter((d) => d >= today)
    : eventDatesInRange(ev, today, addDays(today, 370));
  for (const d of cand) {
    const start = ev.time ? withTime(d, ev.time) : d;
    if (!ev.time || start > now) return { day: d, start };
  }
  return null;
}

// ---- Countdowns ----

const hm = (t) => `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
const fmtDM = (t) => `${t.getDate()} ${MONTHS_GEN[t.getMonth()]}`;

export function buildCountdowns(cal, now) {
  const { state, info } = cal;
  const s = state.settings;
  const b = s.builtins;
  const today = startOfDay(now);
  const rows = [];
  const ti = info(today);
  // Working days still ahead: today counts only until the workday is over.
  const workFrom = !ti.off && now >= withTime(today, s.workEnd) ? addDays(today, 1) : today;

  if (b.payday) {
    for (const p of state.paydays) {
      const hit = nextPayday(cal, p, today);
      if (!hit) continue;
      const moved = ymd(hit.date) !== ymd(hit.nominal);
      rows.push({
        id: `pay:${p.id}`, kind: 'payday', emoji: '💰', title: p.title || 'Зарплата',
        target: hit.date, allDay: true, day: hit.date,
        note: moved ? `перенесено с ${hit.nominal.getDate()}-го` : '',
        workDays: countWorkDays(cal, workFrom, hit.date),
      });
    }
  }

  if (b.workday && !ti.off) {
    const st = withTime(today, s.workStart);
    const en = withTime(today, s.workEnd);
    if (now >= st && now < en) {
      rows.push({
        id: 'workday', kind: 'workday', emoji: '⏳', title: 'До конца рабочего дня',
        target: en, allDay: false, day: today, time: s.workEnd,
      });
    }
  }

  if (b.weekend) {
    if (!ti.off) {
      let d = today;
      for (let i = 0; i < 40 && !info(addDays(d, 1)).off; i++) d = addDays(d, 1);
      let target = withTime(d, s.workEnd);
      let time = s.workEnd;
      if (target <= now) { target = addDays(d, 1); time = ''; }
      const blk = offBlock(cal, addDays(d, 1));
      rows.push({
        id: 'weekend', kind: 'weekend', emoji: '🏖️', title: 'До выходных',
        target, allDay: false, day: d, time,
        note: blk.len > 2 ? `отдыхаем ${days(blk.len)}` : '',
        workDays: countWorkDays(cal, workFrom, addDays(d, 1)),
      });
    } else {
      let d = today;
      for (let i = 0; i < 60 && info(d).off; i++) d = addDays(d, 1);
      rows.push({
        id: 'weekend', kind: 'rest', emoji: '☕', title: 'Отдыхаем · до работы',
        target: withTime(d, s.workStart), allDay: false, day: d, time: s.workStart,
      });
    }
  }

  let hol = null;
  if (b.holiday) {
    hol = nextHoliday(cal, today);
    if (hol) {
      const blk = hol.block;
      rows.push({
        id: 'holiday', kind: 'holiday', emoji: '🎉', title: hol.name,
        target: hol.date, allDay: true, day: hol.date,
        note: blk.len > 1 ? `отдыхаем ${days(blk.len)}` : '',
      });
    }
  }

  if (b.newyear) {
    const ny = new Date(today.getMonth() === 0 && today.getDate() === 1 ? today.getFullYear() : today.getFullYear() + 1, 0, 1);
    if (!hol || ymd(hol.date) !== ymd(ny)) {
      rows.push({ id: 'newyear', kind: 'newyear', emoji: '🎄', title: 'Новый год', target: ny, allDay: true, day: ny });
    }
  }

  if (b.mercury) {
    const p = nextRetrograde(now);
    if (p) {
      const on = p.start <= now;
      const t = on ? p.end : p.start;
      rows.push({
        id: on ? 'mercury-end' : 'mercury', kind: 'mercury', emoji: '☿',
        title: on ? 'Конец ретроградного Меркурия' : 'Ретроградный Меркурий',
        target: t, allDay: false, day: startOfDay(t), time: hm(t),
        note: on ? 'сейчас ретроградный' : `до ${fmtDM(p.end)}`,
      });
    }
  }

  for (const ev of state.events) {
    if (ev.countdown === false) continue;
    const o = nextOccurrence(ev, now);
    if (!o) continue;
    const years = ev.repeat === 'yearly' ? o.day.getFullYear() - parseYmd(ev.date).getFullYear() : 0;
    rows.push({
      id: `ev:${ev.id}`, kind: 'event', ev, emoji: ev.emoji, color: ev.color, title: ev.title,
      target: o.start, allDay: !ev.time, day: o.day, time: ev.time,
      note: years > 0 ? `${years} ${plural(years, 'год', 'года', 'лет')}` : '',
    });
  }

  rows.sort((x, y) => x.target - y.target || x.id.localeCompare(y.id));
  return rows;
}
