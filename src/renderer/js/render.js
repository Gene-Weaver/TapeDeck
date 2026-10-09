// Layout -> 1-bit label bitmap at 180 dpi. Width = length along the tape, height = tape pins.
// measureItems() sizes every element for one label's value, arrange() (layout.js) places them,
// paintItem() draws each element and composeLabel() puts the label together.
import { tape } from './tape.js';
import { expand } from './pattern.js';
import { drawCode128, drawQr } from './codes.js';
import { arrange } from './layout.js';

export const FONTS = ['Helvetica', 'Arial', 'Helvetica Neue', 'Avenir Next', 'Futura', 'Gill Sans', 'Georgia', 'Times New Roman',
  'Courier New', 'Menlo', 'Monaco', 'SF Mono', 'Impact', 'Arial Black', 'Trebuchet MS', 'Verdana', 'Optima', 'Palatino', 'Chalkboard'];

const mctx = document.createElement('canvas').getContext('2d');

// ---- text metrics --------------------------------------------------------------------------------
function fontString(el, size) {
  return `${el.italic ? 'italic ' : ''}${el.bold ? 'bold ' : ''}${size}px "${el.font || 'Helvetica'}", Helvetica, Arial, sans-serif`;
}

function measureText(el, text, size) {
  mctx.font = fontString(el, size);
  const lines = String(text ?? '').split('\n');
  let w = 0, fontAsc = 0, fontDesc = 0;
  const per = [];
  for (const ln of lines) {
    const m = mctx.measureText(ln || ' ');
    w = Math.max(w, m.width);
    fontAsc = Math.max(fontAsc, m.fontBoundingBoxAscent ?? size * 0.8);
    fontDesc = Math.max(fontDesc, m.fontBoundingBoxDescent ?? size * 0.22);
    per.push({ asc: m.actualBoundingBoxAscent ?? 0, desc: m.actualBoundingBoxDescent ?? 0 });
  }
  const lineH = Math.round((fontAsc + fontDesc) * (el.lineHeight || 1.15));
  // Tight vertical bounds of the actual glyphs, so "UM-001-A" centers on its capitals rather than on
  // the font's em box with its empty descender space. Blank text falls back to the font metrics.
  let asc = Math.ceil(per[0].asc), desc = Math.ceil(per[per.length - 1].desc);
  if (asc + desc < 2) { asc = Math.ceil(fontAsc); desc = Math.ceil(fontDesc); }
  return { w: Math.ceil(w), lineH, asc, h: Math.max(1, (lines.length - 1) * lineH + asc + desc), emH: lines.length * lineH, lines };
}

const emCache = new Map();
/** Largest font size whose line boxes fit `maxEm` dots. Depends only on the font and line count, so it is cached. */
function fitEm(el, lines, maxEm) {
  const key = `${fontString(el, 100)}|${el.lineHeight}|${lines}|${maxEm}`;
  let size = emCache.get(key);
  if (size == null) {
    const probe = new Array(lines).fill('Hg').join('\n');
    let lo = 4, hi = 2000;
    while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (measureText(el, probe, mid).emH <= maxEm) lo = mid; else hi = mid - 1; }
    size = lo;
    if (emCache.size > 500) emCache.clear();
    emCache.set(key, size);
  }
  return size;
}

/** Auto size: as large as the tape allows (the em box fits maxEm, descenders safe), shrunk further to fit maxW if given. */
function fitText(el, text, maxEm, maxW) {
  let size = fitEm(el, String(text).split('\n').length, maxEm);
  if (maxW && measureText(el, text, size).w > maxW) {
    let lo = 4, hi = size - 1;
    while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (measureText(el, text, mid).w <= maxW) lo = mid; else hi = mid - 1; }
    size = lo;
  }
  return size;
}

// ---- series: text boxes set to "same width for all labels" fit the widest value of the whole series ----
let series = { values: [], key: 0 };
const seriesWidths = new Map();
/** values: label values spread over the whole series (pattern.js patternSample / spread). */
export function setSeries(values) { series = { values: Array.isArray(values) ? values : [], key: series.key + 1 }; seriesWidths.clear(); }

function seriesWidth(el, maxEm, run) {
  const key = [el.text, el.font, el.bold, el.italic, el.lineHeight, el.autoSize, el.size, maxEm, run].join('|');
  let w = seriesWidths.get(key);
  if (w == null) {
    w = 1;
    const vals = series.values.length ? series.values : [{ text: '', n: 1, i: 1, fields: {} }];
    for (const v of vals) {
      const text = expand(el.text, v);
      const size = el.autoSize ? fitText(el, text, maxEm, run) : Math.max(4, Math.round(el.size || 20));
      w = Math.max(w, measureText(el, text, size).w);
    }
    seriesWidths.set(key, w);
  }
  return w;
}

