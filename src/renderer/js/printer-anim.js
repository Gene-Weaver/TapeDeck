// The print theater: an animated PT-P700 that feeds, prints and cuts each label in sync with the job.
import { dotsToMm, FEED_MM_PER_S } from './tape.js';

const SVG_LEFT = 40, SVG_TOP = 20;          // where the SVG sits inside .scene (see app.css)
const SLOT = { x: 372, y: 161, w: 12, h: 26 }; // tape exit slot in SVG coordinates (y = centre line, h set per tape)
const MAX_LABEL_PX = 84;                     // tallest the emerging label is drawn

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
    this.blade.style.left = `${SVG_LEFT + SLOT.x + 2}px`;
    this.spark.style.left = `${SVG_LEFT + SLOT.x + 1}px`;
    this.queue = Promise.resolve();
    this.audio = null;
  }

  drawPrinter(tapeLabel, slotH = 26) {
    const sy = SLOT.y - slotH / 2;
    this.svg.innerHTML = `
      <defs>
        <linearGradient id="gBody" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#dfe3ea"/></linearGradient>
        <linearGradient id="gTop" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#d9dde5"/><stop offset="1" stop-color="#c3c8d2"/></linearGradient>
        <linearGradient id="gSide" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#b9bec9"/><stop offset="1" stop-color="#9aa0ac"/></linearGradient>
      </defs>
      <ellipse cx="250" cy="282" rx="190" ry="12" fill="rgba(0,0,0,.45)"/>
      <g class="body">
        <path d="M380 60 l26 -14 v212 l-26 14 z" fill="url(#gSide)"/>
        <path d="M120 46 l26 -14 h260 l-26 14 z" fill="#eef0f4"/>
        <rect x="120" y="46" width="260" height="226" rx="14" fill="url(#gBody)" stroke="#b7bcc7"/>
        <rect x="134" y="58" width="232" height="54" rx="9" fill="url(#gTop)"/>
        <circle cx="162" cy="84" r="10" fill="#f4f5f8" stroke="#a9afbb"/>
        <path d="M162 78 v7 M157 81 a6 6 0 1 0 10 0" stroke="#5b6270" stroke-width="1.6" fill="none" stroke-linecap="round"/>
        <circle class="led-power" cx="162" cy="103" r="2.6" fill="#3dff7a"/>
        <circle cx="200" cy="84" r="10" fill="#f4f5f8" stroke="#a9afbb"/>
        <text x="200" y="88" text-anchor="middle" font-size="9" font-family="Helvetica, Arial" font-weight="700" fill="#5b6270">P</text>
        <circle cx="200" cy="103" r="2.6" fill="#4a5a4f"/>
        <g transform="translate(290 62)">
          <rect x="0" y="0" width="68" height="46" rx="6" fill="#1f232b" stroke="#6b7280"/>
          <rect x="7" y="7" width="54" height="32" rx="4" fill="#2c313b" stroke="#4a5160"/>
          <circle cx="22" cy="23" r="7" fill="#1f232b" stroke="#8b93a3"/><circle cx="46" cy="23" r="7" fill="#1f232b" stroke="#8b93a3"/>
          <rect x="24" y="30" width="26" height="4" fill="#fafafa"/>
          <text x="34" y="20" text-anchor="middle" font-size="7" font-family="Helvetica, Arial" fill="#c9ccd3">${tapeLabel || ''}</text>
        </g>
        <rect x="134" y="124" width="232" height="134" rx="12" fill="#fbfcfd" stroke="#d6dae2"/>
        <text x="152" y="246" font-size="12" font-family="Helvetica, Arial" font-weight="700" fill="#8b93a3" letter-spacing="1">PT-P700</text>
        <rect x="${SLOT.x}" y="${sy}" width="${SLOT.w}" height="${slotH}" rx="3" fill="#15171c"/>
        <rect x="${SLOT.x + 3}" y="${sy + 3}" width="6" height="${slotH - 6}" rx="2" fill="#2a2e37"/>
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
    const outX = SVG_LEFT + SLOT.x + SLOT.w;
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
