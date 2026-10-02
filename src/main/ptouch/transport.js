'use strict';
// USB (node-usb / libusb) and mock transports. Both expose async write(buf), read(n, timeoutMs), close().
const { fakeStatus } = require('./status');

const VENDOR_ID = 0x04f9, PRODUCT_ID = 0x2061;   // PT-P700 with P-Lite off
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
    if (!dev) throw new TransportError(NOT_FOUND);
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
  write(data) {
    const buf = Buffer.from(data.buffer ? data : Buffer.from(data));
    const CHUNK = 16 * 1024;
    let p = Promise.resolve();
    for (let i = 0; i < buf.length; i += CHUNK) {
      const slice = buf.subarray(i, i + CHUNK);
      p = p.then(() => new Promise((res, rej) => this.epOut.transfer(slice, (err) => err ? rej(err) : res())));
    }
    return p;
  }
  read(n = 32, timeoutMs) {
    this.epIn.timeout = timeoutMs || this.timeoutMs;
    return new Promise((res, rej) => this.epIn.transfer(n, (err, data) => {
      if (err) { if (/timed?[ _]?out/i.test(String(err.message || err.errno)) || err.errno === this.usb.LIBUSB_TRANSFER_TIMED_OUT || err.errno === this.usb.LIBUSB_ERROR_TIMEOUT) return res(Buffer.alloc(0)); return rej(err); }
      res(Buffer.from(data || []));
    }));
  }
  async close() {
    try { await new Promise(res => this.iface.release(true, () => res())); } catch {}
    try { this.dev.close(); } catch {}
  }
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
      else if (b === 0x47) { const n = d[i + 1] | (d[i + 2] << 8); this.linesInPage++; i += 3 + n; }
      else if (b === 0x5a) { this.linesInPage++; i += 1; }
      else if (b === 0x0c || b === 0x1a) {
        const lines = this.linesInPage; this.linesInPage = 0; this.pagesPrinted++;
        if (this.realtime) { const mm = lines / 7.0866 + 4; await sleep(Math.min(6000, (mm / 20) * 1000)); }
        this.pending.push(fakeStatus({ widthMm: this.tapeMm, statusType: 0x06, phaseType: 0x01 }));
        this.pending.push(fakeStatus({ widthMm: this.tapeMm, statusType: 0x01 }));
        this.pending.push(fakeStatus({ widthMm: this.tapeMm, statusType: 0x06, phaseType: 0x00 }));
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
module.exports = { UsbTransport, MockTransport, TransportError, VENDOR_ID, PRODUCT_ID };
