// Service worker: guarda os arquivos do app para abrir rápido e sem internet.
// Os dados (planilha) nunca passam por aqui — vão direto para o Google.
// No app Android não é usado: os arquivos já vêm dentro do APK.
const VERSION = '2.0.0';
const CACHE = `contas-a-dois-${VERSION}`;
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/api.js',
  './js/app.js',
  './js/charts.js',
  './js/config.js',
  './js/db.js',
  './js/fake-sheets.js',
  './js/format.js',
  './js/native.js',
  './js/stats.js',
  './apps-script/Codigo.gs',
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
