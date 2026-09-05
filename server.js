import express from 'express';
import { createServer as createHttp } from 'node:http';
import { createServer as createHttps } from 'node:https';
import { WebSocketServer } from 'ws';
import QRCode from 'qrcode';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HTTP_PORT = Number(process.env.PORT || 3000);
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 3443);
const ENABLE_HTTPS = process.env.HTTPS !== '0';

/* ---------- ICE ---------- */
const iceServers = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }
];
if (process.env.TURN_URL) {
  iceServers.push({
    urls: process.env.TURN_URL.split(','),
    username: process.env.TURN_USERNAME,
    credential: process.env.TURN_PASSWORD
  });
}

/* ---------- App ---------- */
const app = express();
app.disable('x-powered-by');
app.use(express.static(path.join(ROOT, 'public'), {
  setHeaders: (res, file) => {
    // Service worker phai duoc phep dieu khien toan bo scope goc
    if (file.endsWith('sw.js')) res.setHeader('Service-Worker-Allowed', '/');
  }
}));

app.get('/api/config', (req, res) => res.json({ iceServers }));

app.get('/api/qr', async (req, res) => {
  const text = String(req.query.d || '');
  if (!text || text.length > 512) return res.status(400).end();
  try {
    const svg = await QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    res.type('image/svg+xml').set('Cache-Control', 'no-store').send(svg);
  } catch { res.status(500).end(); }
});

/* ---------- Ten hien thi ---------- */
const ADJ = ['Nhanh', 'Xanh', 'Vui', 'Bay', 'Ruc', 'Am', 'Sang', 'Manh', 'Diu', 'Ngau', 'Lanh', 'Hien'];
const ANIMAL = ['Ho', 'Cao', 'Meo', 'Ca Voi', 'Dai Bang', 'Gau', 'Rai Ca', 'Soi', 'Bao', 'Ky Lan', 'Chim Ung', 'Rua'];

function displayName(seed) {
  const h = crypto.createHash('sha256').update(seed).digest();
  return `${ADJ[h[0] % ADJ.length]} ${ANIMAL[h[1] % ANIMAL.length]}`;
}

function deviceOf(ua = '') {
  if (/iPad|Tablet/i.test(ua)) return 'tablet';
  if (/Mobile|Android|iPhone/i.test(ua)) return 'mobile';
  return 'desktop';
}

const CODE_ALPHABET = 'ACDEFGHJKLMNPQRTUVWXY34679'; // bo ky tu de nham (B/8, I/1, O/0, S/5, Z/2)
function newCode() {
  let c;
  do {
    c = Array.from(crypto.randomBytes(6), b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  } while (codes.has(c));
  return c;
}

/* ---------- Registry ---------- */
const peers = new Map();  // id -> peer
const codes = new Map();  // code -> peerId

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  const ip = fwd ? String(fwd).split(',')[0].trim() : req.socket.remoteAddress || '';
  return ip.replace(/^::ffff:/, '');
}

// Cung IP public => rat nhieu kha nang cung mot mang LAN/WiFi
function lanRoom(ip) {
  return 'lan:' + crypto.createHash('sha256').update('lan|' + ip).digest('hex').slice(0, 16);
}

function peerInfo(p) {
  return { id: p.id, name: p.name, device: p.device, lan: p.lanKey };
}

function visiblePeers(p) {
  const out = [];
  for (const q of peers.values()) {
    if (q === p) continue;
    for (const r of q.rooms) if (p.rooms.has(r)) { out.push(q); break; }
  }
  return out;
}

function send(p, msg) {
  if (p.ws.readyState === 1) p.ws.send(JSON.stringify(msg));
}

function pushList(p) {
  send(p, {
    t: 'peers',
    peers: visiblePeers(p).map(q => ({ ...peerInfo(q), sameLan: q.lanKey === p.lanKey }))
  });
}

// Cap nhat danh sach cho chinh peer va moi peer dang nhin thay no
function refresh(p, alsoNotify = []) {
  const targets = new Set([p, ...visiblePeers(p), ...alsoNotify]);
  for (const q of targets) pushList(q);
}

