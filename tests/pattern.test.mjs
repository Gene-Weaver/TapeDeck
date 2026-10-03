// Run with: npm test
import assert from 'node:assert/strict';
import { counterValues, templateValues, batchValues, expand, letters, parseCsv } from '../src/renderer/js/pattern.js';
import { code128 } from '../src/renderer/js/codes.js';
import { tape, mmToDots } from '../src/renderer/js/tape.js';

assert.equal(letters(0), 'A'); assert.equal(letters(25), 'Z'); assert.equal(letters(26), 'AA'); assert.equal(letters(27, false), 'ab');
assert.equal(expand('LEAF-{n:06}-{A}', { n: 3 }), 'LEAF-000003-D');
assert.equal(expand('{i:02} {text} {unknown}', { i: 7, text: 'hi' }), '07 hi {unknown}');
const cv = counterValues({ prefix: 'L-', start: 1, end: 5, step: 2, padWidth: 3, suffix: 'x' });
assert.deepEqual(cv.map(v => v.text), ['L-001x', 'L-003x', 'L-005x']);
assert.equal(counterValues({ start: 1, count: 4 }).length, 4);
assert.deepEqual(templateValues({ template: 'A{n}', start: 10, count: 2, step: 5 }).map(v => v.text), ['A10', 'A15']);
assert.deepEqual(parseCsv('a,"b,c"\n1,2\n'), [['a', 'b,c'], ['1', '2']]);
const bv = batchValues({ text: 'id\tname\n7\tfern\n8\toak', header: true, template: '{id}:{name}' });
assert.deepEqual(bv.map(v => v.text), ['7:fern', '8:oak']);
assert.deepEqual(batchValues({ text: 'one\ntwo\n' }).map(v => v.text), ['one', 'two']);
// Code 128: "123456" in subset C -> start C(105), 12, 34, 56, check, stop
const w = code128('123456');
assert.equal(w.length, 5 * 6 + 7);   // startC,12,34,56,check = 5 symbols*6 widths + stop*7
assert.equal(code128('').length, 0);
assert.ok(code128('LEAF-000001').length > 0);
assert.equal(tape(6).pins, 42); assert.equal(mmToDots(25.4), 180);
console.log('js logic tests ok');
// segment patterns
import { patternSeries, defaultPattern, lettersToIndex, segmentValues } from '../src/renderer/js/pattern.js';
assert.equal(lettersToIndex('A'), 0); assert.equal(lettersToIndex('AA'), 26); assert.equal(lettersToIndex('BZ'), 77);
assert.deepEqual(segmentValues({ type: 'letters', start: 'AY', end: 'BB' }), ['AY', 'AZ', 'BA', 'BB']);
assert.deepEqual(segmentValues({ type: 'number', start: 1, end: 3, pad: 2 }), ['01', '02', '03']);
const ps = patternSeries(defaultPattern());
assert.equal(ps.total, 156);
assert.deepEqual(ps.values.map(v => v.text), ['UM-AA-01', 'UM-AA-02', 'UM-AA-03']);
assert.deepEqual(ps.values[1].fields, { Project: 'UM', Item: 'AA', Number: '02' });
const all = patternSeries({ ...defaultPattern(), to: 156 });
assert.equal(all.values[3].text, 'UM-AB-01'); assert.equal(all.values[155].text, 'UM-BZ-03'); assert.equal(all.values[155].n, 156);
console.log('segment pattern tests ok');
