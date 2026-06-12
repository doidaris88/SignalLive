// ─────────────────────────────────────────────────────────────────
//  Signal PWA · Service Worker v5
//
//  Strategi caching:
//  ┌─────────────────────┬──────────────────────────────────────┐
//  │ Request             │ Strategi                             │
//  ├─────────────────────┼──────────────────────────────────────┤
//  │ 1H klines           │ Network-first · cache TTL 60 menit  │
//  │ IDR rate            │ Network-first · cache TTL 30 menit  │
//  │ 15m klines + price  │ Network-first · no cache            │
//  │ Static (html/json)  │ Cache-first · update background     │
//  └─────────────────────┴──────────────────────────────────────┘
//
//  Message types (app → SW):
//  · SIGNAL_ALERT   → push notif perubahan sinyal
//  · JAWARA_FOUND   → push notif ⚡ jawara baru
//  · SKIP_WAITING   → paksa aktivasi SW baru
//  · GET_VERSION    → reply dengan versi cache
//
//  Message types (SW → app):
//  · TRIGGER_SCREENER  → minta app jalankan runScreener()
//  · VERSION           → reply versi cache
// ─────────────────────────────────────────────────────────────────

const VER       = 'signal-v5';
const H1_CACHE  = 'h1-klines-v5';
const RATE_CACHE= 'rate-v5';

const STATIC_ASSETS = ['./index.html', './manifest.json'];

// TTL
const H1_TTL   = 60 * 60 * 1000;   // 60 menit
const RATE_TTL = 30 * 60 * 1000;   // 30 menit

// Semua cache yang boleh hidup (sisanya dihapus saat activate)
const VALID_CACHES = [VER, H1_CACHE, RATE_CACHE];

// ── HELPERS ───────────────────────────────────────────────────────
const API_HOSTS = [
  'api.binance.com',
  'api.bybit.com',
  'api.gateio.ws',
  'api.coingecko.com',
  'open.er-api.com',
  'api.exchangerate.host',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
];

function classifyRequest(url) {
  // 1H klines — perlu persistent cache (dipakai lintas sesi)
  if (/interval=1h/.test(url) || /interval=1H/.test(url)) return 'H1';
  // Rate IDR — cukup 30 menit
  if (url.includes('open.er-api.com') || url.includes('exchangerate.host')) return 'RATE';
  // Realtime market data — jangan cache
  if (
    url.includes('interval=15m') || url.includes('interval=15min') ||
    url.includes('/ticker/') || url.includes('/spot/tickers') ||
    url.includes('/v5/market/tickers') || url.includes('simple/price')
  ) return 'LIVE';
  // API lain
  if (API_HOSTS.some(h => url.includes(h))) return 'API';
  return 'STATIC';
}

// ── INSTALL ───────────────────────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(VER)
      .then(c => c.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// ── ACTIVATE ──────────────────────────────────────────────────────
// Hapus cache lama, ambil alih semua client
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => !VALID_CACHES.includes(k)).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ── FETCH ─────────────────────────────────────────────────────────
self.addEventListener('fetch', e => {
  const url = e.request.url;
  const type = classifyRequest(url);

  // 1H klines → network-first + persistent cache 60 menit
  if (type === 'H1') {
    e.respondWith(timedCacheStrategy(e.request, H1_CACHE, H1_TTL));
    return;
  }

  // IDR rate → network-first + cache 30 menit
  if (type === 'RATE') {
    e.respondWith(timedCacheStrategy(e.request, RATE_CACHE, RATE_TTL));
    return;
  }

  // Realtime & API lain → network only, no cache
  if (type === 'LIVE' || type === 'API') {
    e.respondWith(
      fetch(e.request, { cache: 'no-store' })
        .catch(() => offlineApiResponse())
    );
    return;
  }

  // Static → cache-first, background revalidate
  e.respondWith(staticStrategy(e.request));
});

// ── STRATEGY: TIMED CACHE ─────────────────────────────────────────
// Network-first. Jika sukses: simpan + tandai timestamp.
// Jika gagal: serve stale jika masih dalam TTL, else error.
async function timedCacheStrategy(req, cacheName, ttl) {
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(req);

  // Cek apakah cache masih fresh
  if (cached) {
    const ts = cached.headers.get('sw-cached-at');
    if (ts && Date.now() - parseInt(ts, 10) < ttl) {
      return cached; // fresh hit
    }
  }

  // Ambil dari network
  try {
    const res = await fetch(req, { cache: 'no-store' });
    if (!res.ok) return cached || res;

    // Rebuild response dengan header timestamp tambahan
    const text = await res.text();
    const stamped = new Response(text, {
      status: res.status,
      statusText: res.statusText,
      headers: {
        'Content-Type': res.headers.get('content-type') || 'application/json',
        'Cache-Control': 'no-store',
        'sw-cached-at': String(Date.now()),
      },
    });
    await cache.put(req, stamped.clone());
    return stamped;
  } catch {
    // Network gagal → serve stale (expired pun lebih baik dari error)
    if (cached) return cached;
    return offlineApiResponse();
  }
}

