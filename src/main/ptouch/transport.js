'use strict';
// USB (node-usb / libusb) and mock transports. Both expose async write(buf), read(n, timeoutMs), close().
const { fakeStatus } = require('./status');

const VENDOR_ID = 0x04f9, PRODUCT_ID = 0x2061;   // PT-P700 with P-Lite off
const PLITE_PRODUCT_ID = 0x2064;                  // the same printer with P-Lite on (acts as a USB drive)
const NOT_FOUND = 'PT-P700 not found on USB. Check the cable, that the printer is on, and that the green P-Lite light is OFF (hold the P-Lite button ~2 s to switch modes).';

class TransportError extends Error {}

class UsbTransport {
  constructor({ timeoutMs = 5000 } = {}) {
    let mod;
    try { mod = require('usb'); } catch (e) { throw new TransportError(`USB support failed to load (${e.message}).`); }
    const usb = mod.usb || mod;                        // node-usb 2.x: { usb, findByIds, getDeviceList, WebUSB, ... }
    const findByIds = mod.findByIds || usb.findByIds;
    if (typeof findByIds !== 'function') throw new TransportError('Incompatible usb module: findByIds missing (need node-usb 2.x).');
    this.usb = usb; this.timeoutMs = timeoutMs;
    const dev = findByIds(VENDOR_ID, PRODUCT_ID);
    if (!dev) {
      if (findByIds(VENDOR_ID, PLITE_PRODUCT_ID)) throw new TransportError('PT-P700 found, but it is in P-Lite mode (green P-Lite light on). Hold the P-Lite button for about 2 seconds until the light turns off, then try again.');
      throw new TransportError(NOT_FOUND);
    }
    try { dev.open(); } catch (e) { throw new TransportError(accessHint(e)); }
    this.dev = dev;
    try {
      const iface = dev.interfaces.find(i => i.descriptor.bInterfaceClass === 7) || dev.interfaces[0];
      if (process.platform === 'linux' && iface.isKernelDriverActive()) { try { iface.detachKernelDriver(); } catch {} }
      iface.claim();
      this.iface = iface;
      this.epOut = iface.endpoints.find(e => e.direction === 'out');
      this.epIn = iface.endpoints.find(e => e.direction === 'in');
      if (!this.epOut || !this.epIn) throw new Error('printer interface has no bulk endpoints');
      this.epOut.timeout = timeoutMs; this.epIn.timeout = timeoutMs;
    } catch (e) { try { dev.close(); } catch {} throw new TransportError(accessHint(e)); }
  }
  /**
   * opts.timeoutMs: per USB transfer. opts.stallMs: during a print job, how long the printer may hold
   * off data before we give up (0 = fail on the first timeout). opts.lastActivity(): time of the
   * printer's last status message, which also counts as a sign of life.
   */
  write(data, opts = {}) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const transfer = (slice, timeoutMs) => new Promise((res) => {
      this.epOut.timeout = timeoutMs;
      this.epOut.transfer(slice, (error, actual) => res({ error, actual: actual || 0 }));
    });
    return sendPaced(transfer, buf, { timeoutMs: opts.timeoutMs || this.timeoutMs, stallMs: opts.stallMs || 0, lastActivity: opts.lastActivity, isTimeout: (e) => isTimeout(e, this.usb) });
  }
  read(n = 32, timeoutMs) {
    this.epIn.timeout = timeoutMs || this.timeoutMs;
    return new Promise((res, rej) => this.epIn.transfer(n, (err, data) => {
      if (err) { if (isTimeout(err, this.usb)) return res(Buffer.alloc(0)); return rej(err); }
      res(Buffer.from(data || []));
    }));
  }
  async close() {
    try { await new Promise(res => this.iface.release(true, () => res())); } catch {}
    try { this.dev.close(); } catch {}
  }
}

function isTimeout(err, usb) {
  return /timed?[ _]?out/i.test(String(err && (err.message || err.errno))) || (usb && (err.errno === usb.LIBUSB_TRANSFER_TIMED_OUT || err.errno === usb.LIBUSB_ERROR_TIMEOUT));
}

/** The printer was unplugged or switched off (as opposed to a transfer that merely failed). */
function isGone(err) { return /NO_DEVICE|NOT_FOUND|disconnected/i.test(String(err && (err.message || err.errno))) || (err && err.errno === -4); }

const CHUNK = 16 * 1024;
const STALLED = (s) => `The printer stopped taking data for ${Math.round(s / 1000)} s. Check it for a jam, an empty cassette or an error light; if it does not respond, switch it off and on, then print again.`;
const NOT_ACCEPTED = 'The printer did not accept data (USB write timed out). Switch the PT-P700 off and on, check that the P-Lite light is off, then retry.';

