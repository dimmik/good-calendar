import {
  ymd, parseYmd, startOfDay, addDays, daysInMonth, dayDiff, dayOfYear, daysInYear, isoWeek, wdMon,
  withTime, MONTHS, MONTHS_GEN, WEEKDAYS, WD_SHORT, cap, plural, days, fmtShort, fmtLong, fmtRange, hms, pad2,
} from './dates.js';
import {
  makeCal, kindLabel, buildCountdowns, eventDatesInRange, nextOccurrence, paydaysInRange, countWorkDays,
  offBlock, COUNTRIES,
} from './rules.js';
import {
  load, save, normalize, defaultState, encodeShare, decodeShare, mergeStates, shareUrl, newId,
  sanitizeEvent, COLORS, STORAGE_KEY, SHARE_PARAM, replaceWith, sanitizeMember,
} from './store.js';
import {
  JOIN_PARAM, emptyShared, normalizeShared, mergeShared, canonicalShared, packShared, loadShared, saveShared,
  removeShared, joinLink, parseJoin,
} from './shared.js';
import {
  createSync, loadSyncConfig, saveSyncConfig, pairingLink, parsePairing, newKey, validConfig, getRemote,
  DEFAULT_PATH, SYNC_PARAM,
} from './sync.js';

import { placeOf, PLACES, sunTimes, skyIntervals, retrogradeDay, validGeo } from './astro.js';
import { VERSION } from './version.js';
import { pickTime } from './timepicker.js';

let state = load();
const shared = new Map(); // shared calendar id → its events and name (cached on this device)
const calSyncs = new Map(); // shared calendar id → its sync engine
let calHidden = loadCalHidden(); // shared calendars hidden on this device
ensureMembers();
let cal = makeCal(viewState());
let now = new Date();
let todayKey = ymd(now);
let view = { y: now.getFullYear(), m: now.getMonth() };
let selected = startOfDay(now);
let cdSig = '';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const setText = (el, t) => { if (el && el.textContent !== t) el.textContent = t; };

function commit({ keepSettings = false } = {}) {
  if (!save(state)) toast('Не удалось сохранить: хранилище браузера недоступно');
  ensureMembers();
  refreshCal();
  renderAll();
  if (!keepSettings && $('#setDlg').open) renderSettings();
  sync.schedule();
}

/** Mark that settings changed (so the change wins when merged with other devices). */
const touchSettings = () => { state.settingsU = Date.now(); };

// ---------- Sync ----------

const sync = createSync({
  getState: () => state,
  setState: (next) => {
    state = next;
    save(state);
    ensureMembers();
    refreshCal();
    renderAll();
    if ($('#setDlg').open) renderSettings();
  },
  onStatus: (st) => {
    updateSyncWarn(st);
    const el = $('#syncStatus');
    if (el) { setText(el, syncStatusText(st)); el.classList.toggle('err', st.state === 'error'); }
  },
});

// ---------- Shared calendars ----------

/** Personal events plus those of the shared calendars shown on this device (marked with their calendar). */
function viewState() {
  const events = [...state.events];
  for (const m of state.cals) {
    const s = shared.get(m.id);
    if (!s || calHidden.has(m.id)) continue;
    for (const e of s.events) events.push({ ...e, color: s.color, cal: m.id, calName: s.name });
  }
  return { ...state, events };
}

function refreshCal() {
  cal = makeCal(viewState());
}

const findEvent = (id) => cal.state.events.find((x) => x.id === id);

function loadCalHidden() {
  try { return new Set(JSON.parse(localStorage.getItem('good-calendar:cal-hidden')) || []); } catch { return new Set(); }
}
function saveCalHidden() {
  try { localStorage.setItem('good-calendar:cal-hidden', JSON.stringify([...calHidden])); } catch { /* no storage */ }
}

/** Keep caches and sync engines in step with the membership list (which may change on another device). */
function ensureMembers() {
  const ids = new Set(state.cals.map((m) => m.id));
  for (const m of state.cals) {
    if (!shared.has(m.id)) shared.set(m.id, loadShared(m.id) || emptyShared(m.id));
    if (!calSyncs.has(m.id)) calSyncs.set(m.id, makeCalSync(m.id));
  }
  for (const id of [...shared.keys()]) {
    if (ids.has(id)) continue;
    shared.delete(id);
    calSyncs.delete(id);
    removeShared(id);
  }
}

function makeCalSync(id) {
  return createSync({
    getConfig: () => state.cals.find((m) => m.id === id) || null,
    saveConfig: () => {},
    getState: () => shared.get(id),
    setState: (next) => {
      if (!shared.has(id)) return;
      shared.set(id, next);
      saveShared(next);
      refreshCal();
      renderAll();
      if ($('#setDlg').open) renderSettings();
    },
    merge: mergeShared,
    canon: canonicalShared,
    pack: packShared,
    unpack: (o) => normalizeShared(o, id),
    onStatus: (st) => {
      const el = document.getElementById(`calSt-${id}`);
      if (el) { setText(el, calStatusText(st)); el.classList.toggle('err', st.state === 'error'); }
      updateSyncWarn();
    },
  });
}

function calStatusText(st) {
  if (st.state === 'idle') return 'ещё не синхронизировался';
  return syncStatusText(st);
}

function updateSyncWarn(personal = sync.status()) {
  const bad = personal.state === 'error' || [...calSyncs.values()].some((s) => s.status().state === 'error');
  $('#settingsBtn').classList.toggle('warn', bad);
}

function syncAll() {
  sync.run();
  for (const s of calSyncs.values()) s.run();
}

/** Save an event into a calendar ('' = personal); the caller commits. */
function putEvent(calId, ev) {
  if (!calId) {
    const idx = state.events.findIndex((x) => x.id === ev.id);
    if (idx >= 0) state.events[idx] = ev;
    else state.events.push(ev);
    delete state.deleted[ev.id];
    return;
  }
  const s = shared.get(calId);
  s.events = [...s.events.filter((x) => x.id !== ev.id), ev];
  delete s.deleted[ev.id];
  saveShared(s);
  calSyncs.get(calId).schedule();
}

function removeEvent(calId, id) {
  if (!calId) {
    state.events = state.events.filter((x) => x.id !== id);
    state.deleted[id] = Date.now();
    return;
  }
  const s = shared.get(calId);
  if (!s) return;
  s.events = s.events.filter((x) => x.id !== id);
  s.deleted[id] = Date.now();
  saveShared(s);
  calSyncs.get(calId).schedule();
}

function calsSectionHtml() {
  const pc = loadSyncConfig();
  const rows = state.cals.map((m) => {
    const s = shared.get(m.id) || emptyShared(m.id);
    const st = calSyncs.get(m.id)?.status() || { state: 'idle' };
    const n = s.events.length;
    return `<div class="cal-row" data-cid="${esc(m.id)}">
      <div class="cal-top">
        <span class="cal-dot" style="--c:${s.color}"></span>
        <input class="cal-name" data-cf="name" value="${esc(s.name)}" maxlength="40" aria-label="Название календаря">
        <label class="chk cal-show"><input type="checkbox" data-cf="show"${calHidden.has(m.id) ? '' : ' checked'}> видно</label>
      </div>
      <div class="colors cal-colors">${COLORS.map((c) => `<label class="sw"><input type="radio" name="calc-${esc(m.id)}" data-cf="color" value="${c}"${c === s.color ? ' checked' : ''}><span style="--c:${c}"></span></label>`).join('')}</div>
      <p class="small muted cal-meta">${n} ${plural(n, 'событие', 'события', 'событий')} · ${esc(m.repo)} · <span class="sync-status${st.state === 'error' ? ' err' : ''}" id="calSt-${esc(m.id)}">${esc(calStatusText(st))}</span></p>
      <div class="btn-row">
        <button class="btn small primary" data-act="cal-invite">Пригласить</button>
        <button class="btn small" data-act="cal-sync">Синхронизировать</button>
        <button class="btn small ghost danger" data-act="cal-leave">Убрать у себя</button>
      </div>
    </div>`;
  }).join('');
  return `
    <p class="muted small">События общих календарей видны вместе с вашими. У каждого календаря свой ключ: участники одного не прочтут ни ваш, ни другие общие.</p>
    ${rows}
    <details class="cal-new"${state.cals.length ? '' : ' open'}>
      <summary>+ Новый общий календарь</summary>
      <div class="sync-form">
        <label class="fld"><span>Название</span><input id="calNewName" placeholder="Например, Семья" maxlength="40" autocomplete="off"></label>
        <div class="fld"><span>Цвет</span><div class="colors">${COLORS.map((c, i) => `<label class="sw"><input type="radio" name="calNewColor" value="${c}"${i === (state.cals.length + 1) % COLORS.length ? ' checked' : ''}><span style="--c:${c}"></span></label>`).join('')}</div></div>
        ${pc ? `<label class="chk"><input type="checkbox" id="calSameTok" checked> Тот же репозиторий и токен, что у синхронизации (${esc(pc.repo)})</label>` : ''}
        <div class="cal-own"${pc ? ' hidden' : ''}>
          <label class="fld"><span>Репозиторий (владелец/имя)</span><input id="calRepo" value="${esc(pc ? pc.repo : 'dimmik/goodcalc-data')}" autocomplete="off" spellcheck="false"></label>
          <label class="fld"><span>Токен GitHub — или ссылка подключения синхронизации, из неё возьмутся репозиторий и токен</span><input id="calToken" type="password" autocomplete="off" spellcheck="false"></label>
        </div>
        <p class="muted small">В приглашении будут ключ этого календаря и токен. Прочитать другие календари с ним нельзя, но тот же токен позволяет записывать в любой файл репозитория — для людей вне семьи лучше отдельный репозиторий и токен.</p>
        <div class="btn-row"><button class="btn primary" data-act="cal-create">Создать и пригласить</button></div>
      </div>
    </details>
    <div class="fld"><span>Добавить по приглашению</span>
      <div class="linkrow">
        <input id="joinIn" placeholder="Ссылка-приглашение" aria-label="Ссылка-приглашение" autocomplete="off">
        <button class="btn" data-act="join-apply">Добавить</button>
      </div>
    </div>`;
}

function showInvite(id) {
  const m = state.cals.find((x) => x.id === id);
  const s = shared.get(id);
  if (!m || !s) return;
  const url = joinLink(m, s);
  showLink({
    title: `Пригласить в «${s.name}»`,
    desc: 'Кто откроет эту ссылку, увидит события этого календаря и сможет их менять — и только этого календаря. В ссылке ключ и токен: отправляйте её только участникам.',
    url,
    size: `${url.length} символов`,
  });
}

async function askJoin(j) {
  const id = j.member.id;
  if (state.cals.some((m) => m.id === id)) { toast(`«${(shared.get(id) || j).name}» уже добавлен`); return; }
  if (!confirm(`Добавить общий календарь «${j.name}»?\nЕго события будут видны вместе с вашими, и вы сможете их менять.`)) return;
  const s = emptyShared(id, j.name, j.color, 0);
  shared.set(id, s);
  saveShared(s);
  state.cals.push({ ...j.member, u: Date.now() });
  delete state.deleted[id];
  commit();
  await calSyncs.get(id).run();
  const st = calSyncs.get(id).status();
  toast(st.state === 'error' ? `Добавлен, но синхронизация не удалась: ${st.error}` : `Календарь «${shared.get(id).name}» добавлен`);
}

