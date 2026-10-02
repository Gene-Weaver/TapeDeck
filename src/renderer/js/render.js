// Layout -> 1-bit label canvas at 180 dpi. Width = length along the tape, height = tape pins.
import { tape, mmToDots } from './tape.js';
import { expand } from './pattern.js';
import { drawCode128, drawQr } from './codes.js';

let _uid = 0;
export const uid = () => `e${Date.now().toString(36)}${(_uid++).toString(36)}`;

export const FONTS = ['Helvetica', 'Arial', 'Helvetica Neue', 'Avenir Next', 'Futura', 'Gill Sans', 'Georgia', 'Times New Roman',
  'Courier New', 'Menlo', 'Monaco', 'SF Mono', 'Impact', 'Arial Black', 'Trebuchet MS', 'Verdana', 'Optima', 'Palatino', 'Chalkboard'];

export function defaultElement(type, t) {
  const base = { id: uid(), type, x: 8, y: 2, rotate: 0, hCenter: false, vCenter: true };
  switch (type) {
    case 'text': return { ...base, text: '{text}', font: 'Helvetica', size: Math.round(t.pins * 0.7), bold: false, italic: false,
      align: 'left', w: null, autoSize: true, lineHeight: 1.15, invert: false };
    case 'image': return { ...base, w: t.pins, h: t.pins, src: null, dither: 'fs', threshold: 128, invert: false, keepAspect: true, _img: null };
    case 'qr': return { ...base, size: t.pins, text: '{text}', ecc: 'M' };
    case 'barcode': return { ...base, w: Math.round(t.pins * 3), h: Math.max(8, t.pins - 2), text: '{text}', showText: false };
    case 'rect': return { ...base, w: 60, h: t.pins - 2, stroke: 2, fill: false, radius: 4, vCenter: true };
    case 'line': return { ...base, w: 2, h: t.pins, stroke: 0 };
    default: throw new Error('unknown element ' + type);
  }
}

export function simpleTextLayout(opts = {}) {
  const t = tape(opts.tapeMm || 6);
  const el = { ...defaultElement('text', t), x: 0, hCenter: true, vCenter: true, align: 'center',
    font: opts.font || 'Helvetica', bold: !!opts.bold, autoSize: opts.autoSize !== false, size: opts.size || Math.round(t.pins * 0.7) };
  return { version: 1, name: 'Simple text', length: { mode: opts.lengthMode || 'auto', dots: opts.lengthDots || mmToDots(30), padding: opts.padding ?? 6 },
    border: !!opts.border, elements: [el] };
}

// ---- helpers ---------------------------------------------------------------

function fontString(el, size) {
  return `${el.italic ? 'italic ' : ''}${el.bold ? 'bold ' : ''}${size}px "${el.font || 'Helvetica'}"`;
}

const measureCtx = document.createElement('canvas').getContext('2d');

function measureText(el, size) {
  measureCtx.font = fontString(el, size);
  const lines = String(el._resolved ?? '').split('\n');
  let w = 0, asc = 0, desc = 0;
  for (const ln of lines) {
    const m = measureCtx.measureText(ln || ' ');
    w = Math.max(w, m.width);
    asc = Math.max(asc, m.fontBoundingBoxAscent ?? m.actualBoundingBoxAscent ?? size * 0.8);
    desc = Math.max(desc, m.fontBoundingBoxDescent ?? m.actualBoundingBoxDescent ?? size * 0.22);
  }
  const lh = Math.round((asc + desc) * (el.lineHeight || 1.15));
  return { w: Math.ceil(w), lineH: lh, asc, h: lh * lines.length, lines };
}

function fitTextSize(el, maxH, maxW) {
  let lo = 4, hi = 400;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const m = measureText(el, mid);
    if (m.h <= maxH && (!maxW || m.w <= maxW)) lo = mid; else hi = mid - 1;
  }
  return lo;
}

function toOneBit(ctx, w, h, threshold = 128) {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] / 255;
    const lum = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) * a + 255 * (1 - a);
    const v = lum < threshold ? 0 : 255;
    d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

