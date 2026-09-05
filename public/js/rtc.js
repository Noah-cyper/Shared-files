import { createWriter, writerMode } from './writer.js';

/* Một Link = một kết nối WebRTC tới đúng một máy khác.
   Dữ liệu đi thẳng máy ↔ máy; server chỉ dùng để trao đổi SDP/ICE.

   Tốc độ đến từ 4 thứ:
   - nhiều DataChannel song song, mỗi channel tự "bốc" chunk kế tiếp (channel nhanh kéo nhiều hơn)
   - channel để unordered nên một gói chậm không chặn cả dòng (bỏ head-of-line blocking)
   - chunk lớn nhất mà SCTP của trình duyệt cho phép (tối đa 256 KB)
   - đọc file bằng slice().arrayBuffer() nên không bao giờ nạp cả file vào RAM */

const DATA_CHANNELS = 4;
const HDR = 12;                      // u32 fileIndex + f64 offset
// Chrome giới hạn tổng buffer SCTP của cả kết nối (~16 MB) và đóng channel nếu vượt,
// nên mỗi channel chỉ giữ 1 MB: đủ để không bao giờ rỗng ống, mà tổng vẫn rất an toàn.
const HI_WATER = 1 << 20;
const LO_WATER = 256 << 10;
const RX_PAUSE = 64 << 20;           // ghi đĩa không kịp -> bảo bên gửi dừng
const RX_RESUME = 16 << 20;