function syncStatusText(st) {
  const hm = (t) => { const d = new Date(t); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
  switch (st.state) {
    case 'syncing': return 'Синхронизация…';
    case 'ok': return `Синхронизировано в ${hm(st.at)}`;
    case 'error': return `Не получилось (${hm(st.at)}): ${st.error}`;
    case 'idle': {
      const c = loadSyncConfig();
      return c && c.lastSync ? `Последняя синхронизация в ${hm(c.lastSync)}` : 'Ещё не синхронизировалось';
    }
    default: return '';
  }
}

// ---------- Today ----------

function renderToday() {
  const i = cal.info(now);
  const y = now.getFullYear();
  $('#today').innerHTML = `${state.settings.analogClock ? analogClockSvg() : ''}
    <div class="today-head">
      <div class="today-num">${now.getDate()}</div>
      <div class="today-meta">
        <div class="today-wd">${cap(WEEKDAYS[now.getDay()])}</div>
        <div class="today-date">${MONTHS_GEN[now.getMonth()]} ${y}</div>
      </div>
      <div class="today-clock" id="clock"></div>
    </div>
    <div class="today-tags">
      <span class="chip ${i.off ? 'chip-off' : 'chip-work'}">${esc(kindLabel(i))}</span>
      <span class="chip">неделя ${isoWeek(now)}</span>
      <span class="chip chip-doy">день ${dayOfYear(now)} из ${daysInYear(y)}</span>
      ${state.settings.bigClock ? miniClockSvg() : ''}
    </div>
    <div class="today-tiles" id="todayTiles"></div>
    <div class="bars" id="bars">
      ${['day', 'work', 'week', 'month', 'year'].map((k) => `
        <div class="bar" data-bar="${k}">
          <div class="bar-top"><span class="bar-l"></span><span class="bar-r"></span></div>
          ${k === 'week' || k === 'month' ? segTrack(k) : '<div class="bar-track"><div class="bar-fill"></div></div>'}
        </div>`).join('')}
    </div>
    <button class="today-more" data-act="today-more" aria-expanded="${todayExpanded}">${todayExpanded ? 'Скрыть месяц и год' : 'Месяц и год'}</button>`;
  $('#today').classList.toggle('expanded', todayExpanded);
  tickToday();
  renderTiles(true);
  tickMiniClock(true);
}

// Phone: the Today card is compact (month and year bars on demand) and shows the nearest countdowns as tiles.
const UI_KEY = 'good-calendar:ui';
const uiPrefs = (() => { try { return JSON.parse(localStorage.getItem(UI_KEY)) || {}; } catch { return {}; } })();
const saveUi = () => { try { localStorage.setItem(UI_KEY, JSON.stringify(uiPrefs)); } catch { /* private mode */ } };
let todayExpanded = !!uiPrefs.todayExpanded;
let cdAll = false;
const CD_SHORT = 5;

let tilesSig = '';
function renderTiles(force = false) {
  const box = $('#todayTiles');
  if (!box) return;
  const rows = buildCountdowns(cal, now).slice(0, 3);
  const sig = rows.map((r) => r.id).join('|');
  if (force || sig !== tilesSig) {
    tilesSig = sig;
    box.innerHTML = rows.map((r) => `<button class="tile k-${r.kind}" data-act="cd" data-id="${esc(r.id)}" data-day="${ymd(r.day)}">
      <span class="tile-t">${r.emoji ? `${esc(r.emoji)} ` : ''}${esc(r.title)}</span>
      <span class="tile-v"><b></b> <span></span></span></button>`).join('');
  }
  rows.forEach((r, i) => {
    const el = box.children[i];
    if (!el) return;
    const f = cdValue(r);
    setText($('.tile-v b', el), f.v);
    setText($('.tile-v span', el), f.v.includes(':') ? '' : f.u); // a running timer needs no unit
    el.classList.toggle('hot', !!f.hot);
  });
}

/** Translucent analog clock drawn under the Today card's content. */
function analogClockSvg() {
  let ticks = '';
  for (let i = 0; i < 60; i++) {
    const hour = i % 5 === 0;
    const a = (i * 6 * Math.PI) / 180;
    const r1 = hour ? 80 : 88;
    const x1 = (Math.sin(a) * r1).toFixed(2);
    const y1 = (-Math.cos(a) * r1).toFixed(2);
    const x2 = (Math.sin(a) * 94).toFixed(2);
    const y2 = (-Math.cos(a) * 94).toFixed(2);
    ticks += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="${hour ? 'h' : 'm'}"/>`;
  }
  return `<svg class="aclock" viewBox="-100 -100 200 200" aria-hidden="true">
    <circle r="97" class="face"/>
    <g class="ticks">${ticks}</g>
    <line id="acH" class="hand-h" x1="0" y1="10" x2="0" y2="-48"/>
    <line id="acM" class="hand-m" x1="0" y1="12" x2="0" y2="-74"/>
    <line id="acS" class="hand-s" x1="0" y1="18" x2="0" y2="-84"/>
    <circle r="4" class="pin"/>
  </svg>`;
}

function tickAnalog() {
  const h = $('#acH');
  if (!h) return;
  const sec = now.getSeconds();
  const min = now.getMinutes() + sec / 60;
  const hr = (now.getHours() % 12) + min / 60;
  h.setAttribute('transform', `rotate(${(hr * 30).toFixed(2)})`);
  $('#acM').setAttribute('transform', `rotate(${(min * 6).toFixed(2)})`);
  $('#acS').setAttribute('transform', `rotate(${sec * 6})`);
}

// ---------- Big analog clock (wide screens, under the day panel) ----------

const wideMq = matchMedia('(min-width: 1400px)');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
let bcMinute = -1;

const bigClockOn = () => state.settings.bigClock && wideMq.matches;
const dial24 = () => !!state.settings.clock24;
/** Clock-face angle (degrees from the top, clockwise) of a time of day: a 12- or 24-hour dial. */
const dialAngle = (d) => {
  const min = d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
  return dial24() ? min / 4 : (min % 720) / 2;
};

function arcPath(r, a0, span) {
  if (span <= 0.05) return '';
  const pt = (a) => { const t = (a * Math.PI) / 180; return `${(Math.sin(t) * r).toFixed(2)} ${(-Math.cos(t) * r).toFixed(2)}`; };
  if (span >= 359.9) return `M ${pt(a0)} A ${r} ${r} 0 1 1 ${pt(a0 + 180)} A ${r} ${r} 0 1 1 ${pt(a0)}`;
  return `M ${pt(a0)} A ${r} ${r} 0 ${span > 180 ? 1 : 0} 1 ${pt(a0 + span)}`;
}

// The place for sunrise/sunset belongs to the device (not synced): a phone's location should not move the desktop's.
const GEO_KEY = 'good-calendar:geo';
let geo = (() => {
  try {
    const g = JSON.parse(localStorage.getItem(GEO_KEY));
    if (validGeo(g)) return g;
    // 1.10.0 kept it in the synced settings: take it over once
    const old = JSON.parse(localStorage.getItem(STORAGE_KEY))?.settings?.geo;
    if (validGeo(old)) { localStorage.setItem(GEO_KEY, JSON.stringify({ lat: old.lat, lon: old.lon })); return old; }
  } catch { /* no storage */ }
  return null;
})();
function setGeo(g) {
  geo = g;
  try { if (g) localStorage.setItem(GEO_KEY, JSON.stringify(g)); else localStorage.removeItem(GEO_KEY); } catch { /* no storage */ }
  bcMinute = -1;
  tickBigClock();
  renderSettings();
}

function placeText() {
  const s = state.settings;
  const p = placeOf(s, geo);
  const coords = `${p.lat.toFixed(2)}, ${p.lon.toFixed(2)}`;
  return validGeo(geo) ? `По геолокации этого устройства: ${coords}` : `${(PLACES[s.country] || PLACES.rs).name} (по стране календаря): ${coords}`;
}

function renderBigClock() {
  const el = $('#bclock');
  if (!bigClockOn()) { el.innerHTML = ''; return; }
  const d24 = dial24();
  let ticks = '';
  const tick = (deg, kind, r1, r2 = 95) => {
    const a = (deg * Math.PI) / 180;
    ticks += `<line x1="${(Math.sin(a) * r1).toFixed(2)}" y1="${(-Math.cos(a) * r1).toFixed(2)}" x2="${(Math.sin(a) * r2).toFixed(2)}" y2="${(-Math.cos(a) * r2).toFixed(2)}" class="${kind}"/>`;
  };
  // the same minute ring on both dials: short minute marks, long ones every 5 minutes
  for (let i = 0; i < 60; i++) if (i % 5) tick(i * 6, 'm', 90);
  for (let i = 0; i < 12; i++) tick(i * 30, i % 3 ? 'h' : 'q', i % 3 ? 84 : 80);
  // 24-hour dial: short hour marks at the odd hours, inside the minute ring
  if (d24) for (let h = 1; h < 24; h += 2) tick(h * 15, 'h', 81, 87);
  let nums = '';
  for (let h = d24 ? 0 : 1; h <= (d24 ? 23 : 12); h++) {
    const a = ((d24 ? h * 15 : h * 30) * Math.PI) / 180;
    const cls = h % (d24 ? 6 : 3) === 0 ? 'big' : d24 && h % 2 ? 'odd' : '';
    nums += `<text x="${(Math.sin(a) * 68).toFixed(2)}" y="${(-Math.cos(a) * 68).toFixed(2)}"${cls ? ` class="${cls}"` : ''}>${h}</text>`;
  }
  el.innerHTML = `<button class="bc-mode" data-bc-mode title="Циферблат на 12 или 24 часа" aria-label="Циферблат: ${d24 ? '24' : '12'} часа">
    <span${d24 ? '' : ' class="on"'}>12</span><span${d24 ? ' class="on"' : ''}>24</span></button>
  <svg class="bc-svg${d24 ? ' d24' : ''}" viewBox="-114 -114 228 228" role="img" aria-label="Часы">
    <defs><radialGradient id="bcGrad" cx="50%" cy="38%" r="70%"><stop offset="0" class="bc-g0"/><stop offset="1" class="bc-g1"/></radialGradient></defs>
    <circle r="100" class="bc-face"/>
    <g id="bcSky"></g>
    <g id="bcArc"><path class="bc-track"/><path class="bc-done"/></g>
    <g class="bc-ticks">${ticks}</g>
    <g class="bc-nums">${nums}</g>
    <text y="-36" class="bc-month" id="bcMonth"></text>
    <text y="40" class="bc-digital" id="bcDigital"></text>
    <g class="bc-date"><rect x="27" y="-9.5" width="30" height="19" rx="4"/><text x="42" y="0.5" id="bcDate"></text></g>
    <g id="bcDots"></g>
    <g class="bc-hands">
      <path id="bcH" class="bc-h" d="M -4.5 14 L -3 -46 Q 0 -54 3 -46 L 4.5 14 Z"/>
      <path id="bcM" class="bc-m" d="M -3.2 16 L -1.8 -76 Q 0 -84 1.8 -76 L 3.2 16 Z"/>
      <g id="bcS" class="bc-s"><line x1="0" y1="24" x2="0" y2="-90"/><circle cy="-68" r="3.6"/><circle cy="18" r="3"/></g>
      <circle r="4.6" class="bc-pin"/><circle r="1.6" class="bc-pin2"/>
    </g>
  </svg>
  <div class="bc-cap" id="bcCap"></div><div class="bc-sun" id="bcSun"></div>`;
  bcMinute = -1;
  tickBigClock();
  syncSecondHand();
}

/** The second hand sweeps by a CSS animation (cheap); this sets its phase to the real clock. */
function syncSecondHand() {
  const t = new Date();
  for (const s of $$('#bcS')) {
    s.classList.toggle('sweep', !reduceMotion.matches);
    s.style.animationDelay = `-${(t.getSeconds() + t.getMilliseconds() / 1000).toFixed(3)}s`;
  }
}

// ---------- Small analog clock in the Today card (phones; the big one is for wide screens) ----------

let mcMinute = -1;
function miniClockSvg() {
  const d24 = dial24();
  let ticks = '';
  for (let h = 0; h < (d24 ? 24 : 12); h++) {
    const q = h % (d24 ? 6 : 3) === 0;
    const a = ((h * (d24 ? 15 : 30)) * Math.PI) / 180;
    const r1 = q ? 66 : 76;
    ticks += `<line x1="${(Math.sin(a) * r1).toFixed(1)}" y1="${(-Math.cos(a) * r1).toFixed(1)}" x2="${(Math.sin(a) * 86).toFixed(1)}" y2="${(-Math.cos(a) * 86).toFixed(1)}" class="${q ? 'q' : 'h'}"/>`;
  }
  // "12" sits at the top of a 12-hour dial and at the bottom of a 24-hour one, so the mode is visible
  return `<button class="mclock" data-act="clock-mode" title="Циферблат: ${d24 ? '24' : '12'} часа (нажмите, чтобы переключить)" aria-label="Циферблат ${d24 ? '24' : '12'} часа, переключить">
  <svg viewBox="-114 -114 228 228" aria-hidden="true">
    <circle r="100" class="mc-face"/>
    <g id="mcSky"></g>
    <g class="mc-ticks">${ticks}</g>
    <g id="mcArc" class="mc-arc"><path class="bc-track"/><path class="bc-done"/></g>
    <text class="mc-12" y="${d24 ? 44 : -44}">12</text>
    <path id="mcH" class="bc-h" d="M -8 14 L -6 -40 Q 0 -50 6 -40 L 8 14 Z"/>
    <path id="mcM" class="bc-m" d="M -5.5 16 L -3.5 -68 Q 0 -78 3.5 -68 L 5.5 16 Z"/>
    <circle r="8" class="bc-pin"/><circle r="3" class="bc-pin2"/>
  </svg></button>`;
}

function tickMiniClock(force = false) {
  const svg = $('.mclock');
  if (!svg || (!force && !svg.getClientRects().length)) return; // not shown (wide screen)
  const sec = now.getSeconds();
  const min = now.getMinutes() + sec / 60;
  $('#mcH').setAttribute('transform', `rotate(${dialAngle(now).toFixed(2)})`);
  $('#mcM').setAttribute('transform', `rotate(${(min * 6).toFixed(2)})`);
  drawWorkArc($('#mcArc'), 106);
  if (!force && now.getMinutes() === mcMinute) return;
  mcMinute = now.getMinutes();
  $('#mcSky').innerHTML = skyArcs(93);
}

function setHands(t) {
  const h = $('#bcH');
  if (!h) return;
  const sec = t.getSeconds();
  const min = t.getMinutes() + sec / 60;
  const hr = t.getHours() + min / 60;
  h.setAttribute('transform', `rotate(${(dial24() ? hr * 15 : (hr % 12) * 30).toFixed(3)})`);
  $('#bcM').setAttribute('transform', `rotate(${(min * 6).toFixed(3)})`);
  if (reduceMotion.matches) $('#bcS').setAttribute('transform', `rotate(${sec * 6})`);
}

/** Once a second: work-day arc and digital readout; once a minute: date, event dots, caption. */
/** Today's working hours on a dial: { info, work, a, z, p } plus the arc drawn into `arc` at radius r. */
function drawWorkArc(arc, r) {
  const s = state.settings;
  const i = cal.info(now);
  const a = withTime(now, s.workStart);
  const z = withTime(now, s.workEnd);
  const work = !i.off && z > a;
  const p = work ? Math.min(1, Math.max(0, (now - a) / (z - a))) : 0;
  arc.classList.toggle('off', i.off);
  if (work) {
    const a0 = dialAngle(a);
    const span = Math.min(359.9, ((z - a) / 36e5) * (dial24() ? 15 : 30));
    $('.bc-track', arc).setAttribute('d', arcPath(r, a0, span));
    $('.bc-done', arc).setAttribute('d', arcPath(r, a0, span * p));
  } else {
    $('.bc-track', arc).setAttribute('d', i.off ? arcPath(r, 0, 360) : '');
    $('.bc-done', arc).setAttribute('d', '');
  }
  return { i, work, a, z, p };
}

/** Daylight, twilight and night as arcs: the whole day on a 24-hour dial, the next 12 hours on a 12-hour one. */
function skyArcs(r) {
  const pl = placeOf(state.settings, geo);
  const today = startOfDay(now);
  const from = dial24() ? today : now;
  const to = dial24() ? addDays(today, 1) : new Date(+now + 12 * 36e5);
  return skyIntervals(from, to, pl.lat, pl.lon).map((iv) => {
    const span = ((iv.to - iv.from) / 6e4) * (dial24() ? 0.25 : 0.5);
    return `<path class="sky-${iv.kind}" d="${arcPath(r, dialAngle(iv.from), Math.min(span, 359.99))}"/>`;
  }).join('');
}

function tickBigClock() {
  if (!$('#bcH')) return;
  setHands(now);
  const s = state.settings;
  const { i, work, a, p } = drawWorkArc($('#bcArc'), 105);
  setText($('#bcDigital'), `${pad2(now.getHours())}:${pad2(now.getMinutes())}`);
  if (now.getMinutes() === bcMinute) return;
  bcMinute = now.getMinutes();
  syncSecondHand(); // keep the animation in step with the clock
  setText($('#bcMonth'), MONTHS[now.getMonth()].toUpperCase());
  setText($('#bcDate'), `${WD_SHORT[now.getDay()].toUpperCase()} ${now.getDate()}`);
  // today's timed events as dots on the rim: on a 24-hour dial all of them (past ones faded),
  // on a 12-hour dial those within the next 12 hours
  const today = startOfDay(now);
  const until = new Date(+now + 12 * 36e5);
  const dots = [];
  for (const ev of cal.state.events) {
    if (!ev.time || !eventDatesInRange(ev, today, today).length) continue;
    const t = withTime(today, ev.time);
    if (!dial24() && (t < now || t >= until)) continue;
    const ang = (dialAngle(t) * Math.PI) / 180;
    dots.push(`<circle${t < now ? ' class="past"' : ''} cx="${(Math.sin(ang) * 105).toFixed(2)}" cy="${(-Math.cos(ang) * 105).toFixed(2)}" r="5" style="--c:${ev.color}"><title>${esc(`${ev.time} ${ev.title}`)}</title></circle>`);
  }
  $('#bcDots').innerHTML = dots.join('');
  $('#bcSky').innerHTML = skyArcs(93.5);
  const pl = placeOf(s, geo);
  const st = sunTimes(today, pl.lat, pl.lon);
  const hhmm = (t) => `${pad2(t.getHours())}:${pad2(t.getMinutes())}`;
  setText($('#bcSun'), st.sunrise && st.sunset
    ? `Восход ${hhmm(st.sunrise)} · закат ${hhmm(st.sunset)}${st.dusk ? ` · темно с ${hhmm(st.dusk)}` : ''}`
    : st.polar === 'day' ? 'Полярный день' : 'Полярная ночь');
  let text;
  if (i.off) text = i.holiday ? i.holiday : kindLabel(i);
  else if (!work) text = 'Рабочий день';
  else if (now < a) text = `Рабочий день с ${s.workStart} до ${s.workEnd}`;
  else if (p >= 1) text = `Рабочий день закончился в ${s.workEnd}`;
  else text = `Рабочий день до ${s.workEnd} · ${Math.floor(p * 100)}%`;
  setText($('#bcCap'), text);
}

$('#bclock').addEventListener('click', (e) => {
  if (!e.target.closest('[data-bc-mode]')) return;
  state.settings.clock24 = !state.settings.clock24;
  touchSettings();
  commit({ keepSettings: true });
});

// The dial takes the room left under the day panel; hidden when there is too little of it.
new ResizeObserver(() => {
  const el = $('#bclock');
  const cs = getComputedStyle(el);
  const capH = ($('#bcCap')?.offsetHeight || 20) + ($('#bcSun')?.offsetHeight || 18) + 4;
  const w = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const h = el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - capH - 10;
  const size = Math.floor(Math.min(w, h, 440));
  el.style.setProperty('--bc-size', `${Math.max(0, size)}px`);
  const tiny = size < 170;
  if (tiny === el.classList.contains('tiny')) return;
  el.classList.toggle('tiny', tiny);
  if (!tiny) syncSecondHand();
}).observe($('#bclock'));
wideMq.addEventListener?.('change', () => renderBigClock());
reduceMotion.addEventListener?.('change', () => renderBigClock());

/** Days of the current week / month: [{ d, off }] */
function periodDays(k) {
  const today = startOfDay(now);
  const from = k === 'week' ? addDays(today, -wdMon(today)) : new Date(now.getFullYear(), now.getMonth(), 1);
  const n = k === 'week' ? 7 : daysInMonth(now.getFullYear(), now.getMonth());
  return Array.from({ length: n }, (_, i) => {
    const d = addDays(from, i);
    return { d, off: cal.info(d).off };
  });
}

/** A bar split into days; days off are tinted, so the working part of the period is visible. */
function segTrack(k) {
  return `<div class="bar-track seg">${periodDays(k).map(({ d, off }) => `<i class="${off ? 'off' : ''}"${k === 'week' ? ` style="--wd:var(--wd${d.getDay()})"` : ''} title="${esc(`${d.getDate()} ${MONTHS_GEN[d.getMonth()]}${off ? ', выходной' : ''}`)}"><b></b></i>`).join('')}</div>`;
}

/** Share of this week's working time already behind (by working hours), or null without workdays. */
function workWeekProgress() {
  const s = state.settings;
  let total = 0;
  let done = 0;
  for (const { d, off } of periodDays('week')) {
    if (off) continue;
    const a = withTime(d, s.workStart);
    const z = withTime(d, s.workEnd);
    if (z <= a) continue;
    total += z - a;
    done += Math.min(z - a, Math.max(0, now - a));
  }
  return total ? done / total : null;
}

function remainText(ms) {
  const min = Math.floor(ms / 6e4);
  if (min < 60) return `${min} мин`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} ч ${min % 60} мин`;
  return days(Math.floor(h / 24));
}

function tickToday() {
  setText($('#clock'), `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`);
  tickAnalog();
  const today = startOfDay(now);
  const s = state.settings;
  const i = cal.info(now);
  const weekStart = addDays(today, -wdMon(today));
  const bars = {
    day: ['День', today, addDays(today, 1)],
    work: !i.off && withTime(today, s.workStart) < withTime(today, s.workEnd)
      ? ['Рабочий день', withTime(today, s.workStart), withTime(today, s.workEnd)] : null,
    // week and month bars are drawn per day (see segTrack)
    week: ['Неделя', weekStart, addDays(weekStart, 7)],
    month: [cap(MONTHS[now.getMonth()]), new Date(now.getFullYear(), now.getMonth(), 1), new Date(now.getFullYear(), now.getMonth() + 1, 1)],
    year: [`${now.getFullYear()} год`, new Date(now.getFullYear(), 0, 1), new Date(now.getFullYear() + 1, 0, 1)],
  };
  for (const el of $$('#bars .bar')) {
    const b = bars[el.dataset.bar];
    el.hidden = !b;
    if (!b) continue;
    const [label, a, z] = b;
    const p = Math.min(1, Math.max(0, (now - a) / (z - a)));
    const left = z - now;
    let right;
    if (el.dataset.bar === 'work') {
      right = `${Math.floor(p * 100)}% · ${now < a ? `начало в ${s.workStart}` : left <= 0 ? 'закончился' : `ещё ${remainText(left)}`}`;
    } else {
      right = `${(p * 100).toFixed(el.dataset.bar === 'year' ? 1 : 0)}% · ещё ${remainText(left)}`;
    }
    if (el.dataset.bar === 'week') {
      const wp = workWeekProgress();
      if (wp != null) right = right.replace(' · ', ` · рабочая ${Math.round(wp * 100)}% · `);
    }
    setText($('.bar-l', el), label);
    setText($('.bar-r', el), right);
    const fill = $('.bar-fill', el);
    if (fill) fill.style.width = `${(p * 100).toFixed(2)}%`;
    const segs = $$('.seg b', el);
    segs.forEach((b, idx) => {
      const sp = Math.min(1, Math.max(0, p * segs.length - idx));
      b.style.width = `${(sp * 100).toFixed(2)}%`;
    });
  }
}

// ---------- Countdowns ----------

function cdValue(r) {
  const ms = r.target - now;
  if (r.allDay) {
    const d = dayDiff(now, r.target);
    if (d <= 0) return { v: 'Сегодня', u: '', hot: true };
    if (d === 1) return { v: 'Завтра', u: `через ${remainText(r.target - now)}`, hot: true };
    return { v: String(d), u: plural(d, 'день', 'дня', 'дней') };
  }
  if (ms <= 0) return { v: 'Сейчас', u: '', hot: true };
  if (ms < 864e5) return { v: hms(ms), u: 'ч : мин : сек', hot: true, live: true };
  const d = Math.floor(ms / 864e5);
  const h = Math.floor((ms % 864e5) / 36e5);
  return { v: String(d), u: `${plural(d, 'день', 'дня', 'дней')}${h ? ` ${h} ч` : ''}` };
}

function cdSub(r) {
  const parts = [fmtShort(r.day, now) + (r.time ? `, ${r.time}` : '')];
  if (r.note) parts.push(r.note);
  if (r.ev && r.ev.calName) parts.push(r.ev.calName);
  if (r.workDays > 0 && dayDiff(now, r.day) > 0) parts.push(`${r.workDays} раб. ${plural(r.workDays, 'день', 'дня', 'дней')}`);
  return parts.join(' · ');
}

function cdIcon(r) {
  const style = r.color ? ` style="--c:${r.color}"` : '';
  return `<span class="cd-ico${r.emoji ? '' : ' dot'}"${style}>${r.emoji ? esc(r.emoji) : ''}</span>`;
}

function renderCountdowns(force = false) {
  renderTiles();
  const rows = buildCountdowns(cal, now);
  const more = $('#cdMore');
  more.hidden = rows.length <= CD_SHORT;
  setText(more, cdAll ? 'Свернуть' : `Показать все (${rows.length})`);
  $('#cdList').classList.toggle('all', cdAll);
  const sig = `${todayKey}|${rows.map((r) => r.id).join('|')}`;
  const list = $('#cdList');
  if (force || sig !== cdSig) {
    cdSig = sig;
    list.innerHTML = rows.length ? rows.map((r) => {
      const f = cdValue(r);
      return `<li class="cd k-${r.kind}${f.hot ? ' hot' : ''}" data-id="${esc(r.id)}">
        <button class="cd-btn" data-act="cd" data-id="${esc(r.id)}" data-day="${ymd(r.day)}">
          ${cdIcon(r)}
          <span class="cd-main"><span class="cd-title">${esc(r.title)}</span><span class="cd-sub">${esc(cdSub(r))}</span></span>
          <span class="cd-val"><span class="cd-v">${esc(f.v)}</span><span class="cd-u">${esc(f.u)}</span></span>
        </button></li>`;
    }).join('') : '<li class="empty">Пока пусто. Добавьте событие — здесь появится отсчёт.</li>';
    return;
  }
  for (const r of rows) {
    const li = list.querySelector(`li[data-id="${CSS.escape(r.id)}"]`);
    if (!li) continue;
    const f = cdValue(r);
    li.classList.toggle('hot', !!f.hot);
    setText($('.cd-v', li), f.v);
    setText($('.cd-u', li), f.u);
    setText($('.cd-sub', li), cdSub(r));
  }
}

function renderEventList() {
  const evs = [...cal.state.events].sort((a, b) => {
    const oa = nextOccurrence(a, now);
    const ob = nextOccurrence(b, now);
    if (oa && ob) return oa.start - ob.start;
    if (oa) return -1;
    if (ob) return 1;
    return b.date.localeCompare(a.date);
  });
  setText($('#evCount'), evs.length ? `(${evs.length})` : '');
  $('#evList').innerHTML = evs.length ? evs.map((ev) => {
    const o = nextOccurrence(ev, now);
    const rep = { yearly: 'каждый год', monthly: 'каждый месяц', weekly: 'каждую неделю' }[ev.repeat];
    let when;
    if (o) when = fmtShort(o.day, now) + (ev.time ? `, ${ev.time}` : '');
    else {
      const ago = dayDiff(parseYmd(ev.date), now);
      when = `${fmtShort(parseYmd(ev.date), now)} · ${ago === 0 ? 'сегодня' : `${days(ago)} назад`}`;
    }
    return `<li class="${o ? '' : 'past'}"><button class="ev-btn" data-act="edit" data-id="${esc(ev.id)}">
      <span class="cd-ico${ev.emoji ? '' : ' dot'}" style="--c:${ev.color}">${esc(ev.emoji || '')}</span>
      <span class="cd-main"><span class="cd-title">${esc(ev.title)}</span><span class="cd-sub">${esc(when)}${rep ? ` · ${rep}` : ''}${ev.countdown ? '' : ' · без отсчёта'}${ev.calName ? ` · ${esc(ev.calName)}` : ''}</span></span>
    </button></li>`;
  }).join('') : '<li class="empty">Событий нет.</li>';
}

// ---------- Month ----------

function marksFor(from, to) {
  const map = new Map();
  const add = (d, item) => {
    const k = ymd(d);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(item);
  };
  for (const p of state.paydays) {
    for (const hit of paydaysInRange(cal, p, from, to)) add(hit.date, { kind: 'pay', title: p.title || 'Зарплата', emoji: '💰', color: 'var(--pay)' });
  }
  for (const ev of cal.state.events) {
    for (const d of eventDatesInRange(ev, from, to)) add(d, { kind: 'ev', title: ev.calName ? `${ev.title} (${ev.calName})` : ev.title, emoji: ev.emoji, color: ev.color, time: ev.time, id: ev.id });
  }
  for (const list of map.values()) list.sort((a, b) => (a.kind === 'pay' ? -1 : 0) - (b.kind === 'pay' ? -1 : 0) || (a.time || '').localeCompare(b.time || ''));
  return map;
}

function renderMonth() {
  const { y, m } = view;
  const s = state.settings;
  setText($('#mTitle'), `${cap(MONTHS[m])} ${y}`);
  const wk = s.weekNumbers;
  $('#dow').classList.toggle('with-wk', wk);
  $('#grid').classList.toggle('with-wk', wk);
  $('#dow').innerHTML = (wk ? '<span class="wk">нед</span>' : '')
    + ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'].map((d, i) => `<span class="${i > 4 ? 'we' : ''}">${d}</span>`).join('');

  const first = new Date(y, m, 1);
  const offset = wdMon(first);
  const dim = daysInMonth(y, m);
  const weeks = Math.ceil((offset + dim) / 7);
  const start = addDays(first, -offset);
  const end = addDays(start, weeks * 7 - 1);
  const marks = marksFor(start, end);
  const selKey = ymd(selected);
  let html = '';
  let work = 0;
  let estimated = false;
  for (let w = 0; w < weeks; w++) {
    if (wk) html += `<span class="wk">${isoWeek(addDays(start, w * 7))}</span>`;
    for (let i = 0; i < 7; i++) {
      const d = addDays(start, w * 7 + i);
      const inf = cal.info(d);
      const inMonth = d.getMonth() === m;
      if (inMonth) {
        if (!inf.off) work++;
        if (inf.estimated) estimated = true;
      }
      const mk = marks.get(inf.key) || [];
      const cls = ['cell'];
      if (!inMonth) cls.push('out');
      if (inf.off) cls.push('off');
      if (inf.holiday && inf.off) cls.push('hol');
      if (inf.kind === 'work-weekend' || inf.kind === 'custom-work') cls.push('workwk');
      if (inf.override) cls.push('ovr');
      if (inf.key === todayKey) cls.push('today');
      if (!inf.off && inf.key < todayKey) cls.push('past');
      if (!inf.off && inf.key === todayKey) cls.push('wnow');
      if (inf.key === selKey) cls.push('sel');
      const merc = retrogradeDay(d);
      if (merc) cls.push('merc');
      const label = `${d.getDate()} ${MONTHS_GEN[d.getMonth()]}, ${kindLabel(inf)}${mk.length ? `, ${mk.map((x) => x.title).join(', ')}` : ''}`;
      const chips = mk.slice(0, 3).map((x) => `<span class="chip-ev" style="--c:${x.color}">${x.emoji ? `${esc(x.emoji)} ` : ''}${x.time ? `<b>${x.time}</b> ` : ''}${esc(x.title)}</span>`).join('')
        + (mk.length > 3 ? `<span class="chip-more">ещё ${mk.length - 3}</span>` : '');
      const dots = mk.slice(0, 4).map((x) => (x.kind === 'pay' ? '<i class="dot-pay"></i>' : `<i style="--c:${x.color}"></i>`)).join('');
      html += `<button class="${cls.join(' ')}" data-day="${inf.key}" aria-label="${esc(label)}"${inf.key === selKey ? ' aria-pressed="true"' : ''}>
        <span class="c-num">${d.getDate()}</span>
        ${merc ? '<span class="c-merc" title="Ретроградный Меркурий">☿</span>' : ''}
        ${inf.holiday && inf.off ? `<span class="c-hol">${esc(inf.holiday)}</span>`
    : inf.observance ? `<span class="c-hol c-obs">${esc(inf.observance)}</span>` : ''}
        ${mk.length ? `<span class="c-chips">${chips}</span><span class="c-dots">${dots}</span>` : ''}
      </button>`;
    }
  }
  $('#grid').innerHTML = html;
  tickTodayCell();
  const off = dim - work;
  let stats = `${work} ${plural(work, 'рабочий день', 'рабочих дня', 'рабочих дней')} · ${off} ${plural(off, 'выходной', 'выходных', 'выходных')}`;
  if (estimated) stats += ' · переносы на этот год ещё не внесены';
  setText($('#mStats'), stats);
}

/** Hatch today's working-day cell as far as the workday has gone. */
function tickTodayCell() {
  const cell = $('#grid .cell.wnow');
  if (!cell) return;
  const s = state.settings;
  const a = withTime(now, s.workStart);
  const z = withTime(now, s.workEnd);
  const p = z > a ? Math.min(1, Math.max(0, (now - a) / (z - a))) : 0;
  cell.style.setProperty('--wp', p.toFixed(4));
  cell.classList.toggle('wdone', p >= 1);
}

// ---------- Selected day ----------

function renderDay() {
  const d = selected;
  const inf = cal.info(d);
  const diff = dayDiff(now, d);
  const rel = diff === 0 ? 'сегодня' : diff === 1 ? 'завтра' : diff === -1 ? 'вчера'
    : diff > 0 ? `через ${days(diff)}` : `${days(-diff)} назад`;
  const items = [];
  if (inf.holiday && inf.off) {
    const blk = offBlock(cal, d);
    items.push(`<li><span class="cd-ico">🎉</span><span class="cd-main"><span class="cd-title">${esc(inf.holiday)}</span>${blk.len > 1 ? `<span class="cd-sub">отдыхаем ${fmtRange(blk.start, blk.end, now)}, ${days(blk.len)}</span>` : ''}</span></li>`);
  }
  if (inf.observance) {
    items.push(`<li><span class="cd-ico">📌</span><span class="cd-main"><span class="cd-title">${esc(inf.observance)}</span><span class="cd-sub">памятный день, рабочий</span></span></li>`);
  }
  const merc = retrogradeDay(d);
  if (merc) {
    items.push(`<li><span class="cd-ico merc">☿</span><span class="cd-main"><span class="cd-title">Ретроградный Меркурий</span><span class="cd-sub">${esc(fmtRange(merc.start, merc.end, now))}</span></span></li>`);
  }
  for (const p of state.paydays) {
    for (const hit of paydaysInRange(cal, p, d, d)) {
      const moved = ymd(hit.nominal) !== ymd(hit.date);
      items.push(`<li><span class="cd-ico">💰</span><span class="cd-main"><span class="cd-title">${esc(p.title || 'Зарплата')}</span><span class="cd-sub">${moved ? `за ${fmtLong(hit.nominal, now)}, перенесено с выходного` : `${p.day}-е число`}</span></span></li>`);
    }
  }
  const evs = cal.state.events
    .filter((ev) => eventDatesInRange(ev, d, d).length)
    .sort((a, b) => (a.time || '').localeCompare(b.time || ''));
  for (const ev of evs) {
    const rep = { yearly: 'каждый год', monthly: 'каждый месяц', weekly: 'каждую неделю' }[ev.repeat];
    const years = ev.repeat === 'yearly' ? d.getFullYear() - parseYmd(ev.date).getFullYear() : 0;
    const sub = [ev.time || 'весь день', rep, years > 0 ? `${years} ${plural(years, 'год', 'года', 'лет')}` : '', ev.calName].filter(Boolean).join(' · ');
    items.push(`<li><button class="ev-btn" data-act="edit" data-id="${esc(ev.id)}">
      <span class="cd-ico${ev.emoji ? '' : ' dot'}" style="--c:${ev.color}">${esc(ev.emoji || '')}</span>
      <span class="cd-main"><span class="cd-title">${esc(ev.title)}</span><span class="cd-sub">${esc(sub)}</span></span>
      <span class="edit-hint">изменить</span></button></li>`);
  }
  let extra = '';
  if (diff > 1 && diff < 800) {
    const n = countWorkDays(cal, now, d);
    extra = `<p class="muted small">До этого дня ${n} ${plural(n, 'рабочий день', 'рабочих дня', 'рабочих дней')}.</p>`;
  }
  if (inf.estimated && (d.getMonth() === 0 || inf.kind === 'transfer')) {
    extra += `<p class="muted small">Переносы выходных на ${d.getFullYear()} год рассчитаны по Трудовому кодексу, постановление правительства пока не внесено. Если день на самом деле другой — переключите его кнопкой ниже.</p>`;
  }
  $('#day').innerHTML = `
    <div class="day-head">
      <h2>${cap(WEEKDAYS[d.getDay()])}, ${fmtLong(d, now)}</h2>
      <div class="day-rel"><span>${rel}</span><span class="chip ${inf.off ? 'chip-off' : 'chip-work'}">${esc(kindLabel(inf))}</span></div>
    </div>
    ${items.length ? `<ul class="day-items">${items.join('')}</ul>` : '<p class="muted">Ничего не запланировано.</p>'}
    ${extra}
    <div class="day-actions">
      <button class="btn primary" data-act="new-event-day">+ Событие на этот день</button>
      <button class="btn" data-act="toggle-off">${inf.off ? 'Сделать рабочим' : 'Сделать выходным'}</button>
      ${inf.override ? '<button class="btn ghost" data-act="reset-day">Как в календаре</button>' : ''}
    </div>`;
}

function renderAll() {
  applyTheme();
  renderToday();
  renderCountdowns(true);
  renderEventList();
  renderMonth();
  renderDay();
  renderBigClock();
}

function selectDay(d, { scroll = false } = {}) {
  selected = startOfDay(d);
  if (selected.getMonth() !== view.m || selected.getFullYear() !== view.y) view = { y: selected.getFullYear(), m: selected.getMonth() };
  renderMonth();
  renderDay();
  if (scroll && matchMedia('(max-width: 899px)').matches) $('.month').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function shiftMonth(n) {
  const d = new Date(view.y, view.m + n, 1);
  view = { y: d.getFullYear(), m: d.getMonth() };
  const dim = daysInMonth(view.y, view.m);
  selected = new Date(view.y, view.m, Math.min(selected.getDate(), dim));
  if (view.y === now.getFullYear() && view.m === now.getMonth()) selected = startOfDay(now);
  renderMonth();
  renderDay();
}

// ---------- Theme ----------

function applyTheme() {
  const t = state.settings.theme;
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  const dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  for (const m of $$('meta[name="theme-color"]')) m.setAttribute('content', dark ? '#0f1115' : '#f4f4f1');
}

// ---------- Event dialog ----------

let editingId = null;
let editingCal = '';
let evCals = new Set(); // calendars chosen in the event dialog ('' = personal)

const calName = (id) => (id ? (shared.get(id) || {}).name || 'Общий' : 'Мой');
const quoteList = (names) => names.map((n) => `«${n}»`).join(', ').replace(/, ([^,]*)$/, ' и $1');

/** Calendar chips, the "goes to other people" note and the save button follow the choice. */
function renderEvCals() {
  const ids = ['', ...state.cals.map((m) => m.id)];
  $('#evCals').innerHTML = ids.map((id) => {
    const on = evCals.has(id);
    const color = id ? (shared.get(id) || {}).color || COLORS[1] : 'var(--muted)';
    return `<button type="button" class="cal-chip${id ? ' shared' : ''}" data-cal="${esc(id)}" aria-pressed="${on}" style="--c:${color}">
      <i aria-hidden="true">${on ? '✓' : ''}</i>${esc(calName(id))}${id ? '<b aria-hidden="true">🔗</b>' : ''}</button>`;
  }).join('');
  const others = [...evCals].filter(Boolean);
  const note = $('#evCalNote');
  note.hidden = !others.length;
  if (others.length) {
    const names = quoteList(others.map(calName));
    note.innerHTML = `🔗 <b>Это увидят и смогут менять другие люди</b> — все участники ${others.length > 1 ? 'календарей' : 'календаря'} ${esc(names)}.`
      + (evCals.has('') ? ' В «Мой» попадёт отдельная копия.' : '')
      + (editingId && others.length > 1 ? ' В каждый календарь — своя копия.' : '');
  }
  $('#evColors').hidden = !evCals.has(''); // shared calendars paint events in their own colour
  setText($('#evSave'), others.length ? 'Сохранить и отправить' : 'Сохранить');
}

$('#evCals').addEventListener('click', (e) => {
  const b = e.target.closest('.cal-chip');
  if (!b) return;
  const id = b.dataset.cal;
  if (evCals.has(id)) evCals.delete(id); else evCals.add(id);
  renderEvCals();
});

function openEvent(ev, date) {
  editingId = ev ? ev.id : null;
  editingCal = ev ? ev.cal || '' : '';
  const known = new Set(['', ...state.cals.map((m) => m.id)]);
  const last = (Array.isArray(uiPrefs.lastCals) ? uiPrefs.lastCals : []).filter((id) => known.has(id));
  evCals = new Set(ev ? [editingCal] : last.length ? last : ['']);
  $('#evCalFld').hidden = !state.cals.length;
  const f = $('#evForm');
  $('#evDlgTitle').textContent = ev ? 'Событие' : 'Новое событие';
  f.title.value = ev ? ev.title : '';
  f.date.value = ev ? ev.date : ymd(date || selected);
  f.time.value = ev ? ev.time : '';
  showEvTime();
  f.repeat.value = ev ? ev.repeat : 'none';
  f.emoji.value = ev ? ev.emoji : '';
  f.countdown.checked = ev ? ev.countdown : true;
  const color = ev && !ev.cal ? ev.color : COLORS[state.events.length % COLORS.length];
  $('#evColors').innerHTML = COLORS.map((c) => `<label class="sw"><input type="radio" name="color" value="${c}"${c === color ? ' checked' : ''}><span style="--c:${c}"></span></label>`).join('');
  $('#evDelete').hidden = !ev;
  renderEvCals();
  $('#evDlg').showModal();
  if (!ev) f.title.focus();
}

function showEvTime() {
  const v = $('#evForm').time.value;
  const b = $('#evTimeBtn');
  b.textContent = v || 'весь день';
  b.classList.toggle('empty', !v);
}

$('#evTimeBtn').addEventListener('click', async () => {
  const f = $('#evForm');
  const fallback = `${pad2(Math.min(23, now.getHours() + 1))}:00`;
  const v = await pickTime(f.time.value, { allowEmpty: true, title: 'Время события', fallback });
  if (v === null) return;
  f.time.value = v;
  showEvTime();
});

$('#evForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  const ev = sanitizeEvent({
    id: editingId || newId(),
    title: f.title.value,
    date: f.date.value,
    time: f.time.value,
    repeat: f.repeat.value,
    color: (f.querySelector('input[name="color"]:checked') || {}).value,
    emoji: f.emoji.value,
    countdown: f.countdown.checked,
    u: Date.now(),
  });
  if (!ev) { toast('Проверьте название и дату'); return; }
  const targets = ['', ...state.cals.map((m) => m.id)].filter((id) => evCals.has(id));
  if (!targets.length) { toast('Выберите хотя бы один календарь'); return; }
  const existed = !!editingId;
  // the event keeps its id in its own calendar; every other chosen calendar gets an independent copy
  if (existed && !targets.includes(editingCal)) removeEvent(editingCal, ev.id);
  for (const id of targets) {
    putEvent(id, existed && id === editingCal ? ev : { ...ev, id: newId() });
  }
  if (!existed) { uiPrefs.lastCals = targets; saveUi(); }
  $('#evDlg').close();
  selected = parseYmd(ev.date);
  const occ = nextOccurrence(ev, now);
  if (occ) selected = occ.day;
  view = { y: selected.getFullYear(), m: selected.getMonth() };
  commit();
  const sent = targets.filter(Boolean);
  toast(sent.length ? `${existed ? 'Сохранено' : 'Добавлено'} и отправлено в ${quoteList(sent.map(calName))}` : existed ? 'Сохранено' : 'Событие добавлено');
});

