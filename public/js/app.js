import { Link } from './rtc.js';
import { caps, chooseFolder, folderName, hasFolder, initServiceWorker, writerMode } from './writer.js';

const $ = s => document.querySelector(s);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const fmtBytes = b => {
  if (!Number.isFinite(b)) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b < 10 && i > 0 ? b.toFixed(1) : Math.round(b)} ${u[i]}`;
};
const fmtSpeed = s => s > 0 ? fmtBytes(s) + '/s' : '—';
const fmtEta = s => {
  if (!Number.isFinite(s) || s > 86400) return '—';
  if (s < 60) return `${Math.ceil(s)} giây`;
  if (s < 3600) return `${Math.round(s / 60)} phút`;
  return `${(s / 3600).toFixed(1)} giờ`;
};

const ICONS = { desktop: '🖥️', mobile: '📱', tablet: '📱' };
const ROUTE_LABEL = {
  lan: ['Mạng nội bộ', 'Đi thẳng trong LAN/WiFi — nhanh nhất'],
  p2p: ['P2P qua Internet', 'Đi thẳng máy ↔ máy, không qua server'],
  relay: ['Qua TURN', 'NAT chặn đường thẳng nên phải đi vòng qua relay']
};

const state = {
  me: null,
  iceServers: [],
  peers: new Map(),
  links: new Map(),
  staged: [],
  items: new Map(),
  autoAccept: localStorage.getItem('autoAccept') === '1'
};

let ws = null;
let retry = 0;

/* ---------------- signaling ---------------- */

function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);

  ws.onopen = () => { retry = 0; setStatus('online'); };
  ws.onclose = () => {
    setStatus('offline');
    for (const l of state.links.values()) l.close();
    state.links.clear();
    state.peers.clear();
    renderPeers();

    retry = Math.min(retry + 1, 6);
    setTimeout(connect, 500 * 2 ** retry);
  };
  ws.onmessage = e => handle(JSON.parse(e.data));
}

const wsSend = m => ws?.readyState === 1 && ws.send(JSON.stringify(m));

function handle(m) {
  switch (m.t) {
    case 'welcome':
      state.me = m;
      state.iceServers = m.iceServers;
      renderIdentity();
      joinFromUrl();
      break;

    case 'peers':
      state.peers = new Map(m.peers.map(p => [p.id, p]));
      for (const [id, link] of state.links) {
        if (!state.peers.has(id)) { link.close(); state.links.delete(id); }
      }
      renderPeers();
      break;

    case 'peer-left':
      state.links.get(m.id)?.close();
      state.links.delete(m.id);
      state.peers.delete(m.id);
      renderPeers();
      break;

    case 'join-result':
      if (m.ok) toast(`Đã kết nối với ${m.peer.name}`);
      else toast(`Không tìm thấy mã ${m.code}`, true);
      $('#joinCode').value = '';
      break;

    case 'signal':
      if (m.data?.connect) getLink(m.from);
      else getLink(m.from).accept(m.data);
      break;
  }
}

/* ---------------- kết nối P2P ---------------- */

function getLink(peerId) {
  let link = state.links.get(peerId);
  if (link && !link.closed) return link;

  // ID lớn hơn luôn là bên chào hàng -> hai bên không bao giờ cùng gửi offer
  const initiator = state.me.id > peerId;
  link = new Link({
    id: peerId,
    initiator,
    iceServers: state.iceServers,
    signal: data => wsSend({ t: 'signal', to: peerId, data })
  });
  state.links.set(peerId, link);
  wire(link, peerId);
  if (!initiator) wsSend({ t: 'signal', to: peerId, data: { connect: true } });
  return link;
}

function wire(link, peerId) {
  const nameOf = () => state.peers.get(peerId)?.name || 'Thiết bị';

  link.addEventListener('open', async () => {
    const route = await link.route();
    if (route) markRoute(peerId, route);
  });
  link.addEventListener('state', e => {
    if (e.detail === 'connected') link.route().then(r => r && markRoute(peerId, r));
  });

  link.addEventListener('tx-offer', e => upsertItem(e.detail.tid, {
    dir: 'up', peer: nameOf(), peerId, files: e.detail.files, total: e.detail.total, status: 'Đang chờ đồng ý…'
  }));
  link.addEventListener('tx-progress', e => progressItem(e.detail, 'Đang gửi'));
  link.addEventListener('tx-complete', e => finishItem(e.detail.tid, 'Đã gửi xong'));
  link.addEventListener('tx-rejected', tid => {
    finishItem(tid.detail, 'Bị từ chối', true);
    toast(`${nameOf()} đã từ chối`, true);
  });

  link.addEventListener('rx-offer', e => {
    const { tid, files, total } = e.detail;
    upsertItem(tid, { dir: 'down', peer: nameOf(), peerId, files, total, status: 'Chờ bạn đồng ý…' });
    if (state.autoAccept) return link.acceptOffer();
    askAccept(nameOf(), files, total).then(ok => {
      if (ok) link.acceptOffer();
      else { link.rejectOffer(); finishItem(tid, 'Đã từ chối', true); }
    });
  });
  link.addEventListener('rx-progress', e => progressItem(e.detail, 'Đang nhận'));
  link.addEventListener('rx-complete', e => {
    finishItem(e.detail.tid, writerMode() === 'folder' ? `Đã lưu vào ${folderName()}` : 'Đã tải xong');
    toast(`Nhận xong từ ${nameOf()}`);
  });

  link.addEventListener('text', e => showText(nameOf(), e.detail));
  link.addEventListener('closed', () => dropTransfers(peerId, 'Mất kết nối với thiết bị kia'));
  link.addEventListener('state', e => {
    if (e.detail === 'failed') dropTransfers(peerId, 'Kết nối thất bại');
  });
  link.addEventListener('cancelled', e => finishItem(e.detail, 'Đã huỷ', true));
  link.addEventListener('error', e => toast(e.detail, true));
}

// Peer biến mất giữa chừng: WebRTC không báo lỗi cho từng lượt truyền nên phải tự dọn
function dropTransfers(peerId, reason) {
  for (const [tid, item] of state.items) {
    if (item.peerId === peerId && !item.done) { finishItem(tid, reason, true); toast(reason, true); }
  }
}

function waitOpen(link, ms = 30000) {
  if (link.connected) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Không kết nối được tới thiết bị kia')), ms);
    link.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

async function sendTo(peerId, files) {
  if (!files.length) return;
  const link = getLink(peerId);
  try {
    setPeerBusy(peerId, true);
    await waitOpen(link);
    await link.send(files);
  } catch (e) {
    toast(e.message, true);
  } finally {
    setPeerBusy(peerId, false);
  }
}

/* ---------------- UI: danh tính & peer ---------------- */

function setStatus(s) {
  $('#status').className = 'status ' + s;
  $('#status').title = s === 'online' ? 'Đã kết nối máy chủ' : 'Mất kết nối, đang thử lại…';
}

function renderIdentity() {
  $('#myName').textContent = state.me.name;
  $('#myCode').textContent = state.me.code;
  const url = shareUrl();
  $('#shareUrl').value = url;
  $('#qr').src = '/api/qr?d=' + encodeURIComponent(url);
}

const shareUrl = () => `${location.origin}/#${state.me.code}`;