export function ditherImage(srcImg, w, h, mode = 'fs', threshold = 128, invert = false) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(srcImg, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h), d = img.data;
  const g = new Float32Array(w * h);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const a = d[i + 3] / 255;
    let lum = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) * a + 255 * (1 - a);
    g[p] = invert ? 255 - lum : lum;
  }
  if (mode === 'fs') {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = y * w + x, old = g[p], nv = old < 128 ? 0 : 255, err = old - nv;
      g[p] = nv;
      if (x + 1 < w) g[p + 1] += err * 7 / 16;
      if (y + 1 < h) { if (x > 0) g[p + w - 1] += err * 3 / 16; g[p + w] += err * 5 / 16; if (x + 1 < w) g[p + w + 1] += err / 16; }
    }
  } else {
    for (let p = 0; p < g.length; p++) g[p] = g[p] < threshold ? 0 : 255;
  }
  for (let p = 0, i = 0; p < g.length; p++, i += 4) { d[i] = d[i + 1] = d[i + 2] = g[p]; d[i + 3] = 255; }
  ctx.putImageData(img, 0, 0);
  return c;
}

// ---- element rendering -----------------------------------------------------

/** Render one element into an offscreen canvas (unrotated). Returns {canvas, w, h}. */
function renderElement(el, t, value) {
  const c = document.createElement('canvas');
  const ctx0 = c.getContext('2d');
  let w = 1, h = 1;
  const resolve = (s) => expand(s, value);
  switch (el.type) {
    case 'text': {
      el._resolved = resolve(el.text);
      let size = Math.max(4, Math.round(el.size || 20));
      if (el.autoSize) size = fitTextSize(el, Math.max(4, t.pins - 2), el.w || null);
      const m = measureText(el, size);
      w = Math.max(1, el.w || m.w); h = Math.max(1, m.h);
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      if (el.invert) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h); }
      ctx.fillStyle = el.invert ? '#fff' : '#000';
      ctx.font = fontString(el, size);
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = el.align || 'left';
      const ax = el.align === 'center' ? w / 2 : el.align === 'right' ? w : 0;
      m.lines.forEach((ln, i) => ctx.fillText(ln, ax, Math.round(i * m.lineH + m.asc)));
      el._size = size;
      break;
    }
    case 'image': {
      w = Math.max(1, Math.round(el.w)); h = Math.max(1, Math.round(el.h));
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      if (el._img && el._img.complete && el._img.naturalWidth) {
        ctx.drawImage(ditherImage(el._img, w, h, el.dither, el.threshold, el.invert), 0, 0);
      } else {
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
        ctx.strokeStyle = '#000'; ctx.setLineDash([3, 3]); ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(w, h); ctx.moveTo(w, 0); ctx.lineTo(0, h); ctx.stroke();
      }
      break;
    }
    case 'qr': {
      w = h = Math.max(8, Math.round(el.size));
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = '#000';
      el._qr = drawQr(ctx, resolve(el.text), 0, 0, w, el.ecc || 'M');
      break;
    }
    case 'barcode': {
      w = Math.max(16, Math.round(el.w)); h = Math.max(4, Math.round(el.h));
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = '#000';
      const txt = resolve(el.text);
      let barH = h;
      if (el.showText) {
        const fs = Math.max(6, Math.min(12, Math.round(h * 0.3)));
        barH = h - fs - 1;
        ctx.fillStyle = '#000'; ctx.font = `${fs}px Helvetica`; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
        ctx.fillText(txt, w / 2, h - 1);
      }
      el._bc = drawCode128(ctx, txt, 0, 0, w, barH);
      break;
    }
    case 'rect': {
      w = Math.max(2, Math.round(el.w)); h = Math.max(2, Math.round(el.h));
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      const s = Math.max(1, Math.round(el.stroke || 1)), r = Math.max(0, Math.min(el.radius || 0, Math.min(w, h) / 2));
      ctx.fillStyle = '#000'; ctx.strokeStyle = '#000';
      const path = (x, y, ww, hh, rr) => { ctx.beginPath(); ctx.roundRect(x, y, ww, hh, rr); };
      if (el.fill) { path(0, 0, w, h, r); ctx.fill(); }
      else { ctx.lineWidth = s; path(s / 2, s / 2, w - s, h - s, Math.max(0, r - s / 2)); ctx.stroke(); }
      break;
    }
    case 'line': {
      w = Math.max(1, Math.round(el.w)); h = Math.max(1, Math.round(el.h));
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
      break;
    }
  }
  void ctx0;
  return { canvas: c, w, h };
}

function rotatedSize(w, h, rot) { return (rot % 180) ? { w: h, h: w } : { w, h }; }

/**
 * Render a full label. Returns { canvas, width, height, boxes:[{id,x,y,w,h}], lengthDots }.
 * All coordinates in dots. The canvas is strictly black/white.
 */
