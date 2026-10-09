// Layout model: placement geometry, snapping and the layout file format. No DOM in here, so all of it
// runs under `node --test`.
//
// In memory every length is in printer dots (180 dpi, 7.087 dots per mm; fractional values are fine and
// get rounded when drawn). Layout files store millimeters and font sizes in points, which keeps them
// readable, hand-editable and independent of the tape width.
//
// Placement. Elements in the row (the default) are laid out left to right in list order:
//   [padding][spaceBefore A][A][spaceAfter A][gap][spaceBefore B][B][spaceAfter B][padding]
// so a resize, a longer name or a different tape moves everything after it automatically. A free
// element ignores the row and sits at x (or centered on the label). Vertically every element is either
// centered on the tape or at y. List order is also drawing order: later elements are drawn on top.
import { DOTS_PER_MM } from './tape.js';

export const FORMAT = 'tapedeck-layout';
export const VERSION = 2;
export const TYPES = ['text', 'image', 'qr', 'barcode', 'rect', 'line'];
export const DOTS_PER_PT = 180 / 72;
export const MIN_LENGTH = 8;            // dots
export const JUSTIFY = ['start', 'center', 'end', 'spread'];

const fromMm = (mm) => mm * DOTS_PER_MM;
const round = (v, digits) => { const f = 10 ** digits; return Math.round(v * f) / f; };
const toMm = (dots) => round(dots / DOTS_PER_MM, 3);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

let seq = 0;
export const uid = () => `e${Date.now().toString(36)}${(seq++).toString(36)}`;

const BASE = { name: '', free: false, x: 0, y: 0, hCenter: false, vCenter: true, spaceBefore: 0, spaceAfter: 0, rotate: 0, hidden: false };

/** A new element with defaults for a tape `pins` dots high. */
export function newElement(type, pins = 42) {
  const base = { id: uid(), type, ...BASE };
  switch (type) {
    case 'text': return { ...base, text: '{text}', font: 'Helvetica', size: Math.round(pins * 0.7), autoSize: true, bold: false, italic: false,
      align: 'center', widthMode: 'auto', w: fromMm(20), lineHeight: 1.15, invert: false };
    case 'image': return { ...base, src: null, w: pins, h: pins, fullHeight: true, keepAspect: true, dither: 'fs', threshold: 128, invert: false };
    case 'qr': return { ...base, text: '{text}', size: pins, fullHeight: true, ecc: 'M', quiet: 1 };
    case 'barcode': return { ...base, text: '{text}', w: Math.round(pins * 3), h: pins, fullHeight: true, showText: false };
    case 'rect': return { ...base, w: fromMm(8), h: pins, fullHeight: true, stroke: 2, radius: 0, fill: false };
    case 'line': return { ...base, w: 2, h: pins, fullHeight: true };
    default: throw new Error(`Unknown element type "${type}"`);
  }
}

export function newLayout(name = 'Untitled') {
  return { version: VERSION, name, description: '', length: { mode: 'auto', fixed: fromMm(40) }, padding: fromMm(1), gap: fromMm(1.25),
    justify: 'start', border: false, borderWidth: 2, elements: [] };
}

