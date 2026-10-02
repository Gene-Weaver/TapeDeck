"""Background print jobs with pollable progress."""
from __future__ import annotations

import threading
import time
import traceback
import uuid
from dataclasses import dataclass, field, asdict
from pathlib import Path

from .imaging import columns_to_image
from .ptouch.printer import Printer, PrintOptions, PrintError


@dataclass
class Job:
    id: str
    total: int
    tape_mm: int
    state: str = "queued"          # queued | printing | done | error | cancelled
    index: int = 0                 # label currently being printed
    phase: str = ""                # sending | printing | done
    printed: int = 0
    error: str | None = None
    started: float = field(default_factory=time.time)
    finished: float | None = None
    names: list[str] = field(default_factory=list)
    _cancel: bool = False

    def to_dict(self) -> dict:
        d = asdict(self)
        d.pop("_cancel", None)
        return d


class JobManager:
    def __init__(self, printer_factory, out_dir: Path):
        self.printer_factory = printer_factory
        self.out_dir = out_dir
        self.jobs: dict[str, Job] = {}
        self.lock = threading.Lock()
        self._busy = threading.Lock()

    def submit(self, pages: list[list[list[bool]]], names: list[str], options: PrintOptions,
               save_pngs: bool = False) -> Job:
        job = Job(id=uuid.uuid4().hex[:8], total=len(pages), tape_mm=options.tape_mm, names=names)
        with self.lock:
            self.jobs[job.id] = job
        th = threading.Thread(target=self._run, args=(job, pages, options, save_pngs), daemon=True)
        th.start()
        return job

    def cancel(self, job_id: str) -> bool:
        job = self.jobs.get(job_id)
        if not job:
            return False
        job._cancel = True
        return True

    def get(self, job_id: str) -> Job | None:
        return self.jobs.get(job_id)

    def _run(self, job: Job, pages, options: PrintOptions, save_pngs: bool):
        with self._busy:
            job.state = "printing"
            printer = None
            try:
                if save_pngs:
                    d = self.out_dir / f"job_{job.id}"
                    d.mkdir(parents=True, exist_ok=True)
                    for i, cols in enumerate(pages):
                        safe = "".join(c if c.isalnum() or c in "-_." else "_" for c in (job.names[i] if i < len(job.names) else ""))[:40]
                        columns_to_image(cols).save(d / f"{i + 1:04d}_{safe}.png")
                printer = self.printer_factory(options.tape_mm)

                def progress(i, total, phase):
                    job.index, job.phase = i, phase
                    if phase == "done":
                        job.printed = i + 1

                printer.print_pages(pages, options, progress=progress, cancel=lambda: job._cancel)
                job.state = "cancelled" if job._cancel and job.printed < job.total else "done"
            except (PrintError, Exception) as e:
                job.state = "error"
                job.error = str(e) or e.__class__.__name__
                traceback.print_exc()
            finally:
                job.finished = time.time()
                if printer is not None:
                    try:
                        printer.t.close()
                    except Exception:
                        pass