$('#evDelete').addEventListener('click', () => {
  const ev = findEvent(editingId);
  if (!ev || !confirm(`Удалить «${ev.title}»${ev.calName ? ` из «${ev.calName}»` : ''}?`)) return;
  removeEvent(editingCal, editingId);
  $('#evDlg').close();
  commit();
  toast('Удалено');
});

// ---------- Settings ----------

const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

function renderSettings() {
  const s = state.settings;
  const b = s.builtins;
  const pays = state.paydays.map((p) => `
    <div class="pay-row" data-pid="${esc(p.id)}">
      <input class="in" data-f="title" value="${esc(p.title)}" placeholder="Название" aria-label="Название выплаты">
      <label class="pay-day"><input class="in" data-f="day" type="number" min="1" max="31" inputmode="numeric" value="${p.day}" aria-label="Число"><span>число</span></label>
      <select class="in" data-f="shift" aria-label="Если выпадает на выходной">
        <option value="before"${p.shift === 'before' ? ' selected' : ''}>выходной → раньше</option>
        <option value="after"${p.shift === 'after' ? ' selected' : ''}>выходной → позже</option>
        <option value="none"${p.shift === 'none' ? ' selected' : ''}>не переносить</option>
      </select>
      <button class="icon-btn" data-act="pay-del" aria-label="Удалить выплату" title="Удалить">×</button>
    </div>`).join('');
  const chk = (k, label) => `<label class="chk"><input type="checkbox" data-b="${k}"${b[k] ? ' checked' : ''}> ${label}</label>`;
  const canInstall = !!window.__installPrompt;
  $('#setBody').innerHTML = `
    <div class="dlg-title"><h2>Настройки</h2><button class="icon-btn" data-close aria-label="Закрыть">×</button></div>

    <h3>Выплаты</h3>
    <p class="muted small">Если число выпадает на выходной или праздник, дата сдвигается.</p>
    <div class="pays">${pays || '<p class="muted small">Нет выплат.</p>'}</div>
    <button class="btn small" data-act="pay-add">+ Выплата (например, аванс)</button>

    <h3>Что считать</h3>
    <div class="chk-list">
      ${chk('payday', '💰 До зарплаты')}
      ${chk('weekend', '🏖️ До выходных / до работы')}
      ${chk('workday', '⏳ До конца рабочего дня')}
      ${chk('holiday', '🎉 До ближайшего праздника')}
      ${chk('newyear', '🎄 До Нового года')}
      ${chk('mercury', '☿ До ретроградного Меркурия и до его конца')}
    </div>

    <h3>Рабочий день</h3>
    <div class="row2">
      <label class="fld"><span>Начало</span><button type="button" class="time-field" data-time-s="workStart">${s.workStart}</button></label>
      <label class="fld"><span>Конец</span><button type="button" class="time-field" data-time-s="workEnd">${s.workEnd}</button></label>
    </div>

    <h3>Календарь</h3>
    <div class="row2">
      <label class="fld"><span>Праздники и переносы</span>
        <select data-s="country">
          ${Object.entries(COUNTRIES).map(([k, v]) => `<option value="${k}"${s.country === k ? ' selected' : ''}>${v}</option>`).join('')}
        </select>
      </label>
      <label class="fld"><span>Тема</span>
        <select data-s="theme">
          <option value="auto"${s.theme === 'auto' ? ' selected' : ''}>Как в системе</option>
          <option value="light"${s.theme === 'light' ? ' selected' : ''}>Светлая</option>
          <option value="dark"${s.theme === 'dark' ? ' selected' : ''}>Тёмная</option>
        </select>
      </label>
    </div>
    <label class="chk"><input type="checkbox" data-s="weekNumbers"${s.weekNumbers ? ' checked' : ''}> Номера недель</label>
    <label class="chk"><input type="checkbox" data-s="analogClock"${s.analogClock ? ' checked' : ''}> Аналоговые часы в «Сегодня»</label>
    <div class="fld"><span>Место для восхода и заката (тёмное и светлое время на больших часах)</span>
      <p class="small" style="margin:2px 0 6px">${esc(placeText())}</p>
      <div class="btn-row"><button class="btn small" data-act="geo-locate">Определить по геолокации</button>${validGeo(geo) ? '<button class="btn small ghost" data-act="geo-reset">По стране</button>' : ''}</div>
    </div>
    <label class="chk"><input type="checkbox" data-s="bigClock"${s.bigClock ? ' checked' : ''}> Аналоговые часы с дугой рабочего дня и небом: большие справа на широком экране, маленькие в «Сегодня» на телефоне</label>
    <p class="muted small">Любой день можно сделать выходным или рабочим: выберите его в календаре.</p>

    <h3>Перенос между устройствами</h3>
    <p class="muted small">Ссылка содержит все события и настройки. На iPhone приложение на экране «Домой» хранит данные отдельно от Safari — откройте ссылку в нём или вставьте её сюда.</p>
    <div class="btn-row"><button class="btn primary" data-act="share">Получить ссылку</button></div>
    <div class="linkrow">
      <input id="pasteLink" placeholder="Вставьте ссылку или код" aria-label="Ссылка для импорта">
      <button class="btn" data-act="paste-apply">Применить</button>
    </div>
    <div class="btn-row">
      <button class="btn small" data-act="export">Скачать файл</button>
      <label class="btn small file-btn">Загрузить файл<input type="file" accept="application/json,.json" id="importFile" hidden></label>
    </div>

    <h3>Общие календари</h3>
    ${calsSectionHtml()}

    <h3>Синхронизация</h3>
    ${syncSectionHtml()}

    <h3>Приложение</h3>
    ${isStandalone() ? '<p class="muted small">Установлено ✓</p>'
      : canInstall ? '<div class="btn-row"><button class="btn primary" data-act="install">Установить на устройство</button></div>'
        : isIOS ? '<p class="muted small">Установка на iPhone/iPad: в Safari нажмите «Поделиться» → «На экран „Домой“».</p>'
          : '<p class="muted small">Установка: меню браузера → «Установить приложение» или «Добавить на главный экран».</p>'}
    <div class="btn-row"><button class="btn small ghost danger" data-act="reset-all">Сбросить всё</button></div>
    <p class="muted small ver">Версия ${VERSION} · ${loadSyncConfig() ? 'данные синхронизируются в зашифрованном виде' : 'данные хранятся только в этом браузере'}</p>`;
}