// Cập nhật tại chỗ chứ không dựng lại cả danh sách: có người vào/ra giữa chừng thì
// thẻ đang bấm dở không bị thay mất, và nhãn đường truyền đã dò được vẫn còn.
const cards = new Map();

function renderPeers() {
  const alive = new Set();
  for (const p of state.peers.values()) {
    alive.add(p.id);
    let card = cards.get(p.id);
    if (!card) { card = peerCard(p); cards.set(p.id, card); }
    card.querySelector('.peer-name').textContent = p.name;
    const list = $(p.sameLan ? '#lanList' : '#remoteList');
    if (card.parentElement !== list) list.appendChild(card);
  }
  for (const [id, card] of cards) {
    if (!alive.has(id)) { card.remove(); cards.delete(id); }
  }
  $('#lanEmpty').hidden = $('#lanList').childElementCount > 0;
  $('#remoteEmpty').hidden = $('#remoteList').childElementCount > 0;
}

function peerCard(p) {
  const card = el('button', 'peer');
  card.dataset.id = p.id;
  card.appendChild(el('span', 'peer-icon', ICONS[p.device] || '🖥️'));
  const body = el('span', 'peer-body');
  body.appendChild(el('span', 'peer-name', p.name));
  body.appendChild(el('span', 'peer-route', 'Bấm để gửi file'));
  card.appendChild(body);

  card.onclick = () => pickAndSend(p.id);
  card.ondragover = e => { e.preventDefault(); card.classList.add('drop'); };
  card.ondragleave = () => card.classList.remove('drop');
  card.ondrop = async e => {
    e.preventDefault();
    card.classList.remove('drop');
    const files = await filesFromDrop(e.dataTransfer);
    sendTo(p.id, files);
  };
  return card;
}