/**
 * Send `buf` with transfer(slice, timeoutMs) -> Promise<{ error, actual }>, where `actual` is how many
 * bytes the printer accepted, even when the transfer timed out.
 *
 * While it prints, the PT-P700 holds off further data (USB NAKs) until it has room, which can take
 * longer than a transfer timeout when labels are long. So a timeout during a job means "busy", not
 * "stuck": carry on from the first byte the printer has not taken. Never resend accepted bytes (a
 * repeated raster line corrupts the job and desyncs the printer until a power cycle) and never reset
 * the device mid-job (that aborts the print and re-enumerates the printer). Give up only when neither
 * the transfer nor the printer's status messages have shown progress for `stallMs`.
 */
async function sendPaced(transfer, buf, { timeoutMs = 5000, stallMs = 0, lastActivity = null, isTimeout: timedOut = (e) => isTimeout(e) } = {}) {
  let off = 0, progress = Date.now();
  while (off < buf.length) {
    const slice = buf.subarray(off, off + CHUNK);
    const { error, actual } = await transfer(slice, timeoutMs);
    if (actual > 0) { off += actual; progress = Date.now(); }
    if (!error) {
      if (actual <= 0) throw new TransportError('The printer accepted no data.');
      continue;
    }
    if (!timedOut(error)) throw error;
    if (!stallMs) throw new TransportError(NOT_ACCEPTED);
    const last = Math.max(progress, lastActivity ? lastActivity() : 0);
    if (Date.now() - last >= stallMs) throw new TransportError(STALLED(stallMs));
  }
}

/** Plain-language text for a libusb failure in the middle of a conversation with the printer. */
function describeUsbError(e) {
  const m = String(e && e.message || e);
  if (isGone(e)) return `The printer disconnected (${m}). Check the USB cable and that it is switched on, then print again.`;
  if (/^LIBUSB_|LIBUSB_ERROR/.test(m)) return `USB communication with the printer failed (${m}). If the printer does not respond, switch it off and on, then try again.`;
  return m;
}

function accessHint(e) {
  const m = String(e && e.message || e);
  if (/ACCESS|permission/i.test(m)) {
    if (process.platform === 'win32') return `Windows blocked access to the printer (${m}). Install the WinUSB driver for the PT-P700 with Zadig (see README) so libusb can talk to it.`;
    if (process.platform === 'linux') return `Permission denied opening the printer (${m}). Add the udev rule from the README or run TapeDeck with sudo once to confirm.`;
    return `Could not open the printer (${m}). Quit P-touch Editor and any Brother utilities and try again.`;
  }
  if (/BUSY/i.test(m)) return `The printer is in use by another program (${m}). Quit P-touch Editor / the Brother driver and retry.`;
  return `Could not claim the printer (${m}).`;
}

/** Pretends to be a PT-P700: answers status requests and "prints" at ~20 mm/s. */
class MockTransport {
  constructor({ tapeMm = 6, realtime = true } = {}) {
    this.tapeMm = tapeMm; this.realtime = realtime;
    this.written = []; this.pending = []; this.linesInPage = 0; this.pagesPrinted = 0;
  }
  async write(data) {
    const d = Buffer.from(data); this.written.push(d);
    let i = 0;
    while (i < d.length) {
      const b = d[i];
      if (b === 0x1b && d[i + 1] === 0x69 && d[i + 2] === 0x53) { this.pending.push(fakeStatus({ widthMm: this.tapeMm })); i += 3; }
      else if (b === 0x47) { const n = d[i + 1] | (d[i + 2] << 8); this.linesInPage++; this.inkLines = (this.inkLines || 0) + 1; i += 3 + n; }
      else if (b === 0x5a) { this.linesInPage++; i += 1; }
      else if (b === 0x0c || b === 0x1a) {
        const lines = this.linesInPage; this.linesInPage = 0; this.pagesPrinted++;
        console.log(`[mock] page ${this.pagesPrinted}: ${lines} raster lines, ${this.inkLines || 0} with ink`); this.inkLines = 0;
        this.pending.push(fakeStatus({ widthMm: this.tapeMm, statusType: 0x06, phaseType: 0x01 }));
        if (this.realtime) {   // like a real PT-P700: 17.4 mm/s plus a 1 s cut per page; the last page then feeds 24.5 mm and cuts again
          const mm = lines / 7.0866 + 4;
          await sleep((mm / 17.4 + 1.0 + (b === 0x1a ? 24.5 / 17.4 + 1.0 : 0)) * 1000);
        }
        this.pending.push(fakeStatus({ widthMm: this.tapeMm, statusType: 0x01 }));
        if (b === 0x1a) this.pending.push(fakeStatus({ widthMm: this.tapeMm, statusType: 0x06, phaseType: 0x00 }));
        i += 1;
      }
      else if (b === 0x1b && d[i + 1] === 0x69 && i + 2 < d.length) { i += ({ 0x7a: 13, 0x4d: 4, 0x4b: 4, 0x41: 4, 0x64: 5, 0x61: 4, 0x21: 4 })[d[i + 2]] || 3; }
      else i += 1;
    }
  }
  async read() { return this.pending.length ? this.pending.shift() : Buffer.alloc(0); }
  async close() {}
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
module.exports = { UsbTransport, MockTransport, TransportError, sendPaced, isGone, describeUsbError, VENDOR_ID, PRODUCT_ID, PLITE_PRODUCT_ID };
