// The layout designer: the label drawn to scale on a canvas.
//  - click selects; dragging a row element slides it into a new slot while the others make room
//  - dragging a free element snaps it to the label ends, centers, tape edges and other elements
//  - dragging the gap between two row elements changes the space before the right one (⌥: all gaps)
//  - handles resize; heights snap to the full tape height, row widths to 0.5 mm steps
// All model lengths are dots (180 dpi); screen positions are CSS px relative to the tape's top-left.
import { tape, DOTS_PER_MM } from './tape.js';
import { renderLabel, composeLabel, measureLabelWidth } from './render.js';
import { arrange, snapBox, snapTargets, moveInRow, newElement, uid } from './layout.js';

const PAD_X = 28, PAD_TOP = 34, PAD_BOTTOM = 30;   // room around the tape: ruler above, caption below
const HANDLE = 8;                                   // resize handle size
const SNAP_PX = 7, DRAG_PX = 3;                     // snap distance, drag threshold
const COLOR = { accent: '#ffd84a', guide: '#ff4fa3', row: 'rgba(40,120,220,.55)', free: 'rgba(0,0,0,.45)', gap: 'rgba(78,161,255,.22)', pad: 'rgba(255,170,0,.13)' };
const CURSORS = { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize' };
const fmtMm = (dots) => { const mm = dots / DOTS_PER_MM; return `${mm.toFixed(mm < 10 ? 2 : 1).replace(/\.?0+$/, '')} mm`; };
const sideways = (el) => (((el.rotate || 0) % 180) + 180) % 180 !== 0;
const clampY = (y, h, H) => (h <= H ? Math.max(0, Math.min(H - h, y)) : Math.max(H - h, Math.min(0, y)));

export class Designer {
  constructor({ canvas, stage, getTapeMm, getLayout, getSample, onSelect, onCommit, onZoom, onFit, onEdit }) {
    Object.assign(this, { canvas, stage, getTapeMm, getLayout, getSample, onSelect, onCommit, onZoom, onFit, onEdit });
    this.ctx = canvas.getContext('2d');
    this.zoom = 6; this.snap = true;
    this.selectedId = null; this.hoverId = null; this.hoverGap = null; this.drag = null; this.res = null;
    this._bind();
  }

  get layout() { return this.getLayout(); }
  get H() { return tape(this.getTapeMm()).pins; }
  get selected() { return (this.layout && this.layout.elements.find(e => e.id === this.selectedId)) || null; }
  boxOf(id) { return (this.res && this.res.arr.boxes[id]) || null; }
  itemOf(id) { return (this.res && this.res.items.find(it => it.id === id)) || null; }
  elementById(id) { return this.layout.elements.find(e => e.id === id) || null; }

  select(id, notify = true) {
    if (id && !this.elementById(id)) id = null;
    const changed = id !== this.selectedId;
    this.selectedId = id;
    this.redraw();
    if (changed && notify && this.onSelect) this.onSelect(id);
  }

  setZoom(z) { this.zoom = Math.max(0.5, Math.min(12, z)); this.redraw(); }

  /** A zoom that shows the whole label in the stage. */
  fitZoom() {
    const W = this.layout ? measureLabelWidth(this.layout, this.getSample(), this.getTapeMm()) : 300;
    const availW = Math.max(200, this.stage.clientWidth - PAD_X * 2 - 24);
    return Math.max(0.5, Math.min(12, Math.floor(Math.min(availW / W, 260 / this.H) * 4) / 4));
  }

  // ---- drawing -------------------------------------------------------------------------------------
  /** Re-render the label from the model, then draw. */
  render() {
    const L = this.layout; if (!L) return;
    const d = this.drag;
    if (d && d.active && d.kind === 'row') {
      const arr = arrange(L, d.items, this.H, { order: d.order });
      this.res = { ...d.base, arr, canvas: composeLabel(L, arr, d.items, d.base.canvases, { exclude: d.id }) };
    } else {
      this.res = renderLabel(L, this.getSample(), this.getTapeMm());
    }
    this.redraw();
  }

  /** Draw the last rendered label with the current selection, hover and drag overlays. */
  redraw() {
    if (!this.res) { this.render(); return; }
    const res = this.res, z = this.zoom, W = res.arr.W, H = res.arr.H;
    const cssW = Math.round(W * z + PAD_X * 2), cssH = Math.round(H * z + PAD_TOP + PAD_BOTTOM);
    const dpr = window.devicePixelRatio || 1;
    if (this.canvas.width !== Math.round(cssW * dpr) || this.canvas.height !== Math.round(cssH * dpr)) {
      this.canvas.width = Math.round(cssW * dpr); this.canvas.height = Math.round(cssH * dpr);
    }
    this.canvas.style.width = `${cssW}px`; this.canvas.style.height = `${cssH}px`;
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    this._ruler(ctx, W, z);
    ctx.save();
    ctx.translate(PAD_X, PAD_TOP);
    ctx.shadowColor = 'rgba(0,0,0,.5)'; ctx.shadowBlur = 12; ctx.shadowOffsetY = 4;
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W * z, H * z);
    ctx.shadowColor = 'transparent';
    ctx.imageSmoothingEnabled = z < 1;            // crisp dots when enlarged, smooth when shrunk
    ctx.drawImage(res.canvas, 0, 0, W * z, H * z);
    this._grid(ctx, W, H, z);
    this._padding(ctx, res.arr, z);
    this._gapBand(ctx, res.arr, z);
    this._boxes(ctx, res, z);
    if (this.drag && this.drag.active) this._dragOverlay(ctx, res, z);
    ctx.restore();
    this._caption(ctx, res, cssH);
  }

  _ruler(ctx, W, z) {
    const mmPx = z * DOTS_PER_MM, total = W / DOTS_PER_MM;
    const every = mmPx >= 40 ? 1 : mmPx >= 14 ? 5 : 10, tick = mmPx >= 6 ? 1 : mmPx >= 2.5 ? 5 : 10;
    ctx.save();
    ctx.translate(PAD_X, PAD_TOP - 7);
    ctx.strokeStyle = '#5b6271'; ctx.fillStyle = '#8b93a3'; ctx.lineWidth = 1;
    ctx.font = '10px -apple-system, BlinkMacSystemFont, Helvetica, sans-serif'; ctx.textAlign = 'center';
    for (let m = 0; m <= total + 1e-9; m += tick) {
      const x = Math.round(m * mmPx) + 0.5, big = m % every === 0;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, big ? -7 : -4); ctx.stroke();
      if (big) ctx.fillText(m === 0 ? '0 mm' : String(m), x, -10);
    }
    ctx.restore();
  }

  _grid(ctx, W, H, z) {
    const mmPx = z * DOTS_PER_MM;
    if (mmPx < 6) return;
    ctx.lineWidth = 1;
    for (let k = 1; k * mmPx < W * z; k++) {
      ctx.strokeStyle = k % 5 === 0 ? 'rgba(0,120,255,.20)' : 'rgba(0,120,255,.09)';
      const x = Math.round(k * mmPx) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H * z); ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(0,120,255,.09)';
    for (let k = 1; k * mmPx < H * z; k++) { const y = Math.round(k * mmPx) + 0.5; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W * z, y); ctx.stroke(); }
    // the tape's center line
    ctx.strokeStyle = 'rgba(255,79,163,.18)'; ctx.setLineDash([2, 4]);
    const cy = Math.round(H * z / 2) + 0.5;
    ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(W * z, cy); ctx.stroke();
    ctx.setLineDash([]);
  }

  _padding(ctx, arr, z) {
    if (!arr.pad || arr.pad * z < 2) return;
    ctx.fillStyle = COLOR.pad;
    ctx.fillRect(0, 0, arr.pad * z, arr.H * z);
    ctx.fillRect((arr.W - arr.pad) * z, 0, arr.pad * z, arr.H * z);
  }

  _gapBand(ctx, arr, z) {
    const g = this.drag && this.drag.kind === 'gap' ? this.drag : this.hoverGap;
    if (!g) return;
    const a = arr.boxes[g.left], b = arr.boxes[g.right];
    if (!a || !b) return;
    const x0 = (a.x + a.w) * z, x1 = b.x * z;
    ctx.fillStyle = COLOR.gap; ctx.fillRect(Math.min(x0, x1), 0, Math.max(2, Math.abs(x1 - x0)), arr.H * z);
    this._tag(ctx, fmtMm(b.x - a.x - a.w), (x0 + x1) / 2, arr.H * z + 14, 'center');
  }

  _boxes(ctx, res, z) {
    const d = this.drag && this.drag.active ? this.drag : null;
    let sel = null;
    for (const it of res.items) {
      const b = res.arr.boxes[it.id];
      if (!b || (d && d.kind === 'row' && it.id === d.id)) continue;
      if (it.id === this.selectedId) { sel = { it, b }; continue; }
      const hover = it.id === this.hoverId;
      ctx.lineWidth = 1;
      ctx.setLineDash(it.el.free ? [2, 3] : [4, 3]);
      ctx.strokeStyle = it.el.free ? (hover ? '#000' : COLOR.free) : (hover ? '#1f6fd6' : COLOR.row);
      ctx.strokeRect(Math.round(b.x * z) + 0.5, Math.round(b.y * z) + 0.5, Math.max(1, Math.round(b.w * z) - 1), Math.max(1, Math.round(b.h * z) - 1));
    }
    ctx.setLineDash([]);
    if (!sel) return;
    const { it, b } = sel;
    ctx.lineWidth = 2; ctx.strokeStyle = COLOR.accent;
    ctx.strokeRect(Math.round(b.x * z), Math.round(b.y * z), Math.round(b.w * z), Math.round(b.h * z));
    if (!d || d.kind === 'resize') {
      ctx.fillStyle = COLOR.accent; ctx.strokeStyle = '#1a1600'; ctx.lineWidth = 1;
      for (const h of this._handles(it.id)) { ctx.fillRect(h.x - HANDLE / 2, h.y - HANDLE / 2, HANDLE, HANDLE); ctx.strokeRect(h.x - HANDLE / 2 + 0.5, h.y - HANDLE / 2 + 0.5, HANDLE - 1, HANDLE - 1); }
    }
    if (d && d.kind === 'resize') this._tag(ctx, `${fmtMm(b.w)} × ${fmtMm(b.h)}`, (b.x + b.w / 2) * z, res.arr.H * z + 14, 'center');
  }

  _dragOverlay(ctx, res, z) {
    const d = this.drag, H = res.arr.H, W = res.arr.W;
    if (d.kind === 'row') {
      const slot = res.arr.boxes[d.id];
      if (slot) {
        ctx.setLineDash([5, 4]); ctx.lineWidth = 2; ctx.strokeStyle = COLOR.accent;
        ctx.strokeRect(Math.round(slot.x * z) + 1, 1, Math.max(2, Math.round(slot.w * z) - 2), H * z - 2);
        ctx.setLineDash([]);
      }
      const it = d.items.find(x => x.id === d.id), g = d.ghost, c = d.base.canvases.get(d.id);
      if (it && g && c) {
        ctx.save();
        ctx.globalAlpha = 0.75;
        ctx.translate((g.x + it.w / 2) * z, (g.y + it.h / 2) * z);
        ctx.rotate(it.rot * Math.PI / 180);
        ctx.imageSmoothingEnabled = false;
        ctx.fillStyle = 'rgba(255,255,255,.85)'; ctx.fillRect(-it.iw * z / 2, -it.ih * z / 2, it.iw * z, it.ih * z);
        ctx.drawImage(c, -it.iw * z / 2, -it.ih * z / 2, it.iw * z, it.ih * z);
        ctx.restore();
        ctx.lineWidth = 2; ctx.strokeStyle = COLOR.accent;
        ctx.strokeRect(Math.round(g.x * z), Math.round(g.y * z), Math.round(it.w * z), Math.round(it.h * z));
      }
    }
    ctx.strokeStyle = COLOR.guide; ctx.lineWidth = 1;
    if (d.hitX) { const x = Math.round(d.hitX.v * z) + 0.5; ctx.beginPath(); ctx.moveTo(x, -6); ctx.lineTo(x, H * z + 6); ctx.stroke(); }
    if (d.hitY) { const y = Math.round(d.hitY.v * z) + 0.5; ctx.beginPath(); ctx.moveTo(-6, y); ctx.lineTo(W * z + 6, y); ctx.stroke(); }
  }

  _tag(ctx, text, x, y, align = 'left') {
    ctx.save();
    ctx.font = '600 11px -apple-system, BlinkMacSystemFont, Helvetica, sans-serif';
    const w = ctx.measureText(text).width + 10;
    const x0 = align === 'center' ? x - w / 2 : x;
    ctx.fillStyle = 'rgba(20,22,28,.92)'; ctx.beginPath(); ctx.roundRect(x0, y - 9, w, 17, 5); ctx.fill();
    ctx.fillStyle = COLOR.accent; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(text, x0 + 5, y);
    ctx.restore();
  }

  _caption(ctx, res, cssH) {
    const t = tape(this.getTapeMm());
    ctx.font = '11px -apple-system, BlinkMacSystemFont, Helvetica, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    let text = `${t.label} tape · ${fmtMm(res.arr.W)} long · ${res.arr.W}×${res.arr.H} dots`;
    const sample = this.getSample();
    if (sample && sample.text) text += ` · showing “${String(sample.text).split('\n')[0].slice(0, 40)}”`;
    if (this.drag && this.drag.active && this.drag.kind === 'gap') text = '';
    ctx.fillStyle = '#8b93a3';
    ctx.fillText(text, PAD_X, cssH - 9);
    if (res.arr.overflow) {
      const w = ctx.measureText(text).width;
      ctx.fillStyle = '#f87171';
      ctx.fillText(this.layout.length.mode === 'fixed' ? '  ·  content runs past the fixed length' : '  ·  something sits outside the label', PAD_X + w, cssH - 9);
    }
  }

  // ---- hit testing ---------------------------------------------------------------------------------
  _pt(ev) { const r = this.canvas.getBoundingClientRect(); return { x: ev.clientX - r.left - PAD_X, y: ev.clientY - r.top - PAD_TOP }; }

  /** Element under the point: the smallest box that contains it (so a frame drawn over text does not swallow clicks on the text). */
  _hitBox(p) {
    if (!this.res) return null;
    const z = this.zoom;
    let best = null, bestArea = Infinity;
    for (let k = this.res.items.length - 1; k >= 0; k--) {
      const it = this.res.items[k], b = this.res.arr.boxes[it.id];
      if (!b) continue;
      if (p.x >= b.x * z - 2 && p.x <= (b.x + b.w) * z + 2 && p.y >= b.y * z - 2 && p.y <= (b.y + b.h) * z + 2) {
        const area = b.w * b.h;
        if (area < bestArea) { best = it.id; bestArea = area; }
      }
    }
    return best;
  }

  _handles(id) {
    const b = this.boxOf(id), el = this.elementById(id);
    if (!b || !el) return [];
    const z = this.zoom, x0 = b.x * z, y0 = b.y * z, x1 = (b.x + b.w) * z, y1 = (b.y + b.h) * z, xm = (x0 + x1) / 2, ym = (y0 + y1) / 2;
    const at = { nw: [x0, y0], n: [xm, y0], ne: [x1, y0], e: [x1, ym], se: [x1, y1], s: [xm, y1], sw: [x0, y1], w: [x0, ym] };
    let keys;
    if (el.type === 'text') keys = sideways(el) ? ['n', 's'] : ['e', 'w'];
    else if (el.type === 'qr') keys = ['nw', 'ne', 'se', 'sw'];
    else keys = Object.keys(at);
    if (!el.free) keys = keys.filter(k => !k.includes('w'));     // row elements grow to the right
    return keys.map(k => ({ k, x: at[k][0], y: at[k][1] }));
  }

  _handleAt(p) {
    if (!this.selectedId) return null;
    for (const h of this._handles(this.selectedId)) if (Math.abs(p.x - h.x) <= HANDLE / 2 + 3 && Math.abs(p.y - h.y) <= HANDLE / 2 + 3) return h.k;
    return null;
  }

  /** The gap between two neighbors in the row under the point (narrow gaps get a few px to grab). */
  _gapAt(p) {
    const arr = this.res && this.res.arr;
    if (!arr) return null;
    const z = this.zoom;
    if (p.y < 0 || p.y > arr.H * z) return null;
    for (let k = 1; k < arr.row.length; k++) {
      const a = arr.boxes[arr.row[k - 1]], b = arr.boxes[arr.row[k]];
      let x0 = (a.x + a.w) * z, x1 = b.x * z;
      if (x1 - x0 < 8) { const m = (x0 + x1) / 2; x0 = m - 4; x1 = m + 4; }
      if (p.x >= x0 && p.x <= x1) return { left: arr.row[k - 1], right: arr.row[k] };
    }
    return null;
  }

  /** Row slot (0..n) for a point, for dropping a new element. */
  slotAt(clientX) {
    const arr = this.res && this.res.arr;
    if (!arr) return null;
    const r = this.canvas.getBoundingClientRect(), x = (clientX - r.left - PAD_X) / this.zoom;
    return arr.row.filter(id => { const b = arr.boxes[id]; return b.x + b.w / 2 < x; }).length;
  }

  // ---- pointer interaction ---------------------------------------------------------------------------
  _bind() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (ev) => this._down(ev));
    c.addEventListener('pointermove', (ev) => this._move(ev));
    c.addEventListener('pointerup', (ev) => this._up(ev, false));
    c.addEventListener('pointercancel', (ev) => this._up(ev, true));
    c.addEventListener('lostpointercapture', (ev) => { if (this.drag && this.drag.pointerId === ev.pointerId) this._up(ev, false); });
    c.addEventListener('pointerleave', () => { if (!this.drag && (this.hoverId || this.hoverGap)) { this.hoverId = null; this.hoverGap = null; this.redraw(); } });
    c.addEventListener('dblclick', (ev) => {
      const id = this._hitBox(this._pt(ev));
      if (id) { if (this.onEdit) this.onEdit(id); } else if (this.onFit) this.onFit();
    });
    // pinch or ⌘/Ctrl + scroll zooms around the pointer
    c.addEventListener('wheel', (ev) => {
      if (!ev.ctrlKey && !ev.metaKey) return;
      ev.preventDefault();
      const r = c.getBoundingClientRect(), dotX = (ev.clientX - r.left - PAD_X) / this.zoom;
      const z = Math.max(0.5, Math.min(12, Math.round(this.zoom * Math.exp(-ev.deltaY * 0.01) * 4) / 4));
      if (z === this.zoom) return;
      const offset = ev.clientX - this.stage.getBoundingClientRect().left;
      this.setZoom(z);
      this.stage.scrollLeft = dotX * z + PAD_X + c.offsetLeft - offset;
      if (this.onZoom) this.onZoom(z);
    }, { passive: false });
  }

  _down(ev) {
    if (ev.button !== 0 || !this.res) return;
    const p = this._pt(ev);
    const handle = this._handleAt(p);
    if (handle) { this._begin(ev, { kind: 'resize', id: this.selectedId, h: handle }); return; }
    const id = this._hitBox(p);
    if (id) {
      this.select(id);
      this._begin(ev, { kind: this.elementById(id).free ? 'free' : 'row', id });
      return;
    }
    const gap = this._gapAt(p);
    if (gap) { this._begin(ev, { kind: 'gap', id: gap.right, left: gap.left, right: gap.right, all: ev.altKey }); return; }
    this.select(null);
  }

  _begin(ev, d) {
    Object.assign(d, { el: this.elementById(d.id), start: this._pt(ev), active: false, pointerId: ev.pointerId });
    this.drag = d;
    try { this.canvas.setPointerCapture(ev.pointerId); } catch {}
  }

  _move(ev) {
    const p = this._pt(ev), d = this.drag;
    if (!d) { this._hover(p); return; }
    if (!d.active) {
      if (Math.hypot(p.x - d.start.x, p.y - d.start.y) < DRAG_PX) return;
      this._activate(d);
    }
    const noSnap = ev.altKey || !this.snap;
    if (d.kind === 'row') { this._dragRow(d, p, ev.shiftKey, noSnap); this.render(); return; }
    if (d.kind === 'free') this._dragFree(d, p, ev.shiftKey, noSnap);
    else if (d.kind === 'resize') this._dragResize(d, p, ev.shiftKey, noSnap);
    else if (d.kind === 'gap') this._dragGap(d, p);
    this.render();
  }

  _activate(d) {
    d.active = true;
    const res = this.res, z = this.zoom, b = res.arr.boxes[d.id];
    d.box0 = b ? { ...b } : { x: 0, y: 0, w: 1, h: 1 };
    d.orig = { ...d.el };
    d.origGap = this.layout.gap;
    d.targets = snapTargets(res.arr, d.id);
    d.grab = { x: d.start.x / z - d.box0.x, y: d.start.y / z - d.box0.y };
    if (d.kind === 'row') {
      d.base = res;
      d.items = res.items;
      d.others = res.arr.row.filter(id => id !== d.id);
      d.k = Math.max(0, res.arr.row.indexOf(d.id));
      d.order = res.arr.row.slice();
      d.ghost = { ...d.box0 };
    }
    this.hoverGap = null;
    this.canvas.style.cursor = d.kind === 'row' ? 'grabbing' : d.kind === 'free' ? 'move' : d.kind === 'gap' ? 'col-resize' : CURSORS[d.h];
  }

  _ghost(d, p, axisLock) {
    const z = this.zoom;
    let x = p.x / z - d.grab.x, y = p.y / z - d.grab.y;
    if (axisLock) { if (Math.abs(p.x - d.start.x) >= Math.abs(p.y - d.start.y)) y = d.box0.y; else x = d.box0.x; }
    return { x, y, w: d.box0.w, h: d.box0.h };
  }

  _dragRow(d, p, axisLock, noSnap) {
    const H = this.H, g = this._ghost(d, p, axisLock);
    d.hitY = null;
    if (!noSnap) { const s = snapBox(g, { y: d.targets.y }, SNAP_PX / this.zoom, { x: false, y: true }); g.y = s.y; d.hitY = s.hitY; }
    g.y = clampY(g.y, g.h, H);
    d.ghost = g;
    // the slot: neighbors whose midpoints (as currently laid out, with the gap open) lie left of the ghost's center
    const center = g.x + g.w / 2;
    let k = d.k;
    for (let i = 0; i <= d.others.length + 1; i++) {
      const order = d.others.slice(); order.splice(k, 0, d.id);
      const arr = arrange(this.layout, d.items, H, { order });
      const k2 = d.others.filter(id => { const b = arr.boxes[id]; return b.x + b.w / 2 < center; }).length;
      if (k2 === k) break;
      k = k2;
    }
    d.k = k;
    d.order = d.others.slice(); d.order.splice(k, 0, d.id);
  }

  _dragFree(d, p, axisLock, noSnap) {
    const el = d.el, H = this.H, b = this._ghost(d, p, axisLock);
    d.hitX = d.hitY = null;
    if (!noSnap) { const s = snapBox(b, d.targets, SNAP_PX / this.zoom); b.x = s.x; b.y = s.y; d.hitX = s.hitX; d.hitY = s.hitY; }
    b.x = Math.max(0, Math.round(b.x));
    b.y = Math.round(clampY(b.y, b.h, H));
    const keepX = Math.abs(b.x - d.box0.x) < 0.5, keepY = Math.abs(b.y - d.box0.y) < 0.5;   // an untouched axis keeps its centering
    el.hCenter = (d.hitX && d.hitX.kind === 'labelCenter' && d.hitX.edge === 'center') || (keepX && d.orig.hCenter) || false;
    el.vCenter = (d.hitY && d.hitY.kind === 'tapeCenter' && d.hitY.edge === 'center') || (keepY && d.orig.vCenter) || false;
    if (!el.hCenter) el.x = b.x;
    if (!el.vCenter) el.y = b.y;
  }

  _dragResize(d, p, keepAspect, noSnap) {
    const el = d.el, b0 = d.box0, k = d.h, z = this.zoom, H = this.H, side = sideways(el);
    const dx = (p.x - d.start.x) / z, dy = (p.y - d.start.y) / z;
    const cx = el.free && el.hCenter ? 2 : 1, cy = el.vCenter ? 2 : 1;   // a centered element grows on both sides
    let w = b0.w, h = b0.h;
    if (k.includes('e')) w += dx * cx;
    if (k.includes('w')) w -= dx * cx;
    if (k.includes('s')) h += dy * cy;
    if (k.includes('n')) h -= dy * cy;
    d.hitX = d.hitY = null;
    let onGrid = false;
    if (!noSnap) {
      const tol = SNAP_PX / z;
      if (k.includes('e') || k.includes('w')) {
        if (!el.free) { w = Math.max(DOTS_PER_MM / 2, Math.round(w / (DOTS_PER_MM / 2)) * (DOTS_PER_MM / 2)); onGrid = true; }   // row widths: 0.5 mm steps
        else if (cx === 1) {
          const edge = k.includes('e') ? b0.x + w : b0.x + b0.w - w;
          const hit = nearest(edge, d.targets.x, tol);
          if (hit) { w = k.includes('e') ? hit.v - b0.x : b0.x + b0.w - hit.v; d.hitX = hit; }
        }
      }
      if ((k.includes('s') || k.includes('n')) && cy === 1) {
        const edge = k.includes('s') ? b0.y + h : b0.y + b0.h - h;
        const hit = nearest(edge, d.targets.y, tol);
        if (hit) { h = k.includes('s') ? hit.v - b0.y : b0.y + b0.h - hit.v; d.hitY = hit; }
      }
      if (cy === 2 && Math.abs(h - H) <= tol) h = H;
    }
    w = onGrid ? w : Math.max(el.type === 'line' ? 1 : 2, Math.round(w));     // keep an exact mm step; otherwise whole dots
    h = Math.max(el.type === 'line' ? 1 : 2, Math.round(h));
    if (!side) h = Math.min(h, H);

    if (el.type === 'text') {
      el.widthMode = 'fixed'; el.w = Math.max(4, side ? h : w);
    } else if (el.type === 'qr') {
      const grow = Math.max(k.includes('e') || k.includes('w') ? w - b0.w : -Infinity, k.includes('n') || k.includes('s') ? h - b0.h : -Infinity);
      const s = Math.max(8, Math.min(H, Math.round(b0.w + grow)));
      el.fullHeight = s >= H; el.size = s; w = h = s;
    } else {
      if (el.type === 'image' && (el.keepAspect || keepAspect) && b0.h > 0) {   // ⇧ keeps any image's proportions
        const ar = b0.w / b0.h;
        if (k === 'e' || k === 'w') h = Math.max(2, Math.round(w / ar)); else w = Math.max(2, Math.round(h * ar));
        if (!side && h > H) { h = H; w = Math.max(2, Math.round(H * ar)); }
      }
      const ew = side ? h : w, eh = side ? w : h;
      el.w = ew;
      if (!side && eh >= H) { el.fullHeight = true; el.h = H; } else { el.fullHeight = false; el.h = eh; }
    }
    if (el.free && !el.hCenter && k.includes('w')) el.x = Math.max(0, Math.round(b0.x + b0.w - w));
    if (!el.vCenter && k.includes('n')) el.y = Math.round(b0.y + b0.h - h);
  }

  _dragGap(d, p) {
    const delta = Math.round((p.x - d.start.x) / this.zoom);
    if (d.all) { this.layout.gap = Math.max(-200, d.origGap + delta); return; }
    const left = this.elementById(d.left);
    const min = -((left ? left.spaceAfter || 0 : 0) + Math.round(this.layout.gap || 0));
    d.el.spaceBefore = Math.max(min, (d.orig.spaceBefore || 0) + delta);
  }

  _up(ev, cancel) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    try { this.canvas.releasePointerCapture(d.pointerId); } catch {}
    this.canvas.style.cursor = 'default';
    if (!d.active) { this.redraw(); return; }
    if (cancel) { this._restore(d); this.render(); return; }
    if (d.kind === 'row') {
      const el = d.el, g = d.ghost;
      moveInRow(this.layout, d.id, d.k);
      const keepY = Math.abs(g.y - d.box0.y) < 0.5;
      if (d.hitY && d.hitY.kind === 'tapeCenter' && d.hitY.edge === 'center') el.vCenter = true;
      else if (!(keepY && d.orig.vCenter)) { el.vCenter = false; el.y = Math.round(g.y); }
    }
    this.render();
    if (this.onCommit) this.onCommit(d.kind === 'row' ? 'move' : d.kind);
  }

  _restore(d) {
    if (d.kind === 'gap') { this.layout.gap = d.origGap; d.el.spaceBefore = d.orig.spaceBefore; return; }
    if (d.kind === 'free' || d.kind === 'resize') Object.assign(d.el, d.orig);
  }

  /** Abandon a drag in progress (Escape). */
  cancelDrag() { const d = this.drag; if (!d) return false; this.drag = null; if (d.active) this._restore(d); this.render(); return true; }

  _hover(p) {
    let cursor = 'default', hoverId = null, hoverGap = null;
    const h = this._handleAt(p);
    if (h) cursor = CURSORS[h];
    else {
      hoverId = this._hitBox(p);
      if (hoverId) cursor = this.elementById(hoverId).free ? 'move' : 'grab';
      else { hoverGap = this._gapAt(p); if (hoverGap) cursor = 'col-resize'; }
    }
    this.canvas.style.cursor = cursor;
    const sameGap = (a, b) => (!a && !b) || (a && b && a.left === b.left && a.right === b.right);
    if (hoverId !== this.hoverId || !sameGap(hoverGap, this.hoverGap)) { this.hoverId = hoverId; this.hoverGap = hoverGap; this.redraw(); }
  }

  // ---- keyboard ------------------------------------------------------------------------------------
  /** Handle a key press while the designer is active; returns true if it was used. */
  key(ev) {
    if (this.drag) { if (ev.key === 'Escape') return this.cancelDrag(); return false; }
    const el = this.selected, mod = ev.metaKey || ev.ctrlKey;
    if (ev.key === 'Escape') { if (!el) return false; this.select(null); return true; }
    if (!el) return false;
    if (ev.key === 'Backspace' || ev.key === 'Delete') { this.remove(el.id); return true; }
    if (mod && ev.key.toLowerCase() === 'd') { this.duplicate(el.id); return true; }
    const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[ev.key];
    if (!dir || mod) return false;
    const step = ev.shiftKey ? Math.round(DOTS_PER_MM) : 1, box = this.boxOf(el.id);
    if (dir[0] && !el.free) {
      const row = this.res.arr.row, k = row.indexOf(el.id);
      if (k >= 0 && k + dir[0] >= 0 && k + dir[0] < row.length) { moveInRow(this.layout, el.id, k + dir[0]); this.render(); this.onCommit('move'); }
      return true;
    }
    if (dir[0]) { if (el.hCenter) { el.hCenter = false; el.x = box ? box.x : el.x; } el.x = Math.max(0, Math.round(el.x) + dir[0] * step); }
    if (dir[1]) {
      if (el.vCenter) { el.vCenter = false; el.y = box ? box.y : el.y; }
      el.y = Math.round(clampY(Math.round(el.y) + dir[1] * step, box ? box.h : 1, this.H));
    }
    this.render();
    this.onCommit('nudge', `nudge:${el.id}`);
    return true;
  }

  // ---- element operations ------------------------------------------------------------------------------
  /** Add an element after the selected one (or at row slot `slot`) and select it. */
  add(type, { slot = null, src = null, img = null } = {}) {
    const L = this.layout, el = newElement(type, this.H);
    if (type === 'image') { el.src = src; el._img = img; }
    const sel = this.selected;
    if (slot != null) { L.elements.push(el); moveInRow(L, el.id, slot); }
    else L.elements.splice(sel ? L.elements.indexOf(sel) + 1 : L.elements.length, 0, el);
    this.selectedId = el.id;
    this.render();
    if (this.onSelect) this.onSelect(el.id);
    this.onCommit('add');
    return el;
  }

  remove(id) {
    const L = this.layout;
    L.elements = L.elements.filter(e => e.id !== id);
    if (this.selectedId === id) this.selectedId = null;
    this.render();
    if (this.onSelect) this.onSelect(this.selectedId);
    this.onCommit('delete');
  }

  duplicate(id) {
    const L = this.layout, el = this.elementById(id);
    if (!el) return;
    const copy = { ...el, id: uid(), name: el.name ? `${el.name} copy` : '' };
    if (copy.free) { copy.hCenter = false; copy.x = Math.round((this.boxOf(id) || { x: el.x }).x + 2 * DOTS_PER_MM); }
    L.elements.splice(L.elements.indexOf(el) + 1, 0, copy);
    this.selectedId = copy.id;
    this.render();
    if (this.onSelect) this.onSelect(copy.id);
    this.onCommit('duplicate');
  }
}

function nearest(v, targets, tol) {
  let hit = null;
  for (const t of targets) { const d = Math.abs(t.v - v); if (d <= tol && (!hit || d < hit.d)) hit = { ...t, d }; }
  return hit;
}
