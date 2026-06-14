// Signal PWA · Service Worker v5.2
// Fix: navigate = network-first (no stale HTML), API = no-cache

const VER        = 'signal-v5.2';
const H1_CACHE   = 'h1-v5.2';
const RATE_CACHE = 'rate-v5.2';
const VALID      = [VER, H1_CACHE, RATE_CACHE];

const H1_TTL   = 60 * 60 * 1000;
const RATE_TTL = 30 * 60 * 1000;

const API_HOSTS = [
  'api.binance.com','api.bybit.com','api.gateio.ws',
  'api.coingecko.com','open.er-api.com','api.exchangerate.host',
  'fonts.googleapis.com','fonts.gstatic.com',
];

function classify(url) {
  if (/interval=1h/i.test(url))                  return 'H1';
  if (url.includes('open.er-api.com') ||
      url.includes('exchangerate.host'))           return 'RATE';
  if (url.includes('interval=15m') ||
      url.includes('interval=15min') ||
      url.includes('/ticker/') ||
      url.includes('/spot/tickers') ||
      url.includes('/v5/market/tickers') ||
      url.includes('simple/price'))               return 'LIVE';
  if (API_HOSTS.some(h => url.includes(h)))       return 'API';
  return 'STATIC';
}

// ── INSTALL ────────────────────────────────────────────────────────
self.addEventListener('install', e => {
  // Langsung aktif tanpa menunggu tab lama ditutup
  e.waitUntil(self.skipWaiting());
});

// ── ACTIVATE ──────────────────────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => !VALID.includes(k)).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ── FETCH ─────────────────────────────────────────────────────────
self.addEventListener('fetch', e => {
  const req = e.request;
  const url = req.url;
  const type = classify(url);

  // ① HTML navigate → selalu network-first (kode terbaru, bukan cache)
  if (req.mode === 'navigate') {
    e.respondWith(networkFirstHtml(req));
    return;
  }

  // ② 1H klines → timed cache 60 menit
  if (type === 'H1') {
    e.respondWith(timedCache(req, H1_CACHE, H1_TTL));
    return;
  }

  // ③ IDR rate → timed cache 30 menit
  if (type === 'RATE') {
    e.respondWith(timedCache(req, RATE_CACHE, RATE_TTL));
    return;
  }

  // ④ Realtime market data → network only, no cache
  if (type === 'LIVE' || type === 'API') {
    e.respondWith(
      fetch(req, { cache: 'no-store' }).catch(() => apiError())
    );
    return;
  }

  // ⑤ Static assets (font, icon, dll) → cache-first
  e.respondWith(staticFirst(req));
});

// ── STRATEGY: HTML NETWORK-FIRST ──────────────────────────────────
async function networkFirstHtml(req) {
  try {
    const res = await fetch(req, { cache: 'no-store' });
    if (res.ok) {
      // Simpan ke cache untuk offline fallback
      const c = await caches.open(VER);
      c.put(req, res.clone());
      return res;
    }
    // Server error → fallback ke cache
    return (await caches.match(req)) || res;
  } catch {
    // Offline → cache fallback
    return (await caches.match(req))
      || (await caches.match('./index.html'))
      || offlinePage();
  }
}

// ── STRATEGY: TIMED CACHE ─────────────────────────────────────────
async function timedCache(req, cacheName, ttl) {
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(req);

  if (cached) {
    const ts = cached.headers.get('sw-ts');
    if (ts && Date.now() - +ts < ttl) return cached;
  }

  try {
    const res = await fetch(req, { cache: 'no-store' });
    if (!res.ok) return cached || res;
    const text = await res.text();
    const stamped = new Response(text, {
      status: res.status,
      headers: {
        'Content-Type': res.headers.get('content-type') || 'application/json',
        'sw-ts': String(Date.now()),
      },
    });
    cache.put(req, stamped.clone());
    return stamped;
  } catch {
    return cached || apiError();
  }
}