function syncSectionHtml() {
  const c = loadSyncConfig();
  if (c) {
    const st = sync.status();
    return `
    <p class="muted small">Файл <b>${esc(c.path)}</b> в репозитории <b>${esc(c.repo)}</b>, зашифрован ключом, который есть только у ваших устройств.</p>
    <p class="small sync-status${st.state === 'error' ? ' err' : ''}" id="syncStatus">${esc(syncStatusText(st))}</p>
    <div class="btn-row">
      <button class="btn primary" data-act="sync-now">Синхронизировать</button>
      <button class="btn" data-act="sync-pair">Подключить другое устройство</button>
      <button class="btn ghost danger" data-act="sync-off">Отключить</button>
    </div>`;
  }
  return `
    <p class="muted small">События и настройки шифруются прямо на устройстве и хранятся в файле в вашем GitHub-репозитории. Ключ есть только у ваших устройств, GitHub видит одну шифровку.</p>
    <div class="fld"><span>Подключить по ссылке с другого устройства</span>
      <div class="linkrow">
        <input id="pairIn" placeholder="Ссылка подключения" aria-label="Ссылка подключения" autocomplete="off">
        <button class="btn" data-act="pair-apply">Подключить</button>
      </div>
    </div>
    <details class="sync-setup">
      <summary>Первое устройство: настроить с нуля</summary>
      <div class="sync-form">
        <label class="fld"><span>Репозиторий (владелец/имя)</span><input id="syncRepo" value="dimmik/goodcalc-data" autocomplete="off" spellcheck="false"></label>
        <label class="fld"><span>Файл</span><input id="syncPath" value="${DEFAULT_PATH}" autocomplete="off" spellcheck="false"></label>
        <label class="fld"><span>Токен GitHub (доступ только к этому репозиторию, Contents: Read and write)</span><input id="syncToken" type="password" autocomplete="off" spellcheck="false"></label>
        <div class="btn-row"><button class="btn primary" data-act="sync-setup">Создать ключ и включить</button></div>
      </div>
    </details>`;
}

