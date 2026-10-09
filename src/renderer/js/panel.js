// The designer's side panel: the element list (drag a row to reorder it; the top of the list is the
// left end of the label and later elements draw on top), the layout's settings, and the selected
// element's properties. Inputs edit the model directly. Text and number fields never rebuild the
// panel while you type; only checkboxes, menus and buttons that change which fields apply do.
import { DOTS_PER_MM } from './tape.js';
import { moveInList, arrangeAsRow, MIN_LENGTH } from './layout.js';

const PT = 180 / 72;
export const ICON = { text: 'T', image: '▣', qr: '▦', barcode: '▥', rect: '▭', line: '│' };
export const TYPE_NAME = { text: 'Text', image: 'Photo', qr: 'QR code', barcode: 'Barcode', rect: 'Box', line: 'Line' };
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const mm = (dots) => String(Math.round((dots / DOTS_PER_MM) * 100) / 100);
const pt = (dots) => String(Math.round((dots / PT) * 10) / 10);
const EYE = '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M1.3 8S3.8 3.4 8 3.4 14.7 8 14.7 8 12.2 12.6 8 12.6 1.3 8 1.3 8z" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="8" r="2.1" fill="currentColor"/></svg>';
const EYE_OFF = '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M1.3 8S3.8 3.4 8 3.4 14.7 8 14.7 8 12.2 12.6 8 12.6 1.3 8 1.3 8z" fill="none" stroke="currentColor" stroke-width="1.3" opacity=".55"/><path d="M2.5 13.5l11-11" stroke="currentColor" stroke-width="1.4"/></svg>';

const field = (label, inner, cls = '') => `<label class="field ${cls}"><span>${label}</span>${inner}</label>`;
const numInput = (t, key, val, { step = 0.1, min = null, disabled = false, u = 'mm', title = '' } = {}) =>
  `<input type="number" data-${t}="${key}" data-u="${u}" step="${step}" ${min != null ? `min="${min}"` : ''} value="${esc(val)}" ${disabled ? 'disabled' : ''} ${title ? `title="${esc(title)}"` : ''}>`;
const checkbox = (t, key, label, on, { disabled = false, title = '' } = {}) =>
  `<label class="check" ${title ? `title="${esc(title)}"` : ''}><input type="checkbox" data-${t}="${key}" ${on ? 'checked' : ''} ${disabled ? 'disabled' : ''}> ${label}</label>`;
const segmented = (t, key, options, value) => `<div class="seg mini">${options.map(([v, label, title]) =>
  `<button type="button" data-${t}="${key}" data-v="${v}" class="${String(v) === String(value) ? 'active' : ''}" ${title ? `title="${esc(title)}"` : ''}>${label}</button>`).join('')}</div>`;
const select = (t, key, options, value) => `<select data-${t}="${key}">${options.map(([v, label]) => `<option value="${v}" ${String(v) === String(value) ? 'selected' : ''}>${label}</option>`).join('')}</select>`;

/** What an element is called in the list: its name, or a short description. */
export function elementLabel(el) {
  if (el.name) return el.name;
  switch (el.type) {
    case 'text': return (el.text || '').split('\n')[0] || '(empty text)';
    case 'image': return el.src ? 'Photo' : 'Photo (none chosen)';
    case 'qr': return `QR ${el.text || ''}`.trim();
    case 'barcode': return `Barcode ${el.text || ''}`.trim();
    case 'rect': return `${el.fill ? 'Filled box' : 'Box'} ${mm(el.w)} mm`;
    default: return TYPE_NAME[el.type] || el.type;
  }
}

export class Panel {
  constructor({ listEl, layoutEl, propsEl, designer, getLayout, onCommit, onRename, onPickImage }) {
    Object.assign(this, { listEl, layoutEl, propsEl, designer, getLayout, onCommit, onRename, onPickImage });
  }
  get layout() { return this.getLayout(); }

  renderAll() { this.renderList(); this.renderLayout(); this.renderProps(); }

  /** After an edit made on the canvas: rebuild the forms unless the user is typing in one of them. */
  refresh() {
    this.renderList();
    const active = document.activeElement;
    if (!this.propsEl.contains(active)) this.renderProps(); else this.sync();
    if (!this.layoutEl.contains(active)) this.renderLayout(); else this.sync();
  }