function markRoute(peerId, route) {
  const card = document.querySelector(`.peer[data-id="${peerId}"]`);
  if (!card) return;
  const [label, tip] = ROUTE_LABEL[route] || [];
  if (!label) return;
  card.querySelector('.peer-route').textContent = label;
  card.title = tip;
}

function setPeerBusy(peerId, busy) {
  document.querySelector(`.peer[data-id="${peerId}"]`)?.classList.toggle('busy', busy);
}

function pickAndSend(peerId) {
  if (state.staged.length) {
    const files = state.staged;
    clearStaged();
    return sendTo(peerId, files);
  }
  const input = el('input');
  input.type = 'file';
  input.multiple = true;
  input.onchange = () => sendTo(peerId, [...input.files]);
  input.click();
}

/* ---------------- UI: file đã chọn ---------------- */

function stage(files) {
  state.staged = files;
  const bar = $('#staged');
  bar.hidden = !files.length;
  if (!files.length) return;
  const total = files.reduce((a, f) => a + f.size, 0);
  $('#stagedText').textContent = `${files.length} file • ${fmtBytes(total)} — chọn thiết bị để gửi`;
}
const clearStaged = () => stage([]);

async function filesFromDrop(dt) {
  const items = [...(dt.items || [])];
  const entries = items.map(i => i.webkitGetAsEntry?.()).filter(Boolean);
  if (entries.some(e => e.isDirectory)) {
    const out = [];
    await Promise.all(entries.map(e => walk(e, '', out)));
    return out;
  }
  return [...dt.files];
}

function walk(entry, prefix, out) {
  if (entry.isFile) {
    return new Promise(res => entry.file(f => {
      // giữ đường dẫn tương đối để bên nhận dựng lại đúng cây thư mục
      Object.defineProperty(f, 'webkitRelativePath', { value: prefix + entry.name });
      out.push(f);
      res();
    }, res));
  }
  const reader = entry.createReader();
  return new Promise(res => {
    const batch = () => reader.readEntries(async list => {
      if (!list.length) return res();
      await Promise.all(list.map(e => walk(e, prefix + entry.name + '/', out)));
      batch();
    }, res);
    batch();
  });
}

/* ---------------- UI: tiến trình ---------------- */

function upsertItem(tid, data) {
  let item = state.items.get(tid);
  if (!item) {
    const node = el('div', 'item');
    node.innerHTML = `
      <div class="item-head">
        <span class="item-dir"></span>
        <span class="item-title"></span>
        <button class="item-cancel" title="Huỷ">✕</button>
      </div>
      <div class="bar"><i></i></div>
      <div class="item-meta"></div>`;
    $('#transfers').prepend(node);
    $('#transferSection').hidden = false;
    item = { node, ...data };
    state.items.set(tid, item);
    node.querySelector('.item-cancel').onclick = () => {
      for (const l of state.links.values()) if (l.tx?.tid === tid || l.rx?.tid === tid) l.cancel();
    };
  }
  Object.assign(item, data);
  const names = item.files.map(f => f.name);
  item.node.querySelector('.item-dir').textContent = item.dir === 'up' ? '⬆' : '⬇';
  item.node.querySelector('.item-title').textContent =
    (names.length === 1 ? names[0] : `${names.length} file`) + ` · ${item.dir === 'up' ? 'tới' : 'từ'} ${item.peer}`;
  item.node.querySelector('.item-meta').textContent = `${fmtBytes(item.total)} · ${item.status}`;
  return item;
}

function progressItem(stat, verb) {
  const item = state.items.get(stat.tid);
  if (!item || item.done) return;
  const pct = item.total ? Math.min(100, stat.bytes / item.total * 100) : 0;
  item.node.querySelector('.bar i').style.width = pct.toFixed(1) + '%';
  item.node.querySelector('.item-meta').textContent =
    `${fmtBytes(stat.bytes)} / ${fmtBytes(item.total)} · ${fmtSpeed(stat.speed)} · còn ${fmtEta(stat.eta)} · ${verb}`;
}

function finishItem(tid, status, failed = false) {
  const item = state.items.get(tid);
  if (!item) return;
  item.done = true;
  item.node.classList.add(failed ? 'failed' : 'ok');
  item.node.querySelector('.bar i').style.width = failed ? item.node.querySelector('.bar i').style.width : '100%';
  item.node.querySelector('.item-cancel').hidden = true;
  item.node.querySelector('.item-meta').textContent = `${fmtBytes(item.total)} · ${status}`;
}

/* ---------------- UI: hộp thoại, toast, text ---------------- */

