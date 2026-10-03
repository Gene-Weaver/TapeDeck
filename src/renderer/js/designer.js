// Drag-and-drop layout editor drawn on a canvas, with a generated properties panel.
import { tape, dotsToMm, mmToDots } from './tape.js';
import { renderLabel, defaultElement, loadImageInto, FONTS, uid } from './render.js';

const HANDLE = 7;

export class Designer {
  constructor({ canvas, propsEl, imageInput, getTapeMm, getLayout, onChange, getSample }) {
    this.canvas = canvas; this.ctx = canvas.getContext('2d');
    this.propsEl = propsEl; this.imageInput = imageInput;
    this.getTapeMm = getTapeMm; this.getLayout = getLayout; this.onChange = onChange; this.getSample = getSample;
    this.zoom = 6; this.selectedId = null; this.drag = null; this.boxes = [];
    this._bind();
  }

  get layout() { return this.getLayout(); }
  get selected() { return this.layout.elements.find(e => e.id === this.selectedId) || null; }

  // ---- drawing -----------------------------------------------------------
  render() {
    const t = tape(this.getTapeMm());
    const z = this.zoom;
    const res = renderLabel(this.layout, this.getSample(), this.getTapeMm());
    this.boxes = res.boxes; this.lastW = res.width; this.lastH = res.height;
    const PADX = 24, PADY = 24;
    const W = res.width * z + PADX * 2, H = res.height * z + PADY * 2;
    if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; }
    const ctx = this.ctx;
    ctx.clearRect(0, 0, W, H);
    ctx.save(); ctx.translate(PADX, PADY);
    // tape band with shadow
    ctx.shadowColor = 'rgba(0,0,0,.5)'; ctx.shadowBlur = 12; ctx.shadowOffsetY = 4;
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, res.width * z, res.height * z);
    ctx.shadowColor = 'transparent';
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(res.canvas, 0, 0, res.width * z, res.height * z);
    // mm grid
    ctx.strokeStyle = 'rgba(0,120,255,.13)'; ctx.lineWidth = 1;
    const mmPx = z * 180 / 25.4;
    for (let x = mmPx; x < res.width * z; x += mmPx) { ctx.beginPath(); ctx.moveTo(Math.round(x) + .5, 0); ctx.lineTo(Math.round(x) + .5, res.height * z); ctx.stroke(); }
    for (let y = mmPx; y < res.height * z; y += mmPx) { ctx.beginPath(); ctx.moveTo(0, Math.round(y) + .5); ctx.lineTo(res.width * z, Math.round(y) + .5); ctx.stroke(); }
    // element outlines
    for (const b of this.boxes) {
      const sel = b.id === this.selectedId;
      ctx.strokeStyle = sel ? '#ffd84a' : 'rgba(0,0,0,.25)';
      ctx.setLineDash(sel ? [] : [4, 4]); ctx.lineWidth = sel ? 2 : 1;
      ctx.strokeRect(b.x * z + .5, b.y * z + .5, b.w * z, b.h * z);
      ctx.setLineDash([]);
      if (sel) {
        ctx.fillStyle = '#ffd84a'; ctx.strokeStyle = '#1a1600';
        for (const h of this._handles(b)) { ctx.fillRect(h.x - HANDLE / 2, h.y - HANDLE / 2, HANDLE, HANDLE); ctx.strokeRect(h.x - HANDLE / 2 + .5, h.y - HANDLE / 2 + .5, HANDLE - 1, HANDLE - 1); }
      }
    }
    ctx.restore();
    // caption
    ctx.fillStyle = '#8b93a3'; ctx.font = '11px -apple-system, Helvetica, sans-serif';
    ctx.fillText(`${t.label} tape · ${dotsToMm(res.width).toFixed(1)} mm long · ${res.width}×${res.height} dots`, PADX, H - 7);
    this.PADX = PADX; this.PADY = PADY;
  }

  _handles(b) {
    const z = this.zoom, el = this.layout.elements.find(e => e.id === b.id);
    const x0 = b.x * z, y0 = b.y * z, x1 = (b.x + b.w) * z, y1 = (b.y + b.h) * z, xm = (x0 + x1) / 2, ym = (y0 + y1) / 2;
    const all = [
      { k: 'nw', x: x0, y: y0 }, { k: 'n', x: xm, y: y0 }, { k: 'ne', x: x1, y: y0 }, { k: 'e', x: x1, y: ym },
      { k: 'se', x: x1, y: y1 }, { k: 's', x: xm, y: y1 }, { k: 'sw', x: x0, y: y1 }, { k: 'w', x: x0, y: ym },
    ];
    if (!el) return [];
    if (el.type === 'text') return all.filter(h => h.k === 'e' || h.k === 'w');
    if (el.type === 'qr') return all.filter(h => h.k.length === 2);
    return all;
  }

  // ---- interaction -------------------------------------------------------
  _pos(ev) {
    const r = this.canvas.getBoundingClientRect();
    return { x: (ev.clientX - r.left) * (this.canvas.width / r.width) - this.PADX, y: (ev.clientY - r.top) * (this.canvas.height / r.height) - this.PADY };
  }

  _bind() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (ev) => {
      const p = this._pos(ev), z = this.zoom;
      const selBox = this.boxes.find(b => b.id === this.selectedId);
      if (selBox) {
        for (const h of this._handles(selBox)) {
          if (Math.abs(p.x - h.x) <= HANDLE && Math.abs(p.y - h.y) <= HANDLE) {
            const el = this.selected;
            this.drag = { kind: 'resize', h: h.k, el, start: p, orig: { ...el, box: { ...selBox } } };
            c.setPointerCapture(ev.pointerId); return;
          }
        }
      }
      const hit = [...this.boxes].reverse().find(b => p.x >= b.x * z && p.x <= (b.x + b.w) * z && p.y >= b.y * z && p.y <= (b.y + b.h) * z);
      this.selectedId = hit ? hit.id : null;
      if (hit) {
        const el = this.selected;
        this.drag = { kind: 'move', el, start: p, orig: { x: hit.x, y: hit.y, hCenter: el.hCenter, vCenter: el.vCenter }, moved: false };
        c.setPointerCapture(ev.pointerId);
      }
      this.render(); this.renderProps();
    });
    c.addEventListener('pointermove', (ev) => {
      if (!this.drag) { this._cursor(this._pos(ev)); return; }
      const p = this._pos(ev), z = this.zoom, d = this.drag;
      const dx = Math.round((p.x - d.start.x) / z), dy = Math.round((p.y - d.start.y) / z);
      if (d.kind === 'move') {
        if (!dx && !dy && !d.moved) return;
        d.moved = true;
        if (dx) { d.el.x = d.orig.x + dx; d.el.hCenter = false; }
        if (dy) { d.el.y = Math.max(0, Math.min(this.lastH - 1, d.orig.y + dy)); d.el.vCenter = false; }
      } else {
        this._applyResize(d, dx, dy);
      }
      this.render();
    });
    const up = () => { if (this.drag) { this.drag = null; this.renderProps(); this.onChange(); } };
    c.addEventListener('pointerup', up); c.addEventListener('pointercancel', up);
    c.addEventListener('dblclick', () => { const i = this.propsEl.querySelector('[data-prop="text"]'); if (i) i.focus(); });
    c.tabIndex = 0;
    c.addEventListener('keydown', (ev) => {
      const el = this.selected; if (!el) return;
      const step = ev.shiftKey ? 10 : 1;
      if (ev.key === 'Backspace' || ev.key === 'Delete') { this.remove(el.id); ev.preventDefault(); }
      else if (ev.key === 'ArrowLeft') { el.x -= step; el.hCenter = false; }
      else if (ev.key === 'ArrowRight') { el.x += step; el.hCenter = false; }
      else if (ev.key === 'ArrowUp') { el.y -= step; el.vCenter = false; }
      else if (ev.key === 'ArrowDown') { el.y += step; el.vCenter = false; }
      else if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'd') { this.duplicate(el.id); ev.preventDefault(); }
      else return;
      ev.preventDefault(); this.render(); this.renderProps(); this.onChange();
    });
  }

  _cursor(p) {
    const z = this.zoom;
    const selBox = this.boxes.find(b => b.id === this.selectedId);
    let cur = 'default';
    if (selBox) for (const h of this._handles(selBox)) if (Math.abs(p.x - h.x) <= HANDLE && Math.abs(p.y - h.y) <= HANDLE) cur = { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize' }[h.k];
    if (cur === 'default' && this.boxes.some(b => p.x >= b.x * z && p.x <= (b.x + b.w) * z && p.y >= b.y * z && p.y <= (b.y + b.h) * z)) cur = 'move';
    this.canvas.style.cursor = cur;
  }

  _applyResize(d, dx, dy) {
    const el = d.el, o = d.orig, h = d.h;
    const rotated = (el.rotate || 0) % 180 !== 0;
    if (rotated) { [dx, dy] = [dy, dx]; }
    const grow = (w0, h0, ddx, ddy) => ({ w: Math.max(4, w0 + ddx), h: Math.max(4, h0 + ddy) });
    let ddx = h.includes('e') ? dx : h.includes('w') ? -dx : 0;
    let ddy = h.includes('s') ? dy : h.includes('n') ? -dy : 0;
    if (el.type === 'text') { el.w = Math.max(8, (o.w || o.box.w) + ddx); if (h.includes('w') && !el.hCenter) el.x = o.x - ddx; return; }
    if (el.type === 'qr') { const s = Math.max(16, o.size + Math.max(ddx, ddy)); el.size = s; if (h.includes('w') && !el.hCenter) el.x = o.x + (o.size - s); if (h.includes('n') && !el.vCenter) el.y = o.y + (o.size - s); return; }
    let { w, h: hh } = grow(o.w, o.h, ddx, ddy);
    if (el.type === 'image' && el.keepAspect && o.h > 0) {
      const ar = o.w / o.h;
      if (h.length === 2 || h === 'e' || h === 'w') hh = Math.max(4, Math.round(w / ar)); else w = Math.max(4, Math.round(hh * ar));
    }
    el.w = w; el.h = hh;
    if (h.includes('w') && !el.hCenter) el.x = o.x + (o.w - w);
    if (h.includes('n') && !el.vCenter) el.y = o.y + (o.h - hh);
  }

  // ---- element ops -------------------------------------------------------
  add(type) {
    const t = tape(this.getTapeMm());
    const el = defaultElement(type, t);
    const right = this.boxes.reduce((m, b) => Math.max(m, b.x + b.w), 0);
    el.x = this.layout.elements.length ? right + 6 : 6;
    if (type === 'rect' || type === 'line') el.x = 2;
    if (type === 'image') { this.layout.elements.push(el); this.selectedId = el.id; this.pickImage(el); }
    else { this.layout.elements.push(el); this.selectedId = el.id; }
    this.render(); this.renderProps(); this.onChange();
  }
  remove(id) {
    this.layout.elements = this.layout.elements.filter(e => e.id !== id);
    if (this.selectedId === id) this.selectedId = null;
    this.render(); this.renderProps(); this.onChange();
  }
  duplicate(id) {
    const el = this.layout.elements.find(e => e.id === id); if (!el) return;
    const copy = { ...el, id: uid(), x: el.x + 10, y: el.y + 4, hCenter: false, vCenter: el.vCenter };
    this.layout.elements.push(copy); this.selectedId = copy.id;
    this.render(); this.renderProps(); this.onChange();
  }
  reorder(id, dir) {
    const a = this.layout.elements, i = a.findIndex(e => e.id === id), j = i + dir;
    if (i < 0 || j < 0 || j >= a.length) return;
    [a[i], a[j]] = [a[j], a[i]];
    this.render(); this.renderProps(); this.onChange();
  }
  pickImage(el) {
    this.imageInput.onchange = async () => {
      const f = this.imageInput.files[0]; this.imageInput.value = '';
      if (!f) return;
      await loadImageInto(el, f);
      this.render(); this.renderProps(); this.onChange();
    };
    this.imageInput.click();
  }

  // ---- properties panel --------------------------------------------------
  renderProps() {
    const L = this.layout, el = this.selected, root = this.propsEl;
    const mm = (d) => (d == null ? '' : dotsToMm(d).toFixed(1));
    const f = (label, inner) => `<label class="field"><span>${label}</span>${inner}</label>`;
    const chk = (label, prop, on) => `<label class="check"><input type="checkbox" data-prop="${prop}" ${on ? 'checked' : ''}> ${label}</label>`;
    const num = (prop, val, extra = '') => `<input type="number" data-prop="${prop}" data-unit="mm" value="${val}" step="0.1" ${extra}>`;
    let html = `<div class="col"><h4>Layout</h4>
      ${f('Name', `<input data-lprop="name" value="${esc(L.name || '')}">`)}
      <div class="grid2">
        ${f('Length', `<select data-lprop="length.mode"><option value="auto" ${L.length.mode !== 'fixed' ? 'selected' : ''}>Auto</option><option value="fixed" ${L.length.mode === 'fixed' ? 'selected' : ''}>Fixed</option></select>`)}
        ${f('Length (mm)', `<input type="number" data-lprop="length.dots" data-unit="mm" value="${mm(L.length.dots)}" step="0.5" ${L.length.mode !== 'fixed' ? 'disabled' : ''}>`)}
        ${f('Padding (mm)', `<input type="number" data-lprop="length.padding" data-unit="mm" value="${mm(L.length.padding)}" step="0.1">`)}
        <label class="check" style="align-self:end"><input type="checkbox" data-lprop="border" ${L.border ? 'checked' : ''}> Border</label>
      </div>
      <h4>Elements</h4><div class="elist">`;
    for (const e of [...L.elements].reverse()) {
      const name = e.type === 'text' ? e.text : e.type === 'image' ? (e.src ? 'photo' : 'no file') : (e.text || e.type);
      html += `<button data-sel="${e.id}" class="${e.id === this.selectedId ? 'sel' : ''}"><span class="ty">${e.type}</span><span>${esc(String(name).slice(0, 26))}</span></button>`;
    }
    html += `</div>`;
    if (!L.elements.length) html += `<p class="hint">Add an element with the toolbar above.</p>`;
    html += `</div><div class="col">`;
    if (!el) html += `<p class="hint">Select an element on the canvas or in the list to edit it.</p>`;
    if (el) {
      html += `<h4>${el.type} properties</h4>`;
      if (el.type === 'text') {
        html += f('Text <small>(tokens like {text} {n:04} ok)</small>', `<textarea data-prop="text" rows="2" spellcheck="false">${esc(el.text)}</textarea>`)
          + f('Font', `<input data-prop="font" list="fontList" value="${esc(el.font)}">`)
          + `<div class="grid2">${f('Size (dots)', `<input type="number" data-prop="size" value="${el.size}" min="4" max="300" ${el.autoSize ? 'disabled' : ''}>`)}
             ${f('Box width (mm, blank=auto)', `<input type="number" data-prop="w" data-unit="mm" data-nullable="1" value="${mm(el.w)}" step="0.5">`)}</div>`
          + chk('Auto-fit to tape height', 'autoSize', el.autoSize) + `<div class="row">${chk('Bold', 'bold', el.bold)}${chk('Italic', 'italic', el.italic)}${chk('Invert', 'invert', el.invert)}</div>`
          + f('Align', `<select data-prop="align"><option value="left" ${el.align === 'left' ? 'selected' : ''}>Left</option><option value="center" ${el.align === 'center' ? 'selected' : ''}>Center</option><option value="right" ${el.align === 'right' ? 'selected' : ''}>Right</option></select>`);
      } else if (el.type === 'image') {
        html += `<div class="row"><button data-act="pick">Choose photo…</button>${el.src ? '<span class="muted">loaded</span>' : '<span class="muted">none</span>'}</div>`
          + `<div class="grid2">${f('Width (mm)', num('w', mm(el.w)))}${f('Height (mm)', num('h', mm(el.h)))}</div>`
          + chk('Keep aspect ratio', 'keepAspect', el.keepAspect)
          + f('Dithering', `<select data-prop="dither"><option value="fs" ${el.dither === 'fs' ? 'selected' : ''}>Floyd–Steinberg (photos)</option><option value="threshold" ${el.dither === 'threshold' ? 'selected' : ''}>Threshold (logos, line art)</option></select>`)
          + f('Threshold', `<input type="range" data-prop="threshold" min="1" max="254" value="${el.threshold}">`)
          + chk('Invert', 'invert', el.invert);
      } else if (el.type === 'qr') {
        html += f('Content', `<input data-prop="text" value="${esc(el.text)}" spellcheck="false">`)
          + `<div class="grid2">${f('Size (mm)', num('size', mm(el.size)))}
             ${f('Error correction', `<select data-prop="ecc">${['L', 'M', 'Q', 'H'].map(k => `<option ${el.ecc === k ? 'selected' : ''}>${k}</option>`).join('')}</select>`)}</div>`
          + (el._qr && !el._qr.ok ? '<p class="hint danger">Content cannot be encoded.</p>' : el._qr ? `<p class="hint">${el._qr.modules}×${el._qr.modules} modules, ${el._qr.module} dot(s) each</p>` : '');
      } else if (el.type === 'barcode') {
        html += f('Content (Code 128)', `<input data-prop="text" value="${esc(el.text)}" spellcheck="false">`)
          + `<div class="grid2">${f('Width (mm)', num('w', mm(el.w)))}${f('Height (mm)', num('h', mm(el.h)))}</div>`
          + chk('Show text under bars', 'showText', el.showText)
          + (el._bc && !el._bc.ok ? '<p class="hint danger">Only printable ASCII can be encoded.</p>' : '');
      } else if (el.type === 'rect') {
        html += `<div class="grid2">${f('Width (mm)', num('w', mm(el.w)))}${f('Height (mm)', num('h', mm(el.h)))}
          ${f('Stroke (dots)', `<input type="number" data-prop="stroke" value="${el.stroke}" min="1" max="40">`)}${f('Corner radius (dots)', `<input type="number" data-prop="radius" value="${el.radius}" min="0" max="100">`)}</div>`
          + chk('Filled', 'fill', el.fill);
      } else if (el.type === 'line') {
        html += `<div class="grid2">${f('Width (mm)', num('w', mm(el.w)))}${f('Thickness (mm)', num('h', mm(el.h)))}</div>`;
      }
      html += `<h4>Position</h4><div class="grid2">${f('X (mm)', `<input type="number" data-prop="x" data-unit="mm" value="${mm(el.x)}" step="0.1" ${el.hCenter ? 'disabled' : ''}>`)}${f('Y (mm)', `<input type="number" data-prop="y" data-unit="mm" value="${mm(el.y)}" step="0.1" ${el.vCenter ? 'disabled' : ''}>`)}</div>
        <div class="row">${chk('Center ↔', 'hCenter', el.hCenter)}${chk('Center ↕', 'vCenter', el.vCenter)}</div>
        ${f('Rotate', `<select data-prop="rotate">${[0, 90, 180, 270].map(r => `<option value="${r}" ${(el.rotate || 0) === r ? 'selected' : ''}>${r}°</option>`).join('')}</select>`)}
        <div class="row"><button data-act="dup">Duplicate</button><button data-act="fwd">Forward</button><button data-act="back">Back</button><button data-act="del" class="danger">Delete</button></div>`;
    }
    html += `</div>`;
    root.innerHTML = html;
    // bindings
    root.querySelectorAll('[data-sel]').forEach(b => b.onclick = () => { this.selectedId = b.dataset.sel; this.render(); this.renderProps(); });
    root.querySelectorAll('[data-act]').forEach(b => b.onclick = () => {
      const a = b.dataset.act;
      if (a === 'pick') this.pickImage(el); else if (a === 'dup') this.duplicate(el.id); else if (a === 'del') this.remove(el.id);
      else if (a === 'fwd') this.reorder(el.id, +1); else if (a === 'back') this.reorder(el.id, -1);
    });
    root.querySelectorAll('[data-lprop]').forEach(inp => {
      const handler = () => {
        const path = inp.dataset.lprop.split('.');
        let v = inp.type === 'checkbox' ? inp.checked : inp.value;
        if (inp.dataset.unit === 'mm') v = mmToDots(parseFloat(v) || 0);
        let o = L; for (let i = 0; i < path.length - 1; i++) o = o[path[i]];
        o[path[path.length - 1]] = v;
        this.render(); if (inp.tagName === 'SELECT' || inp.type === 'checkbox') this.renderProps(); this.onChange();
      };
      inp.addEventListener('input', handler); inp.addEventListener('change', handler);
    });
    if (el) root.querySelectorAll('[data-prop]').forEach(inp => {
      const handler = () => {
        const p = inp.dataset.prop;
        let v = inp.type === 'checkbox' ? inp.checked : inp.value;
        if (inp.dataset.nullable && v === '') v = null;
        else if (inp.dataset.unit === 'mm') v = mmToDots(parseFloat(v) || 0);
        else if (inp.type === 'number' || inp.type === 'range' || p === 'rotate') v = parseFloat(v) || 0;
        if (p === 'keepAspect' && v && el._img) el.w = Math.max(1, Math.round(el.h * el._img.naturalWidth / el._img.naturalHeight));
        el[p] = v;
        this.render();
        if (inp.type === 'checkbox' || inp.tagName === 'SELECT' || p === 'text') this.renderProps();
        this.onChange();
      };
      inp.addEventListener('input', handler); inp.addEventListener('change', handler);
    });
  }
}

function esc(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'); }
export { FONTS };
