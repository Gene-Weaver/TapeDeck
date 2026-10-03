// The print theater: an animated PT-P700 that feeds, prints and cuts each label in sync with the job.
import { dotsToMm, FEED_MM_PER_S } from './tape.js';

const SVG_LEFT = 40, SVG_TOP = 10;          // where the SVG sits inside .scene (see app.css)
// Three-quarter view: the narrow front face is a true rectangle on the right, the long white
// side recedes to the upper-left (cabinet projection, slope 50/190).
const FRONT = { x0: 330, x1: 430, y0: 118, y1: 292 };
const SLOT = { x: 372, y: 212, w: 50 };     // exit slot on the front panel; y = centre line, height set per tape
const EXIT_TILT = 9;                       // degrees: the label comes out toward the viewer
const MAX_LABEL_PX = 84;

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
    this.soundChk = root.querySelector('#thSound');
    this.blade = document.createElement('div'); this.blade.className = 'blade'; this.scene.appendChild(this.blade);
    this.spark = document.createElement('div'); this.spark.className = 'spark'; this.scene.appendChild(this.spark);
    this.blade.style.left = `${SVG_LEFT + SLOT.x + SLOT.w - 4}px`;
    this.spark.style.left = `${SVG_LEFT + SLOT.x + SLOT.w - 5}px`;
    this.labelOut.style.transformOrigin = 'left center';
    this.labelOut.style.transform = `rotate(${EXIT_TILT}deg)`;
    this.queue = Promise.resolve();
    this.audio = null;
  }

  drawPrinter(tapeLabel, slotH = 26) {
    const sy = SLOT.y - slotH / 2;
    const { x0, x1, y0, y1 } = FRONT;
    const dx = -175, dy = -108;                                  // receding edge of the long side (seen from above)
    const skew = Math.atan2(dy, dx) * 180 / Math.PI + 180;       // ~14.7°, used to draw on the side face
    this.svg.innerHTML = `
      <defs>
        <pattern id="dots" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="4" height="4" fill="#15171b"/><circle cx="2" cy="2" r="0.9" fill="#32353c"/></pattern>
        <linearGradient id="gSide" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#f7f8fa"/><stop offset="1" stop-color="#e4e7ec"/></linearGradient>
        <linearGradient id="gFront" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#eceef2"/><stop offset="1" stop-color="#d9dde4"/></linearGradient>
        <linearGradient id="gPanel" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2a2d33"/><stop offset="1" stop-color="#121418"/></linearGradient>
      </defs>
      <ellipse cx="${(x0 + x1) / 2 + dx / 2}" cy="${y1 + 6}" rx="190" ry="14" fill="rgba(0,0,0,.45)"/>
      <g class="body">
        <!-- long white side (receding) -->
        <path d="M${x0} ${y0} L${x0 + dx} ${y0 + dy} L${x0 + dx} ${y1 + dy} L${x0} ${y1} Z" fill="url(#gSide)" stroke="#c9ced7"/>
        <!-- tape-width badge on the side, drawn in the side face's plane -->
        <g transform="translate(${x0 + dx + 60} ${y0 + dy + 150}) skewY(${skew.toFixed(2)})">
          <rect x="0" y="0" width="54" height="40" rx="7" fill="#1d2026" stroke="#3a3e46"/>
          <text x="27" y="26" text-anchor="middle" font-size="15" font-weight="700" font-family="Helvetica, Arial" fill="#e8eaf0">${tapeLabel || ''}</text>
        </g>
        <!-- front face -->
        <rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" rx="6" fill="url(#gFront)" stroke="#c9ced7"/>
        <!-- black front panel with logo and slot -->
        <rect x="${x0 + 14}" y="${y0}" width="${x1 - x0 - 14}" height="${y1 - y0 - 60}" rx="8" fill="url(#gPanel)"/>
        <text x="${x0 + 14 + (x1 - x0 - 14) / 2}" y="${y0 + 34}" text-anchor="middle" font-size="15" font-family="Helvetica, Arial" font-weight="700" letter-spacing=".3" fill="#f2f3f5">brother</text>
        <rect x="${SLOT.x}" y="${sy}" width="${SLOT.w}" height="${slotH}" rx="3" fill="#000"/>
        <rect x="${SLOT.x + 3}" y="${sy + 3}" width="${SLOT.w - 6}" height="${slotH - 6}" rx="2" fill="#1f2228"/>
        <text x="${x0 + 22}" y="${y1 - 24}" font-size="12" font-style="italic" font-family="Georgia, serif" fill="#8b93a3">P-touch</text>
        <line x1="${x0}" y1="${y1 - 12}" x2="${x1}" y2="${y1 - 12}" stroke="#c9ced7"/>
        <!-- black dotted top -->
        <path d="M${x0} ${y0} L${x1} ${y0} L${x1 + dx} ${y0 + dy} L${x0 + dx} ${y0 + dy} Z" fill="url(#dots)" stroke="#2a2d33"/>
        <path d="M${x0} ${y0} L${x1} ${y0} L${x1 + dx} ${y0 + dy} L${x0 + dx} ${y0 + dy} Z" fill="none" stroke="#3a3e46" stroke-width="1.5"/>
        <!-- three buttons along the top, near the front: feed/cut, P-Lite, power -->
        <g font-family="Helvetica, Arial" font-size="9" fill="#cfd3da">
          <ellipse cx="${x0 + 50 + dx * 0.62}" cy="${y0 + dy * 0.62}" rx="13" ry="8" fill="#2b2e35" stroke="#4a4e57"/>
          <text x="${x0 + 50 + dx * 0.62}" y="${y0 + 3 + dy * 0.62}" text-anchor="middle" font-size="9">✂</text>
          <ellipse cx="${x0 + 50 + dx * 0.40}" cy="${y0 + dy * 0.40}" rx="13" ry="8" fill="#2b2e35" stroke="#4a4e57"/>
          <text x="${x0 + 50 + dx * 0.40}" y="${y0 + 3 + dy * 0.40}" text-anchor="middle" font-size="8" font-weight="700">P</text>
          <ellipse cx="${x0 + 50 + dx * 0.20}" cy="${y0 + dy * 0.20}" rx="13" ry="8" fill="#2b2e35" stroke="#4a4e57"/>
          <text x="${x0 + 50 + dx * 0.20}" y="${y0 + 3 + dy * 0.20}" text-anchor="middle" font-size="9">⏻</text>
          <circle class="led-power" cx="${x0 + 68 + dx * 0.20}" cy="${y0 + dy * 0.20}" r="2.2" fill="#3dff7a"/>
        </g>
      </g>`;
  }

  // ---- lifecycle ---------------------------------------------------------
  open({ labels, tapeMm, tapeLabel, onCancel }) {
    this.labels = labels; this.tapeMm = tapeMm;
    const pins = labels[0]?.height || 32;
    this.labelScale = Math.min(2, MAX_LABEL_PX / pins);
    this.drawPrinter(tapeLabel, Math.round(pins * this.labelScale) + 10);
    this.blade.style.top = `${SVG_TOP + SLOT.y - (pins * this.labelScale) / 2 - 40}px`;
    this.spark.style.top = `${SVG_TOP + SLOT.y - 5}px`;
    this.pile.innerHTML = ''; this.labelOut.innerHTML = ''; this.list.innerHTML = '';
    this.status.textContent = 'Sending job…'; this.status.classList.remove('err');
    this.bar.style.width = '0%';
    this.title.textContent = 'Printing'; this.sub.textContent = `${labels.length} label${labels.length === 1 ? '' : 's'} on ${tapeLabel}`;
    this.btnCancel.classList.remove('hidden'); this.btnClose.classList.add('hidden'); this.btnFeedCut.classList.add('hidden');
    this.btnCancel.onclick = onCancel;
    this.root.classList.remove('hidden');
    this.started = new Set(); this.cut = new Set(); this.queue = Promise.resolve();
    labels.forEach((l, i) => { const s = document.createElement('span'); s.textContent = l.name || `#${i + 1}`; s.dataset.i = i; this.list.appendChild(s); });
    this.shown = -1;
  }

  close() { this.root.classList.add('hidden'); this.scene.classList.remove('printing'); this._hum(false); }

  /** Feed job progress from the server poll. */
  update(job, { chain = false } = {}) {
    this.chain = chain;
    const n = this.labels.length;
    for (let i = 0; i < job.printed; i++) this._ensure(i, true);
    if ((job.phase === 'sending' || job.phase === 'printing') && job.state === 'printing') this._ensure(job.index, false);
    this.bar.style.width = `${(job.printed / n) * 100}%`;
    if (job.state === 'printing') {
      const cur = this.labels[job.index];
      this.status.textContent = `Label ${job.index + 1} / ${n}  ·  ${cur ? cur.name : ''}  ·  ${job.phase}`;
    } else if (job.state === 'done') {
      this.queue = this.queue.then(() => {
        this.status.textContent = this.chain
          ? `Done. ${job.printed} label${job.printed === 1 ? '' : 's'} printed. The last one is still inside the printer (chain printing): it comes out with your next print, or press Feed & cut.`
          : `Done. ${job.printed} label${job.printed === 1 ? '' : 's'} printed and cut.`;
        this._finish();
        if (this.chain) this.btnFeedCut.classList.remove('hidden');
      });
    } else if (job.state === 'error') {
      this.queue = this.queue.then(() => { this.status.textContent = `Error: ${job.error}`; this.status.classList.add('err'); this._finish(); });
    } else if (job.state === 'cancelled') {
      this.queue = this.queue.then(() => { this.status.textContent = `Cancelled after ${job.printed} label(s).`; this._finish(); });
    }
  }

  _finish() {
    this.scene.classList.remove('printing'); this._hum(false);
    this.btnCancel.classList.add('hidden'); this.btnClose.classList.remove('hidden');
    this.title.textContent = 'Finished';
  }

  _ensure(i, done) {
    if (i >= this.labels.length) return;
    if (!this.started.has(i)) { this.started.add(i); this.queue = this.queue.then(() => this._animateStart(i)); }
    const isLast = i === this.labels.length - 1;
    if (done && !this.cut.has(i) && !(this.chain && isLast)) { this.cut.add(i); this.queue = this.queue.then(() => this._animateCut(i)); }
  }

  _scaleFor(label) {
    const availW = this.scene.clientWidth - (SVG_LEFT + SLOT.x + SLOT.w) - 24;
    return Math.max(0.3, Math.min(this.labelScale, availW / label.width));
  }

  async _animateStart(i) {
    const label = this.labels[i];
    this.scene.classList.add('printing'); this._hum(true);
    this.list.querySelectorAll('span').forEach(s => s.classList.toggle('cur', +s.dataset.i === i));
    const s = this._scaleFor(label);
    const c = document.createElement('canvas');
    c.width = label.width; c.height = label.height;
    c.getContext('2d').drawImage(label.canvas, 0, 0);
    c.style.width = `${label.width * s}px`; c.style.height = `${label.height * s}px`;
    const outX = SVG_LEFT + SLOT.x + SLOT.w - 2;
    this.labelOut.style.left = `${outX}px`;
    this.labelOut.style.top = `${SVG_TOP + SLOT.y}px`;
    this.labelOut.style.width = `${this.scene.clientWidth - outX}px`;
    this.labelOut.innerHTML = ''; this.labelOut.appendChild(c);
    const mm = dotsToMm(label.width) + 4;
    const dur = Math.max(600, Math.min(6000, (mm / FEED_MM_PER_S) * 1000));
    const wPx = label.width * s;
    this.currentAnim = c.animate([{ transform: `translateX(${-wPx}px)` }, { transform: 'translateX(0)' }], { duration: dur, easing: 'linear', fill: 'forwards' });
    this.currentCanvas = c;
    await this.currentAnim.finished.catch(() => {});
  }

  async _animateCut(i) {
    const c = this.currentCanvas; if (!c) return;
    this.blade.classList.remove('snap'); void this.blade.offsetWidth; this.blade.classList.add('snap');
    this.spark.classList.remove('go'); void this.spark.offsetWidth; this.spark.classList.add('go');
    this._click();
    await wait(200);
    const p = c.cloneNode(true); p.getContext('2d').drawImage(c, 0, 0);
    const count = this.pile.children.length;
    p.style.width = `${parseFloat(c.style.width) * 0.6}px`; p.style.height = `${parseFloat(c.style.height) * 0.6}px`;
    p.style.left = `${Math.min(40, count * 1.5) + (Math.random() * 16 - 8)}px`;
    p.style.bottom = `${Math.min(70, count * 2.2)}px`;
    p.style.setProperty('--dx', `${(Math.random() * 30 - 15).toFixed(0)}px`);
    p.style.setProperty('--rot', `${(Math.random() * 10 - 5).toFixed(1)}deg`);
    p.classList.add('drop');
    this.pile.appendChild(p);
    if (this.pile.children.length > 60) this.pile.removeChild(this.pile.firstChild);
    this.labelOut.innerHTML = ''; this.currentCanvas = null;
    this.list.querySelectorAll('span').forEach(s => { if (+s.dataset.i === i) { s.classList.remove('cur'); s.classList.add('done'); s.scrollIntoView({ block: 'nearest' }); } });
    await wait(250);
  }

  // ---- sound -------------------------------------------------------------
  _ctx() {
    if (!this.soundChk.checked) return null;
    if (!this.audio) { try { this.audio = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; } }
    if (this.audio.state === 'suspended') this.audio.resume();
    return this.audio;
  }
  _hum(on) {
    const a = this._ctx();
    if (!on || !a) { if (this.humNode) { try { this.humNode.gain.gain.linearRampToValueAtTime(0, (this.audio?.currentTime || 0) + .1); setTimeout(() => this.humNode?.osc.stop(), 150); } catch {} this.humNode = null; } return; }
    if (this.humNode) return;
    const osc = a.createOscillator(), gain = a.createGain(), lfo = a.createOscillator(), lg = a.createGain();
    osc.type = 'sawtooth'; osc.frequency.value = 95; gain.gain.value = 0.0; gain.gain.linearRampToValueAtTime(0.025, a.currentTime + .15);
    lfo.frequency.value = 18; lg.gain.value = 12; lfo.connect(lg); lg.connect(osc.frequency);
    osc.connect(gain); gain.connect(a.destination); osc.start(); lfo.start();
    this.humNode = { osc, gain };
  }
  _click() {
    const a = this._ctx(); if (!a) return;
    const n = a.sampleRate * 0.06, buf = a.createBuffer(1, n, a.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 3);
    const src = a.createBufferSource(), g = a.createGain(); g.gain.value = 0.35;
    src.buffer = buf; src.connect(g); g.connect(a.destination); src.start();
  }
}

const wait = (ms) => new Promise(r => setTimeout(r, ms));
