'use strict';
// One print job at a time, with progress callbacks and cancellation.
const { Printer, PrintError } = require('./ptouch/printer');
const { TransportError, describeUsbError } = require('./ptouch/transport');

const KEEP_JOBS = 20;

class JobManager {
  /** lock(fn) serializes USB access with status polls (see main.js); the default runs fn directly.
   *  mockOptions go to the mock printer (tests use { realtime: false }). */
  constructor({ lock = (fn) => fn(), mockOptions = {} } = {}) { this.jobs = new Map(); this.current = null; this.seq = 0; this.lock = lock; this.mockOptions = mockOptions; }
  get busy() { return !!this.current; }

  /** Runs asynchronously; returns the job record immediately. */
  start({ pages, names, options, mock, mockTape }, onProgress) {
    if (this.current) throw new Error('A print job is already running');
    const job = { id: `j${++this.seq}_${Date.now().toString(36)}`, total: pages.length, tapeMm: options.tapeMm, state: 'queued', index: 0, phase: '', printed: 0, error: null, warning: null, names, started: Date.now(), finished: null,
      sentAt: [], doneAt: [], movingAt: null };   // wall-clock ms: page i fully sent, page i reported printed, tape started moving
    this.jobs.set(job.id, job); this.current = job;
    this._prune();
    const cancelFlag = { v: false }; job._cancel = cancelFlag;
    const emit = () => onProgress && onProgress(publicJob(job));
    this.lock(async () => {
      let printer = null;
      try {
        job.state = 'printing'; emit();
        printer = mock ? Printer.mock({ tapeMm: mockTape || options.tapeMm, ...this.mockOptions }) : Printer.usb();
        await printer.printPages(pages, options, (i, total, phase) => {
          const now = Date.now();
          if (phase === 'moving') { if (!job.movingAt) job.movingAt = now; emit(); return; }
          job.index = i; job.phase = phase;
          if (phase === 'printing') job.sentAt[i] = now;
          if (phase === 'done') { job.printed = i + 1; job.doneAt[i] = now; }
          emit();
        }, () => cancelFlag.v);
        job.warning = printer.warning || null;
        job.state = (cancelFlag.v && job.printed < job.total) ? 'cancelled' : 'done';
      } catch (e) {
        job.state = 'error';
        job.error = e instanceof PrintError || e instanceof TransportError ? e.message : describeUsbError(e);
        if (!(e instanceof PrintError)) console.error(e);
      } finally {
        if (printer) { try { await printer.t.close(); } catch {} }
        job.finished = Date.now(); this.current = null;
        emit();
      }
    });
    return publicJob(job);
  }
  /** Runs a feed-and-cut as a tiny job so it serializes with printing. */
  async feedAndCut({ tapeMm, mock, mockTape }) {
    if (this.current) throw new Error('A print job is already running');
    this.current = { id: 'feedcut' };
    try {
      await this.lock(async () => {
        const printer = mock ? Printer.mock({ tapeMm: mockTape || tapeMm, ...this.mockOptions }) : Printer.usb();
        try { await printer.feedAndCut(tapeMm); } finally { try { await printer.t.close(); } catch {} }
      });
    } finally { this.current = null; }
    return { ok: true };
  }
  cancel(id) { const j = this.jobs.get(id); if (!j || !j._cancel) return false; j._cancel.v = true; return true; }
  get(id) { const j = this.jobs.get(id); return j ? publicJob(j) : null; }
  _prune() { for (const [id, j] of this.jobs) { if (this.jobs.size <= KEEP_JOBS) break; if (j !== this.current) this.jobs.delete(id); } }
}
function publicJob(j) { const { _cancel, ...rest } = j; return rest; }

module.exports = { JobManager };