// ---- file format -------------------------------------------------------------------------------
// Field kinds: 'len' = dots in memory / mm on disk, 'pt' = dots in memory / points on disk,
// 'num', 'bool', 'str', 'str?' (string or null), or an array of allowed values.
const COMMON_FIELDS = { name: 'str', free: 'bool', x: 'len', y: 'len', hCenter: 'bool', vCenter: 'bool', spaceBefore: 'len', spaceAfter: 'len', rotate: [0, 90, 180, 270], hidden: 'bool' };
const TYPE_FIELDS = {
  text: { text: 'str', font: 'str', size: 'pt', autoSize: 'bool', bold: 'bool', italic: 'bool', align: ['left', 'center', 'right'], widthMode: ['auto', 'series', 'fixed'], w: 'len', lineHeight: 'num', invert: 'bool' },
  image: { src: 'str?', w: 'len', h: 'len', fullHeight: 'bool', keepAspect: 'bool', dither: ['fs', 'threshold'], threshold: 'num', invert: 'bool' },
  qr: { text: 'str', size: 'len', fullHeight: 'bool', ecc: ['L', 'M', 'Q', 'H'], quiet: 'num' },
  barcode: { text: 'str', w: 'len', h: 'len', fullHeight: 'bool', showText: 'bool' },
  rect: { w: 'len', h: 'len', fullHeight: 'bool', stroke: 'len', radius: 'len', fill: 'bool' },
  line: { w: 'len', h: 'len', fullHeight: 'bool' },
};
// Sanity limits (in memory units) so a hand-edited file cannot produce absurd canvases.
const LIMITS = { x: [-20000, 20000], y: [-2000, 2000], spaceBefore: [-2000, 2000], spaceAfter: [-2000, 2000], w: [1, 20000], h: [1, 2000],
  size: [4, 2000], stroke: [0, 200], radius: [0, 1000], lineHeight: [0.5, 4], threshold: [1, 254], quiet: [0, 8] };
const fileKey = (type, key) => (type === 'text' && key === 'size' ? 'fontSize' : key);

function coerce(kind, v, key) {
  if (Array.isArray(kind)) return kind.includes(v) ? v : undefined;
  let out;
  switch (kind) {
    case 'bool': return typeof v === 'boolean' ? v : undefined;
    case 'str': return typeof v === 'string' ? v : (isNum(v) ? String(v) : undefined);
    case 'str?': return typeof v === 'string' || v === null ? v : undefined;
    case 'num': out = isNum(v) ? v : undefined; break;
    case 'len': out = isNum(v) ? fromMm(v) : undefined; break;
    case 'pt': out = isNum(v) ? v * DOTS_PER_PT : undefined; break;
    default: return undefined;
  }
  if (out !== undefined && LIMITS[key]) out = clamp(out, ...LIMITS[key]);
  return out;
}

function elementFromFile(j, warnings) {
  const el = newElement(j.type);
  const fields = { ...COMMON_FIELDS, ...TYPE_FIELDS[j.type] };
  for (const [key, kind] of Object.entries(fields)) {
    const fk = fileKey(j.type, key);
    if (!(fk in j)) continue;
    const v = coerce(kind, j[fk], key);
    if (v === undefined) warnings.push(`${j.type}: ignored invalid "${fk}"`);
    else el[key] = v;
  }
  return el;
}

/** Element -> plain object for the file (mm / pt), leaving out fields that do nothing in its current mode. */
function elementToFile(el) {
  const out = { type: el.type };
  if (el.name) out.name = el.name;
  const skip = new Set();
  if (el.type === 'text') { if (el.autoSize) skip.add('size'); if (el.widthMode !== 'fixed') skip.add('w'); }
  if (el.fullHeight) skip.add(el.type === 'qr' ? 'size' : 'h');
  for (const [key, kind] of Object.entries(TYPE_FIELDS[el.type])) {
    if (skip.has(key) || el[key] === undefined) continue;
    const v = el[key];
    out[fileKey(el.type, key)] = kind === 'len' ? toMm(v) : kind === 'pt' ? round(v / DOTS_PER_PT, 2) : v;
  }
  if (el.free) {
    out.free = true;
    if (el.hCenter) out.hCenter = true; else out.x = toMm(el.x);
  } else {
    if (el.spaceBefore) out.spaceBefore = toMm(el.spaceBefore);
    if (el.spaceAfter) out.spaceAfter = toMm(el.spaceAfter);
  }
  out.vCenter = !!el.vCenter;
  if (!el.vCenter) out.y = toMm(el.y);
  if (el.rotate) out.rotate = el.rotate;
  if (el.hidden) out.hidden = true;
  return out;
}

/** In-memory layout -> the JSON object written to layouts/<id>.json. */
export function toFile(L) {
  const out = { format: FORMAT, version: VERSION, name: L.name || 'Untitled' };
  if (L.description) out.description = L.description;
  out.units = { length: 'mm', fontSize: 'pt' };
  out.length = { mode: L.length.mode === 'fixed' ? 'fixed' : 'auto', fixed: toMm(L.length.fixed) };
  out.padding = toMm(L.padding);
  out.gap = toMm(L.gap);
  out.justify = L.justify;
  out.border = !!L.border;
  if (L.border) out.borderWidth = toMm(L.borderWidth);
  out.elements = L.elements.map(elementToFile);
  return out;
}
export const toFileText = (L) => JSON.stringify(toFile(L), null, 2) + '\n';

