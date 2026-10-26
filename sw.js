// Keeps a copy of the whole app so it opens instantly and works offline. Every publish stamps a
// new VERSION and file list (tools\stamp.ps1); browsers see the changed file, download the new
// version in the background, and the page switches to it (right away when nothing is open).

const VERSION = '2026.10.26-1115';
const FILES = ['./', 'assets/badger-logo.png', 'assets/badger-mark.png', 'css/app.css', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'index.html', 'js/app.js', 'js/doc.js', 'js/dxf/font.js', 'js/dxf/model.js', 'js/dxf/scene.js', 'js/geom.js', 'js/icons.js', 'js/io/export.js', 'js/io/import.js', 'js/ops.js', 'js/panels.js', 'js/pathops.js', 'js/pathtools.js', 'js/render.js', 'js/state.js', 'js/tools.js', 'js/ui.js', 'js/view.js', 'manifest.webmanifest', 'vendor/clipper.js', 'vendor/LICENSES/clipper-lib.txt', 'vendor/LICENSES/pdf-lib.txt', 'vendor/pdf-lib.esm.min.js'];

const CACHE = 'vector-draw-' + VERSION;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('vector-draw-') && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

// the page says when it's a good moment to switch to a waiting new version
self.addEventListener('message', (e) => {
  if (e.data === 'activate') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(e.request, { ignoreSearch: true });
    if (hit) return hit;
    try {
      return await fetch(e.request);
    } catch {
      return (await cache.match('index.html')) || Response.error();
    }
  })());
});
