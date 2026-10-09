// The print theater: a PT-P700 drawn in a three-axis projection. Labels leave the slot flat,
// in line with the printer's depth axis, curl up to face the viewer, run to the right, and after
// the cut drop into a translucent bin where the stack builds up with the newest label on top.
//
// Timing follows the real printer: the tape runs on a clock at the printer's speed (PRINT in tape.js),
// starting when the printer reports it is moving. Out come the blank lead piece, then each label with
// its feed margins, with a short stop at every cut. The printer's "label printed" reports keep the clock
// honest: it catches up when it is behind, waits at a cut when it is ahead, and the measured gaps
// between reports correct the speed. When the job ends, whatever is left plays out quickly.
import { DOTS_PER_MM, PRINT } from './tape.js';

const HOLD_MAX_MS = 2500;    // longest the tape waits at a cut for the printer to report that label

// ---- projection ---------------------------------------------------------------------------
const norm = (x, y) => { const l = Math.hypot(x, y); return [x / l, y / l]; };
const D = norm(0.93, 0.37);        // depth axis: back -> front, toward the viewer (down-right on screen)
const Wv = norm(0.93, -0.36);      // width axis: left -> right across the front (up-right on screen)
const V = [0, 1];                  // height axis: top -> bottom
const DIM = { d: 270, w: 138, h: 252 };         // body proportions (152 × 78 × 143 mm), height exaggerated a touch for the low camera
const ORIGIN = [56, 58];                         // top-back-left corner on screen
const P = (d, w, h) => [ORIGIN[0] + d * D[0] + w * Wv[0] + h * V[0], ORIGIN[1] + d * D[1] + w * Wv[1] + h * V[1]];
const SLOT = { w: 0.5, h: 0.50 };               // slot centre as fractions of the front face (width, height)
const EXIT = P(DIM.d, DIM.w * SLOT.w, DIM.h * SLOT.h);   // screen point where the tape leaves the printer
const PATH = { flat: 24, bend: 80 };            // px along the tape path: flat, then curl up to face the viewer
const SLICE = 6;                                // px per tape slice
const BIN = { x: 500, y: 236, w: 390, h: 160 }; // translucent tray, scene coordinates

/** Position and orientation of the tape at arc length s from the slot. Returns { x, y, tx, ty, ux, uy }:
 *  (tx,ty) is the tangent (label x axis), (ux,uy) the "up" direction of the label (toward its top edge). */
function tapeFrame(s) {
  const t = Math.max(0, Math.min(1, (s - PATH.flat) / PATH.bend));      // 0 flat .. 1 upright
  const e = t * t * (3 - 2 * t);                                        // smoothstep
  const ang = Math.atan2(D[1], D[0]) * (1 - e);                          // tangent turns from D to +x
  const tx = Math.cos(ang), ty = Math.sin(ang);
  const ux = Wv[0] * (1 - e), uy = Wv[1] * (1 - e) + (-1) * e;           // up: W (flat) -> screen up (facing)
  let x, y;
  if (s <= PATH.flat) { x = EXIT[0] + s * D[0]; y = EXIT[1] + s * D[1]; }
  else {
    // integrate the turning tangent numerically (cheap: 12 steps)
    x = EXIT[0] + PATH.flat * D[0]; y = EXIT[1] + PATH.flat * D[1];
    const n = 12, len = Math.min(s, PATH.flat + PATH.bend) - PATH.flat, ds = len / n;
    for (let i = 0; i < n; i++) { const si = PATH.flat + (i + 0.5) * ds, tt = (si - PATH.flat) / PATH.bend, ee = tt * tt * (3 - 2 * tt), a = Math.atan2(D[1], D[0]) * (1 - ee); x += Math.cos(a) * ds; y += Math.sin(a) * ds; }
    if (s > PATH.flat + PATH.bend) x += s - PATH.flat - PATH.bend;
  }
  return { x, y, tx, ty, ux, uy };
}

