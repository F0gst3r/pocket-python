const SHELL_CACHE = 'pocket-python-shell-v3';
const RUNTIME_CACHE = 'pocket-python-runtime-v1';
const KEEP = [SHELL_CACHE, RUNTIME_CACHE];

const SHELL = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];

// Third-party origins the app needs in order to run at all. Caching them is what
// makes the installed iOS app work offline — Pyodide alone is several MB, so it
// lives in its own cache that shell version bumps do not evict.
const RUNTIME_HOSTS = [
  'cdn.jsdelivr.net',
  'cdnjs.cloudflare.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => !KEEP.includes(k)).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

function putCopy(cacheName, req, res) {
  const copy = res.clone();
  caches.open(cacheName).then((c) => c.put(req, copy)).catch(() => {});
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  const sameOrigin = url.origin === self.location.origin;
  const isRuntimeAsset = RUNTIME_HOSTS.includes(url.hostname);
  if (!sameOrigin && !isRuntimeAsset) return;   // e.g. api.anthropic.com — never cache

  const isShell =
    req.mode === 'navigate' ||
    (sameOrigin && (url.pathname.endsWith('/') || url.pathname.endsWith('.html')));

  // Network-first for the shell, so a fixed index.html is never shadowed by a
  // stale cached copy.
  if (isShell) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) putCopy(SHELL_CACHE, req, res);
          return res;
        })
        .catch(() =>
          caches.match(req).then((cached) => cached || caches.match('./index.html'))
        )
    );
    return;
  }

  // Cache-first for everything else: the Python runtime is large and immutable
  // (its URL is version-pinned), so refetching it on every launch is waste.
  const target = isRuntimeAsset ? RUNTIME_CACHE : SHELL_CACHE;
  e.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (res && res.ok && res.type !== 'opaque') putCopy(target, req, res);
        return res;
      });
    })
  );
});
