// Offline shell: the app works without a connection; market data always comes live.
const VERSION = 'tradelab-v3';
const SHELL = ['./', 'index.html', 'css/app.css', 'manifest.webmanifest',
  'js/app.js', 'js/config.js', 'js/engine.js', 'js/strategies.js', 'js/indicators.js', 'js/timemachine.js',
  'js/data.js', 'js/store.js', 'js/chart.js', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/favicon.svg', 'js/demo.js'];
self.addEventListener('install', e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (/binance/.test(url.hostname)) return; // never cache market data
  if (url.hostname.includes('fonts.') || url.hostname.includes('jsdelivr')) {     // fonts: cache first
    e.respondWith(caches.open(VERSION).then(async c => (await c.match(e.request)) || fetch(e.request).then(r => { c.put(e.request, r.clone()); return r; })));
    return;
  }
  if (url.origin !== location.origin) return;
  // app files: network first (fresh updates), cache when offline
  e.respondWith(fetch(e.request).then(r => { const copy = r.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); return r; })
    .catch(() => caches.match(e.request).then(r => r || caches.match('index.html'))));
});
self.addEventListener('notificationclick', e => { e.notification.close(); e.waitUntil(self.clients.matchAll({ type: 'window' }).then(w => w.length ? w[0].focus() : self.clients.openWindow('./'))); });