export class PrintTheater {
  constructor(root) {
    this.root = root;
    this.svg = root.querySelector('#printerSvg');
    this.scene = root.querySelector('#scene');
    this.labelOut = root.querySelector('#labelOut');
    this.pile = root.querySelector('#pile');
    this.bar = root.querySelector('#thBar');
    this.status = root.querySelector('#thStatus');
    this.list = root.querySelector('#thList');
    this.title = root.querySelector('#thTitle');
    this.sub = root.querySelector('#thSub');
    this.btnCancel = root.querySelector('#thCancel');
    this.btnClose = root.querySelector('#thClose');
    this.btnFeedCut = root.querySelector('#thFeedCut');
    this.svg.setAttribute('viewBox', '0 0 920 420'); this.svg.setAttribute('width', '920'); this.svg.setAttribute('height', '420');
    // bin: back wall behind the pile, front wall in front of it
    this.binBack = document.createElement('div'); this.binBack.className = 'bin bin-back';
    this.binFront = document.createElement('div'); this.binFront.className = 'bin bin-front';
    for (const b of [this.binBack, this.binFront]) { b.style.left = `${BIN.x}px`; b.style.top = `${BIN.y}px`; b.style.width = `${BIN.w}px`; b.style.height = `${BIN.h}px`; }
    this.scene.insertBefore(this.binBack, this.pile);
    this.scene.appendChild(this.binFront);
    const lbl = document.createElement('div'); lbl.className = 'bin-label'; lbl.textContent = 'labels'; this.binFront.appendChild(lbl);
    this.pile.style.left = `${BIN.x + 18}px`; this.pile.style.width = `${BIN.w - 36}px`; this.pile.style.top = `${BIN.y}px`; this.pile.style.height = `${BIN.h - 8}px`; this.pile.style.right = 'auto'; this.pile.style.bottom = 'auto';
    this.blade = document.createElement('div'); this.blade.className = 'blade'; this.scene.appendChild(this.blade);
    this.spark = document.createElement('div'); this.spark.className = 'spark'; this.scene.appendChild(this.spark);
    this.blade.style.left = `${EXIT[0] + 2}px`;
    this.spark.style.left = `${EXIT[0] - 4}px`; this.spark.style.top = `${EXIT[1] - 5}px`;
    this.labelOut.style.left = '0px'; this.labelOut.style.top = '0px'; this.labelOut.style.width = '0'; this.labelOut.style.height = '0'; this.labelOut.style.transform = 'none';

  }

