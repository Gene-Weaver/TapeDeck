import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendPaced, TransportError, MockTransport, isGone } from '../src/main/ptouch/transport.js';
import { Printer } from '../src/main/ptouch/printer.js';
import { tapeForMm } from '../src/main/ptouch/tapes.js';

const timeoutErr = () => Object.assign(new Error('LIBUSB_TRANSFER_TIMED_OUT'), { errno: 2 });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** A fake OUT endpoint for a printer that takes `perCall` bytes and then holds off (times out). */
function busyPrinter(plan) {
  const received = [];
  let call = 0;
  const transfer = async (slice) => {
    const take = Math.min(slice.length, plan[Math.min(call, plan.length - 1)]);
    call++;
    received.push(Buffer.from(slice.subarray(0, take)));
    await sleep(1);
    return take === slice.length ? { error: null, actual: take } : { error: timeoutErr(), actual: take };
  };
  return { transfer, received: () => Buffer.concat(received), calls: () => call };
}

test('a busy printer gets every byte exactly once, resuming after each timeout', async () => {
  const data = Buffer.from(Array.from({ length: 40000 }, (_, i) => i % 251));
  const p = busyPrinter([5000, 0, 0, 12000, 0, 100000]);       // partial, held off, held off, partial, ..., then all
  await sendPaced(p.transfer, data, { timeoutMs: 10, stallMs: 5000 });
  assert.ok(p.received().equals(data));
  assert.ok(p.calls() > 4);
});

test('outside a job a write timeout is reported, never retried', async () => {
  const p = busyPrinter([10]);
  await assert.rejects(sendPaced(p.transfer, Buffer.alloc(100), { timeoutMs: 10 }), (e) => e instanceof TransportError && /did not accept data/.test(e.message));
  assert.equal(p.calls(), 1);
});

test('gives up when neither data nor status messages move for stallMs', async () => {
  const p = busyPrinter([0]);
  const t0 = Date.now();
  await assert.rejects(sendPaced(p.transfer, Buffer.alloc(100), { timeoutMs: 5, stallMs: 60 }), /stopped taking data/);
  assert.ok(Date.now() - t0 >= 55);
});

test('status messages from the printer keep a held-off write alive', async () => {
  const p = busyPrinter([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1000]);
  const t0 = Date.now();
  await sendPaced(p.transfer, Buffer.alloc(1000, 7), { timeoutMs: 5, stallMs: 20, lastActivity: () => Date.now() - t0 < 1000 ? Date.now() : 0 });
  assert.equal(p.received().length, 1000);
});

test('other USB errors are passed through', async () => {
  const transfer = async () => ({ error: Object.assign(new Error('LIBUSB_ERROR_PIPE'), { errno: -9 }), actual: 0 });
  await assert.rejects(sendPaced(transfer, Buffer.alloc(10), { stallMs: 1000 }), /LIBUSB_ERROR_PIPE/);
  assert.ok(isGone({ message: 'LIBUSB_ERROR_NO_DEVICE', errno: -4 }) && !isGone({ message: 'LIBUSB_ERROR_OTHER', errno: -99 }));
});

function pages(n, tape) { return Array.from({ length: n }, () => ({ width: 30, height: tape.pins, pixels: new Uint8Array(30 * tape.pins).fill(1) })); }

test('a flaky progress read does not fail the job', async () => {
  const t = new MockTransport({ tapeMm: 6, realtime: false });
  const read = t.read.bind(t); let bad = 3;
  t.read = async (...a) => { if (bad-- > 0) throw Object.assign(new Error('LIBUSB_ERROR_OTHER'), { errno: -99 }); return read(...a); };
  const p = new Printer(t);
  const n = await p.printPages(pages(3, tapeForMm(6)), { tapeMm: 6, checkMedia: false });
  assert.equal(n, 3); assert.equal(t.pagesPrinted, 3); assert.equal(p.warning, null);
});

test('progress reports that never come back give a warning, not an error', async () => {
  const t = new MockTransport({ tapeMm: 6, realtime: false });
  t.read = async () => { throw Object.assign(new Error('LIBUSB_ERROR_OTHER'), { errno: -99 }); };
  const p = new Printer(t);
  const n = await p.printPages(pages(2, tapeForMm(6)), { tapeMm: 6, checkMedia: false });
  assert.equal(n, 2); assert.equal(t.pagesPrinted, 2);
  assert.match(p.warning, /stopped sending progress reports/);
});

test('an unplugged printer fails the job', async () => {
  const t = new MockTransport({ tapeMm: 6, realtime: false });
  t.read = async () => { throw Object.assign(new Error('LIBUSB_ERROR_NO_DEVICE'), { errno: -4 }); };
  const t2 = t.write.bind(t); t.write = async (d) => { await sleep(20); return t2(d); };
  await assert.rejects(new Printer(t).printPages(pages(3, tapeForMm(6)), { tapeMm: 6, checkMedia: false }), /NO_DEVICE/);
});
