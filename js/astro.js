// Astronomy without a network: sunrise/sunset/twilight and Mercury retrograde periods.
// Accuracy is about a minute for the Sun and within a day for Mercury's stations.

import { startOfDay, addDays } from './dates.js';

const RAD = Math.PI / 180;
const J2000 = 2451545;
const jd = (t) => +t / 864e5 + 2440587.5;
const fromJd = (j) => new Date((j - 2440587.5) * 864e5);
const mod360 = (x) => ((x % 360) + 360) % 360;

/** Default places by calendar country (when the user has not set coordinates). */
export const PLACES = {
  rs: { lat: 44.8125, lon: 20.4612, name: 'Белград' },
  ru: { lat: 55.7558, lon: 37.6173, name: 'Москва' },
  none: { lat: 44.8125, lon: 20.4612, name: 'Белград' },
};

export function placeOf(settings) {
  const g = settings.geo;
  if (g && Number.isFinite(g.lat) && Number.isFinite(g.lon)) return { lat: g.lat, lon: g.lon, name: g.name || '' };
  return PLACES[settings.country] || PLACES.rs;
}

/**
 * Sun events of a local calendar day (sunrise equation).
 * Returns { dawn, sunrise, sunset, dusk } (civil twilight: Sun 6° below the horizon) as Dates;
 * a field is null when the Sun does not cross that altitude that day; `polar` is 'day' or 'night'
 * when it stays above / below the horizon.
 */
export function sunTimes(day, lat, lon) {
  const noon = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 12);
  const lw = -lon;
  const n = Math.round(jd(noon) - J2000 - 0.0009 - lw / 360);
  const jStar = J2000 + 0.0009 + lw / 360 + n;
  const M = mod360(357.5291 + 0.98560028 * (jStar - J2000));
  const C = 1.9148 * Math.sin(M * RAD) + 0.02 * Math.sin(2 * M * RAD) + 0.0003 * Math.sin(3 * M * RAD);
  const lam = mod360(M + C + 180 + 102.9372);
  const jTransit = jStar + 0.0053 * Math.sin(M * RAD) - 0.0069 * Math.sin(2 * lam * RAD);
  const sinDec = Math.sin(lam * RAD) * Math.sin(23.4397 * RAD);
  const cosDec = Math.cos(Math.asin(sinDec));
  const at = (h) => {
    const cw = (Math.sin(h * RAD) - Math.sin(lat * RAD) * sinDec) / (Math.cos(lat * RAD) * cosDec);
    if (cw < -1) return 'above';
    if (cw > 1) return 'below';
    const w = Math.acos(cw) / RAD;
    return [fromJd(jTransit - w / 360), fromJd(jTransit + w / 360)];
  };
  const rise = at(-0.833);
  const civ = at(-6);
  const r = {
    dawn: Array.isArray(civ) ? civ[0] : null,
    sunrise: Array.isArray(rise) ? rise[0] : null,
    sunset: Array.isArray(rise) ? rise[1] : null,
    dusk: Array.isArray(civ) ? civ[1] : null,
    polar: rise === 'above' ? 'day' : rise === 'below' ? 'night' : null,
    civilPolar: civ === 'above' ? 'light' : civ === 'below' ? 'dark' : null,
  };
  return r;
}

/**
 * Light of the sky over [from, to): a list of { from, to, kind: 'night' | 'twilight' | 'day' }.
 */
export function skyIntervals(from, to, lat, lon) {
  const marks = [];
  for (let d = addDays(startOfDay(from), -1); d <= to; d = addDays(d, 1)) {
    const s = sunTimes(d, lat, lon);
    const dayStart = startOfDay(d);
    const dayEnd = addDays(dayStart, 1);
    if (s.polar === 'day') { marks.push([dayStart, 'day']); continue; }
    if (s.polar === 'night') {
      marks.push([dayStart, s.civilPolar === 'dark' ? 'night' : 'twilight']);
      continue;
    }
    if (s.dawn) marks.push([s.dawn, 'twilight']);
    else marks.push([dayStart, 'twilight']); // white night: twilight instead of night
    marks.push([s.sunrise, 'day']);
    marks.push([s.sunset, 'twilight']);
    if (s.dusk) marks.push([s.dusk, 'night']);
    void dayEnd;
  }
  marks.sort((a, b) => a[0] - b[0]);
  const out = [];
  let kind = 'night';
  let cur = from;
  for (const [t, k] of marks) {
    if (t <= from) { kind = k; continue; }
    if (t >= to) break;
    if (k !== kind) { out.push({ from: cur, to: t, kind }); cur = t; kind = k; }
  }
  out.push({ from: cur, to, kind });
  return out;
}