  // ---- the printer ----------------------------------------------------------------------
  drawPrinter(tapeLabel, tapePx = 26) {
    const { d, w, h } = DIM;
    const pt = (p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`;
    const poly = (...pts) => 'M' + pts.map(pt).join(' L') + ' Z';
    const m = (xb, yb, o) => `matrix(${xb[0]} ${xb[1]} ${yb[0]} ${yb[1]} ${o[0]} ${o[1]})`;   // plane transform
    const topM = m(D, Wv, P(0, 0, 0)), frontM = m(Wv, V, P(d, 0, 0)), sideM = m(D, V, P(0, 0, 0));
    const slotW = tapePx + 14, slotH = 9;
    const panelTop = 0, panelH = h * 0.74;
    this.svg.innerHTML = `
      <defs>
        <pattern id="dots" width="3.2" height="3.2" patternUnits="userSpaceOnUse" patternTransform="${topM}"><rect width="3.2" height="3.2" fill="#17191d"/><circle cx="1.6" cy="1.6" r="0.75" fill="#30333a"/></pattern>
        <linearGradient id="gSide" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f6f7f9"/><stop offset="1" stop-color="#dfe3ea"/></linearGradient>
        <linearGradient id="gFront" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#e9ecf1"/><stop offset="1" stop-color="#d3d8e0"/></linearGradient>
        <linearGradient id="gPanel" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2a2d33"/><stop offset="1" stop-color="#0f1114"/></linearGradient>
        <radialGradient id="gShadow"><stop offset="0" stop-color="rgba(0,0,0,.55)"/><stop offset="1" stop-color="rgba(0,0,0,0)"/></radialGradient>
      </defs>
      <ellipse cx="${(P(d / 2, w / 2, h)[0]).toFixed(0)}" cy="${(P(d / 2, w / 2, h)[1] + 8).toFixed(0)}" rx="${d * 0.62}" ry="26" fill="url(#gShadow)"/>
      <g class="body" stroke-linejoin="round">
        <!-- long white side (left) -->
        <path d="${poly(P(0, 0, 0), P(d, 0, 0), P(d, 0, h), P(0, 0, h))}" fill="url(#gSide)" stroke="#c4c9d2"/>
        <g transform="${sideM}">
          <rect x="${d * 0.30}" y="${h * 0.52}" width="44" height="34" rx="7" fill="#1b1e24" stroke="#3a3e46"/>
          <text x="${d * 0.30 + 22}" y="${h * 0.52 + 22}" text-anchor="middle" font-size="14" font-weight="700" font-family="Helvetica, Arial" fill="#e8eaf0">${tapeLabel || ''}</text>
        </g>
        <!-- front face -->
        <path d="${poly(P(d, 0, 0), P(d, w, 0), P(d, w, h), P(d, 0, h))}" fill="url(#gFront)" stroke="#c4c9d2"/>
        <g transform="${frontM}">
          <rect x="${w * 0.12}" y="${panelTop}" width="${w * 0.88}" height="${panelH}" rx="7" fill="url(#gPanel)"/>
          <text x="${w * 0.56}" y="${h * 0.14}" text-anchor="middle" font-size="17" font-family="Helvetica, Arial" font-weight="700" fill="#f2f3f5">brother</text>
          <rect x="${w * SLOT.w - slotW / 2}" y="${h * SLOT.h - slotH / 2}" width="${slotW}" height="${slotH}" rx="2.5" fill="#000"/>
          <rect x="${w * SLOT.w - slotW / 2 + 2}" y="${h * SLOT.h - slotH / 2 + 2}" width="${slotW - 4}" height="${slotH - 4}" rx="1.5" fill="#1d2026"/>
          <text x="${w * 0.56}" y="${h * 0.69}" text-anchor="middle" font-size="12" font-style="italic" font-family="'Snell Roundhand', 'Brush Script MT', Georgia, serif" fill="#e8eaf0">P-touch</text>
          <text x="${w * 0.56}" y="${h * 0.735}" text-anchor="middle" font-size="6.5" font-family="Helvetica, Arial" fill="#9aa1ad">P700</text>
          <line x1="${w * 0.5}" y1="${panelH + 2}" x2="${w * 0.5}" y2="${h}" stroke="#b9bfc9" stroke-width="1.2"/>
          <line x1="0" y1="${h * 0.94}" x2="${w}" y2="${h * 0.94}" stroke="#c4c9d2" stroke-width=".8"/>
        </g>
        <!-- black dotted top with the three buttons: cut, P-Lite, power -->
        <path d="${poly(P(0, 0, 0), P(0, w, 0), P(d, w, 0), P(d, 0, 0))}" fill="url(#dots)" stroke="#34373e" stroke-width="1.5"/>
        <g transform="${topM}" font-family="Helvetica, Arial" fill="#d4d8df" text-anchor="middle">
          <circle cx="${d * 0.80}" cy="${w * 0.22}" r="13" fill="#2b2e35" stroke="#4a4e57"/><text x="${d * 0.80}" y="${w * 0.22 + 4}" font-size="11">✂</text>
          <circle cx="${d * 0.80}" cy="${w * 0.52}" r="13" fill="#2b2e35" stroke="#4a4e57"/><text x="${d * 0.80}" y="${w * 0.52 + 4}" font-size="10" font-weight="700">P</text>
          <circle cx="${d * 0.80}" cy="${w * 0.78}" r="13" fill="#2b2e35" stroke="#4a4e57"/><text x="${d * 0.80}" y="${w * 0.78 + 4}" font-size="11">⏻</text>
          <circle class="led-power" cx="${d * 0.90}" cy="${w * 0.78}" r="2.6" fill="#3dff7a"/>
        </g>
      </g>`;
  }

  // ---- lifecycle ------------------------------------------------------------------------
  /** marginMm: feed margin at each end of a label; mmPerS: the printer's speed (measured on earlier jobs if known). */
  open({ labels, tapeMm, tapeLabel, onCancel, marginMm = 2, mmPerS = PRINT.mmPerS, onSpeed = null }) {
    this.labels = labels; this.tapeMm = tapeMm; this.onSpeed = onSpeed;
    const pins = labels[0]?.height || 32;
    const margin = Math.round(Math.max(0, marginMm) * DOTS_PER_MM);
    // what physically leaves the slot: the blank lead piece, then each label with its feed margins
    this.pieces = [{ kind: 'leader', canvas: blankTape(Math.round(PRINT.leaderMm * DOTS_PER_MM), pins) },
      ...labels.map((l, i) => ({ kind: 'label', i, canvas: withMargins(l.canvas, margin, pins) }))];
    this.ends = [];
    let acc = 0;
    for (const p of this.pieces) { p.mm = p.canvas.width / DOTS_PER_MM; acc += p.mm; this.ends.push(acc); }
    this.totalMm = acc;
    const longest = Math.max(...this.pieces.map(p => p.canvas.width));
    const pathAvail = (BIN.x + BIN.w - 10) - EXIT[0] - PATH.flat - PATH.bend * 0.6;
    this.labelScale = Math.max(0.3, Math.min(1.6, 70 / pins, pathAvail / longest));
    this.drawPrinter(tapeLabel, Math.round(pins * this.labelScale));
    this.blade.style.top = `${EXIT[1] - (pins * this.labelScale) / 2 - 40}px`;
    this.pile.innerHTML = ''; this.labelOut.innerHTML = ''; this.list.innerHTML = '';
    this.status.textContent = 'Sending the job…'; this.status.classList.remove('err');
    this.bar.style.width = '0%';
    this.title.textContent = 'Printing'; this.sub.textContent = `${labels.length} label${labels.length === 1 ? '' : 's'} on ${tapeLabel}`;
    this.btnCancel.classList.remove('hidden'); this.btnClose.classList.add('hidden'); this.btnFeedCut.classList.add('hidden');
    this.btnCancel.onclick = onCancel;
    this.root.classList.remove('hidden');
    labels.forEach((l, i) => { const sp = document.createElement('span'); sp.textContent = l.name || `#${i + 1}`; sp.dataset.i = i; this.list.appendChild(sp); });
    this.job = { state: 'queued', index: 0, printed: 0, phase: '', sentAt: [], doneAt: [] }; this.chain = false;
    this.v = Math.max(8, Math.min(80, mmPerS || PRINT.mmPerS)); this.speeds = []; this.freeRun = false;
    this.st = { mode: 'wait', k: 0, d: 0, cutEnd: 0, holdSince: 0 };
    this.cur = null;
    if (this.raf) cancelAnimationFrame(this.raf);
    const run = this.run = (this._runId = (this._runId || 0) + 1);
    this.lastNow = performance.now();
    const loop = (now) => { if (this.run !== run) return; this._tick(now); if (this.st.mode !== 'stopped') this.raf = requestAnimationFrame(loop); };
    this.raf = requestAnimationFrame(loop);
  }

  close() { this.root.classList.add('hidden'); this.scene.classList.remove('printing'); this.run = -1; if (this.raf) cancelAnimationFrame(this.raf); }

  /** Called with every job update from the main process. */
  update(job, { chain = false } = {}) {
    const before = (this.job.doneAt || []).length;
    this.job = job; this.chain = chain;
    // Speed from the gaps between consecutive "label printed" reports. That gap is one label plus a cut,
    // whatever point of the tape path the printer reports from. The last report also includes the
    // final feed to the cutter, so it is left out.
    const done = job.doneAt || [];
    for (let i = Math.max(1, before); i < done.length && i < this.labels.length - 1; i++) {
      if (done[i] == null || done[i - 1] == null) continue;
      const secs = (done[i] - done[i - 1]) / 1000 - PRINT.cutS, v = this.pieces[i + 1].mm / secs;
      if (secs > 0.2 && v >= 8 && v <= 80) { this.speeds.push(v); this.v = this.v * 0.4 + v * 0.6; }
    }
    if (job.state === 'error' || job.state === 'cancelled') { this.st.mode = 'stopped'; this._end(); }
  }

  /** Tape (mm) the printer has provably fed: it reports a label once the head has printed it, a lead piece's length before that label is cut. */
  _reportedMm() { const n = Math.min(this.job.printed || 0, this.labels.length); return n ? this.ends[n] - PRINT.leaderMm : 0; }
  _reported(p) { return p.kind !== 'label' || (this.job.printed || 0) > p.i || this.job.state === 'done'; }

  _tick(now) {
    const dt = Math.min(0.1, Math.max(0, (now - this.lastNow) / 1000));
    this.lastNow = now;
    const st = this.st, job = this.job, ended = job.state === 'done';
    if (st.mode === 'stopped') return;
    if (st.mode === 'wait') {
      const start = job.movingAt || (job.sentAt && job.sentAt[0] != null ? job.sentAt[0] + PRINT.startS * 1000 : null);
      if (ended) st.mode = 'finish';
      else if (start != null && Date.now() >= start) st.mode = 'run';
      else { if (job.sentAt && job.sentAt[0] != null) this.status.textContent = 'Waiting for the printer…'; return; }
      this.scene.classList.add('printing');
      this._beginPiece();
    }
    if (st.mode === 'cut' || st.mode === 'finishcut') {
      if (now < st.cutEnd) return this._paint();
      st.k++;
      if (st.k >= this.pieces.length) { st.mode = 'out'; this.cur = null; this.labelOut.innerHTML = ''; }
      else { st.mode = st.mode === 'finishcut' ? 'finish' : 'run'; this._beginPiece(); }
    }
    if (st.mode === 'out') { this.bar.style.width = '100%'; if (ended) { st.mode = 'stopped'; this._end(); } return; }
    if (ended && st.mode !== 'finish') st.mode = 'finish';                 // the printer is done: play out the rest quickly
    if (st.mode === 'hold') {
      if (this._reported(this.pieces[st.k])) this._cut(now);
      else if (now - st.holdSince > HOLD_MAX_MS) { this.freeRun = true; this._cut(now); }   // this printer does not report each label
      return this._paint();
    }
    let v = this.v;
    const behind = this._reportedMm() - st.d;
    if (behind > 2) v *= Math.min(4, 1 + behind / 15);                     // the printer is ahead of us: catch up
    if (st.mode === 'finish') v = Math.max(this.v * 4, (this.totalMm - st.d) / 0.8);
    st.d = Math.min(this.ends[st.k], st.d + v * dt);
    if (st.d >= this.ends[st.k] - 1e-6) {
      const p = this.pieces[st.k];
      if (st.mode !== 'finish' && !this.freeRun && !this._reported(p)) { st.mode = 'hold'; st.holdSince = now; }   // ahead of the printer: wait
      else this._cut(now);
    }
    this._paint();
  }

  _beginPiece() {
    const p = this.pieces[this.st.k], n = this.labels.length;
    this.cur = this._buildSlices(p.canvas);
    this.list.querySelectorAll('span').forEach(sp => sp.classList.toggle('cur', p.kind === 'label' && +sp.dataset.i === p.i));
    this.status.textContent = p.kind === 'leader' ? 'Feeding the blank lead piece…' : `Label ${p.i + 1} of ${n}  ·  ${this.labels[p.i].name || ''}`;
  }

  _paint() {
    const st = this.st;
    if (this.cur) this._layout((st.d - (st.k ? this.ends[st.k - 1] : 0)) * DOTS_PER_MM * this.labelScale);
    this.bar.style.width = `${Math.min(100, (st.d / this.totalMm) * 100).toFixed(2)}%`;
  }

  _cut(now) {
    const st = this.st, p = this.pieces[st.k];
    const lastLabel = p.kind === 'label' && p.i === this.labels.length - 1;
    if (!(this.chain && lastLabel)) {
      this.blade.classList.remove('snap'); void this.blade.offsetWidth; this.blade.classList.add('snap');
      this.spark.classList.remove('go'); void this.spark.offsetWidth; this.spark.classList.add('go');
      this._drop(p);
    }
    if (p.kind === 'label') this.list.querySelectorAll('span').forEach(sp => { if (+sp.dataset.i === p.i) { sp.classList.remove('cur'); sp.classList.add('done'); sp.scrollIntoView({ block: 'nearest' }); } });
    const fast = st.mode === 'finish';
    st.mode = fast ? 'finishcut' : 'cut';
    st.cutEnd = now + (fast ? 120 : PRINT.cutS * 1000);
  }

  /** The finished job's message and buttons. */
  _end() {
    const j = this.job;
    this.scene.classList.remove('printing');
    if (j.state === 'done') {
      this.bar.style.width = '100%';
      this.status.textContent = (this.chain ? `Done. ${j.printed} printed; the last label is still inside the printer (press Feed & cut).` : `Done. ${j.printed} label${j.printed === 1 ? '' : 's'} printed and cut.`) + (j.warning ? ` Note: ${j.warning}` : '');
      if (this.speeds.length && this.onSpeed) this.onSpeed(this.speeds.slice().sort((a, b) => a - b)[this.speeds.length >> 1]);
    } else if (j.state === 'error') { this.status.textContent = `Error: ${j.error}`; this.status.classList.add('err'); }
    // a cancelled job never sends its final feed-and-cut page, so the last printed label stays inside
    const leftInside = j.state === 'cancelled' && (j.printed > 0 || !!j.phase);
    if (j.state === 'cancelled') this.status.textContent = `Cancelled after ${j.printed} label${j.printed === 1 ? '' : 's'}.${leftInside ? ' The last one may still be inside the printer: press Feed & cut to get it out.' : ''}`;
    this.btnCancel.classList.add('hidden'); this.btnClose.classList.remove('hidden'); this.title.textContent = 'Finished';
    if ((j.state === 'done' && this.chain) || leftInside) this.btnFeedCut.classList.remove('hidden');
  }

  // ---- tape coming out of the slot ---------------------------------------------------------
  _buildSlices(canvas) {
    const s = this.labelScale, hPx = canvas.height * s, Wpx = canvas.width * s;
    const n = Math.ceil(Wpx / SLICE), slices = [];
    this.labelOut.innerHTML = '';
    for (let i = 0; i < n; i++) {
      const x0 = i * SLICE, wPx = Math.min(SLICE, Wpx - x0);
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(wPx / s)); c.height = canvas.height;
      c.getContext('2d').drawImage(canvas, Math.round(x0 / s), 0, c.width, canvas.height, 0, 0, c.width, canvas.height);
      c.className = 'slice'; c.style.width = `${wPx + 1.2}px`; c.style.height = `${hPx}px`;
      c.style.display = 'none';
      this.labelOut.appendChild(c);
      slices.push({ el: c, x0, w: wPx });
    }
    return { slices, hPx, Wpx };
  }

