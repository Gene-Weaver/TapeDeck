import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fromFile, toFile, toFileText, arrange, snapBox, snapTargets, moveInRow, moveInList, arrangeAsRow, newLayout, newElement, snapshot, signature, rowOrder, FORMAT } from '../src/renderer/js/layout.js';
import { History } from '../src/renderer/js/history.js';
import { patternSample, defaultPattern, patternSeries, spread } from '../src/renderer/js/pattern.js';

const preset = (id) => JSON.parse(fs.readFileSync(new URL(`../src/presets/${id}.json`, import.meta.url), 'utf8'));
const items = (L, sizes) => L.elements.filter(e => !e.hidden).map(e => ({ id: e.id, el: e, w: sizes[e.name || e.type][0], h: sizes[e.name || e.type][1] }));

test('presets are canonical: loading and saving gives back the same file', () => {
  for (const id of ['label-wrap', 'plain']) {
    const j = preset(id);
    const L = fromFile(j);
    assert.equal(L._warnings, undefined, `${id} has warnings`);
    assert.deepEqual(toFile(L), j);
    assert.deepEqual(JSON.parse(toFileText(L)), j);
  }
});

test('label wrap reproduces the 0.1 default geometry to the dot', () => {
  const L = fromFile(preset('label-wrap'));
  assert.deepEqual(L.elements.map(e => e.type), ['qr', 'text', 'rect', 'text', 'qr']);
  assert.ok(L.elements.every(e => !e.free && e.vCenter));
  const H = 42;
  // old layout on 6 mm: QR x=4, text box 150 at 52 (centered ink), box 71 at 212, text at 293, QR at 449, length 495
  const arr = arrange(L, items(L, { QR: [H, H], Name: [144, 30], 'Fold box': [71, H], 'Name (back)': [144, 30], 'QR (back)': [H, H] }), H);
  const b = L.elements.map(e => arr.boxes[e.id]);
  assert.deepEqual(b.map(x => x.x), [4, 55, 212, 296, 449]);
  assert.equal(b[1].x + b[1].w / 2, 52 + 150 / 2);     // name centered where it was
  assert.equal(b[3].x + b[3].w / 2, 293 + 150 / 2);
  assert.equal(arr.W, 495);
  assert.equal(b[0].y, 0); assert.equal(b[1].y, 6);
});

test('row: sizes push later elements along; hidden elements are skipped by the caller', () => {
  const L = fromFile(preset('label-wrap'));
  const s = { QR: [42, 42], Name: [100, 30], 'Fold box': [71, 42], 'Name (back)': [100, 30], 'QR (back)': [42, 42] };
  const a1 = arrange(L, items(L, s), 42);
  s.Name = [140, 30];
  const a2 = arrange(L, items(L, s), 42);
  const fold = L.elements[2].id;
  assert.equal(a2.boxes[fold].x - a1.boxes[fold].x, 40);
  L.elements[0].hidden = true;
  const a3 = arrange(L, items(L, s), 42);
  assert.equal(a3.boxes[L.elements[1].id].x, 4);       // the name moved to the start, no gap before the first item
});

test('fixed length: justify start / center / end / spread and overflow', () => {
  const L = newLayout('t'); L.padding = 10; L.gap = 0; L.length = { mode: 'fixed', fixed: 200 };
  const a = newElement('rect'), b = newElement('rect'); a.name = 'a'; b.name = 'b'; L.elements.push(a, b);
  const it = items(L, { a: [20, 42], b: [30, 42] });
  const xs = (j) => { L.justify = j; const r = arrange(L, it, 42); return [r.boxes[a.id].x, r.boxes[b.id].x, r.W]; };
  assert.deepEqual(xs('start'), [10, 30, 200]);
  assert.deepEqual(xs('center'), [75, 95, 200]);
  assert.deepEqual(xs('end'), [140, 160, 200]);
  assert.deepEqual(xs('spread'), [10, 160, 200]);
  L.length.fixed = 50;
  assert.equal(arrange(L, it, 42).overflow, true);
});

test('free elements: absolute or centered, and they extend an auto length', () => {
  const L = newLayout('t'); L.padding = 6; L.gap = 9;
  const t = newElement('text'); t.name = 't';
  const box = newElement('rect'); box.name = 'box'; box.free = true; box.x = 300; box.vCenter = false; box.y = 3;
  L.elements.push(t, box);
  let r = arrange(L, items(L, { t: [100, 30], box: [20, 20] }), 42);
  assert.deepEqual([r.boxes[box.id].x, r.boxes[box.id].y, r.W], [300, 3, 326]);
  box.hCenter = true;
  r = arrange(L, items(L, { t: [100, 30], box: [20, 20] }), 42);
  assert.equal(r.W, 112); assert.equal(r.boxes[box.id].x, 46);
});