export class Link extends EventTarget {
  constructor({ id, initiator, iceServers, signal }) {
    super();
    this.id = id;
    this.initiator = initiator;
    this.signal = signal;
    this.tx = null;
    this.rx = null;
    this.closed = false;
    this.hiWater = HI_WATER;

    const pc = this.pc = new RTCPeerConnection({ iceServers, iceCandidatePoolSize: 4 });
    pc.onicecandidate = e => e.candidate && signal({ ice: e.candidate });
    pc.onconnectionstatechange = () => {
      this.emit('state', pc.connectionState);
      if (pc.connectionState === 'failed') pc.restartIce();
    };
    pc.onnegotiationneeded = async () => {
      if (!initiator) return; // chỉ một bên chào hàng -> không bao giờ đụng độ offer
      try {
        await pc.setLocalDescription();
        signal({ sdp: pc.localDescription });
      } catch (e) { this.emit('error', e.message); }
    };

    this.ctrl = pc.createDataChannel('ctrl', { negotiated: true, id: 0, ordered: true });
    this.ctrl.onmessage = e => this.onCtrl(JSON.parse(e.data));
    this.ctrl.onopen = () => this.emit('open');
    this.ctrl.onclose = () => this.emit('closed');

    this.data = [];
    for (let i = 0; i < DATA_CHANNELS; i++) {
      const ch = pc.createDataChannel('d' + i, { negotiated: true, id: i + 1, ordered: false });
      ch.binaryType = 'arraybuffer';
      ch.onmessage = e => this.onChunk(e.data);
      ch.onerror = e => {
        if (this.tx || this.rx) this.emit('error', 'Kênh dữ liệu lỗi: ' + (e.error?.message || 'đứt kết nối'));
      };
      this.data.push(ch);
    }
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  get connected() { return this.ctrl.readyState === 'open'; }

  get chunkSize() {
    const max = this.pc.sctp?.maxMessageSize || 65536;
    return Math.max(16384, Math.min(262144, max)) - HDR;
  }

  async accept({ sdp, ice }) {
    try {
      if (sdp) {
        await this.pc.setRemoteDescription(sdp);
        if (sdp.type === 'offer') {
          await this.pc.setLocalDescription();
          this.signal({ sdp: this.pc.localDescription });
        }
      } else if (ice) {
        await this.pc.addIceCandidate(ice);
      }
    } catch (e) { this.emit('error', e.message); }
  }

  /** 'lan' | 'p2p' | 'relay' | null - cho biết dữ liệu đang chạy đường nào */
  async route() {
    if (this.pc.connectionState !== 'connected') return null;
    const stats = await this.pc.getStats();
    let pair = null;
    for (const s of stats.values()) {
      if (s.type === 'candidate-pair' && s.state === 'succeeded' && (s.nominated || !pair)) pair = s;
    }
    if (!pair) return null;
    const local = stats.get(pair.localCandidateId);
    const remote = stats.get(pair.remoteCandidateId);
    if (local?.candidateType === 'relay' || remote?.candidateType === 'relay') return 'relay';
    if (local?.candidateType === 'host' && remote?.candidateType === 'host') return 'lan';
    return 'p2p';
  }

  ctrlSend(msg) { if (this.ctrl.readyState === 'open') this.ctrl.send(JSON.stringify(msg)); }

  sendText(text) { this.ctrlSend({ t: 'text', text }); }

  /* ---------------- gửi ---------------- */

  async send(files) {
    if (this.tx) throw new Error('Đang có một lượt gửi khác');
    const meta = files.map(f => ({
      name: f.name,
      path: f.webkitRelativePath || f.name,
      size: f.size,
      type: f.type
    }));
    const total = meta.reduce((a, f) => a + f.size, 0);
    const tid = crypto.randomUUID();
    this.tx = { tid, files, meta, total, sent: 0, paused: false, aborted: false, startedAt: 0 };
    this.ctrlSend({ t: 'offer', tid, files: meta, total });
    this.emit('tx-offer', { tid, files: meta, total });
    return tid;
  }

  async startSending() {
    const tx = this.tx;
    tx.startedAt = performance.now();
    const size = this.chunkSize;
    let fi = 0, off = 0;

    const next = () => {
      while (fi < tx.files.length && off >= tx.files[fi].size) { fi++; off = 0; }
      if (fi >= tx.files.length) return null;
      const job = { fi, off, len: Math.min(size, tx.files[fi].size - off) };
      off += job.len;
      return job;
    };

    const tick = setInterval(() => this.emit('tx-progress', this.stat(tx)), 250);
    try {
      await Promise.all(this.data.map(ch => this.pump(ch, tx, next)));
      if (!tx.aborted) {
        await this.drain(tx);
        this.ctrlSend({ t: 'done', tid: tx.tid });
      }
    } catch (e) {
      if (!tx.aborted) this.emit('error', e.message);
    } finally {
      clearInterval(tick);
      this.emit('tx-progress', this.stat(tx));
    }
  }

  async pump(ch, tx, next) {
    while (!tx.aborted && this.connected) {
      if (tx.paused) { await sleep(50); continue; }
      if (ch.readyState !== 'open') return;
      if (ch.bufferedAmount > this.hiWater) { await this.waitDrain(ch); continue; }

      const job = next();
      if (!job) return;
      const buf = await tx.files[job.fi].slice(job.off, job.off + job.len).arrayBuffer();
      if (tx.aborted || ch.readyState !== 'open') return;

      const out = new Uint8Array(HDR + buf.byteLength);
      const dv = new DataView(out.buffer);
      dv.setUint32(0, job.fi);
      dv.setFloat64(4, job.off);
      out.set(new Uint8Array(buf), HDR);
      ch.send(out);
      tx.sent += job.len;
    }
  }

  waitDrain(ch) {
    const low = Math.min(LO_WATER, this.hiWater / 2);
    return new Promise(resolve => {
      ch.bufferedAmountLowThreshold = low;
      if (ch.bufferedAmount <= low || ch.readyState !== 'open') return resolve();
      const done = () => {
        ch.removeEventListener('bufferedamountlow', done);
        ch.removeEventListener('close', done);
        resolve();
      };
      ch.addEventListener('bufferedamountlow', done);
      ch.addEventListener('close', done);
    });
  }

  async drain(tx) {
    while (!tx.aborted && this.data.some(ch => ch.readyState === 'open' && ch.bufferedAmount > 0)) {
      await sleep(60);
    }
  }

  stat(t) {
    const secs = t.startedAt ? (performance.now() - t.startedAt) / 1000 : 0;
    const done = t.sent ?? t.received;
    return {
      tid: t.tid, bytes: done, total: t.total,
      speed: secs > 0.3 ? done / secs : 0,
      eta: secs > 0.3 && done > 0 ? (t.total - done) / (done / secs) : Infinity
    };
  }

  /* ---------------- nhận ---------------- */

  async onCtrl(m) {
    switch (m.t) {
      case 'offer':
        this.rx = {
          tid: m.tid, meta: m.files, total: m.total, received: 0, startedAt: 0,
          perFile: m.files.map(() => 0), writers: [], queues: [], pending: 0, done: 0, aborted: false
        };
        this.emit('rx-offer', { tid: m.tid, files: m.files, total: m.total });
        break;

      case 'accept':
        if (this.tx?.tid === m.tid) {
          // Bên nhận phải ghi tuần tự -> giữ hàng đợi nhỏ để buffer sắp xếp lại chunk không phình RAM
          this.hiWater = m.reorder === false ? (512 << 10) : HI_WATER;
          this.startSending();
        }
        break;

      case 'reject':
        if (this.tx?.tid === m.tid) { this.tx = null; this.emit('tx-rejected', m.tid); }
        break;

      case 'pause': if (this.tx) this.tx.paused = true; break;
      case 'resume': if (this.tx) this.tx.paused = false; break;

      case 'cancel':
        if (this.tx?.tid === m.tid) { this.tx.aborted = true; this.tx = null; }
        if (this.rx?.tid === m.tid) await this.abortRx();
        this.emit('cancelled', m.tid);
        break;

      case 'complete':
        if (this.tx?.tid === m.tid) { this.emit('tx-complete', this.stat(this.tx)); this.tx = null; }
        break;

      case 'text':
        this.emit('text', m.text);
        break;
    }
  }

  acceptOffer() {
    const rx = this.rx;
    if (!rx) return;
    rx.startedAt = performance.now();
    rx.tick = setInterval(() => this.emit('rx-progress', this.stat({ ...rx, sent: rx.received })), 250);
    this.ctrlSend({ t: 'accept', tid: rx.tid, reorder: writerMode() !== 'stream' });
  }

  rejectOffer() {
    if (!this.rx) return;
    this.ctrlSend({ t: 'reject', tid: this.rx.tid });
    this.rx = null;
  }

  cancel() {
    const tid = this.tx?.tid || this.rx?.tid;
    if (!tid) return;
    this.ctrlSend({ t: 'cancel', tid });
    if (this.tx) { this.tx.aborted = true; this.tx = null; }
    if (this.rx) this.abortRx();
    this.emit('cancelled', tid);
  }

  async abortRx() {
    const rx = this.rx;
    if (!rx) return;
    rx.aborted = true;
    clearInterval(rx.tick);
    this.rx = null;
    for (const p of rx.writers) {
      try { (await p).abort(); } catch { /* writer chưa mở xong */ }
    }
  }

  onChunk(buf) {
    const rx = this.rx;
    if (!rx || rx.aborted) return;
    const dv = new DataView(buf);
    const fi = dv.getUint32(0);
    const off = dv.getFloat64(4);
    if (!rx.meta[fi]) return;
    const data = new Uint8Array(buf, HDR);

    rx.received += data.byteLength;
    rx.perFile[fi] += data.byteLength;
    rx.pending += data.byteLength;
    if (rx.pending > RX_PAUSE && !rx.throttled) { rx.throttled = true; this.ctrlSend({ t: 'pause' }); }

    if (!rx.writers[fi]) rx.writers[fi] = createWriter(rx.meta[fi]);
    const finished = rx.perFile[fi] >= rx.meta[fi].size;

    // Ghi tuần tự theo từng file: writer không chịu được nhiều lệnh write chồng nhau
    const prev = rx.queues[fi] || Promise.resolve();
    rx.queues[fi] = prev
      .then(async () => {
        const w = await rx.writers[fi];
        if (rx.aborted) return;
        await w.write(off, data);
        rx.pending -= data.byteLength;
        if (rx.throttled && rx.pending < RX_RESUME) { rx.throttled = false; this.ctrlSend({ t: 'resume' }); }
        if (finished) {
          await w.close();
          this.emit('rx-file', { index: fi, name: rx.meta[fi].name });
          if (++rx.done === rx.meta.length) this.finishRx(rx);
        }
      })
      .catch(async e => {
        if (rx.aborted) return;
        this.emit('error', 'Không ghi được file: ' + e.message);
        this.ctrlSend({ t: 'cancel', tid: rx.tid });
        await this.abortRx();
      });
  }

  finishRx(rx) {
    clearInterval(rx.tick);
    this.ctrlSend({ t: 'complete', tid: rx.tid });
    this.emit('rx-complete', this.stat({ ...rx, sent: rx.received }));
    if (this.rx === rx) this.rx = null;
  }

  close() {
    this.closed = true;
    if (this.tx) this.tx.aborted = true;
    this.abortRx();
    try { this.pc.close(); } catch { /* đã đóng */ }
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
