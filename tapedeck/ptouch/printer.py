"""High-level printer: status, validation, and page-by-page job execution."""
from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Callable, Iterable

from . import protocol
from .status import PrinterStatus, parse_status
from .tapes import TapeSpec, tape_for_mm
from .transport import MockTransport, TransportError, UsbTransport


class PrintError(RuntimeError):
    pass


@dataclass
class PrintOptions:
    tape_mm: int = 6
    auto_cut: bool = True
    cut_each: int = 1
    mirror: bool = False
    margin_dots: int = 14
    flip: bool = False
    check_media: bool = True


ProgressFn = Callable[[int, int, str], None]   # (index, total, phase)


class Printer:
    def __init__(self, transport):
        self.t = transport

    # -- construction helpers ------------------------------------------------
    @classmethod
    def usb(cls) -> "Printer":
        return cls(UsbTransport())

    @classmethod
    def mock(cls, tape_mm: int = 6, realtime: bool = True) -> "Printer":
        return cls(MockTransport(tape_mm=tape_mm, realtime=realtime))

    # -- status ----------------------------------------------------------------
    def status(self, timeout_ms: int = 2000) -> PrinterStatus:
        self.t.write(protocol.invalidate() + protocol.initialize() + protocol.status_request())
        deadline = time.time() + timeout_ms / 1000
        while time.time() < deadline:
            buf = self.t.read(32, timeout_ms=500)
            if len(buf) >= 32 and buf[0] == 0x80:
                return parse_status(buf)
        raise PrintError("Printer did not answer the status request")

    def _drain(self, seconds: float = 0.3) -> list[PrinterStatus]:
        """Read any queued status notifications."""
        out = []
        deadline = time.time() + seconds
        while time.time() < deadline:
            buf = self.t.read(32, timeout_ms=200)
            if len(buf) >= 32 and buf[0] == 0x80:
                try:
                    out.append(parse_status(buf))
                except ValueError:
                    pass
            else:
                break
        return out

    # -- printing --------------------------------------------------------------
    def print_pages(self, pages: Iterable[list[list[bool]]], options: PrintOptions,
                    progress: ProgressFn | None = None, cancel: Callable[[], bool] | None = None) -> int:
        """pages: list of label images, each a list of columns, each column a list of
        `tape.pins` booleans (top -> bottom). Returns number of pages printed."""
        pages = list(pages)
        if not pages:
            return 0
        tape = tape_for_mm(options.tape_mm)
        media_type = None
        if options.check_media:
            st = self.status()
            if st.errors:
                raise PrintError("Printer reports: " + ", ".join(st.errors))
            if not st.has_media:
                raise PrintError("No tape cassette detected")
            if int(st.media_width_mm) != int(round(tape.width_mm)) and not (st.media_width_mm == 4 and tape.width_mm == 3.5):
                raise PrintError(
                    f"Loaded tape is {st.media_width_mm} mm but the job was designed for {tape.label}. "
                    "Change the tape width in the app or swap the cassette.")
            media_type = st.media_type_code

        raster_pages = [protocol.columns_to_raster_lines(cols, tape, flip=options.flip) for cols in pages]
        opt = protocol.JobOptions(auto_cut=options.auto_cut, cut_each=options.cut_each, mirror=options.mirror,
                                  margin_dots=options.margin_dots, media_type=media_type)
        chunks = protocol.build_job(raster_pages, tape, opt)
        self.t.write(chunks[0])
        total = len(pages)
        printed = 0
        for i, chunk in enumerate(chunks[1:]):
            if cancel and cancel():
                break
            if progress:
                progress(i, total, "sending")
            self.t.write(chunk)
            if progress:
                progress(i, total, "printing")
            self._wait_page_done(i == total - 1)
            printed += 1
            if progress:
                progress(i, total, "done")
        return printed

    def _wait_page_done(self, last: bool, timeout_s: float = 60.0) -> None:
        """Watch status notifications until the printer reports the page finished
        (status type 0x01) or returns to the editing phase. Falls back to a short
        wait if the printer sends nothing (some firmware only notifies when enabled)."""
        deadline = time.time() + timeout_s
        saw_any = False
        while time.time() < deadline:
            buf = self.t.read(32, timeout_ms=1000)
            if len(buf) >= 32 and buf[0] == 0x80:
                saw_any = True
                st = parse_status(buf)
                if st.errors:
                    raise PrintError("Printer error during job: " + ", ".join(st.errors))
                if st.status_type_code == 0x01:
                    self._drain(0.2)
                    return
                if st.status_type_code == 0x06 and st.phase_type == 0x00:
                    return
            elif saw_any:
                return
            else:
                return