// ---- measuring -------------------------------------------------------------------------------------
const sideways = (el) => (((el.rotate || 0) % 180) + 180) % 180 !== 0;

/** Element size before rotation, in dots, for this label's value. */
function measureElement(el, value, H) {
  const side = sideways(el);
  switch (el.type) {
    case 'text': {
      const text = expand(el.text, value);
      const maxEm = side ? 600 : Math.max(4, H - 2);
      const run = side ? Math.max(4, H - 2) : null;          // sideways text runs across the tape
      let boxW = null;
      if (el.widthMode === 'fixed') boxW = Math.max(4, Math.round(el.w || 0));
      else if (el.widthMode === 'series') boxW = seriesWidth(el, maxEm, run);
      const limit = run && boxW ? Math.min(run, boxW) : (run || boxW);
      const size = el.autoSize ? fitText(el, text, maxEm, limit) : Math.max(4, Math.round(el.size || 20));
      const m = measureText(el, text, size);
      return { w: boxW ?? Math.max(1, m.w), h: m.h, text, size, m };
    }
    case 'image': {
      const h = el.fullHeight && !side ? H : Math.max(1, Math.round(el.h || 1));
      const img = el._img;
      const w = el.keepAspect && img && img.naturalWidth && img.naturalHeight ? Math.max(1, Math.round(h * img.naturalWidth / img.naturalHeight)) : Math.max(1, Math.round(el.w || 1));
      return { w, h };
    }
    case 'qr': { const s = el.fullHeight ? H : Math.max(8, Math.round(el.size || H)); return { w: s, h: s }; }
    case 'barcode': return { w: Math.max(16, Math.round(el.w || 16)), h: el.fullHeight && !side ? H : Math.max(4, Math.round(el.h || H)) };
    case 'rect': return { w: Math.max(2, Math.round(el.w || 2)), h: el.fullHeight && !side ? H : Math.max(2, Math.round(el.h || H)) };
    case 'line': return { w: Math.max(1, Math.round(el.w || 1)), h: el.fullHeight && !side ? H : Math.max(1, Math.round(el.h || H)) };
    default: return { w: 1, h: 1 };
  }
}

/**
 * Size every visible element for one label. Returns { H, items } with items in list order:
 * { id, el, rot, iw, ih (size before rotation), w, h (size on the label), info }.
 */
export function measureItems(L, value, tapeMm) {
  const H = tape(tapeMm).pins;
  const items = [];
  for (const el of L.elements) {
    if (el.hidden) continue;
    const info = measureElement(el, value, H);
    const rot = (((el.rotate || 0) % 360) + 360) % 360;
    const side = rot % 180 !== 0;
    items.push({ id: el.id, el, rot, iw: info.w, ih: info.h, w: side ? info.h : info.w, h: side ? info.w : info.h, info });
  }
  return { H, items };
}

// ---- painting --------------------------------------------------------------------------------------
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
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(srcImg, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h), d = img.data;
  const g = new Float32Array(w * h);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const a = d[i + 3] / 255;
    const lum = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) * a + 255 * (1 - a);
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

const dithered = new WeakMap();   // image -> Map(settings -> canvas), so a photo is dithered once per size, not once per label
function ditherCached(el, w, h) {
  let m = dithered.get(el._img);
  if (!m) { m = new Map(); dithered.set(el._img, m); }
  const key = `${w}x${h}|${el.dither}|${el.threshold}|${el.invert}`;
  let c = m.get(key);
  if (!c) { if (m.size > 16) m.clear(); c = ditherImage(el._img, w, h, el.dither, el.threshold, el.invert); m.set(key, c); }
  return c;
}

