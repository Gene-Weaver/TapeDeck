'use strict';
// One print job at a time, with progress callbacks and cancellation.
const { Printer, PrintError } = require('./ptouch/printer');

class JobManager {
  constructor() { this.jobs = new Map(); this.current = null; this.seq = 0; }
  get busy() { return !!this.current; }

  /** Runs asynchronously; returns the job record immediately. */
  start({ pages, names, options, mock, mockTape }, onProgress) {
    if (this.current) throw new Error('A print job is already running');
    const job = { id: `j${++this.seq}_${Date.now().toString(36)}`, total: pages.length, tapeMm: options.tapeMm, state: 'queued', index: 0, phase: '', printed: 0, error: null, names, started: Date.now(), finished: null };
    this.jobs.set(job.id, job); this.current = job;
    const cancelFlag = { v: false }; job._cancel = cancelFlag;
    const emit = () => onProgress && onProgress(publicJob(job));
    (async () => {
      let printer = null;
      try {
        job.state = 'printing'; emit();
        printer = mock ? Printer.mock({ tapeMm: mockTape || options.tapeMm }) : Printer.usb();
        await printer.printPages(pages, options, (i, total, phase) => { job.index = i; job.phase = phase; if (phase === 'done') job.printed = i + 1; emit(); }, () => cancelFlag.v);
        job.state = (cancelFlag.v && job.printed < job.total) ? 'cancelled' : 'done';
      } catch (e) {
        job.state = 'error'; job.error = (e && e.message) || String(e);
        if (!(e instanceof PrintError)) console.error(e);
      } finally {
        job.finished = Date.now(); this.current = null;
        if (printer) { try { await printer.t.close(); } catch {} }
        emit();
      }
    })();
    return publicJob(job);
  }
  cancel(id) { const j = this.jobs.get(id); if (!j || !j._cancel) return false; j._cancel.v = true; return true; }
  get(id) { const j = this.jobs.get(id); return j ? publicJob(j) : null; }
}
function publicJob(j) { const { _cancel, ...rest } = j; return rest; }

module.exports = { JobManager };