export function renderLabel(layout, value, tapeMm, { minLength = 8 } = {}) {
  const t = tape(tapeMm);
  const H = t.pins;
  const pad = Math.max(0, Math.round(layout.length?.padding ?? 6));
  const parts = [];
  for (const el of layout.elements || []) {
    if (el.hidden) continue;
    const r = renderElement(el, t, value);
    const rs = rotatedSize(r.w, r.h, el.rotate || 0);
    parts.push({ el, ...r, rw: rs.w, rh: rs.h });
  }
  let W;
  if (layout.length?.mode === 'fixed') W = Math.max(minLength, Math.round(layout.length.dots || mmToDots(30)));
  else {
    let right = 0, centeredW = 0;
    for (const p of parts) {
      if (p.el.hCenter) centeredW = Math.max(centeredW, p.rw);
      else right = Math.max(right, Math.round(p.el.x) + p.rw);
    }
    W = Math.max(minLength, Math.max(right + pad, centeredW + 2 * pad));
    if (!parts.length) W = Math.max(minLength, mmToDots(10));
  }
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  ctx.imageSmoothingEnabled = false;
  const boxes = [];
  for (const p of parts) {
    const el = p.el;
    const x = el.hCenter ? Math.round((W - p.rw) / 2) : Math.round(el.x);
    const y = el.vCenter ? Math.round((H - p.rh) / 2) : Math.round(el.y);
    const rot = ((el.rotate || 0) % 360 + 360) % 360;
    ctx.save();
    ctx.translate(x + p.rw / 2, y + p.rh / 2);
    ctx.rotate(rot * Math.PI / 180);
    ctx.drawImage(p.canvas, -p.w / 2, -p.h / 2);
    ctx.restore();
    boxes.push({ id: el.id, x, y, w: p.rw, h: p.rh });
  }
  if (layout.border) {
    const s = Math.max(1, Math.round(layout.borderWidth || 2));
    ctx.strokeStyle = '#000'; ctx.lineWidth = s;
    ctx.strokeRect(s / 2, s / 2, W - s, H - s);
  }
  toOneBit(ctx, W, H);
  return { canvas, width: W, height: H, boxes, lengthDots: W };
}

export function canvasToPng(canvas) { return canvas.toDataURL('image/png'); }

/** Load an image file into an element (sets el.src and el._img). */
export function loadImageInto(el, file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const img = new Image();
      img.onload = () => {
        el.src = fr.result; el._img = img;
        if (el.keepAspect && img.naturalWidth) el.w = Math.max(1, Math.round(el.h * img.naturalWidth / img.naturalHeight));
        resolve(el);
      };
      img.onerror = reject;
      img.src = fr.result;
    };
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}

/** Rehydrate `_img` for layouts loaded from JSON. */
export function hydrateLayout(layout) {
  const waits = [];
  for (const el of layout.elements || []) {
    if (el.type === 'image' && el.src && !el._img) {
      waits.push(new Promise((res) => { const im = new Image(); im.onload = () => { el._img = im; res(); }; im.onerror = res; im.src = el.src; }));
    }
  }
  return Promise.all(waits).then(() => layout);
}

export function serializeLayout(layout) {
  return JSON.stringify(layout, (k, v) => (k.startsWith('_') ? undefined : v));
}

/** Fast label width (dots) for text-only layouts; falls back to a full render. */
export function measureLabelWidth(layout, value, tapeMm) {
  const t = tape(tapeMm);
  if (layout.length?.mode === 'fixed') return Math.max(8, Math.round(layout.length.dots || mmToDots(30)));
  const els = (layout.elements || []).filter(e => !e.hidden);
  if (els.length && els.every(e => e.type === 'text' && !(e.rotate % 180))) {
    const pad = Math.max(0, Math.round(layout.length?.padding ?? 6));
    let right = 0, centeredW = 0;
    for (const el of els) {
      el._resolved = expand(el.text, value);
      let size = Math.max(4, Math.round(el.size || 20));
      if (el.autoSize) size = fitTextSize(el, Math.max(4, t.pins - 2), el.w || null);
      const w = Math.max(1, el.w || measureText(el, size).w);
      if (el.hCenter) centeredW = Math.max(centeredW, w); else right = Math.max(right, Math.round(el.x) + w);
    }
    return Math.max(8, Math.max(right + pad, centeredW + 2 * pad));
  }
  return renderLabel(layout, value, tapeMm).width;
}
