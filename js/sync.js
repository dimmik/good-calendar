// Sync between devices without a backend: the shared data is encrypted in the browser
// (AES-256-GCM, WebCrypto) and kept as one file in a GitHub repository, written through the
// GitHub Contents API. The key never leaves the devices; GitHub only ever sees ciphertext.
//
// One run: GET the file (remember its sha) → decrypt → merge with the local state → if the
// merge differs from the file, encrypt and PUT it with that sha. A 409/422 means another
// device wrote first: start over (at most a few times).

import { normalize, mergeStates, canonical, shareable, b64u } from './store.js';

const CFG_KEY = 'good-calendar:sync';
export const SYNC_PARAM = 'sync';
export const DEFAULT_PATH = 'calendar.enc';

export class SyncError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

// ---------- Config (per device; never part of shared data, links or exports) ----------

const reRepo = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const rePath = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/;

export function validConfig(c) {
  return !!c && typeof c === 'object'
    && typeof c.repo === 'string' && reRepo.test(c.repo)
    && typeof c.path === 'string' && rePath.test(c.path)
    && typeof c.token === 'string' && /^[A-Za-z0-9_]{20,255}$/.test(c.token)
    && typeof c.key === 'string' && /^[A-Za-z0-9_-]{43}$/.test(c.key);
}

export function loadSyncConfig() {
  try {
    const c = JSON.parse(localStorage.getItem(CFG_KEY) || 'null');
    return validConfig(c) ? c : null;
  } catch {
    return null;
  }
}

export function saveSyncConfig(c) {
  try {
    if (c) localStorage.setItem(CFG_KEY, JSON.stringify(c));
    else localStorage.removeItem(CFG_KEY);
  } catch { /* storage unavailable */ }
}

export const newKey = () => b64u.enc(crypto.getRandomValues(new Uint8Array(32)));

/** A link that connects another device: repository, file, token and key in the URL hash. */
export function pairingLink(c) {
  const payload = b64u.enc(new TextEncoder().encode(JSON.stringify({ r: c.repo, p: c.path, t: c.token, k: c.key })));
  const u = new URL(location.href);
  u.search = '';
  u.hash = `${SYNC_PARAM}=${payload}`;
  return u.href;
}

/** Accepts the whole link or just its code. Throws on garbage. */
export function parsePairing(input) {
  const s = String(input || '').trim();
  const m = s.match(new RegExp(`[#&?]${SYNC_PARAM}=([A-Za-z0-9_-]+)`));
  const code = m ? m[1] : s;
  if (!/^[A-Za-z0-9_-]{40,2000}$/.test(code)) throw new Error('bad pairing code');
  const o = JSON.parse(new TextDecoder().decode(b64u.dec(code)));
  const c = { repo: o.r, path: o.p || DEFAULT_PATH, token: o.t, key: o.k };
  if (!validConfig(c)) throw new Error('bad pairing code');
  return c;
}

// ---------- Encryption ----------

const aesKey = (k) => crypto.subtle.importKey('raw', b64u.dec(k), 'AES-GCM', false, ['encrypt', 'decrypt']);

export const encryptState = (c, state) => encryptJson(c, shareable(state));
export const decryptState = async (c, text) => normalize(await decryptJson(c, text));

export async function encryptJson(c, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(obj));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(c.key), data));
  return JSON.stringify({ app: 'good-calendar', v: 1, alg: 'A256GCM', iv: b64u.enc(iv), ct: b64u.enc(ct) });
}

export async function decryptJson(c, text) {
  let env;
  try {
    env = JSON.parse(text);
  } catch {
    throw new SyncError('format', 'В файле синхронизации не то, что ожидалось');
  }
  if (!env || env.alg !== 'A256GCM' || typeof env.iv !== 'string' || typeof env.ct !== 'string') {
    throw new SyncError('format', 'В файле синхронизации не то, что ожидалось');
  }
  let plain;
  try {
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64u.dec(env.iv) }, await aesKey(c.key), b64u.dec(env.ct));
  } catch {
    throw new SyncError('key', 'Файл зашифрован другим ключом — подключите устройство по ссылке с того, где синхронизация уже работает');
  }
  return JSON.parse(new TextDecoder().decode(plain));
}

// ---------- GitHub ----------

