import { test } from 'node:test';
import assert from 'node:assert/strict';
import { counterValues, templateValues, batchValues, expand, letters, parseCsv, patternSeries, defaultPattern, lettersToIndex, segmentValues } from '../src/renderer/js/pattern.js';
import { code128 } from '../src/renderer/js/codes.js';
import { tape, mmToDots } from '../src/renderer/js/tape.js';

test('letters, tokens, counters and templates', () => {
  assert.equal(letters(0), 'A'); assert.equal(letters(25), 'Z'); assert.equal(letters(26), 'AA'); assert.equal(letters(27, false), 'ab');
  assert.equal(expand('LEAF-{n:06}-{A}', { n: 3 }), 'LEAF-000003-D');
  assert.equal(expand('{i:02} {text} {unknown}', { i: 7, text: 'hi' }), '07 hi {unknown}');
  const cv = counterValues({ prefix: 'L-', start: 1, end: 5, step: 2, padWidth: 3, suffix: 'x' });
  assert.deepEqual(cv.map(v => v.text), ['L-001x', 'L-003x', 'L-005x']);
  assert.equal(counterValues({ start: 1, count: 4 }).length, 4);
  assert.deepEqual(templateValues({ template: 'A{n}', start: 10, count: 2, step: 5 }).map(v => v.text), ['A10', 'A15']);
});

test('CSV and batch lists', () => {
  assert.deepEqual(parseCsv('a,"b,c"\n1,2\n'), [['a', 'b,c'], ['1', '2']]);
  const bv = batchValues({ text: 'id\tname\n7\tfern\n8\toak', header: true, template: '{id}:{name}' });
  assert.deepEqual(bv.map(v => v.text), ['7:fern', '8:oak']);
  assert.deepEqual(batchValues({ text: 'one\ntwo\n' }).map(v => v.text), ['one', 'two']);
});

test('Code 128 and tape geometry', () => {
  const w = code128('123456');                       // start C, 12, 34, 56, check, stop
  assert.equal(w.length, 5 * 6 + 7);
  assert.equal(code128('').length, 0);
  assert.ok(code128('LEAF-000001').length > 0);
  assert.equal(tape(6).pins, 42); assert.equal(mmToDots(25.4), 180);
});

test('segment patterns: last segment cycles fastest, print range, lowercase letters', () => {
  assert.equal(lettersToIndex('A'), 0); assert.equal(lettersToIndex('AA'), 26); assert.equal(lettersToIndex('BZ'), 77);
  assert.deepEqual(segmentValues({ type: 'letters', start: 'AY', end: 'BB' }), ['AY', 'AZ', 'BA', 'BB']);
  assert.deepEqual(segmentValues({ type: 'letters', start: 'a', end: 'c' }), ['a', 'b', 'c']);
  assert.deepEqual(segmentValues({ type: 'number', start: 1, end: 3, pad: 2 }), ['01', '02', '03']);
  const ps = patternSeries(defaultPattern());
  assert.equal(ps.total, 156);
  assert.deepEqual(ps.values.map(v => v.text), ['UM-001-A', 'UM-001-B', 'UM-001-C']);
  assert.deepEqual(ps.values[1].fields, { Project: 'UM', Number: '001', Letter: 'B' });
  const all = patternSeries({ ...defaultPattern(), to: 156 });
  assert.equal(all.values[3].text, 'UM-002-A'); assert.equal(all.values[155].text, 'UM-052-C'); assert.equal(all.values[155].n, 156);
  assert.equal(patternSeries({ ...defaultPattern(), from: 5, to: 4 }).values.length, 0);
});
// table mode
import { tableValues, normalizeCell, rowComplete, parseTableText } from '../src/renderer/js/pattern.js';
test('table mode: complete rows only, cells normalized like their segment', () => {
  const pat = defaultPattern();
  assert.equal(normalizeCell(pat.segments[1], '7'), '007');
  assert.equal(normalizeCell(pat.segments[2], 'd'), 'D');
  assert.equal(normalizeCell(pat.segments[0], ' UM '), 'UM');
  assert.equal(rowComplete(['UM', '001', 'A'], 3), true);
  assert.equal(rowComplete(['UM', '', 'A'], 3), false);
  assert.equal(rowComplete(['UM', '001', 'A'], 0), false);
  const rows = [['UM', '1', 'd'], ['UM', '', 'E'], ['UM', '12', 'e'], ['', '', '']];
  const v = tableValues(rows, pat);
  assert.deepEqual(v.map(x => x.text), ['UM-001-D', 'UM-012-E']);
  assert.deepEqual(v[1].fields, { Project: 'UM', Number: '012', Letter: 'E' });
  assert.equal(v[1].n, 3); assert.equal(v[1].i, 2);
  assert.deepEqual(parseTableText('UM\t001\tD\nUM,002,E\nUM-003-F\n\n'), [['UM', '001', 'D'], ['UM', '002', 'E'], ['UM', '003', 'F']]);
});
