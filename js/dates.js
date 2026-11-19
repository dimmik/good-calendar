// Date helpers. All dates are local "wall clock" dates; a day is identified by "YYYY-MM-DD".

export const MS_DAY = 864e5;

export const pad2 = (n) => String(n).padStart(2, '0');
export const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
export const mdOf = (d) => `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

export function parseYmd(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
export const daysInMonth = (y, m) => new Date(y, m + 1, 0).getDate();
export const dayDiff = (a, b) => Math.round((startOfDay(b) - startOfDay(a)) / MS_DAY);
export const isWeekend = (d) => d.getDay() === 0 || d.getDay() === 6;
export const dayOfYear = (d) => dayDiff(new Date(d.getFullYear(), 0, 1), d) + 1;
export const daysInYear = (y) => (new Date(y, 1, 29).getMonth() === 1 ? 366 : 365);
/** Monday-based weekday: 0 = Monday … 6 = Sunday */
export const wdMon = (d) => (d.getDay() + 6) % 7;

export function withTime(d, hhmm) {
  const [h, m] = (hhmm || '00:00').split(':').map(Number);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h || 0, m || 0);
}

export function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t - y0) / MS_DAY + 1) / 7);
}

export const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
export const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
export const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
export const WEEKDAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
export const WD_SHORT = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

export const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export function plural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

export const days = (n) => `${n} ${plural(n, 'день', 'дня', 'дней')}`;

/** "пт, 5 дек" (+ year if it differs from `ref`) */
export function fmtShort(d, ref = new Date()) {
  let s = `${WD_SHORT[d.getDay()]}, ${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`;
  if (d.getFullYear() !== ref.getFullYear()) s += ` ${d.getFullYear()}`;
  return s;
}

/** "5 декабря" (+ year if it differs from `ref`) */
export function fmtLong(d, ref = new Date()) {
  let s = `${d.getDate()} ${MONTHS_GEN[d.getMonth()]}`;
  if (d.getFullYear() !== ref.getFullYear()) s += ` ${d.getFullYear()}`;
  return s;
}

export function fmtRange(a, b, ref = new Date()) {
  if (ymd(a) === ymd(b)) return fmtLong(a, ref);
  if (a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear()) {
    return `${a.getDate()}–${fmtLong(b, ref)}`;
  }
  return `${fmtLong(a, ref)} – ${fmtLong(b, ref)}`;
}

export function hms(ms) {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return `${h}:${pad2(m)}:${pad2(s)}`;
}
