// Service worker: guarda os arquivos do app para abrir rápido e sem internet.
// Os dados (planilha) nunca passam por aqui — vão direto para o Google.
// A versão é trocada automaticamente a cada publicação (veja .github/workflows/pages.yml).
const VERSION = 'dev';
const CACHE = `contas-a-dois-${VERSION}`;
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/app.js',
  './js/auth.js',
  './js/charts.js',
  './js/config.js',
  './js/db.js',
  './js/fake-google.js',
  './js/format.js',
  './js/google.js',
  './js/stats.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Página: tenta a rede primeiro (pega versões novas), cai no cache se offline.
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => caches.match('./index.html')));
    return;
  }
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
});
