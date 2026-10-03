import { test } from 'node:test';
import assert from 'node:assert/strict';
import P from '../src/main/ptouch/protocol.js';
import { tapeForMm, TAPES, RASTER_BYTES } from '../src/main/ptouch/tapes.js';
import { parseStatus, fakeStatus } from '../src/main/ptouch/status.js';
import { Printer, PrintError } from '../src/main/ptouch/printer.js';
import { MockTransport } from '../src/main/ptouch/transport.js';
import { JobManager } from '../src/main/jobs.js';

test('packbits roundtrip and known values', () => {
  let seed = 1; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let t = 0; t < 200; t++) {
    const n = Math.floor(rnd() * 64);
    const data = Buffer.from(Array.from({ length: n }, () => [0, 0, 0, 255, Math.floor(rnd() * 256)][Math.floor(rnd() * 5)]));
    assert.deepEqual(P.unpackBits(P.packBits(data)), data);
  }
  assert.deepEqual(P.packBits(Buffer.alloc(16)), Buffer.from([0xf1, 0x00]));
  assert.deepEqual(P.packBits(Buffer.from([1, 2])), Buffer.from([1, 1, 2]));
});

test('tape table sums to 128 pins', () => { for (const t of Object.values(TAPES)) assert.equal(t.pins + 2 * t.marginPins, 128); });

test('pixels -> raster lines places pins at margin, reversed', () => {
  const tape = tapeForMm(6);
  const px = new Uint8Array(1 * tape.pins); px[0] = 1; px[tape.pins - 1] = 1;
  const [line] = P.pixelsToRasterLines(px, 1, tape.pins, tape);
  assert.equal(line.length, RASTER_BYTES);
  const set = []; for (let i = 0; i < 128; i++) if (line[i >> 3] & (1 << (7 - (i & 7)))) set.push(i);
  assert.deepEqual(set, [tape.marginPins, tape.marginPins + tape.pins - 1]);
  const top = new Uint8Array(tape.pins); top[0] = 1;
  const [a] = P.pixelsToRasterLines(top, 1, tape.pins, tape), [b] = P.pixelsToRasterLines(top, 1, tape.pins, tape, true);
  assert.notDeepEqual(a, b);
  assert.throws(() => P.pixelsToRasterLines(px, 1, 10, tape), /needs 32/);
});

test('columns are sent last-first so the label is not mirrored', () => {
  const tape = tapeForMm(6);
  const px = new Uint8Array(3 * tape.pins); px[0 * 3 + 0] = 1;      // only column 0 has ink (top-left pixel)
  const lines = P.pixelsToRasterLines(px, 3, tape.pins, tape);
  assert.equal(lines.length, 3);
  assert.ok(!lines[0].some(b => b) && !lines[1].some(b => b) && lines[2].some(b => b));
});

test('print information layout', () => {
  const cmd = P.printInformation(tapeForMm(12), 0x010203, false, 0x01);
  assert.deepEqual([...cmd.subarray(0, 3)], [0x1b, 0x69, 0x7a]);
  assert.equal(cmd[3], 0x86); assert.equal(cmd[4], 0x01); assert.equal(cmd[5], 12);
  assert.deepEqual([...cmd.subarray(7, 11)], [3, 2, 1, 0]); assert.equal(cmd[11], 0x01);
});

test('job structure: header, per-page chain flags, cut, packbits, blank lines', () => {
  const tape = tapeForMm(6);
  const blank = new Uint8Array(10 * tape.pins), dot = new Uint8Array(10 * tape.pins); dot[5 * 10 + 3] = 1;
  const pages = [P.pixelsToRasterLines(blank, 10, tape.pins, tape), P.pixelsToRasterLines(dot, 10, tape.pins, tape)];
  const chunks = P.buildJob(pages, tape, {});
  assert.ok(chunks[0].equals(Buffer.concat([Buffer.alloc(200), Buffer.from([0x1b, 0x40, 0x1b, 0x69, 0x61, 0x01])])));
  assert.equal(chunks[1][chunks[1].length - 1], 0x0c); assert.equal(chunks[2][chunks[2].length - 1], 0x1a);
  assert.ok(chunks[1].includes(Buffer.from([0x1b, 0x69, 0x4b, 0x00]))); assert.ok(chunks[2].includes(Buffer.from([0x1b, 0x69, 0x4b, 0x08])));
  assert.ok(chunks[1].includes(Buffer.from([0x1b, 0x69, 0x4d, 0x40]))); assert.ok(chunks[1].includes(Buffer.from([0x4d, 0x02])));
  assert.ok([...chunks[1]].filter(b => b === 0x5a).length >= 10);   // blank page is all Z lines
  assert.equal(chunks.length, 3);                                     // header + 2 pages, no extra blank page
  const chained = P.buildJob(pages, tape, { chain: true });
  assert.equal(chained[2][chained[2].length - 1], 0x0c);             // last page not fed/cut
});

test('status parse', () => {
  const st = parseStatus(fakeStatus({ widthMm: 12 }));
  assert.equal(st.mediaWidthMm, 12); assert.ok(st.hasMedia && st.ok);
  const bad = Buffer.from(fakeStatus({ widthMm: 12 })); bad[8] = 0x01; bad[9] = 0x10;
  assert.deepEqual(parseStatus(bad).errors, ['No media', 'Cover open']);
});

test('mock print end to end with progress', async () => {
  const t = new MockTransport({ tapeMm: 6, realtime: false });
  const p = new Printer(t); const tape = tapeForMm(6);
  const pages = Array.from({ length: 3 }, () => ({ width: 60, height: tape.pins, pixels: new Uint8Array(60 * tape.pins).fill(0).map((_, i) => (i % 7 === 0 ? 1 : 0)) }));
  const events = [];
  const n = await p.printPages(pages, { tapeMm: 6 }, (i, tot, ph) => events.push(`${i}:${ph}`));
  assert.equal(n, 3); assert.equal(t.pagesPrinted, 3); assert.ok(events.includes('2:done'));
});

test('mock rejects wrong tape', async () => {
  const p = new Printer(new MockTransport({ tapeMm: 12, realtime: false }));
  await assert.rejects(p.printPages([{ width: 5, height: 32, pixels: new Uint8Array(5 * 32) }], { tapeMm: 6 }), (e) => e instanceof PrintError && /12 mm/.test(e.message));
});

test('job manager runs a mock job and reports progress', async () => {
  const jm = new JobManager(); const tape = tapeForMm(9);
  const pages = [{ width: 20, height: tape.pins, pixels: new Uint8Array(20 * tape.pins) }, { width: 20, height: tape.pins, pixels: new Uint8Array(20 * tape.pins) }];
  const seen = [];
  const job = jm.start({ pages, names: ['a', 'b'], options: { tapeMm: 9 }, mock: true, mockTape: 9 }, (j) => seen.push(j.state + ':' + j.printed));
  assert.equal(job.total, 2);
  for (let i = 0; i < 100 && jm.busy; i++) await new Promise(r => setTimeout(r, 50));
  assert.equal(jm.get(job.id).state, 'done'); assert.equal(jm.get(job.id).printed, 2);
  assert.ok(seen.includes('done:2'));
});