test('order override (drag preview) and moveInRow keep free elements in place', () => {
  const L = newLayout('t'); L.padding = 0; L.gap = 0;
  const [a, b, f, c] = ['a', 'b', 'f', 'c'].map(n => Object.assign(newElement('rect'), { name: n }));
  f.free = true;
  L.elements.push(a, b, f, c);
  const it = items(L, { a: [10, 42], b: [20, 42], f: [5, 5], c: [30, 42] });
  const r = arrange(L, it, 42, { order: [c.id, a.id, b.id] });
  assert.deepEqual([r.boxes[c.id].x, r.boxes[a.id].x, r.boxes[b.id].x], [0, 30, 40]);
  assert.ok(moveInRow(L, a.id, 2));
  assert.deepEqual(L.elements.map(e => e.name), ['b', 'f', 'c', 'a']);
  assert.ok(moveInRow(L, a.id, 0));
  assert.deepEqual(L.elements.map(e => e.name), ['a', 'b', 'f', 'c']);
  assert.equal(moveInRow(L, a.id, 0), false);
  assert.deepEqual(rowOrder(L), [a.id, b.id, c.id]);
  assert.ok(moveInList(L, 0, 3));
  assert.deepEqual(L.elements.map(e => e.name), ['b', 'f', 'c', 'a']);
});

test('snapping: closest edge or center within tolerance, label and tape centers', () => {
  const arr = { W: 200, H: 42, pad: 4, boxes: { a: { x: 20, y: 0, w: 40, h: 42 }, me: { x: 0, y: 0, w: 10, h: 10 } } };
  const t = snapTargets(arr, 'me');
  let s = snapBox({ x: 96, y: 15, w: 10, h: 10 }, t, 3);
  assert.equal(s.x, 95); assert.equal(s.hitX.kind, 'labelCenter'); assert.equal(s.hitX.edge, 'center');
  assert.equal(s.y, 16); assert.equal(s.hitY.kind, 'tapeCenter');
  s = snapBox({ x: 62, y: 1, w: 10, h: 10 }, t, 3);
  assert.equal(s.x, 60); assert.equal(s.hitX.kind, 'element'); assert.equal(s.y, 0); assert.equal(s.hitY.kind, 'tapeTop');
  s = snapBox({ x: 130, y: 20, w: 10, h: 10 }, t, 2);
  assert.equal(s.hitX, null); assert.equal(s.x, 130);
  assert.equal(snapBox({ x: 96, y: 15, w: 10, h: 10 }, t, 3, { x: false, y: true }).x, 96);
});

test('arrange as row keeps positions', () => {
  const L = newLayout('t'); L.padding = 4; L.gap = 9;
  const [a, b] = ['a', 'b'].map(n => Object.assign(newElement('rect'), { name: n, free: true }));
  a.x = 50; b.x = 10;
  L.elements.push(a, b);
  const it = items(L, { a: [20, 42], b: [30, 42] });
  const before = arrange(L, it, 42);
  arrangeAsRow(L, before.boxes);
  assert.deepEqual(L.elements.map(e => e.name), ['b', 'a']);
  const after = arrange(L, items(L, { a: [20, 42], b: [30, 42] }), 42);
  assert.equal(after.boxes[a.id].x, 50); assert.equal(after.boxes[b.id].x, 10);
});

test('version 1 layouts (0.1 exports) load as free elements in the same place', () => {
  const v1 = { version: 1, name: 'Label wrap', length: { mode: 'auto', dots: 283, padding: 4 }, border: false, elements: [
    { id: 'q', type: 'qr', x: 4, y: 2, rotate: 0, hCenter: false, vCenter: true, size: 42, text: '{text}', ecc: 'M', quiet: 0 },
    { id: 't', type: 'text', x: 52, y: 2, rotate: 0, hCenter: false, vCenter: true, text: '{text}', font: 'Helvetica', size: 29, bold: true, italic: false, align: 'center', w: 150, autoSize: true, lineHeight: 1.15, invert: false },
    { id: 'r', type: 'rect', x: 212, y: 2, rotate: 0, hCenter: false, vCenter: true, w: 71, h: 42, stroke: 1, fill: true, radius: 0 },
    { id: 'p', type: 'text', x: 0, y: 2, hCenter: true, vCenter: true, text: 'x', w: null, autoSize: true }] };
  const L = fromFile(v1);
  assert.ok(L.elements.every(e => e.free));
  assert.equal(L.padding, 4); assert.equal(L.length.fixed, 283);
  assert.equal(L.elements[1].widthMode, 'fixed'); assert.equal(L.elements[1].w, 150); assert.equal(L.elements[1].size, 29);
  assert.equal(L.elements[3].widthMode, 'auto'); assert.equal(L.elements[3].hCenter, true);
  assert.equal(L.elements[2].fullHeight, false); assert.equal(L.elements[2].h, 42);
  const r = arrange(L, L.elements.map(e => ({ id: e.id, el: e, w: e.type === 'qr' ? 42 : e.w || 10, h: 42 })), 42);
  assert.deepEqual(L.elements.slice(0, 3).map(e => r.boxes[e.id].x), [4, 52, 212]);
  // and it saves as a version 2 file
  assert.equal(toFile(L).format, FORMAT);
});

