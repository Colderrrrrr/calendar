// Service worker: файлы сайта всегда сверяем с сервером (чтобы обновления приходили сразу),
// а без интернета показываем сохранённую копию. Запросы к Supabase и погоде не трогаем.
// При каждом обновлении сайта: поднять номер версии здесь и ?v= в index.html.
const CACHE = 'calendar-shell-v5';
const SHELL = [
  './', 'index.html', 'style.css?v=5', 'app.js?v=5', 'config.js?v=5', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  const libs = url.hostname === 'cdn.jsdelivr.net' || url.hostname.endsWith('fonts.googleapis.com') || url.hostname.endsWith('fonts.gstatic.com');
  if (!sameOrigin && !libs) return;

  // свои файлы — мимо HTTP-кэша браузера, библиотеки с CDN — как обычно (у них версия в адресе)
  const fresh = sameOrigin ? fetch(req, { cache: 'no-cache' }) : fetch(req);
  e.respondWith(
    fresh
      .then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
        return res;
      })
      .catch(() => caches.match(req).then(hit => hit || (req.mode === 'navigate' ? caches.match('index.html') : Response.error())))
  );
});