// ── STRATEGY: STATIC CACHE-FIRST ─────────────────────────────────
async function staticFirst(req) {
  const cached = await caches.match(req);
  if (cached) {
    // Background revalidate
    fetch(req).then(async res => {
      if (res?.status === 200 && res.type !== 'opaque') {
        (await caches.open(VER)).put(req, res);
      }
    }).catch(() => {});
    return cached;
  }
  try {
    const res = await fetch(req);
    if (req.method === 'GET' && res.status === 200 && res.type !== 'opaque') {
      (await caches.open(VER)).put(req, res.clone());
    }
    return res;
  } catch {
    return new Response('Offline', { status: 503 });
  }
}

// ── FALLBACKS ─────────────────────────────────────────────────────
function apiError() {
  return new Response(
    JSON.stringify({ error: 'offline', ts: Date.now() }),
    { status: 503, headers: { 'Content-Type': 'application/json' } }
  );
}
function offlinePage() {
  return new Response(
    `<html><body style="background:#030712;color:#94a3b8;font-family:monospace;
     padding:40px;text-align:center">
     <h2 style="color:#00e5a0">⚡ Signal</h2>
     <p>Offline · Buka saat ada koneksi internet.</p></body></html>`,
    { status: 200, headers: { 'Content-Type': 'text/html' } }
  );
}

// ── MESSAGES ─────────────────────────────────────────────────────
self.addEventListener('message', e => {
  if (!e.data) return;
  switch (e.data.type) {
    case 'SIGNAL_ALERT': showSignalNotif(e.data); break;
    case 'JAWARA_FOUND': showJawaraNotif(e.data); break;
    case 'SKIP_WAITING': self.skipWaiting(); break;
    case 'GET_VERSION':  e.source?.postMessage({ type:'VERSION', ver:VER }); break;
  }
});

// ── PUSH ──────────────────────────────────────────────────────────
self.addEventListener('push', e => {
  let d = { title:'🔔 Signal', body:'Sinyal berubah!', action:'HOLD' };
  try { d = e.data.json(); } catch {}
  e.waitUntil(showSignalNotif(d));
});

// ── NOTIFICATION CLICK ────────────────────────────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  if (e.action === 'dismiss') return;
  e.waitUntil(
    clients.matchAll({ type:'window', includeUncontrolled:true })
      .then(cs => {
        const w = cs.find(c => c.visibilityState === 'visible') || cs[0];
        if (w) { w.focus(); return; }
        return clients.openWindow('./index.html');
      })
  );
});

// ── NOTIFICATION HELPERS ─────────────────────────────────────────
function vibe(action) {
  if (action==='BUY')    return [100,50,100,50,200];
  if (action==='SELL')   return [300,100,300];
  if (action==='JAWARA') return [100,40,100,40,100,40,300];
  return [150,100,150];
}
function showSignalNotif(d) {
  const e = d.action==='BUY'?'🟢':d.action==='SELL'?'🔴':'🟡';
  return self.registration.showNotification(`${e} ${d.title}`, {
    body: d.body, icon:'./icon-192.png', badge:'./icon-192.png',
    tag:`signal-${(d.action||'hold').toLowerCase()}`,
    renotify:true, vibrate:vibe(d.action),
    actions:[{action:'view',title:'Lihat Signal'}], data:d,
  });
}
function showJawaraNotif(d) {
  const lines = (d.jawara||[])
    .map(j=>`${j.action==='BUY'?'▲':'▼'} ${j.name} · Skor ${j.score}`)
    .join('\n') || 'Setup bersih terdeteksi.';
  return self.registration.showNotification('⚡ Jawara Harian Ditemukan', {
    body:lines, icon:'./icon-192.png', badge:'./icon-192.png',
    tag:'jawara-alert', renotify:true, vibrate:vibe('JAWARA'),
    actions:[{action:'view',title:'⚡ Lihat'},{action:'dismiss',title:'Tutup'}],
    data:d,
  });
}

// ── SYNC ──────────────────────────────────────────────────────────
self.addEventListener('sync', e => {
  if (e.tag === 'screener-sync') {
    e.waitUntil(
      clients.matchAll({type:'window'})
        .then(cs => cs.forEach(c => c.postMessage({type:'TRIGGER_SCREENER'})))
    );
  }
});
self.addEventListener('periodicsync', e => {
  if (e.tag === 'screener-periodic') {
    e.waitUntil(
      clients.matchAll({type:'window'})
        .then(cs => cs.forEach(c => c.postMessage({type:'TRIGGER_SCREENER'})))
    );
  }
});