test('bad files: rejected or cleaned up with warnings', () => {
  assert.throws(() => fromFile(null), /Not a TapeDeck layout/);
  assert.throws(() => fromFile({ name: 'x' }), /Not a TapeDeck layout/);
  assert.throws(() => fromFile({ format: FORMAT, version: 99, elements: [] }), /newer TapeDeck/);
  const L = fromFile({ format: FORMAT, version: 2, name: 'x', padding: 'wide', elements: [
    { type: 'sparkle' }, { type: 'qr', size: 'big', ecc: 'Z', quiet: 3 }, { type: 'rect', w: 1e9, rotate: 45 }] });
  assert.equal(L.elements.length, 2);
  assert.equal(L.elements[0].ecc, 'M'); assert.equal(L.elements[0].quiet, 3);
  assert.equal(L.elements[1].w, 20000); assert.equal(L.elements[1].rotate, 0);
  assert.equal(L._warnings.length, 4);
  assert.ok(L.padding > 0);
});

test('units: mm on disk, dots in memory, points for fonts', () => {
  const L = newLayout('u');
  const t = newElement('text'); t.autoSize = false; t.size = 25; t.widthMode = 'fixed'; t.w = 70.866; t.free = true; t.x = 7.0866; t.vCenter = false; t.y = 14.173;
  L.elements.push(t);
  const f = toFile(L).elements[0];
  assert.equal(f.fontSize, 10); assert.equal(f.w, 10); assert.equal(f.x, 1); assert.equal(f.y, 2); assert.equal(f.size, undefined);
  const back = fromFile(toFile(L)).elements[0];
  assert.ok(Math.abs(back.size - 25) < 1e-9 && Math.abs(back.w - 70.866) < 0.01);
});

test('snapshots share image data and signatures notice changes', () => {
  const L = newLayout('s'); const img = newElement('image'); img.src = 'data:image/png;base64,' + 'A'.repeat(5000); img._img = {};
  L.elements.push(img);
  const s = snapshot(L);
  assert.equal(s.elements[0]._img, undefined);
  assert.equal(s.elements[0].src, img.src);
  const sig = signature(L);
  assert.ok(sig.length < 1000);
  img.w += 1;
  assert.notEqual(signature(L), sig);
});

test('history: undo, redo, coalescing and branch truncation', () => {
  const h = new History(5);
  h.reset('a'); h.push('b', null, 0); h.push('c', 'k', 10); h.push('d', 'k', 500);
  assert.deepEqual(h.stack, ['a', 'b', 'd']);
  assert.equal(h.undo(), 'b'); assert.equal(h.undo(), 'a'); assert.equal(h.undo(), null);
  assert.equal(h.redo(), 'b');
  h.push('x', null, 1000);
  assert.deepEqual(h.stack, ['a', 'b', 'x']); assert.equal(h.canRedo, false);
  for (const s of ['1', '2', '3', '4']) h.push(s, null, 2000);
  assert.equal(h.stack.length, 5); assert.equal(h.stack[4], '4');
  h.push('5', 'k', 3000); h.push('6', 'k', 9000);         // too far apart: two steps
  assert.deepEqual(h.stack.slice(-2), ['5', '6']);
});

test('series sample covers the whole series, not just the print range', () => {
  const p = defaultPattern();
  const s = patternSample(p);
  assert.equal(s.length, 156); assert.equal(s[155].text, 'UM-052-C');
  const big = { separator: '-', segments: [{ name: 'N', type: 'number', start: 1, end: 10000, pad: 5 }] };
  const sm = patternSample(big, 100);
  assert.equal(sm.length, 100); assert.equal(sm[0].text, '00001'); assert.equal(sm[99].text, '10000');
  assert.equal(patternSeries(p).values.length, 3);
  assert.deepEqual(spread([1, 2, 3, 4, 5], 3), [1, 3, 5]);
});
