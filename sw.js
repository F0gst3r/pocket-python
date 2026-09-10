const SHELL_CACHE = 'pocket-python-shell-v4';
const RUNTIME_CACHE = 'pocket-python-runtime-v2';
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

// The editor's own libraries load from <head>, before this worker controls the
// first page view, so they never pass through the fetch handler on that visit.
// Precaching them here is what makes offline work after one visit instead of two.
// Pyodide itself (several MB) is deliberately left out — it is fetched on the
// first actual Run, so opening the app never costs that download.
const CM = 'https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/';
const PRECACHE_CDN = [
  CM + 'codemirror.min.js',
  CM + 'mode/python/python.min.js',
  CM + 'addon/hint/show-hint.min.js',
  CM + 'codemirror.min.css',
  CM + 'theme/dracula.min.css',
  CM + 'addon/hint/show-hint.min.css',
  'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js'
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const shell = await caches.open(SHELL_CACHE);
    await shell.addAll(SHELL).catch(() => {});

    // One failing CDN asset must not fail the whole install, so cache them
    // individually. Explicit CORS mode keeps the responses inspectable —
    // an opaque response has status 0 and cannot be validated before caching.
    const runtime = await caches.open(RUNTIME_CACHE);
    await Promise.all(PRECACHE_CDN.map(async (url) => {
      try {
        const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
        if (res && res.ok) await runtime.put(url, res);
      } catch (err) { /* offline at install time — fetched on demand later */ }
    }));
  })());
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
        // res.ok is false for opaque responses (status 0), so this also skips
        // anything that arrived without CORS — it could not be validated anyway.
        if (res && res.ok) putCopy(target, req, res);
        return res;
      });
    })
  );
});