  // ---- element list --------------------------------------------------------------------------------
  renderList() {
    const L = this.layout, sel = this.designer.selectedId;
    this.listEl.innerHTML = L.elements.length ? L.elements.map((e, i) => `
      <div class="erow${e.id === sel ? ' sel' : ''}${e.hidden ? ' off' : ''}" data-id="${e.id}" data-i="${i}">
        <span class="grip" title="Drag to reorder">⋮⋮</span><span class="ico">${ICON[e.type]}</span>
        <span class="nm">${esc(elementLabel(e))}</span>${e.free ? '<span class="badge" title="Free position: not part of the row">free</span>' : ''}
        <button type="button" class="eye" data-eye="${e.id}" title="${e.hidden ? 'Show' : 'Hide'} this element">${e.hidden ? EYE_OFF : EYE}</button>
      </div>`).join('') : '<p class="hint">No elements yet: add one with the buttons above the label.</p>';
    this.listEl.querySelectorAll('[data-eye]').forEach(b => b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const el = L.elements.find(e => e.id === b.dataset.eye);
      if (!el) return;
      el.hidden = !el.hidden;
      this.designer.render();
      this.onCommit('hide');
      this.renderList();
    }));
    this._sortable();
  }

  /** Pointer-driven sorting: the grabbed row follows the pointer and the others slide out of its way. */
  _sortable() {
    const rows = [...this.listEl.querySelectorAll('.erow')];
    rows.forEach((row) => row.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0 || ev.target.closest('.eye')) return;
      const from = +row.dataset.i, startY = ev.clientY;
      const rects = rows.map(r => r.getBoundingClientRect());
      const pitch = rects.length > 1 ? rects[1].top - rects[0].top : rects[0].height + 4;
      let dragging = false, to = from;
      try { row.setPointerCapture(ev.pointerId); } catch {}
      const move = (e) => {
        const dy = e.clientY - startY;
        if (!dragging && Math.abs(dy) < 4) return;
        if (!dragging) { dragging = true; this.listEl.classList.add('sorting'); row.classList.add('lifted'); }
        const cdy = Math.max(rects[0].top - rects[from].top, Math.min(rects[rects.length - 1].top - rects[from].top, dy));
        row.style.transform = `translateY(${cdy}px)`;
        const mid = rects[from].top + rects[from].height / 2 + cdy;
        to = from;
        rects.forEach((r, j) => {
          if (j < from && mid <= r.top + r.height / 2) to = Math.min(to, j);
          if (j > from && mid >= r.top + r.height / 2) to = Math.max(to, j);
        });
        rows.forEach((r, j) => {
          if (j === from) return;
          const shift = from < to && j > from && j <= to ? -pitch : to < from && j >= to && j < from ? pitch : 0;
          r.style.transform = shift ? `translateY(${shift}px)` : '';
        });
      };
      const end = (e) => {
        row.removeEventListener('pointermove', move); row.removeEventListener('pointerup', end); row.removeEventListener('pointercancel', end);
        this.listEl.classList.remove('sorting');
        if (!dragging) { this.designer.select(row.dataset.id); return; }
        rows.forEach(r => { r.style.transform = ''; });
        row.classList.remove('lifted');
        if (e.type !== 'pointercancel' && moveInList(this.layout, from, to)) { this.designer.render(); this.onCommit('reorder'); }
        this.renderList();
      };
      row.addEventListener('pointermove', move); row.addEventListener('pointerup', end); row.addEventListener('pointercancel', end);
    }));
  }

  // ---- layout settings -------------------------------------------------------------------------------
  _layoutValue(key) {
    const L = this.layout;
    switch (key) {
      case 'length.mode': return L.length.mode;
      case 'length.fixed': return mm(L.length.fixed);
      case 'padding': case 'gap': return mm(L[key] || 0);
      default: return L[key];
    }
  }

  renderLayout() {
    const L = this.layout, fixed = L.length.mode === 'fixed', v = (k) => this._layoutValue(k);
    this.layoutEl.innerHTML = `<h4>Layout</h4>
      ${field('Name', `<input data-l="name" value="${esc(L.name)}" spellcheck="false" title="Also renames the layout's file when you press Enter or leave the field">`)}
      ${field('Notes', `<input data-l="description" value="${esc(L.description || '')}" placeholder="optional" spellcheck="false">`)}
      <div class="grid2">
        ${field('Length', segmented('l', 'length.mode', [['auto', 'Fit content'], ['fixed', 'Fixed']], L.length.mode))}
        ${field('Fixed length (mm)', numInput('l', 'length.fixed', v('length.fixed'), { step: 0.5, min: 2, disabled: !fixed }))}
        ${field('End padding (mm)', numInput('l', 'padding', v('padding'), { step: 0.1, min: 0, title: 'Blank tape at each end of the printed area' }))}
        ${field('Spacing (mm)', numInput('l', 'gap', v('gap'), { step: 0.1, title: 'Space between neighbors in the row (drag a gap with ⌥ held to change it on the label)' }))}
      </div>
      ${fixed ? field('Row alignment', segmented('l', 'justify', [['start', 'Start'], ['center', 'Center'], ['end', 'End'], ['spread', 'Spread']], L.justify)) : ''}
      ${checkbox('l', 'border', 'Border around the label', L.border)}
      ${L.elements.some(e => e.free && !e.hidden) ? '<button type="button" class="small" data-act="row" title="Put every free element into the row, in left-to-right order, keeping where it is now">Put free elements in the row</button>' : ''}`;
    this._bindInputs(this.layoutEl, 'l');
    const name = this.layoutEl.querySelector('[data-l="name"]');
    name.addEventListener('change', () => { if (this.onRename) this.onRename(name.value.trim()); });
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') name.blur(); });
    this.layoutEl.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => this._act(b.dataset.act)));
  }

  focusName() { const n = this.layoutEl.querySelector('[data-l="name"]'); if (n) { n.focus(); n.select(); } }

  // ---- element properties ----------------------------------------------------------------------------
  _value(el, key, it, box) {
    switch (key) {
      case 'x': return mm(el.hCenter && box ? box.x : el.x);
      case 'y': return mm(el.vCenter && box ? box.y : el.y);
      case 'size': return el.type === 'text' ? pt(el.autoSize && it ? it.info.size : el.size) : mm(el.fullHeight && it ? it.iw : el.size);
      case 'w': return mm(it && (el.type === 'image' || (el.type === 'text' && el.widthMode !== 'fixed')) ? it.iw : el.w);
      case 'h': return mm(it && (el.fullHeight || el.type === 'image') ? it.ih : el.h);
      case 'spaceBefore': case 'spaceAfter': case 'stroke': case 'radius': return mm(el[key] || 0);
      case 'free': return el.free ? 'free' : 'row';
      default: return el[key];
    }
  }

  renderProps() {
    const el = this.designer.selected, root = this.propsEl;
    if (!el) {
      root.innerHTML = `<h4>Element</h4><p class="hint">Select an element on the label or in the list to edit it.</p>
        <p class="hint">Elements sit in a <b>row</b>: drag one along the label and the others make room; make one bigger and everything after it moves along. Make an element <b>free</b> to place it anywhere, for example a frame over other elements.</p>`;
      return;
    }
    const it = this.designer.itemOf(el.id), box = this.designer.boxOf(el.id), v = (k) => this._value(el, k, it, box);
    const fullOk = el.type === 'qr' || !((el.rotate || 0) % 180);
    let h = `<div class="ph"><span class="ico">${ICON[el.type]}</span><h4>${TYPE_NAME[el.type]}</h4><span class="spacer"></span>
      <button type="button" class="small" data-act="dup" title="Duplicate (⌘D)">Duplicate</button><button type="button" class="small danger" data-act="del" title="Delete (⌫)">Delete</button></div>`;
    h += field('Name in the list', `<input data-k="name" value="${esc(el.name)}" placeholder="${esc(elementLabel({ ...el, name: '' }))}" spellcheck="false">`);
    switch (el.type) {
      case 'text':
        h += field('Text <small>tokens such as {text} or {Number}; Enter starts a new line</small>', `<textarea data-k="text" rows="2" spellcheck="false">${esc(el.text)}</textarea>`)
          + `<div class="grid2">${field('Font', `<input data-k="font" list="fontList" value="${esc(el.font)}" spellcheck="false">`)}${field('Size (pt)', numInput('k', 'size', v('size'), { u: 'pt', step: 0.5, min: 2, disabled: el.autoSize }))}</div>`
          + `<div class="checks">${checkbox('k', 'autoSize', 'Fit tape height', el.autoSize)}${checkbox('k', 'bold', 'Bold', el.bold)}${checkbox('k', 'italic', 'Italic', el.italic)}${checkbox('k', 'invert', 'White on black', el.invert)}</div>`
          + `<div class="grid2">${field('Box width', select('k', 'widthMode', [['auto', 'Fit the text'], ['series', 'Same for all labels'], ['fixed', 'Fixed']], el.widthMode))}${field('Width (mm)', numInput('k', 'w', v('w'), { step: 0.5, min: 0.5, disabled: el.widthMode !== 'fixed' }))}</div>`
          + (el.widthMode === 'series' ? '<p class="hint">Sized for the widest label in the whole series, so every label lines up the same.</p>' : '')
          + field('Align in the box', segmented('k', 'align', [['left', 'Left'], ['center', 'Center'], ['right', 'Right']], el.align));
        break;
      case 'image':
        h += `<div class="row"><button type="button" class="small" data-act="pick">Choose photo…</button><span class="muted">${el.src ? (it ? `${it.iw} × ${it.ih} dots` : '') : 'none yet, or drop an image on the label'}</span></div>`
          + `<div class="grid2">${field('Width (mm)', numInput('k', 'w', v('w'), { step: 0.5, min: 0.5 }))}${field('Height (mm)', numInput('k', 'h', v('h'), { step: 0.5, min: 0.5, disabled: el.fullHeight && fullOk }))}</div>`
          + `<div class="checks">${checkbox('k', 'fullHeight', 'Full tape height', el.fullHeight, { disabled: !fullOk })}${checkbox('k', 'keepAspect', 'Keep proportions', el.keepAspect)}${checkbox('k', 'invert', 'Invert', el.invert)}</div>`
          + `<div class="grid2">${field('Dithering', select('k', 'dither', [['fs', 'Floyd–Steinberg (photos)'], ['threshold', 'Threshold (logos, line art)']], el.dither))}${field('Threshold', `<input type="range" data-k="threshold" data-u="num" min="1" max="254" value="${el.threshold}" ${el.dither === 'fs' ? 'disabled' : ''}>`)}</div>`;
        break;
      case 'qr':
        h += field('Content', `<input data-k="text" value="${esc(el.text)}" spellcheck="false">`)
          + `<div class="grid2">${field('Size (mm)', numInput('k', 'size', v('size'), { step: 0.5, min: 1, disabled: el.fullHeight }))}${field('Error correction', select('k', 'ecc', [['L', 'L (7%)'], ['M', 'M (15%)'], ['Q', 'Q (25%)'], ['H', 'H (30%)']], el.ecc))}</div>`
          + `<div class="grid2 bottom">${checkbox('k', 'fullHeight', 'Full tape height', el.fullHeight)}${field('Quiet zone (modules)', numInput('k', 'quiet', el.quiet ?? 1, { u: 'int', step: 1, min: 0 }))}</div>`
          + (el._qr && !el._qr.ok ? '<p class="hint danger">This content cannot be encoded as a QR code.</p>'
            : el._qr ? `<p class="hint">${el._qr.modules}×${el._qr.modules} modules, ${el._qr.module} dot${el._qr.module === 1 ? '' : 's'} each${el._qr.module < 2 ? ': small, some scanners may struggle' : ''}.</p>` : '');
        break;
      case 'barcode':
        h += field('Content (Code 128)', `<input data-k="text" value="${esc(el.text)}" spellcheck="false">`)
          + `<div class="grid2">${field('Width (mm)', numInput('k', 'w', v('w'), { step: 0.5, min: 2 }))}${field('Height (mm)', numInput('k', 'h', v('h'), { step: 0.5, min: 0.5, disabled: el.fullHeight && fullOk }))}</div>`
          + `<div class="checks">${checkbox('k', 'fullHeight', 'Full tape height', el.fullHeight, { disabled: !fullOk })}${checkbox('k', 'showText', 'Text under the bars', el.showText)}</div>`
          + (el._bc && !el._bc.ok ? '<p class="hint danger">Only printable ASCII characters can be encoded.</p>' : '');
        break;
      case 'rect':
        h += `<div class="grid2">${field('Width (mm)', numInput('k', 'w', v('w'), { step: 0.5, min: 0.3 }))}${field('Height (mm)', numInput('k', 'h', v('h'), { step: 0.5, min: 0.3, disabled: el.fullHeight && fullOk }))}</div>`
          + `<div class="checks">${checkbox('k', 'fullHeight', 'Full tape height', el.fullHeight, { disabled: !fullOk })}${checkbox('k', 'fill', 'Filled', el.fill)}</div>`
          + `<div class="grid2">${field('Line width (mm)', numInput('k', 'stroke', v('stroke'), { step: 0.05, min: 0.1, disabled: el.fill }))}${field('Corner radius (mm)', numInput('k', 'radius', v('radius'), { step: 0.1, min: 0 }))}</div>`;
        break;
      case 'line':
        h += `<div class="grid2">${field('Thickness (mm)', numInput('k', 'w', v('w'), { step: 0.05, min: 0.1 }))}${field('Length (mm)', numInput('k', 'h', v('h'), { step: 0.5, min: 0.3, disabled: el.fullHeight && fullOk }))}</div>`
          + `<div class="checks">${checkbox('k', 'fullHeight', 'Full tape height', el.fullHeight, { disabled: !fullOk })}</div>`;
        break;
    }
    h += '<h4>Placement</h4>' + segmented('k', 'free', [['row', 'In the row', 'Laid out left to right with the others, and moves when they change'], ['free', 'Free', 'Placed anywhere; ignores the row']], v('free'));
    if (!el.free) h += `<div class="grid2">${field('Space before (mm)', numInput('k', 'spaceBefore', v('spaceBefore'), { step: 0.1 }))}${field('Space after (mm)', numInput('k', 'spaceAfter', v('spaceAfter'), { step: 0.1 }))}</div>`;
    else h += `<div class="grid2 bottom">${field('X (mm)', numInput('k', 'x', v('x'), { step: 0.1, min: 0, disabled: el.hCenter }))}${checkbox('k', 'hCenter', 'Center on the label', el.hCenter)}</div>`;
    h += `<div class="grid2 bottom">${field('Y (mm)', numInput('k', 'y', v('y'), { step: 0.1, disabled: el.vCenter }))}${checkbox('k', 'vCenter', 'Center on the tape', el.vCenter)}</div>`;
    h += field('Rotate', segmented('k', 'rotate', [[0, '0°'], [90, '90°'], [180, '180°'], [270, '270°']], el.rotate || 0));
    root.innerHTML = h;
    this._bindInputs(root, 'k');
    root.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => this._act(b.dataset.act)));
  }

  /** Focus the element's main content field (double-click on the canvas). */
  focusMain() { const f = this.propsEl.querySelector('textarea[data-k="text"], input[data-k="text"]'); if (f) { f.focus(); f.select(); } }

  /** Update input values from the model without rebuilding (skips the field being edited). */
  sync() {
    const el = this.designer.selected;
    if (el) {
      const it = this.designer.itemOf(el.id), box = this.designer.boxOf(el.id);
      this.propsEl.querySelectorAll('[data-k]').forEach(inp => this._syncInput(inp, this._value(el, inp.dataset.k, it, box)));
    }
    this.layoutEl.querySelectorAll('[data-l]').forEach(inp => this._syncInput(inp, this._layoutValue(inp.dataset.l)));
  }

  _syncInput(inp, v) {
    if (inp === document.activeElement) return;
    if (inp.tagName === 'BUTTON') inp.classList.toggle('active', String(inp.dataset.v) === String(v));
    else if (inp.type === 'checkbox') inp.checked = !!v;
    else if (inp.value !== String(v ?? '')) inp.value = v ?? '';
  }

  _bindInputs(root, t) {
    root.querySelectorAll(`[data-${t}]`).forEach((inp) => {
      const key = inp.dataset[t];
      if (inp.tagName === 'BUTTON') { inp.addEventListener('click', () => this._apply(t, key, inp.dataset.v, inp)); return; }
      const live = inp.tagName === 'TEXTAREA' || ['text', 'number', 'range', 'search'].includes(inp.type);
      inp.addEventListener(live ? 'input' : 'change', () => this._apply(t, key, inp.type === 'checkbox' ? inp.checked : inp.value, inp));
      if (inp.type === 'number') inp.addEventListener('blur', () => setTimeout(() => this.sync(), 0));   // tidy the number once editing ends
    });
  }

  _apply(t, key, raw, inp) {
    let v = raw;
    const u = inp.dataset.u;
    if (u) {
      const n = parseFloat(raw);
      if (!Number.isFinite(n)) return;                                   // half-typed number: wait for more
      if (inp.min !== '' && n < parseFloat(inp.min)) return;
      v = u === 'mm' ? n * DOTS_PER_MM : u === 'pt' ? n * PT : u === 'int' ? Math.round(n) : n;
    }
    if (t === 'l') this._applyLayout(key, v);
    else if (!this._applyElement(key, v)) return;
    this.designer.render();
    const typing = inp.tagName === 'TEXTAREA' || ['text', 'number', 'range', 'search'].includes(inp.type);
    this.onCommit(`${t}:${key}`, typing ? `${t}:${t === 'k' ? this.designer.selectedId : 'layout'}:${key}` : null);
    if (!typing) { if (t === 'l') this.renderLayout(); else this.renderProps(); }
    else this.sync();
    this.renderList();
  }

  _applyLayout(key, v) {
    const L = this.layout;
    switch (key) {
      case 'length.mode': L.length.mode = v === 'fixed' ? 'fixed' : 'auto'; break;
      case 'length.fixed': L.length.fixed = Math.max(MIN_LENGTH, v); break;
      case 'padding': L.padding = Math.max(0, v); break;
      default: L[key] = v;     // name, description, gap, justify, border
    }
  }

  _applyElement(key, v) {
    const el = this.designer.selected;
    if (!el) return false;
    const it = this.designer.itemOf(el.id), box = this.designer.boxOf(el.id);
    switch (key) {
      case 'free': {
        const free = v === 'free';
        if (free === !!el.free) return false;
        if (box) { el.x = box.x; el.y = box.y; }
        el.hCenter = false; el.free = free;
        break;
      }
      case 'hCenter': if (!v && box) el.x = box.x; el.hCenter = v; break;
      case 'vCenter': if (!v && box) el.y = box.y; el.vCenter = v; break;
      case 'autoSize': if (!v && it && it.info.size) el.size = it.info.size; el.autoSize = v; break;
      case 'widthMode': if (v === 'fixed' && it) el.w = it.iw; el.widthMode = v; break;
      case 'fullHeight':
        if (!v && it) { if (el.type === 'qr') el.size = it.iw; else { el.h = it.ih; if (el.type === 'image') el.w = it.iw; } }
        el.fullHeight = v;
        break;
      case 'keepAspect': if (!v && it) { el.w = it.iw; el.h = it.ih; } el.keepAspect = v; break;
      case 'rotate': el.rotate = Number(v) || 0; break;
      case 'w':
        if (el.type === 'image' && el.keepAspect && el._img && el._img.naturalWidth) { el.h = v * el._img.naturalHeight / el._img.naturalWidth; el.fullHeight = false; }
        el.w = v;
        break;
      default: el[key] = v;
    }
    return true;
  }

  _act(a) {
    if (a === 'row') {
      arrangeAsRow(this.layout, this.designer.res.arr.boxes);
      this.designer.render();
      this.onCommit('arrange');
      this.renderAll();
      return;
    }
    const el = this.designer.selected;
    if (!el) return;
    if (a === 'dup') this.designer.duplicate(el.id);
    else if (a === 'del') this.designer.remove(el.id);
    else if (a === 'pick' && this.onPickImage) this.onPickImage(el);
  }
}
