// State: load/save to localStorage, validation, share-link encoding and merging.

const KEY = 'good-calendar:v1';

export const COLORS = ['#4f5bd5', '#e5534b', '#2f9e5b', '#e09b19', '#c64fbf', '#2a9bb7', '#7a7f8c'];
const REPEATS = ['none', 'yearly', 'monthly', 'weekly'];
const SHIFTS = ['before', 'after', 'none'];
const BUILTINS = ['payday', 'weekend', 'workday', 'holiday', 'newyear'];

export function defaultState() {
  return {
    v: 1,
    events: [],
    paydays: [{ id: 'salary', title: 'Зарплата', day: 5, shift: 'before', u: 0 }],
    overrides: {},
    deleted: {},
    settings: {
      country: 'ru',
      workStart: '09:00',
      workEnd: '18:00',
      builtins: { payday: true, weekend: true, workday: true, holiday: true, newyear: true },
      weekNumbers: false,
      theme: 'auto',
    },
  };
}

export const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

const isStr = (v, max) => typeof v === 'string' && v.length <= max;
const reDate = /^\d{4}-\d{2}-\d{2}$/;
const reTime = /^([01]\d|2[0-3]):[0-5]\d$/;
const reId = /^[A-Za-z0-9_-]{1,40}$/;
const reColor = /^#[0-9a-fA-F]{6}$/;

function firstGrapheme(s) {
  if (!s) return '';
  try {
    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
      const it = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)[Symbol.iterator]().next();
      return it.done ? '' : it.value.segment.slice(0, 16);
    }
  } catch { /* fall through */ }
  return Array.from(s).slice(0, 2).join('');
}

export function sanitizeEvent(e) {
  if (!e || typeof e !== 'object') return null;
  if (!isStr(e.id, 40) || !reId.test(e.id)) return null;
  if (!isStr(e.date, 10) || !reDate.test(e.date) || Number.isNaN(new Date(e.date).getTime())) return null;
  const title = isStr(e.title, 400) ? e.title.trim().slice(0, 120) : '';
  if (!title) return null;
  return {
    id: e.id,
    title,
    date: e.date,
    time: isStr(e.time, 5) && reTime.test(e.time) ? e.time : '',
    repeat: REPEATS.includes(e.repeat) ? e.repeat : 'none',
    color: isStr(e.color, 7) && reColor.test(e.color) ? e.color : COLORS[0],
    emoji: isStr(e.emoji, 64) ? firstGrapheme(e.emoji.trim()) : '',
    countdown: e.countdown !== false,
    u: Number.isFinite(e.u) ? e.u : 0,
  };
}

function sanitizePayday(p) {
  if (!p || typeof p !== 'object') return null;
  if (!isStr(p.id, 40) || !reId.test(p.id)) return null;
  const day = Math.round(Number(p.day));
  if (!(day >= 1 && day <= 31)) return null;
  return {
    id: p.id,
    title: isStr(p.title, 200) ? p.title.trim().slice(0, 60) : '',
    day,
    shift: SHIFTS.includes(p.shift) ? p.shift : 'before',
    u: Number.isFinite(p.u) ? p.u : 0,
  };
}