/**
 * Parse a layout file (format 2, or the version-1 layouts older TapeDeck builds exported) into the
 * in-memory model. Throws on anything that is not a layout. Problems that can be skipped (an unknown
 * element type, an invalid value) are listed in the returned layout's `_warnings`.
 */
export function fromFile(j) {
  if (!j || typeof j !== 'object' || !Array.isArray(j.elements)) throw new Error('Not a TapeDeck layout (no "elements" list)');
  const warnings = [];
  let L;
  if (j.format === FORMAT) {
    if (isNum(j.version) && j.version > VERSION) throw new Error(`This layout was saved by a newer TapeDeck (format version ${j.version})`);
    L = newLayout(typeof j.name === 'string' && j.name.trim() ? j.name : 'Untitled');
    if (typeof j.description === 'string') L.description = j.description;
    if (j.length && typeof j.length === 'object') {
      L.length.mode = j.length.mode === 'fixed' ? 'fixed' : 'auto';
      if (isNum(j.length.fixed)) L.length.fixed = clamp(fromMm(j.length.fixed), MIN_LENGTH, 100000);
    }
    if (isNum(j.padding)) L.padding = clamp(fromMm(j.padding), 0, 2000);
    if (isNum(j.gap)) L.gap = clamp(fromMm(j.gap), -2000, 2000);
    if (JUSTIFY.includes(j.justify)) L.justify = j.justify;
    L.border = j.border === true;
    if (isNum(j.borderWidth)) L.borderWidth = clamp(fromMm(j.borderWidth), 1, 50);
    for (const e of j.elements) {
      if (!e || !TYPES.includes(e.type)) { warnings.push(`skipped an element of unknown type "${e && e.type}"`); continue; }
      L.elements.push(elementFromFile(e, warnings));
    }
  } else {
    L = fromV1(j, warnings);
  }
  if (warnings.length) L._warnings = warnings;
  return L;
}

// Version 1 (TapeDeck 0.1): lengths in dots, every element absolutely positioned. Migrated as free
// elements so the design looks exactly the same; "Arrange in a row" turns it into a row afterwards.
function fromV1(j, warnings) {
  const L = newLayout(typeof j.name === 'string' && j.name.trim() ? j.name : 'Untitled');
  const len = j.length || {};
  L.length.mode = len.mode === 'fixed' ? 'fixed' : 'auto';
  if (isNum(len.dots)) L.length.fixed = clamp(len.dots, MIN_LENGTH, 100000);
  L.padding = isNum(len.padding) ? clamp(len.padding, 0, 2000) : 6;
  L.gap = 0;
  L.border = j.border === true;
  if (isNum(j.borderWidth)) L.borderWidth = clamp(j.borderWidth, 1, 50);
  for (const e of j.elements) {
    if (!e || !TYPES.includes(e.type)) { warnings.push(`skipped an element of unknown type "${e && e.type}"`); continue; }
    const el = newElement(e.type);
    const fields = { ...COMMON_FIELDS, ...TYPE_FIELDS[e.type] };
    for (const [key, kind] of Object.entries(fields)) {
      if (!(key in e) || key === 'free' || key === 'name') continue;
      const v = kind === 'len' || kind === 'pt' ? (isNum(e[key]) ? clamp(e[key], ...(LIMITS[key] || [-1e5, 1e5])) : undefined) : coerce(kind, e[key], key);
      if (v !== undefined) el[key] = v;
    }
    el.free = true;
    el.fullHeight = false;
    if (e.type === 'text') { el.widthMode = isNum(e.w) ? 'fixed' : 'auto'; if (!isNum(e.w)) el.w = fromMm(20); }
    L.elements.push(el);
  }
  return L;
}

