/* Service worker làm hai việc:
   1. biến một ReadableStream do trang gửi sang thành response download, để file lớn
      chảy thẳng xuống ổ đĩa thay vì nằm hết trong RAM
   2. cache vỏ ứng dụng để mở nhanh và để cài được lên màn hình chính */

const CACHE = 'shared-files-v1';
const SHELL = [
  '/', '/index.html', '/cai-dat.html', '/manifest.webmanifest',
  '/css/style.css', '/js/app.js', '/js/rtc.js', '/js/writer.js',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png'
];

const downloads = new Map(); // id -> { stream, name, size, mime }

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => { /* offline lúc cài thì bỏ qua */ }));
});

self.addEventListener('activate', e => e.waitUntil(
  caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim())
));

self.addEventListener('message', e => {
  const m = e.data;
  if (m?.type !== 'dl') return;
  downloads.set(m.id, m);
  // Dọn rác nếu trang không bao giờ gọi tới URL download (người dùng huỷ, tab đóng...)
  setTimeout(() => downloads.delete(m.id), 60000);
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith('/__dl/')) {
    return e.respondWith(streamDownload(decodeURIComponent(url.pathname.slice(6))));
  }
  // Signaling, chứng chỉ và QR luôn phải lấy tươi từ server
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/') || url.pathname.startsWith('/ca.')) return;

  e.respondWith(networkFirst(e.request));
});

// Ưu tiên mạng: app vô dụng khi mất server nên không có lý do phục vụ bản cũ trong cache;
// cache chỉ để mở được vỏ ứng dụng và để trình duyệt cho cài lên màn hình chính.
async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(request);
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch (e) {
    const hit = await cache.match(request, { ignoreSearch: true });
    if (hit) return hit;
    throw e;
  }
}

async function streamDownload(id) {
  // postMessage và navigation là hai kênh khác nhau nên thứ tự tới nơi không đảm bảo
  for (let i = 0; i < 40 && !downloads.has(id); i++) await new Promise(r => setTimeout(r, 50));
  const dl = downloads.get(id);
  if (!dl) return new Response('Download đã hết hạn', { status: 404 });
  downloads.delete(id);

  const headers = {
    'Content-Type': dl.mime || 'application/octet-stream',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(dl.name)}`,
    'Cache-Control': 'no-store'
  };
  if (Number.isFinite(dl.size)) headers['Content-Length'] = String(dl.size);
  return new Response(dl.stream, { headers });
}
