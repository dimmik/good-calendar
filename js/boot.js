// Runs before the app: theme without a flash, the web app manifest (re-added from JS when a
// content blocker strips it out of the HTML), the service worker and the install prompt.
(function () {
  'use strict';

  // Theme
  try {
    var st = JSON.parse(localStorage.getItem('good-calendar:v1') || 'null');
    var theme = st && st.settings && st.settings.theme;
    if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme);
  } catch (e) { /* ignore */ }

  // Manifest
  var MANIFEST_FILE = 'pwa.json';
  var base = document.baseURI;
  var abs = function (u) { return new URL(u, base).href; };
  var inline = {
    name: 'Удобный календарь',
    short_name: 'Календарь',
    description: 'Сегодня, месяц и отсчёты до событий, выходных и зарплаты',
    id: abs('./'),
    start_url: abs('./'),
    scope: abs('./'),
    display: 'standalone',
    orientation: 'any',
    lang: 'ru',
    background_color: '#f4f4f1',
    theme_color: '#f4f4f1',
    icons: [
      { src: abs('icons/icon-192.png'), sizes: '192x192', type: 'image/png' },
      { src: abs('icons/icon-512.png'), sizes: '512x512', type: 'image/png' },
      { src: abs('icons/maskable-512.png'), sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: abs('icons/icon.svg'), sizes: 'any', type: 'image/svg+xml' }
    ]
  };

  function ensureManifest() {
    if (document.querySelector('link[rel="manifest"]')) return;
    var link = document.createElement('link');
    link.rel = 'manifest';
    link.href = MANIFEST_FILE;
    document.head.appendChild(link);
    // If the file itself is blocked too, use a manifest built right here.
    fetch(MANIFEST_FILE, { cache: 'no-cache' })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .catch(function () {
        link.href = 'data:application/manifest+json;charset=utf-8,' + encodeURIComponent(JSON.stringify(inline));
      });
  }

  function ensureHeadLink(rel, href, extra) {
    if (document.querySelector('link[rel="' + rel + '"]')) return;
    var l = document.createElement('link');
    l.rel = rel;
    l.href = href;
    if (extra) for (var k in extra) l.setAttribute(k, extra[k]);
    document.head.appendChild(l);
  }

  ensureManifest();
  ensureHeadLink('apple-touch-icon', 'icons/apple-touch-icon.png');
  ensureHeadLink('icon', 'icons/icon.svg', { type: 'image/svg+xml' });
  document.addEventListener('DOMContentLoaded', ensureManifest);
  window.addEventListener('load', ensureManifest);

  // Install prompt (Chrome / Edge / Android)
  window.__installPrompt = null;
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    window.__installPrompt = e;
    window.dispatchEvent(new Event('installable'));
  });
  window.addEventListener('appinstalled', function () {
    window.__installPrompt = null;
    window.dispatchEvent(new Event('installable'));
  });

  // Service worker (offline + installability)
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () { /* ignore */ });
    });
  }
})();