// ---- geometry ----------------------------------------------------------------------------------

/**
 * Place measured items on a label `H` dots high.
 * items: [{ id, el, w, h }] in list order with w/h the size on the label (after rotation); hidden
 *        elements must already be left out.
 * opts.order: ids of the row elements in the order to use (the designer's drag preview).
 * Returns { W, H, pad, boxes: { id: { x, y, w, h, row } }, row: [ids], overflow }.
 */
export function arrange(L, items, H, opts = {}) {
  const r = Math.round;
  const pad = Math.max(0, r(L.padding || 0)), gap = r(L.gap || 0);
  const fixed = L.length && L.length.mode === 'fixed';
  let row = items.filter(it => !it.el.free);
  if (opts.order) {
    const pos = new Map(opts.order.map((id, k) => [id, k]));
    row = row.map((it, k) => [it, pos.has(it.id) ? pos.get(it.id) : 1e6 + k]).sort((a, b) => a[1] - b[1]).map(p => p[0]);
  }
  const free = items.filter(it => it.el.free);
  const sb = (it) => r(it.el.spaceBefore || 0), sa = (it) => r(it.el.spaceAfter || 0);
  let rowW = 0;
  row.forEach((it, k) => { rowW += (k ? gap : 0) + sb(it) + it.w + sa(it); });

  let W;
  if (fixed) W = Math.max(MIN_LENGTH, r(L.length.fixed || 0));
  else if (!items.length) W = r(10 * DOTS_PER_MM);
  else {
    W = row.length ? pad + rowW + pad : 0;
    for (const it of free) W = Math.max(W, it.el.hCenter ? it.w + 2 * pad : r(it.el.x || 0) + it.w + pad);
    W = Math.max(MIN_LENGTH, W);
  }

  let start = pad, between = gap;
  const extra = W - 2 * pad - rowW;
  if (fixed && extra > 0 && row.length) {
    if (L.justify === 'center' || (L.justify === 'spread' && row.length === 1)) start += Math.floor(extra / 2);
    else if (L.justify === 'end') start += extra;
    else if (L.justify === 'spread') between = gap + extra / (row.length - 1);
  }
  const vpos = (it) => (it.el.vCenter ? r((H - it.h) / 2) : r(it.el.y || 0));
  const boxes = {};
  let cursor = start;
  row.forEach((it, k) => {
    if (k) cursor += between;
    cursor += sb(it);
    boxes[it.id] = { x: r(cursor), y: vpos(it), w: it.w, h: it.h, row: true };
    cursor += it.w + sa(it);
  });
  for (const it of free) boxes[it.id] = { x: it.el.hCenter ? r((W - it.w) / 2) : r(it.el.x || 0), y: vpos(it), w: it.w, h: it.h, row: false };
  const overflow = items.some(it => boxes[it.id].x < 0 || boxes[it.id].x + it.w > W);
  return { W, H, pad, boxes, row: row.map(it => it.id), overflow };
}

/** Guide lines a dragged box can snap to: label ends, padding, label center, tape edges and center, and every other element's edges and centers. */
export function snapTargets(arr, excludeId) {
  const x = [{ v: 0, kind: 'edge' }, { v: arr.W, kind: 'edge' }, { v: arr.W / 2, kind: 'labelCenter' }];
  if (arr.pad > 0) x.push({ v: arr.pad, kind: 'padding' }, { v: arr.W - arr.pad, kind: 'padding' });
  const y = [{ v: 0, kind: 'tapeTop' }, { v: arr.H, kind: 'tapeBottom' }, { v: arr.H / 2, kind: 'tapeCenter' }];
  for (const [id, b] of Object.entries(arr.boxes)) {
    if (id === excludeId) continue;
    x.push({ v: b.x, kind: 'element' }, { v: b.x + b.w / 2, kind: 'element' }, { v: b.x + b.w, kind: 'element' });
    y.push({ v: b.y, kind: 'element' }, { v: b.y + b.h / 2, kind: 'element' }, { v: b.y + b.h, kind: 'element' });
  }
  return { x, y };
}

