"""FastAPI app: serves the UI and exposes the printer."""

import os
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import __version__
from .imaging import decode_data_url, image_to_columns
from .jobs import JobManager
from .ptouch.printer import Printer, PrintError, PrintOptions
from .ptouch.tapes import tape_for_mm, tape_table
from .ptouch.transport import TransportError

ROOT = Path(__file__).resolve().parent.parent
UI_DIR = ROOT / "ui"
OUT_DIR = ROOT / "out"


def create_app(mock: bool = False, mock_tape: int = 6, realtime: bool = True) -> FastAPI:
    app = FastAPI(title="TapeDeck", version=__version__)
    state = {"mock": mock, "mock_tape": mock_tape}

    def printer_factory(tape_mm: int) -> Printer:
        if state["mock"]:
            return Printer.mock(tape_mm=state["mock_tape"], realtime=realtime)
        return Printer.usb()

    jobs = JobManager(printer_factory, OUT_DIR)

    class LabelIn(BaseModel):
        png: str
        name: str = ""

    class PrintIn(BaseModel):
        tape_mm: int = 6
        labels: list[LabelIn]
        auto_cut: bool = True
        cut_each: int = 1
        mirror: bool = False
        margin_dots: int = 14
        flip: bool = False
        check_media: bool = True
        save_pngs: bool = False
        dry_run: bool = False

    @app.get("/api/config")
    def config():
        return {"version": __version__, "mock": state["mock"], "mock_tape": state["mock_tape"],
                "tapes": tape_table(), "out_dir": str(OUT_DIR)}

    @app.post("/api/mock")
    def set_mock(body: dict):
        if "mock" in body:
            state["mock"] = bool(body["mock"])
        if "tape_mm" in body:
            tape_for_mm(int(body["tape_mm"]))
            state["mock_tape"] = int(body["tape_mm"])
        return {"mock": state["mock"], "mock_tape": state["mock_tape"]}

    @app.get("/api/status")
    def status():
        try:
            p = printer_factory(state["mock_tape"])
            try:
                st = p.status()
            finally:
                p.t.close()
            return {"connected": True, "mock": state["mock"], "status": st.to_dict()}
        except (TransportError, PrintError) as e:
            return {"connected": False, "mock": state["mock"], "error": str(e)}
        except Exception as e:  # pragma: no cover
            return {"connected": False, "mock": state["mock"], "error": f"{e.__class__.__name__}: {e}"}

    @app.post("/api/print")
    def print_labels(body: PrintIn):
        if not body.labels:
            raise HTTPException(400, "No labels in job")
        tape = tape_for_mm(body.tape_mm)
        pages, names = [], []
        for i, lab in enumerate(body.labels):
            try:
                img = decode_data_url(lab.png)
            except Exception as e:
                raise HTTPException(400, f"Label {i + 1}: bad PNG ({e})")
            cols = image_to_columns(img, body.tape_mm)
            if not cols:
                raise HTTPException(400, f"Label {i + 1} is empty")
            pages.append(cols)
            names.append(lab.name)
        if body.dry_run:
            return {"ok": True, "pages": len(pages), "lengths_mm": [round(len(c) / 7.0866, 1) for c in pages],
                    "tape": tape.label}
        options = PrintOptions(tape_mm=body.tape_mm, auto_cut=body.auto_cut, cut_each=body.cut_each,
                               mirror=body.mirror, margin_dots=body.margin_dots, flip=body.flip,
                               check_media=body.check_media)
        job = jobs.submit(pages, names, options, save_pngs=body.save_pngs or state["mock"])
        return job.to_dict()

    @app.post("/api/export")
    def export_labels(body: PrintIn):
        """Save every label as a PNG under out/export_<timestamp>/ without printing."""
        import time as _t
        from .imaging import columns_to_image
        if not body.labels:
            raise HTTPException(400, "No labels to export")
        d = OUT_DIR / f"export_{_t.strftime('%Y%m%d_%H%M%S')}"
        d.mkdir(parents=True, exist_ok=True)
        for i, lab in enumerate(body.labels):
            cols = image_to_columns(decode_data_url(lab.png), body.tape_mm)
            safe = "".join(c if c.isalnum() or c in "-_." else "_" for c in lab.name)[:40]
            columns_to_image(cols).save(d / f"{i + 1:04d}_{safe}.png")
        return {"ok": True, "dir": str(d), "count": len(body.labels)}

    @app.get("/api/jobs/{job_id}")
    def job_status(job_id: str):
        job = jobs.get(job_id)
        if not job:
            raise HTTPException(404, "Unknown job")
        return job.to_dict()

    @app.post("/api/jobs/{job_id}/cancel")
    def job_cancel(job_id: str):
        if not jobs.cancel(job_id):
            raise HTTPException(404, "Unknown job")
        return {"ok": True}

    @app.get("/")
    def index():
        return FileResponse(UI_DIR / "index.html")

    app.mount("/", StaticFiles(directory=UI_DIR), name="ui")
    return app
