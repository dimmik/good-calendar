// Shared calendars: a set of events kept in its own encrypted file (its own key), so that the
// people in one calendar cannot read another. Membership (where the file is and the key) lives in
// the personal state (`state.cals`) and travels with it between one's own devices; the events
// of each calendar are cached on the device under their own storage key.

import { sanitizeEvent, b64u, COLORS, sanitizeMember } from './store.js';

export const JOIN_PARAM = 'join';
const PREFIX = 'good-calendar:cal:';
const reId = /^[A-Za-z0-9_-]{1,40}$/;
const reColor = /^#[0-9a-fA-F]{6}$/;

export function emptyShared(id, name = 'Общий календарь', color = COLORS[1], metaU = 0) {
  return { v: 1, id, name, color, metaU, events: [], deleted: {} };
}

export function normalizeShared(raw, id) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim().slice(0, 40) : 'Общий календарь';
  const color = typeof r.color === 'string' && reColor.test(r.color) ? r.color : COLORS[1];
  const events = Array.isArray(r.events) ? r.events.slice(0, 2000).map(sanitizeEvent).filter(Boolean) : [];
  const deleted = {};
  if (r.deleted && typeof r.deleted === 'object') {
    const ent = Object.entries(r.deleted).filter(([k, v]) => reId.test(k) && Number.isFinite(v));
    ent.sort((a, b) => b[1] - a[1]);
    for (const [k, v] of ent.slice(0, 500)) deleted[k] = v;
  }
  return {
    v: 1, id: typeof r.id === 'string' && reId.test(r.id) ? r.id : id,
    name, color, metaU: Number.isFinite(r.metaU) ? r.metaU : 0, events, deleted,
  };
}

/** What goes into the file. */
export function packShared(s) {
  const { id, name, color, metaU, events, deleted } = s;
  return { app: 'good-calendar-shared', v: 1, id, name, color, metaU, events, deleted };
}

export function mergeShared(mine, inc) {
  const deleted = { ...mine.deleted };
  for (const [k, v] of Object.entries(inc.deleted || {})) deleted[k] = Math.max(deleted[k] || 0, v);
  const m = new Map(mine.events.map((x) => [x.id, x]));
  for (const x of inc.events) {
    const cur = m.get(x.id);
    if (!cur || (x.u || 0) >= (cur.u || 0)) m.set(x.id, x);
  }
  const events = [...m.values()].filter((x) => !(deleted[x.id] && deleted[x.id] >= (x.u || 0)));
  const meta = (inc.metaU || 0) >= (mine.metaU || 0) ? inc : mine;
  return normalizeShared({
    id: mine.id, name: meta.name, color: meta.color, metaU: Math.max(mine.metaU || 0, inc.metaU || 0), events, deleted,
  }, mine.id);
}

export function canonicalShared(s) {
  const ev = [...s.events].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((e) => Object.keys(e).sort().map((k) => [k, e[k]]));
  const del = Object.keys(s.deleted).sort().map((k) => [k, s.deleted[k]]);
  return JSON.stringify([s.name, s.color, s.metaU, ev, del]);
}

// ---- Device cache ----

export function loadShared(id) {
  try {
    const raw = localStorage.getItem(PREFIX + id);
    return raw ? normalizeShared(JSON.parse(raw), id) : null;
  } catch {
    return null;
  }
}

export function saveShared(s) {
  try { localStorage.setItem(PREFIX + s.id, JSON.stringify(s)); } catch { /* storage unavailable */ }
}

export function removeShared(id) {
  try { localStorage.removeItem(PREFIX + id); } catch { /* storage unavailable */ }
}

// ---- Invitations ----

/** A link that adds this calendar on another device: its file, token, key and current name/colour. */
export function joinLink(member, meta) {
  const o = { i: member.id, r: member.repo, p: member.path, t: member.token, k: member.key, n: meta.name, c: meta.color };
  const u = new URL(location.href);
  u.search = '';
  u.hash = `${JOIN_PARAM}=${b64u.enc(new TextEncoder().encode(JSON.stringify(o)))}`;
  return u.href;
}

/** { member, name, color } from a whole link or its code. Throws on garbage. */
export function parseJoin(input) {
  const s = String(input || '').trim();
  const m = s.match(new RegExp(`[#&?]${JOIN_PARAM}=([A-Za-z0-9_-]+)`));
  const code = m ? m[1] : s;
  if (!/^[A-Za-z0-9_-]{40,3000}$/.test(code)) throw new Error('bad invitation');
  const o = JSON.parse(new TextDecoder().decode(b64u.dec(code)));
  const member = sanitizeMember({ id: o.i, repo: o.r, path: o.p, token: o.t, key: o.k, u: 0 });
  if (!member) throw new Error('bad invitation');
  const meta = normalizeShared({ name: o.n, color: o.c }, member.id);
  return { member, name: meta.name, color: meta.color };
}