async function enableSync(c) {
  saveSyncConfig(c);
  if ($('#setDlg').open) renderSettings();
  await sync.run();
  const st = sync.status();
  if (st.state === 'error') {
    if (st.kind === 'key' || st.kind === 'auth' || st.kind === 'perm' || st.kind === 'format') {
      saveSyncConfig(null);
      if ($('#setDlg').open) renderSettings();
      toast(`Синхронизация не включена: ${st.error}`);
      return false;
    }
    toast(`Синхронизация включена, но пока не получилось: ${st.error}`);
    return true;
  }
  toast('Синхронизация включена');
  return true;
}

async function askPair(c) {
  if (!confirm(`Подключить синхронизацию через ${c.repo}?\nДанные этого устройства объединятся с общими.`)) return;
  await enableSync(c);
}

$('#setBody').addEventListener('change', (e) => {
  const t = e.target;
  if (t.id === 'calSameTok') { $('.cal-own').hidden = t.checked; return; }
  if (t.dataset.cf) {
    const id = t.closest('.cal-row').dataset.cid;
    const s = shared.get(id);
    if (!s) return;
    if (t.dataset.cf === 'show') {
      if (t.checked) calHidden.delete(id); else calHidden.add(id);
      saveCalHidden();
      refreshCal();
      renderAll();
      return;
    }
    if (t.dataset.cf === 'name') s.name = t.value.trim().slice(0, 40) || s.name;
    if (t.dataset.cf === 'color') s.color = t.value;
    s.metaU = Date.now();
    saveShared(s);
    calSyncs.get(id).schedule();
    refreshCal();
    renderAll();
    renderSettings();
    return;
  }
  const s = state.settings;
  if (t.dataset.b) { s.builtins[t.dataset.b] = t.checked; touchSettings(); commit({ keepSettings: true }); return; }
  if (t.dataset.s) {
    const k = t.dataset.s;
    if (t.type === 'checkbox') s[k] = t.checked;
    else s[k] = t.value;
    touchSettings();
    commit({ keepSettings: true });
    return;
  }
  if (t.dataset.f) {
    const row = t.closest('.pay-row');
    const p = state.paydays.find((x) => x.id === row.dataset.pid);
    if (!p) return;
    if (t.dataset.f === 'day') {
      const v = Math.round(Number(t.value));
      if (!(v >= 1 && v <= 31)) { t.value = p.day; return; }
      p.day = v;
    } else if (t.dataset.f === 'title') p.title = t.value.trim().slice(0, 60);
    else p.shift = t.value;
    p.u = Date.now();
    commit({ keepSettings: true });
  }
  if (t.id === 'importFile' && t.files[0]) {
    t.files[0].text().then((txt) => {
      try { askImport(normalize(JSON.parse(txt))); } catch { toast('Не похоже на файл календаря'); }
    });
    t.value = '';
  }
});

