'use strict';
// High-level printer: status, media validation, page-by-page job execution with progress.
const P = require('./protocol');
const { parseStatus } = require('./status');
const { tapeForMm } = require('./tapes');
const { UsbTransport, MockTransport } = require('./transport');

class PrintError extends Error {}

class Printer {
  constructor(transport) { this.t = transport; }
  static usb() { return new Printer(new UsbTransport()); }
  static mock(opts) { return new Printer(new MockTransport(opts)); }

  async status(timeoutMs = 2000) {
    await this.t.write(Buffer.concat([P.invalidate(), P.initialize(), P.statusRequest()]));
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const buf = await this.t.read(32, 500);
      if (buf.length >= 32 && buf[0] === 0x80) return parseStatus(buf);
    }
    throw new PrintError('Printer did not answer the status request');
  }

  /**
   * pages: [{ width, height, pixels: Uint8Array }] with height == tape pins.
   * options: { tapeMm, autoCut, cutEach, mirror, marginDots, flip, checkMedia }
   * progress(i, total, phase) phase in sending | printing | done. cancel() -> bool.
   */
  async printPages(pages, options, progress, cancel) {
    if (!pages.length) return 0;
    const tape = tapeForMm(options.tapeMm);
    let mediaType = null;
    if (options.checkMedia !== false) {
      const st = await this.status();
      if (st.errors.length) throw new PrintError('Printer reports: ' + st.errors.join(', '));
      if (!st.hasMedia) throw new PrintError('No tape cassette detected');
      if (st.mediaWidthMm !== tape.key) throw new PrintError(`Loaded tape is ${st.mediaWidthMm} mm but the job was designed for ${tape.label}. Change the tape width in the app or swap the cassette.`);
      mediaType = st.mediaTypeCode;
    }
    const rasterPages = pages.map(p => P.pixelsToRasterLines(p.pixels, p.width, p.height, tape, !!options.flip));
    const chunks = P.buildJob(rasterPages, tape, { autoCut: options.autoCut !== false, cutEach: options.cutEach || 1, mirror: !!options.mirror, marginDots: options.marginDots ?? 14, mediaType, chain: !!options.chain });
    await this.t.write(chunks[0]);
    const total = pages.length; let printed = 0;
    for (let i = 0; i < total; i++) {
      if (cancel && cancel()) break;
      progress && progress(i, total, 'sending');
      await this.t.write(chunks[i + 1]);
      progress && progress(i, total, 'printing');
      await this._waitPageDone();
      printed++;
      progress && progress(i, total, 'done');
    }
    return printed;
  }

  /** Watch status notifications until the page finishes (0x01) or the printer returns to editing phase. */
  async _waitPageDone(timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs;
    let sawAny = false;
    while (Date.now() < deadline) {
      const buf = await this.t.read(32, 1000);
      if (buf.length >= 32 && buf[0] === 0x80) {
        sawAny = true;
        const st = parseStatus(buf);
        if (st.errors.length) throw new PrintError('Printer error during job: ' + st.errors.join(', '));
        if (st.statusTypeCode === 0x01) { await this._drain(); return; }
        if (st.statusTypeCode === 0x06 && st.phaseType === 0x00) return;
      } else return;   // nothing (more) to read: assume the page went through
    }
    void sawAny;
  }
  async _drain(ms = 200) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) { const b = await this.t.read(32, 100); if (!b.length) break; }
  }
}

module.exports = { Printer, PrintError };