/** Turn anything (stored or received in a link) into a valid state. */
export function normalize(raw) {
  const d = defaultState();
  if (!raw || typeof raw !== 'object') return d;
  const s = raw.settings && typeof raw.settings === 'object' ? raw.settings : {};
  const settings = { ...d.settings };
  if (s.country === 'ru' || s.country === 'none') settings.country = s.country;
  if (isStr(s.workStart, 5) && reTime.test(s.workStart)) settings.workStart = s.workStart;
  if (isStr(s.workEnd, 5) && reTime.test(s.workEnd)) settings.workEnd = s.workEnd;
  if (typeof s.weekNumbers === 'boolean') settings.weekNumbers = s.weekNumbers;
  if (['auto', 'light', 'dark'].includes(s.theme)) settings.theme = s.theme;
  settings.builtins = { ...d.settings.builtins };
  if (s.builtins && typeof s.builtins === 'object') {
    for (const k of BUILTINS) if (typeof s.builtins[k] === 'boolean') settings.builtins[k] = s.builtins[k];
  }

  const events = Array.isArray(raw.events) ? raw.events.slice(0, 2000).map(sanitizeEvent).filter(Boolean) : [];
  const paydays = Array.isArray(raw.paydays) ? raw.paydays.slice(0, 20).map(sanitizePayday).filter(Boolean) : d.paydays;

  const overrides = {};
  if (raw.overrides && typeof raw.overrides === 'object') {
    for (const [k, v] of Object.entries(raw.overrides).slice(0, 5000)) {
      if (reDate.test(k) && (v === 'off' || v === 'work')) overrides[k] = v;
    }
  }
  const deleted = {};
  if (raw.deleted && typeof raw.deleted === 'object') {
    const ent = Object.entries(raw.deleted).filter(([k, v]) => reId.test(k) && Number.isFinite(v));
    ent.sort((a, b) => b[1] - a[1]);
    for (const [k, v] of ent.slice(0, 200)) deleted[k] = v;
  }
  return { v: 1, events, paydays, overrides, deleted, settings };
}

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return normalize(JSON.parse(raw));
  } catch { /* private mode or broken data */ }
  return defaultState();
}

export function save(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export const STORAGE_KEY = KEY;

/**
 * Merge `inc` into `mine`: newer edit of the same item wins, deletions travel along
 * (tombstones), settings and day overrides are taken from the incoming state.
 */
export function mergeStates(mine, inc) {
  const deleted = { ...mine.deleted };
  for (const [k, v] of Object.entries(inc.deleted)) deleted[k] = Math.max(deleted[k] || 0, v);
  const mergeList = (a, b) => {
    const m = new Map(a.map((x) => [x.id, x]));
    for (const x of b) {
      const cur = m.get(x.id);
      if (!cur || (x.u || 0) >= (cur.u || 0)) m.set(x.id, x);
    }
    return [...m.values()].filter((x) => !(deleted[x.id] && deleted[x.id] >= (x.u || 0)));
  };
  return normalize({
    v: 1,
    events: mergeList(mine.events, inc.events),
    paydays: mergeList(mine.paydays, inc.paydays),
    overrides: { ...mine.overrides, ...inc.overrides },
    deleted,
    settings: inc.settings,
  });
}

// ---- Share links ----

function b64uEnc(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64uDec(str) {
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pipe(bytes, stream) {
  const res = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await res.arrayBuffer());
}

export const SHARE_PARAM = 'import';

export async function encodeShare(state) {
  const { events, paydays, overrides, deleted, settings } = state;
  const json = JSON.stringify({ v: 1, events, paydays, overrides, deleted, settings });
  const bytes = new TextEncoder().encode(json);
  if (typeof CompressionStream === 'function') {
    try {
      return `1z${b64uEnc(await pipe(bytes, new CompressionStream('deflate-raw')))}`;
    } catch { /* fall back to plain */ }
  }
  return `1j${b64uEnc(bytes)}`;
}

/** Accepts a whole link or just the code. Throws on garbage. */
export async function decodeShare(input) {
  let code = String(input || '').trim();
  const m = code.match(new RegExp(`[#&?]${SHARE_PARAM}=([A-Za-z0-9_-]+)`));
  if (m) code = m[1];
  if (!/^1[zj][A-Za-z0-9_-]+$/.test(code) || code.length > 200000) throw new Error('bad code');
  let bytes = b64uDec(code.slice(2));
  if (code[1] === 'z') {
    if (typeof DecompressionStream !== 'function') throw new Error('no decompression');
    bytes = await pipe(bytes, new DecompressionStream('deflate-raw'));
  }
  if (bytes.length > 2_000_000) throw new Error('too big');
  return normalize(JSON.parse(new TextDecoder().decode(bytes)));
}

export function shareUrl(code) {
  const u = new URL(location.href);
  u.search = '';
  u.hash = `${SHARE_PARAM}=${code}`;
  return u.href;
}
