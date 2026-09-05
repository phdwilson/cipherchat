// CipherChat Service Worker（v1.5.0 PWA）
// 策略：仅缓存静态外壳（app shell），API 与 WebSocket 一律不缓存（隐私优先 —— 密文绝不落 SW 缓存）
const CACHE = 'cipherchat-shell-v1'
const SHELL = ['/', '/logo.svg', '/manifest.json', '/worklets/pitch-shift.js']

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  )
})

// 网络优先，失败回退缓存（静态资源）；/api/* 完全直通不缓存
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (url.pathname.startsWith('/api/') || event.request.method !== 'GET') return
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok && url.origin === self.location.origin) {
          const copy = res.clone()
          caches.open(CACHE).then((c) => c.put(event.request, copy)).catch(() => {})
        }
        return res
      })
      .catch(() => caches.match(event.request).then((hit) => hit || caches.match('/'))),
  )
})
