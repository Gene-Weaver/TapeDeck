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
   * options: { tapeMm, autoCut, cutEach, mirror, marginDots, flip, checkMedia, chain (default false), offsetDots }
   * progress(i, total, phase) phase in sending | printing | done. cancel() -> bool.
   *
   * Pages are STREAMED back to back. The printer buffers them and prints continuously, cutting
   * between labels without feeding blank tape; waiting for each page to finish before sending
   * the next makes the printer feed every label out to the cutter first and wastes ~25 mm each.
   * Completion is tracked from the printer's "printing completed" notifications.
   */
  async printPages(pages, options, progress, cancel) {
    if (!pages.length) return 0;
    const tape = tapeForMm(options.tapeMm, options.offsetDots || 0);
    let mediaType = null;
    if (options.checkMedia !== false) {
      const st = await this.status();
      if (st.errors.length) throw new PrintError('Printer reports: ' + st.errors.join(', '));
      if (!st.hasMedia) throw new PrintError('No tape cassette detected');
      if (st.mediaWidthMm !== tape.key) throw new PrintError(`Loaded tape is ${st.mediaWidthMm} mm but the job was designed for ${tape.label}. Change the tape width in the app or swap the cassette.`);
      mediaType = st.mediaTypeCode;
    }
    const rasterPages = pages.map(p => P.pixelsToRasterLines(p.pixels, p.width, p.height, tape, !!options.flip));
    const chunks = P.buildJob(rasterPages, tape, { autoCut: options.autoCut !== false, cutEach: options.cutEach || 1, mirror: !!options.mirror, marginDots: options.marginDots ?? 14, mediaType, chain: options.chain === true });
    const total = pages.length;
    let sent = 0, done = 0, readerErr = null, active = true, lastActivity = Date.now();
    const reader = (async () => {
      while (active) {
        let buf;
        try { buf = await this.t.read(32, 500); } catch (e) { readerErr = e; break; }
        if (!buf.length) { await new Promise(r => setTimeout(r, 25)); continue; }   // yield (mock reads return instantly)
        if (buf.length >= 32 && buf[0] === 0x80) {
          lastActivity = Date.now();
          let st; try { st = parseStatus(buf); } catch { continue; }
          if (st.errors.length) { readerErr = new PrintError('Printer error during job: ' + st.errors.join(', ')); break; }
          if (st.statusTypeCode === 0x01 && done < total) { done++; progress && progress(done - 1, total, 'done'); }
        }
      }
    })();
    try {
      await this.t.write(chunks[0]);
      for (let i = 0; i < total; i++) {
        if (readerErr) throw readerErr;
        if (cancel && cancel()) break;
        progress && progress(i, total, 'sending');
        await this.t.write(chunks[i + 1]);
        sent++; lastActivity = Date.now();
        progress && progress(i, total, 'printing');
      }
      // wait for the printer to report every sent page, with a generous per-page budget
      const deadline = Date.now() + 15000 + sent * 20000;
      while (done < sent && Date.now() < deadline) {
        if (readerErr) throw readerErr;
        if (Date.now() - lastActivity > 12000) break;      // printer went quiet: assume the rest printed
        await new Promise(r => setTimeout(r, 100));
      }
      if (readerErr) throw readerErr;
      if (done < sent) { for (let i = done; i < sent; i++) progress && progress(i, total, 'done'); done = sent; }
      return sent;
    } finally {
      active = false;
      await reader.catch(() => {});
    }
  }

  /** Feed the tape to the cutter and cut, releasing a label left inside by chain printing. */
  async feedAndCut(tapeMm) {
    const st = await this.status();
    if (st.errors.length) throw new PrintError('Printer reports: ' + st.errors.join(', '));
    const tape = tapeForMm(st.hasMedia ? st.mediaWidthMm : tapeMm);
    await this.t.write(P.buildFeedAndCut(tape, { mediaType: st.mediaTypeCode, marginDots: 14 }));
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const buf = await this.t.read(32, 500);
      if (buf.length >= 32 && buf[0] === 0x80) { const s2 = parseStatus(buf); if (s2.errors.length) throw new PrintError(s2.errors.join(', ')); if (s2.statusTypeCode === 0x01) break; }
      else { if (Date.now() - deadline > -7000) break; await new Promise(r => setTimeout(r, 50)); }
    }
  }
}

module.exports = { Printer, PrintError };
