// 24-hour clock-face time picker (the native <input type="time"> shows AM/PM in some locales).
// Hours: outer ring 1–12, inner ring 13–23 and 00; after an hour is picked the dial turns to
// minutes (snapped to 5; any minute can be typed). Returns a promise: "HH:MM", "" (cleared) or
// null (cancelled).

const pad2 = (n) => String(n).padStart(2, '0');
const TAU = Math.PI * 2;
const C = 130; // dial centre in the 260×260 viewBox
const R_OUT = 104;
const R_IN = 68;

let dlg;
let svg;
let hIn;
let mIn;
let st = null; // { h, m, mode, resolve }
let dragging = false;

function finish(value) {
  if (!st) return;
  const { resolve } = st;
  st = null;
  if (dlg.open) dlg.close();
  resolve(value);
}

const at = (i, n, r) => {
  const a = (i / n) * TAU;
  return [C + Math.sin(a) * r, C - Math.cos(a) * r];
};

function render() {
  const { h, m, mode } = st;
  if (document.activeElement !== hIn) hIn.value = pad2(h);
  if (document.activeElement !== mIn) mIn.value = pad2(m);
  hIn.classList.toggle('on', mode === 'h');
  mIn.classList.toggle('on', mode === 'm');

  const labels = [];
  let sel;
  if (mode === 'h') {
    for (let i = 0; i < 12; i++) {
      const outer = i === 0 ? 12 : i;
      const inner = i === 0 ? 0 : i + 12;
      labels.push({ p: at(i, 12, R_OUT), text: String(outer), val: outer, cls: '' });
      labels.push({ p: at(i, 12, R_IN), text: pad2(inner), val: inner, cls: 'in' });
    }
    sel = labels.find((l) => l.val === h).p;
  } else {
    for (let i = 0; i < 12; i++) labels.push({ p: at(i, 12, R_OUT), text: pad2(i * 5), val: i * 5, cls: '' });
    sel = at(m, 60, R_OUT);
  }
  const cur = mode === 'h' ? h : m;
  svg.innerHTML = `<circle cx="${C}" cy="${C}" r="126" class="tp-face"/>
    <line x1="${C}" y1="${C}" x2="${sel[0].toFixed(1)}" y2="${sel[1].toFixed(1)}" class="tp-hand"/>
    <circle cx="${C}" cy="${C}" r="4" class="tp-pin"/>
    <circle cx="${sel[0].toFixed(1)}" cy="${sel[1].toFixed(1)}" r="19" class="tp-sel"/>
    ${labels.map((l) => `<text x="${l.p[0].toFixed(1)}" y="${l.p[1].toFixed(1)}" class="tp-l ${l.cls}${l.val === cur ? ' on' : ''}">${l.text}</text>`).join('')}`;
}

function pickAt(e) {
  const r = svg.getBoundingClientRect();
  const x = ((e.clientX - r.left) / r.width) * 260 - C;
  const y = ((e.clientY - r.top) / r.height) * 260 - C;
  let a = Math.atan2(x, -y);
  if (a < 0) a += TAU;
  if (st.mode === 'h') {
    const i = Math.round(a / (TAU / 12)) % 12;
    st.h = Math.hypot(x, y) > (R_OUT + R_IN) / 2 ? (i === 0 ? 12 : i) : (i === 0 ? 0 : i + 12);
  } else {
    const mm = Math.round(a / (TAU / 60)) % 60;
    st.m = (Math.round(mm / 5) * 5) % 60;
  }
  render();
}

function onType(input, max, key) {
  const v = input.value.replace(/\D/g, '').slice(0, 2);
  input.value = v;
  if (!v) return;
  const n = Number(v);
  if (n > max) { input.value = v.slice(0, 1); return; }
  st[key] = n;
  if (key === 'h' && v.length === 2) {
    st.mode = 'm';
    mIn.focus();
    mIn.select();
  }
  render();
}

function build() {
  dlg = document.createElement('dialog');
  dlg.className = 'sheet tp-dlg';
  dlg.innerHTML = `
    <div class="dlg-body tp">
      <h2 class="tp-title"></h2>
      <div class="tp-display">
        <input class="tp-num" inputmode="numeric" maxlength="2" autocomplete="off" aria-label="Часы">
        <span class="tp-colon">:</span>
        <input class="tp-num" inputmode="numeric" maxlength="2" autocomplete="off" aria-label="Минуты">
      </div>
      <svg class="tp-dial" viewBox="0 0 260 260" aria-hidden="true"></svg>
      <div class="dlg-actions">
        <button type="button" class="btn ghost" data-tp="clear">Без времени</button>
        <span class="sp"></span>
        <button type="button" class="btn" data-tp="cancel">Отмена</button>
        <button type="button" class="btn primary" data-tp="ok" autofocus>Готово</button>
      </div>
    </div>`;
  document.body.appendChild(dlg);
  svg = dlg.querySelector('svg');
  [hIn, mIn] = dlg.querySelectorAll('.tp-num');

  svg.addEventListener('pointerdown', (e) => {
    if (!st) return;
    dragging = true;
    svg.setPointerCapture(e.pointerId);
    e.preventDefault();
    pickAt(e);
  });
  svg.addEventListener('pointermove', (e) => { if (dragging && st) pickAt(e); });
  const up = () => {
    if (!dragging || !st) return;
    dragging = false;
    if (st.mode === 'h') { st.mode = 'm'; render(); }
  };
  svg.addEventListener('pointerup', up);
  svg.addEventListener('pointercancel', up);

  hIn.addEventListener('focus', () => { st.mode = 'h'; render(); hIn.select(); });
  mIn.addEventListener('focus', () => { st.mode = 'm'; render(); mIn.select(); });
  hIn.addEventListener('input', () => onType(hIn, 23, 'h'));
  mIn.addEventListener('input', () => onType(mIn, 59, 'm'));
  for (const inp of [hIn, mIn]) {
    inp.addEventListener('blur', () => { if (st) render(); });
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); finish(`${pad2(st.h)}:${pad2(st.m)}`); } });
  }

  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) { finish(null); return; }
    const b = e.target.closest('[data-tp]');
    if (!b) return;
    if (b.dataset.tp === 'ok') finish(`${pad2(st.h)}:${pad2(st.m)}`);
    else if (b.dataset.tp === 'clear') finish('');
    else finish(null);
  });
  dlg.addEventListener('close', () => finish(null));
}

/**
 * @param {string} value "HH:MM" or "" (then `fallback` is shown)
 * @param {{ allowEmpty?: boolean, title?: string, fallback?: string }} opts
 */
export function pickTime(value, { allowEmpty = false, title = 'Время', fallback = '09:00' } = {}) {
  if (!dlg) build();
  if (st) finish(null);
  const [h, m] = (/^\d{2}:\d{2}$/.test(value) ? value : fallback).split(':').map(Number);
  return new Promise((resolve) => {
    st = { h, m, mode: 'h', resolve };
    dlg.querySelector('.tp-title').textContent = title;
    dlg.querySelector('[data-tp="clear"]').hidden = !allowEmpty;
    render();
    dlg.showModal();
  });
}
