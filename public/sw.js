/* Service worker chỉ làm một việc: biến một ReadableStream do trang gửi sang thành
   một response download, để file lớn chảy thẳng xuống ổ đĩa thay vì nằm hết trong RAM. */

const downloads = new Map(); // id -> { stream, name, size, mime }

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('message', e => {
  const m = e.data;
  if (m?.type !== 'dl') return;
  downloads.set(m.id, m);
  // Dọn rác nếu trang không bao giờ gọi tới URL download (người dùng huỷ, tab đóng...)
  setTimeout(() => downloads.delete(m.id), 60000);
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith('/__dl/')) return;
  e.respondWith(respond(decodeURIComponent(url.pathname.slice(6))));
});

async function respond(id) {
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