  /** Lay the slices along the path for an emerged length L (px). The piece's trailing end is at the slot. */
  _layout(L) {
    const { slices, hPx, Wpx } = this.cur;
    for (const sl of slices) {
      const sMid = L - (Wpx - (sl.x0 + sl.w / 2));         // distance of this slice from the slot
      if (sMid < 0) { if (sl.el.style.display !== 'none') sl.el.style.display = 'none'; continue; }
      const f = tapeFrame(Math.max(0, sMid - sl.w / 2));
      const ex = f.x + (hPx / 2) * f.ux, ey = f.y + (hPx / 2) * f.uy;    // top-left corner of the slice
      sl.el.style.display = 'block';
      sl.el.style.transform = `matrix(${f.tx.toFixed(4)},${f.ty.toFixed(4)},${(-f.ux).toFixed(4)},${(-f.uy).toFixed(4)},${ex.toFixed(1)},${ey.toFixed(1)})`;
    }
  }

  /** The cut piece drops into the bin: one flat canvas, scaled to the bin, newest on top. */
  _drop(p) {
    if (!this.cur) return;
    const c = p.canvas, binInner = BIN.w - 36, s = Math.min(this.labelScale, binInner / c.width, 40 / c.height);
    const el = document.createElement('canvas'); el.width = c.width; el.height = c.height; el.getContext('2d').drawImage(c, 0, 0);
    if (p.kind === 'leader') el.classList.add('chip');
    const lift = Math.min(BIN.h - 50, this.pile.children.length * 2.4);
    el.style.width = `${c.width * s}px`; el.style.height = `${c.height * s}px`;
    el.style.left = `${Math.max(0, (binInner - c.width * s) / 2) + (Math.random() * 10 - 5)}px`;
    el.style.bottom = `${8 + lift}px`;
    el.style.setProperty('--rot', `${(Math.random() * 4 - 2).toFixed(1)}deg`);
    this.pile.appendChild(el);
    const end = tapeFrame(Math.min(this.cur.Wpx, PATH.flat + PATH.bend + 10));
    const pileRect = this.pile.getBoundingClientRect(), sceneRect = this.scene.getBoundingClientRect();
    const targetX = pileRect.left - sceneRect.left + parseFloat(el.style.left), targetY = pileRect.bottom - sceneRect.top - parseFloat(el.style.bottom) - c.height * s;
    const dx = end.x - targetX, dy = (end.y - c.height * this.labelScale / 2) - targetY;
    el.animate([{ transform: `translate(${dx}px, ${dy}px) rotate(0deg)`, opacity: .95 }, { transform: 'translate(0,0) rotate(var(--rot))', opacity: 1 }], { duration: 650, easing: 'cubic-bezier(.3,.8,.4,1.05)', fill: 'forwards' });
    if (this.pile.children.length > 80) this.pile.removeChild(this.pile.firstChild);
    this.labelOut.innerHTML = ''; this.cur = null;
  }
}

function blankTape(w, h) {
  const c = document.createElement('canvas'); c.width = Math.max(1, w); c.height = h;
  const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, h);
  return c;
}
function withMargins(src, margin, h) { const c = blankTape(src.width + 2 * margin, h); c.getContext('2d').drawImage(src, margin, 0); return c; }
