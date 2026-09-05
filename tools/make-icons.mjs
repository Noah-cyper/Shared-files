/* Sinh icon PNG cho PWA. Chạy lại khi muốn đổi màu/hình: node tools/make-icons.mjs */
import { PNG } from 'pngjs';
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.join(import.meta.dirname, '..', 'public', 'icons');
const BOLT = [[.58, .05], [.24, .55], [.45, .55], [.40, .95], [.76, .43], [.53, .43]];
const TOP = [91, 140, 255], BOTTOM = [35, 214, 160];
const SS = 4; // siêu lấy mẫu để cạnh xiên của tia sét không bị răng cưa

const inPoly = (x, y, poly) => {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
};

// bo góc kiểu squircle nhẹ; maskable thì phủ kín khung vì hệ điều hành tự cắt
const inRounded = (x, y, r) => {
  const dx = Math.max(r - x, 0, x - (1 - r));
  const dy = Math.max(r - y, 0, y - (1 - r));
  return dx * dx + dy * dy <= r * r;
};

function render(size, { maskable = false } = {}) {
  const png = new PNG({ width: size, height: size });
  const radius = maskable ? 0 : 0.22;
  const scale = maskable ? 0.62 : 1;   // vùng an toàn của icon maskable là 80% ở giữa
  const shift = (1 - scale) / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bg = 0, fg = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + .5) / SS) / size;
          const v = (y + (sy + .5) / SS) / size;
          if (radius && !inRounded(u, v, radius)) continue;
          bg++;
          if (inPoly((u - shift) / scale, (v - shift) / scale, BOLT)) fg++;
        }
      }
      const n = SS * SS;
      const t = y / size;
      const base = TOP.map((c, i) => c + (BOTTOM[i] - c) * t);
      const cover = fg / n;
      const i = (size * y + x) << 2;
      for (let c = 0; c < 3; c++) png.data[i + c] = Math.round(base[c] * (1 - cover) + 255 * cover);
      png.data[i + 3] = Math.round(255 * (bg / n));
    }
  }
  return PNG.sync.write(png);
}

// ICO va ICNS deu cho phep nhet thang PNG vao, khoi can encoder rieng
function ico(png256) {
  const head = Buffer.alloc(22);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(1, 4);
  head[6] = 0; head[7] = 0;                       // 0 = 256 pixel
  head.writeUInt16LE(1, 10); head.writeUInt16LE(32, 12);
  head.writeUInt32LE(png256.length, 14); head.writeUInt32LE(22, 18);
  return Buffer.concat([head, png256]);
}

function icns(parts) {
  const chunks = parts.map(([type, data]) => {
    const h = Buffer.alloc(8);
    h.write(type, 0, 'ascii');
    h.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([h, data]);
  });
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii');
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

fs.mkdirSync(OUT, { recursive: true });
const made = {};
for (const [file, size, opts] of [
  ['icon-192.png', 192, {}],
  ['icon-256.png', 256, {}],
  ['icon-512.png', 512, {}],
  ['icon-maskable.png', 512, { maskable: true }],
  ['apple-touch-icon.png', 180, {}]
]) {
  made[file] = render(size, opts);
  fs.writeFileSync(path.join(OUT, file), made[file]);
}
fs.writeFileSync(path.join(OUT, 'app.ico'), ico(made['icon-256.png']));
fs.writeFileSync(path.join(OUT, 'app.icns'), icns([['ic08', made['icon-256.png']], ['ic09', made['icon-512.png']]]));
console.log('đã tạo:', fs.readdirSync(OUT).join(', '));