// ── STRATEGY: STATIC CACHE-FIRST ──────────────────────────────────
async function staticStrategy(req) {
  const cached = await caches.match(req);
  if (cached) {
    // Background revalidate (stale-while-revalidate)
    fetch(req).then(async res => {
      if (res && res.status === 200 && res.type !== 'opaque') {
        const c = await caches.open(VER);
        c.put(req, res);
      }
    }).catch(() => {});
    return cached;
  }

  try {
    const res = await fetch(req);
    if (req.method === 'GET' && res.status === 200 && res.type !== 'opaque') {
      const c = await caches.open(VER);
      c.put(req, res.clone());
    }
    return res;
  } catch {
    if (req.mode === 'navigate') {
      const fallback = await caches.match('./index.html');
      return fallback || offlinePageResponse();
    }
    return new Response('Offline', { status: 503 });
  }
}

// ── OFFLINE FALLBACKS ─────────────────────────────────────────────
function offlineApiResponse() {
  return new Response(
    JSON.stringify({ error: 'offline', ts: Date.now() }),
    { status: 503, headers: { 'Content-Type': 'application/json' } }
  );
}

function offlinePageResponse() {
  return new Response(
    '<html><body style="background:#030712;color:#94a3b8;font-family:monospace;padding:40px;text-align:center">'
    + '<h2>⚡ Signal</h2><p>Offline · Buka aplikasi saat ada koneksi.</p></body></html>',
    { status: 200, headers: { 'Content-Type': 'text/html' } }
  );
}

// ── PUSH NOTIFICATION (dari server) ───────────────────────────────
self.addEventListener('push', e => {
  let d = { title: '🔔 Signal', body: 'Sinyal berubah!', action: 'HOLD' };
  try { d = e.data.json(); } catch {}
  e.waitUntil(showSignalNotif(d));
});

// ── NOTIFICATION CLICK ────────────────────────────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const action = e.action; // 'view' atau 'dismiss'
  if (action === 'dismiss') return;

  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(cs => {
        // Prioritaskan window yang sudah visible
        const active = cs.find(c => c.visibilityState === 'visible');
        if (active) { active.focus(); return; }
        if (cs.length > 0) { cs[0].focus(); return; }
        return clients.openWindow('./index.html');
      })
  );
});

// ── MESSAGES DARI APP ─────────────────────────────────────────────
self.addEventListener('message', e => {
  if (!e.data) return;
  switch (e.data.type) {

    case 'SIGNAL_ALERT':
      // { type, title, body, action }
      showSignalNotif(e.data);
      break;

    case 'JAWARA_FOUND':
      // { type, jawara: [{symbol, name, action, score}] }
      showJawaraNotif(e.data);
      break;

    case 'SKIP_WAITING':
      // App meminta SW baru langsung aktif (setelah toast update)
      self.skipWaiting();
      break;

    case 'GET_VERSION':
      // Debug: tanya versi cache yang aktif
      e.source?.postMessage({ type: 'VERSION', ver: VER });
      break;
  }
});

// ── NOTIFICATION HELPERS ──────────────────────────────────────────
function vibePattern(action) {
  switch (action) {
    case 'BUY':    return [100, 50, 100, 50, 200];       // 2 ketuk pendek + panjang
    case 'SELL':   return [300, 100, 300];               // 2 ketuk panjang
    case 'JAWARA': return [100, 40, 100, 40, 100, 40, 300]; // 3 cepat + panjang (khas ⚡)
    default:       return [150, 100, 150];               // hold: 2 sedang
  }
}

function showSignalNotif(d) {
  const emoji = d.action === 'BUY'  ? '🟢'
              : d.action === 'SELL' ? '🔴' : '🟡';
  const tag   = `signal-${(d.action || 'hold').toLowerCase()}`;
  return self.registration.showNotification(`${emoji} ${d.title}`, {
    body:     d.body,
    icon:     './icon-192.png',
    badge:    './icon-192.png',
    tag,
    renotify: true,
    vibrate:  vibePattern(d.action),
    actions:  [{ action: 'view', title: 'Lihat Signal' }],
    data:     d,
  });
}

function showJawaraNotif(d) {
  // Format ringkas: "▲ SOL · ▼ HYPE"
  const lines = (d.jawara || []).map(j => {
    const arr = j.action === 'BUY' ? '▲' : '▼';
    return `${arr} ${j.name} · Skor ${j.score}`;
  });
  const body = lines.join('\n') || 'Setup bersih terdeteksi — buka app.';

  return self.registration.showNotification('⚡ Jawara Harian Ditemukan', {
    body,
    icon:     './icon-192.png',
    badge:    './icon-192.png',
    tag:      'jawara-alert',
    renotify: true,
    vibrate:  vibePattern('JAWARA'),
    actions:  [
      { action: 'view',    title: '⚡ Lihat Jawara' },
      { action: 'dismiss', title: 'Tutup' },
    ],
    data: d,
  });
}

// ── BACKGROUND SYNC (one-off, e.g. setelah reconnect) ────────────
self.addEventListener('sync', e => {
  if (e.tag === 'screener-sync') {
    e.waitUntil(pingClients());
  }
});

// ── PERIODIC BACKGROUND SYNC (Chrome Android, optional) ──────────
// Membutuhkan izin 'periodic-background-sync' dan HTTPS.
// App mendaftarkan tag 'screener-periodic' via reg.periodicSync.register()
self.addEventListener('periodicsync', e => {
  if (e.tag === 'screener-periodic') {
    e.waitUntil(pingClients());
  }
});

// Kirim sinyal ke semua window client agar jalankan runScreener()
function pingClients() {
  return clients.matchAll({ type: 'window' }).then(cs => {
    cs.forEach(c => c.postMessage({ type: 'TRIGGER_SCREENER' }));
  });
}