/** Draw one measured element (unrotated) into its own canvas. */
export function paintItem(it, value) {
  const el = it.el, w = Math.max(1, it.iw), h = Math.max(1, it.ih);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  switch (el.type) {
    case 'text': {
      const { size, m } = it.info;
      if (el.invert) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h); }
      ctx.fillStyle = el.invert ? '#fff' : '#000';
      ctx.font = fontString(el, size);
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = el.align || 'left';
      const ax = el.align === 'center' ? w / 2 : el.align === 'right' ? w : 0;
      m.lines.forEach((ln, i) => ctx.fillText(ln, ax, Math.round(i * m.lineH + m.asc)));
      break;
    }
    case 'image': {
      if (el._img && el._img.complete && el._img.naturalWidth) ctx.drawImage(ditherCached(el, w, h), 0, 0);
      else {
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
        ctx.strokeStyle = '#000'; ctx.setLineDash([3, 3]); ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(w, h); ctx.moveTo(w, 0); ctx.lineTo(0, h); ctx.stroke();
      }
      break;
    }
    case 'qr': {
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = '#000';
      el._qr = drawQr(ctx, expand(el.text, value), 0, 0, w, el.ecc || 'M', el.quiet ?? 1);
      break;
    }
    case 'barcode': {
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = '#000';
      const txt = expand(el.text, value);
      let barH = h;
      if (el.showText) {
        const fs = Math.max(6, Math.min(12, Math.round(h * 0.3)));
        barH = h - fs - 1;
        ctx.fillStyle = '#000'; ctx.font = `${fs}px Helvetica, Arial, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
        ctx.fillText(txt, w / 2, h - 1);
      }
      el._bc = drawCode128(ctx, txt, 0, 0, w, barH);
      break;
    }
    case 'rect': {
      const s = Math.max(1, Math.round(el.stroke || 1)), r = Math.max(0, Math.min(el.radius || 0, Math.min(w, h) / 2));
      ctx.fillStyle = '#000'; ctx.strokeStyle = '#000';
      ctx.beginPath();
      if (el.fill) { ctx.roundRect(0, 0, w, h, r); ctx.fill(); }
      else { ctx.lineWidth = s; ctx.roundRect(s / 2, s / 2, w - s, h - s, Math.max(0, r - s / 2)); ctx.stroke(); }
      break;
    }
    case 'line': ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h); break;
  }
  return c;
}

/** Put a label together from painted elements. opts.exclude leaves one element out (the designer draws it under the pointer). */
export function composeLabel(L, arr, items, canvases, { exclude = null, oneBit = true } = {}) {
  const W = arr.W, H = arr.H;
  const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });   // read back for 1-bit conversion and printing
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  ctx.imageSmoothingEnabled = false;
  for (const it of items) {
    if (it.id === exclude) continue;
    const b = arr.boxes[it.id], c = canvases.get(it.id);
    if (!b || !c) continue;
    ctx.save();
    ctx.translate(b.x + it.w / 2, b.y + it.h / 2);
    ctx.rotate(it.rot * Math.PI / 180);
    ctx.drawImage(c, -it.iw / 2, -it.ih / 2);
    ctx.restore();
  }
  if (L.border) {
    const s = Math.max(1, Math.round(L.borderWidth || 2));
    ctx.strokeStyle = '#000'; ctx.lineWidth = s;
    ctx.strokeRect(s / 2, s / 2, W - s, H - s);
  }
  if (oneBit) toOneBit(ctx, W, H);
  return canvas;
}

/**
 * Render a full label. Returns { canvas, width, height, boxes, arr, items, canvases }; all coordinates in dots.
 * opts: { order, exclude, oneBit } (see arrange and composeLabel). The canvas is strictly black and white.
 */
export function renderLabel(L, value, tapeMm, opts = {}) {
  const { H, items } = measureItems(L, value, tapeMm);
  const arr = arrange(L, items, H, opts);
  const canvases = new Map(items.map(it => [it.id, paintItem(it, value)]));
  const canvas = composeLabel(L, arr, items, canvases, opts);
  return { canvas, width: arr.W, height: H, boxes: arr.boxes, arr, items, canvases };
}

/** Label length in dots without painting anything. */
export function measureLabelWidth(L, value, tapeMm) {
  const { H, items } = measureItems(L, value, tapeMm);
  return arrange(L, items, H).W;
}

export function canvasToPng(canvas) { return canvas.toDataURL('image/png'); }

// ---- images ------------------------------------------------------------------------------------------
const imgCache = new Map();   // data URL -> loaded image, so undo and layout switches do not reload photos
const loadImg = (src) => new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error('The image could not be read')); im.src = src; });
function remember(src, img) { if (imgCache.size > 40) imgCache.delete(imgCache.keys().next().value); imgCache.set(src, img); }

/** Attach loaded images (`_img`) to a layout read from a file or restored by undo. */
export function hydrateLayout(L) {
  const waits = [];
  for (const el of L.elements) {
    if (el.type !== 'image') continue;
    if (!el.src) { el._img = null; continue; }
    const hit = imgCache.get(el.src);
    if (hit) { el._img = hit; continue; }
    waits.push(loadImg(el.src).then((im) => { remember(el.src, im); el._img = im; }, () => { el._img = null; }));
  }
  return Promise.all(waits).then(() => L);
}

/** Read an image file as a data URL, scaled down so its longer side is at most maxSide pixels (labels are at most 128 dots tall). */
export async function readImageFile(file, maxSide = 600) {
  const url = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => rej(fr.error); fr.readAsDataURL(file); });
  let img = await loadImg(url), src = url;
  const big = Math.max(img.naturalWidth, img.naturalHeight);
  if (big > maxSide) {
    const k = maxSide / big, c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.naturalWidth * k)); c.height = Math.max(1, Math.round(img.naturalHeight * k));
    const ctx = c.getContext('2d'); ctx.imageSmoothingQuality = 'high'; ctx.drawImage(img, 0, 0, c.width, c.height);
    src = c.toDataURL('image/png');
    img = await loadImg(src);
  }
  remember(src, img);
  return { src, img };
}