function askAccept(name, files, total) {
  const dlg = $('#askDialog');
  $('#askTitle').textContent = `${name} muốn gửi cho bạn`;
  $('#askBody').textContent = files.length === 1
    ? `${files[0].name} · ${fmtBytes(total)}`
    : `${files.length} file · ${fmtBytes(total)}`;
  dlg.showModal();
  return new Promise(resolve => {
    dlg.onclose = () => resolve(dlg.returnValue === 'ok');
  });
}

function toast(msg, bad = false) {
  const n = el('div', 'toast' + (bad ? ' bad' : ''), msg);
  $('#toasts').appendChild(n);
  setTimeout(() => n.classList.add('out'), 3500);
  setTimeout(() => n.remove(), 4000);
}

function showText(name, text) {
  const box = $('#textIn');
  box.hidden = false;
  $('#textInFrom').textContent = `${name} đã gửi:`;
  $('#textInBody').textContent = text;
  $('#textCopy').onclick = () => navigator.clipboard.writeText(text).then(() => toast('Đã copy'));
}

/* ---------------- khởi động ---------------- */

function joinFromUrl() {
  const code = location.hash.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (code.length >= 4) {
    wsSend({ t: 'join', code });
    history.replaceState(null, '', location.pathname);
  }
}

function updateSaveMode() {
  const mode = writerMode();
  const text = {
    folder: `Lưu thẳng vào thư mục "${folderName()}" — nhanh nhất, không giới hạn dung lượng`,
    stream: 'File tải thẳng xuống thư mục Downloads (stream, không tốn RAM)',
    memory: 'File giữ tạm trong RAM rồi mới lưu — chỉ nên dùng cho file nhỏ'
  }[mode];
  $('#saveMode').textContent = text;
  $('#saveMode').className = 'save-mode ' + mode;
  $('#pickFolder').hidden = !caps.fsAccess;
  $('#pickFolder').textContent = hasFolder() ? 'Đổi thư mục lưu' : 'Chọn thư mục lưu';
}

function bindUi() {
  $('#pickFolder').onclick = async () => {
    try { await chooseFolder(); updateSaveMode(); toast('Đã chọn thư mục lưu'); }
    catch (e) { if (e.name !== 'AbortError') toast(e.message, true); }
  };

  $('#fileBtn').onclick = () => $('#fileInput').click();
  $('#folderBtn').onclick = () => $('#folderInput').click();
  $('#fileInput').onchange = e => stage([...e.target.files]);
  $('#folderInput').onchange = e => stage([...e.target.files]);
  $('#stagedClear').onclick = clearStaged;

  $('#joinForm').onsubmit = e => {
    e.preventDefault();
    const code = $('#joinCode').value.trim().toUpperCase();
    if (code) wsSend({ t: 'join', code });
  };

  $('#copyLink').onclick = () => navigator.clipboard.writeText(shareUrl()).then(() => toast('Đã copy link'));
  $('#copyCode').onclick = () => navigator.clipboard.writeText(state.me.code).then(() => toast('Đã copy mã'));

  $('#myName').onblur = () => {
    const name = $('#myName').textContent.trim();
    if (name && name !== state.me.name) { state.me.name = name; wsSend({ t: 'rename', name }); }
  };
  $('#myName').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); $('#myName').blur(); } };

  $('#autoAccept').checked = state.autoAccept;
  $('#autoAccept').onchange = e => {
    state.autoAccept = e.target.checked;
    localStorage.setItem('autoAccept', state.autoAccept ? '1' : '0');
  };

  $('#textSend').onclick = () => {
    const text = $('#textOut').value.trim();
    if (!text) return;
    const targets = [...state.links.values()].filter(l => l.connected);
    if (!targets.length) return toast('Chưa kết nối với thiết bị nào', true);
    targets.forEach(l => l.sendText(text));
    $('#textOut').value = '';
    toast(`Đã gửi tới ${targets.length} thiết bị`);
  };

  let depth = 0;
  document.addEventListener('dragenter', e => {
    if (![...e.dataTransfer.types].includes('Files')) return;
    depth++; $('#drop').hidden = false;
  });
  document.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; $('#drop').hidden = true; } });
  document.addEventListener('dragover', e => e.preventDefault());
  document.addEventListener('drop', async e => {
    e.preventDefault();
    depth = 0; $('#drop').hidden = true;
    if (e.target.closest('.peer')) return; // thả thẳng lên một thiết bị đã có handler riêng
    stage(await filesFromDrop(e.dataTransfer));
  });
}

bindUi();
initServiceWorker().then(updateSaveMode);
updateSaveMode();
connect();