/**
 * Snap a box being dragged. Each axis tries the box's start, center and end against every target
 * within `tol` dots and keeps the closest. Returns { x, y, hitX, hitY } where a hit is
 * { v, kind, edge: 'start' | 'center' | 'end' } or null.
 */
export function snapBox(box, targets, tol, axes = { x: true, y: true }) {
  const best = (pos, size, list) => {
    let hit = null;
    for (const t of list) {
      for (const [edge, off] of [['start', 0], ['center', size / 2], ['end', size]]) {
        const d = t.v - (pos + off);
        if (Math.abs(d) <= tol && (!hit || Math.abs(d) < Math.abs(hit.d) - 1e-9)) hit = { d, v: t.v, kind: t.kind, edge };
      }
    }
    return hit;
  };
  const hx = axes.x ? best(box.x, box.w, targets.x || []) : null;
  const hy = axes.y ? best(box.y, box.h, targets.y || []) : null;
  return { x: hx ? Math.round(box.x + hx.d) : box.x, y: hy ? Math.round(box.y + hy.d) : box.y, hitX: hx, hitY: hy };
}

// ---- ordering ----------------------------------------------------------------------------------

/** Ids of the visible row elements in list order. */
export const rowOrder = (L) => L.elements.filter(e => !e.free && !e.hidden).map(e => e.id);

/** Move row element `id` so it becomes the k-th visible row element. Free and hidden elements keep their list positions relative to the rest. Returns true if the order changed. */
export function moveInRow(L, id, k) {
  const els = L.elements, from = els.findIndex(e => e.id === id);
  if (from < 0) return false;
  const before = els.map(e => e.id).join();
  const [el] = els.splice(from, 1);
  const others = els.filter(e => !e.free && !e.hidden);
  let at;
  if (!others.length) at = Math.min(from, els.length);
  else if (k <= 0) at = els.indexOf(others[0]);
  else if (k >= others.length) at = els.indexOf(others[others.length - 1]) + 1;
  else at = els.indexOf(others[k]);
  els.splice(at, 0, el);
  return els.map(e => e.id).join() !== before;
}

/** Move the element at list index `from` to index `to` (the index it ends up at). */
export function moveInList(L, from, to) {
  const els = L.elements;
  if (from < 0 || from >= els.length) return false;
  to = clamp(to, 0, els.length - 1);
  if (from === to) return false;
  const [el] = els.splice(from, 1);
  els.splice(to, 0, el);
  return true;
}

/** Turn every visible element into a row element ordered by its current x, keeping the spacing it has now (boxes from arrange()). */
export function arrangeAsRow(L, boxes) {
  const vis = L.elements.filter(e => !e.hidden && boxes[e.id]);
  const sorted = [...vis].sort((a, b) => boxes[a.id].x - boxes[b.id].x || L.elements.indexOf(a) - L.elements.indexOf(b));
  const pad = Math.round(L.padding || 0), gap = Math.round(L.gap || 0);
  let end = null;
  for (const e of sorted) {
    const b = boxes[e.id];
    const natural = end == null ? pad : end + gap;
    e.free = false; e.hCenter = false; e.spaceAfter = 0;
    e.spaceBefore = Math.max(end == null ? 0 : -gap, b.x - natural);
    end = natural + e.spaceBefore + b.w;
  }
  const rest = L.elements.filter(e => !sorted.includes(e));
  L.elements = [...sorted, ...rest];
  return L;
}

// ---- snapshots (undo history) ------------------------------------------------------------------

/** Copy of a layout without runtime fields (keys starting with "_"); strings such as image data are shared, not copied. */
export function snapshot(L) {
  const out = {};
  for (const k in L) if (k[0] !== '_') out[k] = L[k];
  out.length = { ...L.length };
  out.elements = L.elements.map(e => { const o = {}; for (const k in e) if (k[0] !== '_') o[k] = e[k]; return o; });
  return out;
}

/** A cheap fingerprint for "did anything change" (image data reduced to its length and tail). */
export function signature(L) {
  return JSON.stringify(snapshot(L), (k, v) => (k === 'src' && typeof v === 'string' ? `${v.length}:${v.slice(-24)}` : v));
}