/* ---------- Signaling ---------- */
const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws, req) => {
  const ip = clientIp(req);
  const id = crypto.randomUUID();
  const code = newCode();
  const peer = {
    id, ws, code,
    name: displayName(id),
    device: deviceOf(req.headers['user-agent']),
    lanKey: lanRoom(ip),
    rooms: new Set([lanRoom(ip), 'p:' + id]),
    alive: true
  };
  peers.set(id, peer);
  codes.set(code, id);

  send(peer, { t: 'welcome', ...peerInfo(peer), code, iceServers });
  refresh(peer);

  ws.on('pong', () => { peer.alive = true; });

  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }

    switch (m.t) {
      case 'rename': {
        const name = String(m.name || '').trim().slice(0, 24);
        if (name) { peer.name = name; refresh(peer); }
        break;
      }
      case 'join': {
        const c = String(m.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
        const ownerId = codes.get(c);
        if (!ownerId || ownerId === id) return send(peer, { t: 'join-result', ok: false, code: c });
        const owner = peers.get(ownerId);
        peer.rooms.add('p:' + ownerId);
        send(peer, { t: 'join-result', ok: true, code: c, peer: peerInfo(owner) });
        refresh(peer, [owner]);
        break;
      }
      case 'signal': {
        const target = peers.get(m.to);
        // Chi chuyen tiep giua hai peer co chung phong -> tranh quet ID nguoi la
        if (!target || ![...target.rooms].some(r => peer.rooms.has(r))) return;
        send(target, { t: 'signal', from: id, data: m.data });
        break;
      }
    }
  });

  ws.on('close', () => {
    const others = visiblePeers(peer);
    peers.delete(id);
    codes.delete(code);
    for (const q of others) {
      send(q, { t: 'peer-left', id });
      pushList(q);
    }
  });
});

const hb = setInterval(() => {
  for (const p of peers.values()) {
    if (!p.alive) { p.ws.terminate(); continue; }
    p.alive = false;
    try { p.ws.ping(); } catch { /* socket dang dong */ }
  }
}, 25000);
hb.unref();

/* ---------- Servers ---------- */
function attach(server) {
  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url, 'http://x').pathname !== '/ws') return socket.destroy();
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });
  return server;
}

function lanIps() {
  return Object.values(os.networkInterfaces()).flat()
    .filter(i => i && i.family === 'IPv4' && !i.internal)
    .map(i => i.address);
}

async function tlsOptions() {
  const dir = path.join(ROOT, '.cert');
  const keyFile = path.join(dir, 'key.pem');
  const certFile = path.join(dir, 'cert.pem');
  if (fs.existsSync(keyFile) && fs.existsSync(certFile)) {
    return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
  }
  const selfsigned = await import('selfsigned').then(m => m.default || m);
  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
    ...lanIps().map(ip => ({ type: 7, ip }))
  ];
  const pems = selfsigned.generate([{ name: 'commonName', value: 'shared-files.local' }], {
    days: 3650, keySize: 2048, algorithm: 'sha256', extensions: [{ name: 'subjectAltName', altNames }]
  });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(keyFile, pems.private);
  fs.writeFileSync(certFile, pems.cert);
  return { key: pems.private, cert: pems.cert };
}

const ready = { http: null, https: null };

async function banner() {
  const ip = lanIps()[0];
  const best = ready.https && ip ? `https://${ip}:${HTTPS_PORT}`
    : ip ? `http://${ip}:${HTTP_PORT}`
    : `http://localhost:${HTTP_PORT}`;

  console.log('\n  ' + '='.repeat(56));
  console.log('   Shared Files - chia se file P2P toc do cao');
  console.log('  ' + '='.repeat(56));
  console.log('\n  May nay          : http://localhost:' + HTTP_PORT);
  if (lanIps().length) {
    console.log('  May khac cung wifi: ' + lanIps().map(i => `http://${i}:${HTTP_PORT}`).join('\n' + ' '.repeat(22)));
  }
  if (ready.https) {
    console.log('\n  Dien thoai (nen dung ban HTTPS de stream file lon + copy clipboard):');
    console.log('                     ' + lanIps().concat('localhost').map(i => `https://${i}:${HTTPS_PORT}`).join('\n' + ' '.repeat(21)));
    console.log('\n  Chung chi tu ky -> trinh duyet canh bao 1 lan:');
    console.log('  bam "Advanced / Nang cao" -> "Proceed / Tiep tuc".');
  }

  try {
    console.log('\n  Quet QR bang camera dien thoai de mo ' + best + ':\n');
    console.log(await QRCode.toString(best, { type: 'terminal', small: true }));
  } catch { /* terminal khong ve duoc QR thi thoi */ }
  console.log('  Dung: Ctrl + C\n');
}

attach(createHttp(app)).listen(HTTP_PORT, '0.0.0.0', () => { ready.http = true; });

if (ENABLE_HTTPS) {
  try {
    const server = attach(createHttps(await tlsOptions(), app));
    server.on('error', e => console.warn('  Bo qua HTTPS:', e.message));
    await new Promise(res => server.listen(HTTPS_PORT, '0.0.0.0', () => { ready.https = true; res(); }));
  } catch (e) {
    console.warn('  Bo qua HTTPS:', e.message);
  }
}

banner();