async function gh(c, method, body) {
  const path = c.path.split('/').map(encodeURIComponent).join('/');
  const headers = {
    Authorization: `Bearer ${c.token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (body) headers['Content-Type'] = 'application/json';
  try {
    return await fetch(`https://api.github.com/repos/${c.repo}/contents/${path}`, {
      method, headers, cache: 'no-store', body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new SyncError('net', 'Нет связи с GitHub');
  }
}

function httpError(res) {
  if (res.status === 401) return new SyncError('auth', 'GitHub не принял токен: он неверный или истёк');
  if (res.status === 403 || res.status === 404) {
    return new SyncError('perm', 'Нет доступа к репозиторию: проверьте его имя и права токена (Contents: Read and write)');
  }
  return new SyncError('http', `GitHub ответил ошибкой ${res.status}`);
}

/** The remote file as { sha, state }, or null when there is no file yet. */
export async function getRemote(c, unpack = normalize) {
  const res = await gh(c, 'GET');
  if (res.status === 404) return null; // no file yet (if the repo itself is inaccessible, PUT will say so)
  if (!res.ok) throw httpError(res);
  const j = await res.json();
  if (typeof j.content !== 'string') throw new SyncError('format', 'В файле синхронизации не то, что ожидалось');
  const text = atob(j.content.replace(/\s/g, ''));
  return { sha: j.sha, state: unpack(await decryptJson(c, text)) };
}

/** The new sha when written, null when someone else wrote first (sha mismatch) or GitHub stumbled. */
async function putRemote(c, packed, sha) {
  const body = { message: `sync ${new Date().toISOString()}`, content: btoa(await encryptJson(c, packed)) };
  if (sha) body.sha = sha;
  const res = await gh(c, 'PUT', body);
  // 409/422: someone wrote first; 5xx: GitHub sometimes fails commits that follow each other closely
  if (res.status === 409 || res.status === 422 || res.status >= 500) return null;
  if (!res.ok) throw httpError(res);
  try { return (await res.json()).content.sha || 'written'; } catch { return 'written'; }
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Engine ----------

/**
 * One synced file. Defaults are the personal calendar; shared calendars pass their own config,
 * merge and (un)packing.
 */
export function createSync({
  getState, setState, onStatus = () => {},
  getConfig = loadSyncConfig, saveConfig = saveSyncConfig,
  merge = mergeStates, canon = canonical, pack = shareable, unpack = normalize,
}) {
  let running = null;
  let again = false;
  let timer = null;
  let status = { state: getConfig() ? 'idle' : 'off' };
  // Right after a write GitHub may still serve the version it replaced for a few seconds:
  // remember what was replaced, so that a stale read is waited out instead of fought with.
  let replaced = null;

  const report = (s) => {
    status = s;
    onStatus(s);
  };

  async function once() {
    const c = getConfig();
    if (!c) { report({ state: 'off' }); return; }
    report({ state: 'syncing' });
    try {
      for (let attempt = 0; ; attempt++) {
        let remote = await getRemote(c, unpack);
        for (let i = 0; remote && replaced && remote.sha === replaced && i < 4; i++) {
          await pause(1500 * (i + 1));
          remote = await getRemote(c, unpack);
        }
        const local = getState();
        const merged = remote ? merge(local, remote.state) : unpack(pack(local));
        if (canon(merged) !== canon(local)) setState(merged);
        if (remote && canon(merged) === canon(remote.state)) break;
        const written = await putRemote(c, pack(merged), remote && remote.sha);
        if (written) { replaced = remote && remote.sha; break; }
        if (attempt >= 4) throw new SyncError('busy', 'Файл всё время меняется другим устройством, попробую позже');
        await pause(1000 * 2 ** attempt); // 1, 2, 4, 8 s: let the other write settle
      }
      const at = Date.now();
      saveConfig({ ...c, lastSync: at });
      report({ state: 'ok', at });
    } catch (e) {
      report({ state: 'error', kind: e.kind || 'unknown', error: e.message || String(e), at: Date.now() });
    }
  }

  /** Sync now; if a run is in progress, run once more after it. */
  async function run() {
    clearTimeout(timer);
    if (running) { again = true; return running; }
    running = once();
    try {
      await running;
    } finally {
      running = null;
      if (again) { again = false; run(); }
    }
    return undefined;
  }

  return {
    run,
    /** Debounced sync after local changes. */
    schedule(ms = 2000) {
      if (!getConfig()) return;
      clearTimeout(timer);
      timer = setTimeout(run, ms);
    },
    status: () => status,
  };
}