// ---- Mercury ----

// Keplerian elements and their rates per century (Standish, JPL; valid 1800–2050, fine a bit beyond).
const ELEM = {
  mercury: [0.38709927, 0.00000037, 0.20563593, 0.00001906, 7.00497902, -0.00594749,
    252.25032350, 149472.67411175, 77.45779628, 0.16047689, 48.33076593, -0.12534081],
  earth: [1.00000261, 0.00000562, 0.01671123, -0.00004392, -0.00001531, -0.01294668,
    100.46457166, 35999.37244981, 102.93768193, 0.32327364, 0, 0],
};

function helio(el, T) {
  const a = el[0] + el[1] * T;
  const e = el[2] + el[3] * T;
  const I = (el[4] + el[5] * T) * RAD;
  const L = el[6] + el[7] * T;
  const peri = el[8] + el[9] * T;
  const node = el[10] + el[11] * T;
  const w = (peri - node) * RAD;
  const M = mod360(L - peri);
  const Mr = (M > 180 ? M - 360 : M) * RAD;
  let E = Mr + e * Math.sin(Mr);
  for (let k = 0; k < 8; k++) E -= (E - e * Math.sin(E) - Mr) / (1 - e * Math.cos(E));
  const xp = a * (Math.cos(E) - e);
  const yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const O = node * RAD;
  const cw = Math.cos(w); const sw = Math.sin(w);
  const cO = Math.cos(O); const sO = Math.sin(O);
  const cI = Math.cos(I); const sI = Math.sin(I);
  return [
    (cw * cO - sw * sO * cI) * xp + (-sw * cO - cw * sO * cI) * yp,
    (cw * sO + sw * cO * cI) * xp + (-sw * sO + cw * cO * cI) * yp,
    (sw * sI) * xp + (cw * sI) * yp,
  ];
}

/** Geocentric ecliptic longitude of Mercury, degrees. */
export function mercuryLongitude(t) {
  const T = (jd(t) - J2000) / 36525;
  const m = helio(ELEM.mercury, T);
  const e = helio(ELEM.earth, T);
  return mod360(Math.atan2(m[1] - e[1], m[0] - e[0]) / RAD);
}

const speed = (t) => {
  let d = mercuryLongitude(new Date(+t + 3 * 36e5)) - mercuryLongitude(new Date(+t - 3 * 36e5));
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
};

function station(a, b) {
  // speed changes sign between a and b: bisect to the minute
  let lo = +a; let hi = +b;
  const sLo = Math.sign(speed(new Date(lo)));
  while (hi - lo > 6e4) {
    const mid = (lo + hi) / 2;
    if (Math.sign(speed(new Date(mid))) === sLo) lo = mid; else hi = mid;
  }
  return new Date((lo + hi) / 2);
}

const retroCache = new Map();

/** Mercury retrograde periods of a year (and the ones overlapping it): [{ start, end }] as moments. */
export function mercuryRetrogrades(year) {
  if (retroCache.has(year)) return retroCache.get(year);
  const from = new Date(year - 1, 10, 1);
  const to = new Date(year + 1, 2, 1);
  const out = [];
  let prev = from;
  let ps = speed(prev);
  let start = null;
  for (let t = new Date(+from + 864e5); t <= to; t = new Date(+t + 864e5)) {
    const s = speed(t);
    if (ps > 0 && s <= 0) start = station(prev, t);
    else if (ps < 0 && s >= 0 && start) {
      const end = station(prev, t);
      if (end.getFullYear() >= year && start.getFullYear() <= year) out.push({ start, end });
      start = null;
    }
    prev = t;
    ps = s;
  }
  retroCache.set(year, out);
  return out;
}

/** The retrograde period covering a moment, or null. */
export function retrogradeAt(t) {
  for (const y of [t.getFullYear()]) {
    for (const p of mercuryRetrogrades(y)) if (p.start <= t && t < p.end) return p;
  }
  return null;
}

/** Is any part of this local calendar day inside a retrograde period? */
export function retrogradeDay(day) {
  const a = startOfDay(day);
  const z = addDays(a, 1);
  for (const p of mercuryRetrogrades(a.getFullYear())) if (p.start < z && p.end > a) return p;
  return null;
}

/** The current period (if retrograde now) or the next one. */
export function nextRetrograde(now) {
  for (const y of [now.getFullYear(), now.getFullYear() + 1]) {
    for (const p of mercuryRetrogrades(y)) if (p.end > now) return p;
  }
  return null;
}