$('#setBody').addEventListener('click', async (e) => {
  const tb = e.target.closest('[data-time-s]');
  if (tb) {
    const k = tb.dataset.timeS;
    const v = await pickTime(state.settings[k], { title: k === 'workStart' ? 'Начало рабочего дня' : 'Конец рабочего дня' });
    if (v) { state.settings[k] = v; touchSettings(); commit(); }
    return;
  }
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  switch (btn.dataset.act) {
    case 'geo-locate':
      if (!navigator.geolocation) { toast('Геолокация недоступна в этом браузере'); break; }
      navigator.geolocation.getCurrentPosition((pos) => {
        // two decimals (about a kilometre) are plenty for sunrise times
        const r2 = (x) => Math.round(x * 100) / 100;
        setGeo({ lat: r2(pos.coords.latitude), lon: r2(pos.coords.longitude) });
        toast('Место сохранено на этом устройстве');
      }, () => toast('Не удалось определить место'), { timeout: 15000, maximumAge: 36e5 });
      break;
    case 'geo-reset':
      setGeo(null);
      break;
    case 'pay-add':
      state.paydays.push({ id: newId(), title: 'Аванс', day: 20, shift: 'before', u: Date.now() });
      commit();
      break;
    case 'pay-del': {
      const id = btn.closest('.pay-row').dataset.pid;
      state.paydays = state.paydays.filter((p) => p.id !== id);
      state.deleted[id] = Date.now();
      commit();
      break;
    }
    case 'share': openShare(); break;
    case 'paste-apply': {
      const v = $('#pasteLink').value;
      try { askImport(await decodeShare(v)); } catch { toast('Не получилось прочитать ссылку'); }
      break;
    }
    case 'export': {
      const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `calendar-${ymd(now)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      break;
    }
    case 'sync-now': await sync.run(); break;
    case 'cal-create': {
      const name = $('#calNewName').value.trim().slice(0, 40) || 'Общий календарь';
      const color = ($('input[name="calNewColor"]:checked') || {}).value || COLORS[1];
      const pc = loadSyncConfig();
      let repo;
      let token;
      if (pc && $('#calSameTok') && $('#calSameTok').checked) ({ repo, token } = pc);
      else {
        repo = $('#calRepo').value.trim();
        token = $('#calToken').value.trim();
        if (token.includes(`${SYNC_PARAM}=`)) {
          try { ({ repo, token } = parsePairing(token)); } catch { toast('Не получилось прочитать ссылку подключения'); break; }
        }
      }
      const id = newId();
      const m = sanitizeMember({ id, repo, path: `cal/${id}.enc`, token, key: newKey(), u: Date.now() });
      if (!m) { toast('Проверьте репозиторий и токен'); break; }
      const s = emptyShared(id, name, color, Date.now());
      shared.set(id, s);
      saveShared(s);
      state.cals.push(m);
      delete state.deleted[id];
      commit();
      toast('Создаю файл календаря…');
      await calSyncs.get(id).run();
      const st = calSyncs.get(id).status();
      renderSettings();
      if (st.state === 'error') { toast(`Календарь создан, но синхронизация не удалась: ${st.error}`); break; }
      showInvite(id);
      break;
    }
    case 'cal-invite': showInvite(btn.closest('.cal-row').dataset.cid); break;
    case 'cal-sync': await calSyncs.get(btn.closest('.cal-row').dataset.cid)?.run(); break;
    case 'cal-leave': {
      const id = btn.closest('.cal-row').dataset.cid;
      const s = shared.get(id);
      if (!confirm(`Убрать «${s ? s.name : 'календарь'}» с ваших устройств?\nУ остальных участников он останется.`)) break;
      state.cals = state.cals.filter((x) => x.id !== id);
      state.deleted[id] = Date.now();
      calHidden.delete(id);
      saveCalHidden();
      commit();
      toast('Календарь убран');
      break;
    }
    case 'join-apply': {
      let j;
      try { j = parseJoin($('#joinIn').value); } catch { toast('Не получилось прочитать приглашение'); break; }
      await askJoin(j);
      break;
    }
    case 'sync-pair': {
      const c = loadSyncConfig();
      if (c) {
        showLink({
          title: 'Подключить другое устройство',
          desc: 'Откройте ссылку или отсканируйте QR-код на другом устройстве — оно начнёт синхронизироваться с этим. В ссылке ключ и токен: не пересылайте её чужим.',
          url: pairingLink(c),
          size: '',
        });
      }
      break;
    }
    case 'sync-off':
      if (!confirm('Отключить синхронизацию на этом устройстве? Данные останутся здесь и в общем файле.')) return;
      saveSyncConfig(null);
      sync.run();
      renderSettings();
      toast('Синхронизация отключена');
      break;
    case 'pair-apply': {
      let c;
      try { c = parsePairing($('#pairIn').value); } catch { toast('Не похоже на ссылку подключения'); return; }
      await askPair(c);
      break;
    }
    case 'sync-setup': {
      const c = {
        repo: $('#syncRepo').value.trim().replace(/^https:\/\/github\.com\//, '').replace(/\/+$/, ''),
        path: $('#syncPath').value.trim() || DEFAULT_PATH,
        token: $('#syncToken').value.trim(),
        key: newKey(),
      };
      if (!validConfig(c)) { toast('Проверьте репозиторий, имя файла и токен'); return; }
      btn.disabled = true;
      try {
        // Refuse to start a second, incompatible key over existing data.
        if (await getRemote(c).catch((e) => { if (e.kind === 'key' || e.kind === 'format') return 'taken'; throw e; }) === 'taken') {
          toast('В этом файле уже есть данные с другим ключом — подключите устройство по ссылке с того, где синхронизация уже работает');
          return;
        }
      } catch (e) {
        toast(e.message);
        return;
      } finally {
        btn.disabled = false;
      }
      await enableSync(c);
      break;
    }
    case 'install': doInstall(); break;
    case 'reset-all':
      if (!confirm('Удалить все события и вернуть настройки по умолчанию?')) return;
      state = replaceWith(state, defaultState());
      commit();
      toast('Всё сброшено');
      break;
    default:
  }
});

// ---------- Share / import ----------

let qrLoading = null;
function loadQr() {
  if (window.qrcode) return Promise.resolve(window.qrcode);
  if (!qrLoading) {
    qrLoading = new Promise((res, rej) => {
      const sc = document.createElement('script');
      sc.src = 'js/vendor/qrcode.js';
      sc.onload = () => res(window.qrcode);
      sc.onerror = rej;
      document.head.appendChild(sc);
    });
  }
  return qrLoading;
}

// Shared calendars (their keys and tokens) go into the transfer link only when asked for.
let shareSel = null; // ids of the shared calendars to include; null = none

async function openShare(keepChoice = false) {
  if (!keepChoice) shareSel = null;
  const cals = shareSel ? state.cals.filter((m) => shareSel.has(m.id)) : [];
  const code = await encodeShare({ ...state, cals });
  const url = shareUrl(code);
  const n = state.events.length;
  await showLink({
    title: 'Перенести на другое устройство',
    desc: 'Откройте эту ссылку на телефоне или другом компьютере — события и настройки применятся там. Можно отсканировать QR-код камерой.',
    url,
    size: `${n} ${plural(n, 'событие', 'события', 'событий')}${cals.length ? ` · ${cals.length} ${plural(cals.length, 'общий календарь', 'общих календаря', 'общих календарей')}` : ''} · ${url.length} символов`,
    keepOpts: true,
  });
  renderShareOpts();
}

function renderShareOpts() {
  $('#shareOpts').hidden = !state.cals.length;
  $('#shareCals').checked = !!shareSel;
  const chips = $('#shareCalChips');
  chips.hidden = !shareSel;
  chips.innerHTML = shareSel ? state.cals.map((m) => {
    const on = shareSel.has(m.id);
    const s = shared.get(m.id) || {};
    return `<button type="button" class="cal-chip shared" data-cal="${esc(m.id)}" aria-pressed="${on}" style="--c:${s.color || COLORS[1]}">
      <i aria-hidden="true">${on ? '✓' : ''}</i>${esc(calName(m.id))}</button>`;
  }).join('') : '';
  const picked = shareSel ? state.cals.filter((m) => shareSel.has(m.id)).map((m) => calName(m.id)) : [];
  const note = $('#shareCalNote');
  note.hidden = !picked.length;
  if (picked.length) {
    note.innerHTML = `🔑 <b>В ссылке будут ключи и токены ${picked.length > 1 ? 'календарей' : 'календаря'} ${esc(quoteList(picked))}.</b> Кто её увидит, сможет читать и менять ${picked.length > 1 ? 'эти календари' : 'этот календарь'}. Отправляйте только себе.`;
  }
}

$('#shareCals').addEventListener('change', (e) => {
  shareSel = e.target.checked ? new Set(state.cals.map((m) => m.id)) : null;
  openShare(true);
});

$('#shareCalChips').addEventListener('click', (e) => {
  const b = e.target.closest('.cal-chip');
  if (!b || !shareSel) return;
  const id = b.dataset.cal;
  if (shareSel.has(id)) shareSel.delete(id); else shareSel.add(id);
  openShare(true);
});

/** The link dialog with a QR code (used for sharing data and for pairing devices). */
async function showLink({ title, desc, url, size, keepOpts = false }) {
  if (!keepOpts) $('#shareOpts').hidden = true; // the shared-calendar choice belongs to the transfer link only
  setText($('#shareTitle'), title);
  setText($('#shareDesc'), desc);
  $('#shareLink').value = url;
  setText($('#shareSize'), size);
  $('#nativeShare').hidden = !navigator.share;
  $('#qr').innerHTML = '';
  if (!$('#shareDlg').open) $('#shareDlg').showModal();
  try {
    const qrcode = await loadQr();
    const q = qrcode(0, url.length > 1800 ? 'L' : 'M');
    q.addData(url);
    q.make();
    $('#qr').innerHTML = q.createSvgTag({ cellSize: 4, margin: 4, scalable: true, alt: 'QR-код ссылки' });
  } catch {
    $('#qr').innerHTML = '<p class="muted small">Слишком много данных для QR-кода — используйте ссылку.</p>';
  }
}

$('#copyLink').addEventListener('click', async () => {
  const inp = $('#shareLink');
  try {
    await navigator.clipboard.writeText(inp.value);
  } catch {
    inp.select();
    document.execCommand('copy');
  }
  toast('Ссылка скопирована');
});

$('#nativeShare').addEventListener('click', () => {
  navigator.share({ title: 'Календарь', text: $('#shareTitle').textContent, url: $('#shareLink').value }).catch(() => {});
});

let pendingImport = null;

function askImport(inc) {
  pendingImport = inc;
  const n = inc.events.length;
  const pays = inc.paydays.map((p) => `${p.title || 'выплата'} ${p.day}-го`).join(', ');
  const ov = Object.keys(inc.overrides).length;
  const k = inc.cals.length;
  $('#impSummary').innerHTML = `В ссылке: <b>${n} ${plural(n, 'событие', 'события', 'событий')}</b>`
    + `${pays ? `, выплаты: ${esc(pays)}` : ''}${ov ? `, ${ov} ${plural(ov, 'изменённый день', 'изменённых дня', 'изменённых дней')}` : ''}`
    + `${k ? `, <b>доступ к ${k} ${plural(k, 'общему календарю', 'общим календарям', 'общим календарям')}</b>` : ''} и настройки.`;
  if ($('#setDlg').open) $('#setDlg').close();
  $('#impDlg').showModal();
}

function finishImport(next, msg) {
  state = next;
  pendingImport = null;
  $('#impDlg').close();
  commit();
  toast(msg);
}

$('#impMerge').addEventListener('click', () => pendingImport && finishImport(mergeStates(state, pendingImport), 'Данные объединены'));
// Replacing keeps this device's shared calendars: a link without them must not make it leave them.
$('#impReplace').addEventListener('click', () => {
  if (!pendingImport) return;
  const cals = new Map(state.cals.map((m) => [m.id, m]));
  for (const m of pendingImport.cals) cals.set(m.id, m);
  finishImport(replaceWith(state, { ...pendingImport, cals: [...cals.values()] }), 'Данные заменены');
});

function clearHash() {
  history.replaceState(null, '', location.pathname + location.search);
}

async function checkHash() {
  if (location.hash.includes(`${JOIN_PARAM}=`)) {
    const h = location.hash;
    clearHash(); // holds a key and a token
    let j;
    try { j = parseJoin(h); } catch { toast('Приглашение повреждено или неполное'); return; }
    await askJoin(j);
    return;
  }
  if (location.hash.includes(`${SYNC_PARAM}=`)) {
    const h = location.hash;
    clearHash(); // the link holds the key and the token: do not leave it in the address bar
    let c;
    try { c = parsePairing(h); } catch { toast('Ссылка подключения повреждена или неполная'); return; }
    await askPair(c);
    return;
  }
  if (!location.hash.includes(`${SHARE_PARAM}=`)) return;
  const h = location.hash;
  clearHash();
  try {
    askImport(await decodeShare(h));
  } catch {
    toast('Ссылка повреждена или неполная');
  }
}

// ---------- Install ----------

function updateInstallBtn() {
  $('#installBtn').hidden = !window.__installPrompt || isStandalone();
}

async function doInstall() {
  const p = window.__installPrompt;
  if (!p) return;
  p.prompt();
  try { await p.userChoice; } catch { /* ignore */ }
  window.__installPrompt = null;
  updateInstallBtn();
  if ($('#setDlg').open) renderSettings();
}

window.addEventListener('installable', () => { updateInstallBtn(); if ($('#setDlg').open) renderSettings(); });
$('#installBtn').addEventListener('click', doInstall);

// ---------- Toast ----------

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

// ---------- Global events ----------

document.addEventListener('click', (e) => {
  const closeBtn = e.target.closest('[data-close]');
  if (closeBtn) { closeBtn.closest('dialog').close(); return; }
  if (e.target.tagName === 'DIALOG') { e.target.close(); return; }

  const cell = e.target.closest('.cell');
  if (cell) {
    const d = parseYmd(cell.dataset.day);
    if (cell.classList.contains('sel') && e.detail === 2) { openEvent(null, d); return; }
    selectDay(d);
    if (matchMedia('(max-width: 899px)').matches) $('#day').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return;
  }
  const btn = e.target.closest('[data-act]');
  if (!btn || btn.closest('#setBody')) return;
  switch (btn.dataset.act) {
    case 'prev': shiftMonth(-1); break;
    case 'next': shiftMonth(1); break;
    case 'today': selectDay(now); break;
    case 'new-event': openEvent(null, startOfDay(now)); break;
    case 'new-event-day': openEvent(null, selected); break;
    case 'edit': openEvent(findEvent(btn.dataset.id)); break;
    case 'clock-mode':
      state.settings.clock24 = !state.settings.clock24;
      touchSettings();
      commit({ keepSettings: true });
      break;
    case 'today-more':
      todayExpanded = !todayExpanded;
      uiPrefs.todayExpanded = todayExpanded;
      saveUi();
      renderToday();
      break;
    case 'cd-more':
      cdAll = !cdAll;
      renderCountdowns();
      break;
    case 'cd': {
      const id = btn.dataset.id;
      if (id.startsWith('ev:')) openEvent(findEvent(id.slice(3)));
      else selectDay(parseYmd(btn.dataset.day), { scroll: true });
      break;
    }
    case 'toggle-off': {
      const inf = cal.info(selected);
      const want = inf.off ? 'work' : 'off';
      if ((want === 'off') === inf.base) delete state.overrides[inf.key];
      else state.overrides[inf.key] = want;
      state.overridesU[inf.key] = Date.now();
      commit();
      break;
    }
    case 'reset-day':
      delete state.overrides[ymd(selected)];
      state.overridesU[ymd(selected)] = Date.now();
      commit();
      break;
    default:
  }
});

$('#addBtn').addEventListener('click', () => openEvent(null, selected));
$('#shareBtn').addEventListener('click', () => openShare());
$('#settingsBtn').addEventListener('click', () => { renderSettings(); $('#setDlg').showModal(); });

document.addEventListener('keydown', (e) => {
  if (document.querySelector('dialog[open]')) return;
  if (e.target.closest('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'ArrowLeft') shiftMonth(-1);
  else if (e.key === 'ArrowRight') shiftMonth(1);
  else if (e.key === 't' || e.key === 'е') selectDay(now);
  else if (e.key === 'n' || e.key === 'т') { e.preventDefault(); openEvent(null, selected); }
});

// Swipe months on touch screens
(() => {
  const g = $('#grid');
  let sx = 0;
  let sy = 0;
  let st = 0;
  g.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    sx = t.clientX; sy = t.clientY; st = Date.now();
  }, { passive: true });
  g.addEventListener('touchend', (e) => {
    const t = e.changedTouches[0];
    const dx = t.clientX - sx;
    const dy = t.clientY - sy;
    if (Date.now() - st < 600 && Math.abs(dx) > 50 && Math.abs(dy) < Math.abs(dx) * 0.6) shiftMonth(dx < 0 ? 1 : -1);
  }, { passive: true });
})();

// Other tabs / windows
window.addEventListener('storage', (e) => {
  if (e.key && e.key.startsWith('good-calendar:cal:')) {
    const id = e.key.slice('good-calendar:cal:'.length);
    if (shared.has(id)) { shared.set(id, loadShared(id) || emptyShared(id)); refreshCal(); renderAll(); }
    return;
  }
  if (e.key !== STORAGE_KEY) return;
  state = load();
  ensureMembers();
  refreshCal();
  renderAll();
});

matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', applyTheme);
window.addEventListener('hashchange', checkHash);

// ---------- Clock ----------

let timer;
function tick() {
  clearTimeout(timer);
  const prev = todayKey;
  now = new Date();
  todayKey = ymd(now);
  if (todayKey !== prev) {
    if (ymd(selected) === prev) selected = startOfDay(now);
    refreshCal();
    renderAll();
  } else {
    tickToday();
    tickBigClock();
    tickMiniClock();
    tickTodayCell();
    renderCountdowns();
  }
  timer = setTimeout(tick, 1000 - (Date.now() % 1000) + 20);
}

let lastSyncRun = 0;
function syncSoon() {
  // on returning to the app; not more often than every 20 seconds
  if (Date.now() - lastSyncRun < 20e3) return;
  lastSyncRun = Date.now();
  syncAll();
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  tick();
  syncSecondHand();
  checkForUpdate();
  syncSoon();
});

// ---------- Full screen ----------

const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement || null;
const fsSupported = !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);

function toggleFullscreen() {
  const el = document.documentElement;
  if (fsElement()) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  else {
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    Promise.resolve(req.call(el, { navigationUI: 'hide' })).catch(() => toast('Браузер не разрешил полный экран'));
  }
}

function updateFsBtn() {
  const on = !!fsElement();
  const b = $('#fsBtn');
  b.querySelector('.fs-on').hidden = on;
  b.querySelector('.fs-off').hidden = !on;
  b.title = on ? 'Выйти из полного экрана (F)' : 'На весь экран (F)';
  b.setAttribute('aria-label', on ? 'Выйти из полного экрана' : 'На весь экран');
}

$('#fsBtn').hidden = !fsSupported;
$('#fsBtn').addEventListener('click', toggleFullscreen);
document.addEventListener('fullscreenchange', updateFsBtn);
document.addEventListener('webkitfullscreenchange', updateFsBtn);
document.addEventListener('keydown', (e) => {
  if (!fsSupported || document.querySelector('dialog[open]')) return;
  if (e.target.closest('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'f' || e.key === 'а') toggleFullscreen();
});

// ---------- Updates ----------
// The server's js/version.js is compared with the running one; a newer one is offered.

const verNum = (v) => String(v).split('.').map((x) => parseInt(x, 10) || 0);
function isNewer(a, b) {
  const x = verNum(a);
  const y = verNum(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  }
  return false;
}

let lastCheck = 0;
let dismissed = '';

async function checkForUpdate(force = false) {
  if (!force && Date.now() - lastCheck < 5 * 60e3) return;
  if (!navigator.onLine) return;
  lastCheck = Date.now();
  try {
    const res = await fetch(`js/version.js?check=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return;
    const m = (await res.text()).match(/VERSION\s*=\s*'([\d.]+)'/);
    if (!m || !isNewer(m[1], VERSION) || m[1] === dismissed) return;
    setText($('#updateText'), `Новая версия ${m[1]}`);
    $('#updateBar').hidden = false;
    $('#updateBar').dataset.ver = m[1];
  } catch { /* offline or blocked: try later */ }
}

$('#updateBtn').addEventListener('click', async () => {
  $('#updateBtn').disabled = true;
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    await reg?.update();
  } catch { /* reload anyway */ }
  location.reload();
});
$('#updateClose').addEventListener('click', () => {
  dismissed = $('#updateBar').dataset.ver || '';
  $('#updateBar').hidden = true;
});
setInterval(() => checkForUpdate(true), 30 * 60e3);
window.addEventListener('online', () => { checkForUpdate(true); syncAll(); });
setInterval(() => { if (!document.hidden) syncAll(); }, 5 * 60e3);
setTimeout(() => { lastSyncRun = Date.now(); syncAll(); }, 800);

renderAll();
updateInstallBtn();
updateFsBtn();
tick();
checkHash();
setTimeout(() => checkForUpdate(true), 3000);
