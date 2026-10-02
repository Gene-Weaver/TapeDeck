"""Brother P-touch raster command builders for the PT-P700.

Every function returns bytes. `build_job` assembles a full multi-page job.
Reference: Brother "Raster Command Reference, PT-H500/P700/E500".
"""
from __future__ import annotations

from dataclasses import dataclass
from .tapes import HEAD_PINS, RASTER_BYTES, TapeSpec

ESC = b"\x1b"

# ---- basic commands -------------------------------------------------------

def invalidate() -> bytes:
    """100 NUL bytes flush any partial command left in the printer."""
    return b"\x00" * 100


def initialize() -> bytes:
    return ESC + b"@"


def status_request() -> bytes:
    return ESC + b"iS"


def switch_to_raster_mode() -> bytes:
    return ESC + b"ia\x01"


def notify_mode(enabled: bool = True) -> bytes:
    """ESC i ! n : n=0 -> automatic status notification on."""
    return ESC + b"i!" + (b"\x00" if enabled else b"\x01")


def print_information(tape: TapeSpec, raster_lines: int, first_page: bool,
                      media_type: int | None = None) -> bytes:
    """ESC i z : tell the printer what media we expect and how many lines follow."""
    PI_KIND, PI_WIDTH, PI_RECOVER = 0x02, 0x04, 0x80
    valid = PI_WIDTH | PI_RECOVER
    kind = 0
    if media_type is not None:
        valid |= PI_KIND
        kind = media_type
    width = int(round(tape.width_mm)) if tape.width_mm >= 4 else 4
    n = raster_lines
    return (ESC + b"iz" + bytes([
        valid, kind, width, 0x00,
        n & 0xFF, (n >> 8) & 0xFF, (n >> 16) & 0xFF, (n >> 24) & 0xFF,
        0x00 if first_page else 0x01, 0x00,
    ]))


def various_mode(auto_cut: bool = True, mirror: bool = False) -> bytes:
    n = (0x40 if auto_cut else 0) | (0x80 if mirror else 0)
    return ESC + b"iM" + bytes([n])


def advanced_mode(no_chain_printing: bool = True, special_tape_no_cut: bool = False) -> bytes:
    """ESC i K : bit3 = no chain printing (feed+cut at end of job)."""
    n = (0x08 if no_chain_printing else 0) | (0x10 if special_tape_no_cut else 0)
    return ESC + b"iK" + bytes([n])


def cut_every(n_labels: int = 1) -> bytes:
    """ESC i A n : with auto-cut on, cut after every n labels."""
    return ESC + b"iA" + bytes([max(1, min(255, n_labels))])


def margin(dots: int = 14) -> bytes:
    """ESC i d : feed amount (left/right margin) in dots. PT-P700 minimum is 14."""
    dots = max(14, min(0xFFFF, dots))
    return ESC + b"id" + bytes([dots & 0xFF, dots >> 8])


def compression(packbits: bool = True) -> bytes:
    return b"M" + (b"\x02" if packbits else b"\x00")


def raster_line(data: bytes, packbits: bool = True) -> bytes:
    if not any(data):
        return b"Z"                       # zero raster line
    payload = pack_bits(data) if packbits else bytes(data)
    return b"G" + bytes([len(payload) & 0xFF, len(payload) >> 8]) + payload


def print_page(last: bool) -> bytes:
    return b"\x1a" if last else b"\x0c"   # ^Z prints and feeds; FF prints and waits for next page


# ---- PackBits (TIFF) compression -------------------------------------------

def pack_bits(data: bytes) -> bytes:
    """Standard PackBits: runs of 2+ identical bytes become (-(n-1), byte)."""
    out = bytearray()
    i, n = 0, len(data)
    while i < n:
        run = 1
        while i + run < n and data[i + run] == data[i] and run < 128:
            run += 1
        if run >= 2:
            out += bytes([(256 - (run - 1)) & 0xFF, data[i]])
            i += run
            continue
        start = i
        i += 1
        while i < n and (i - start) < 128:
            if i + 1 < n and data[i] == data[i + 1]:
                break
            i += 1
        out += bytes([i - start - 1]) + data[start:i]
    return bytes(out)


def unpack_bits(data: bytes) -> bytes:
    out = bytearray()
    i = 0
    while i < len(data):
        h = data[i]
        i += 1
        if h < 128:
            out += data[i:i + h + 1]
            i += h + 1
        else:
            out += bytes([data[i]]) * (257 - h)
            i += 1
    return bytes(out)


# ---- page / job assembly ----------------------------------------------------

def columns_to_raster_lines(columns: list[list[bool]], tape: TapeSpec, flip: bool = False) -> list[bytes]:
    """Each column is a list of `tape.pins` booleans (True = black) ordered top -> bottom
    of the label as seen when reading it. Returns one 16-byte raster line per column.

    Pin 0 (bit 7 of byte 0) is the pin closest to the tape's bottom edge on the
    PT-P700, so the column is reversed before being placed at `margin_pins`.
    Set `flip` if a test print comes out upside down."""
    lines: list[bytes] = []
    for col in columns:
        if len(col) != tape.pins:
            raise ValueError(f"column has {len(col)} pixels, tape needs {tape.pins}")
        px = list(col) if flip else list(reversed(col))
        line = bytearray(RASTER_BYTES)
        for k, black in enumerate(px):
            if black:
                p = tape.margin_pins + k
                line[p // 8] |= 1 << (7 - (p % 8))
        lines.append(bytes(line))
    return lines


@dataclass
class JobOptions:
    auto_cut: bool = True
    cut_each: int = 1
    mirror: bool = False
    margin_dots: int = 14
    packbits: bool = True
    media_type: int | None = None     # pass status media type to let the printer validate


def build_page(lines: list[bytes], tape: TapeSpec, first: bool, last: bool, opt: JobOptions) -> bytes:
    buf = bytearray()
    buf += print_information(tape, len(lines), first_page=first, media_type=opt.media_type)
    buf += various_mode(auto_cut=opt.auto_cut, mirror=opt.mirror)
    buf += advanced_mode(no_chain_printing=last)
    buf += cut_every(opt.cut_each)
    buf += margin(opt.margin_dots)
    buf += compression(opt.packbits)
    for ln in lines:
        buf += raster_line(ln, packbits=opt.packbits)
    buf += print_page(last)
    return bytes(buf)


def build_job_header() -> bytes:
    return invalidate() + initialize() + switch_to_raster_mode()


def build_job(pages: list[list[bytes]], tape: TapeSpec, opt: JobOptions | None = None) -> list[bytes]:
    """Return a list of byte chunks: [header, page1, page2, ...]. Sending them
    one by one lets the caller report progress per label."""
    opt = opt or JobOptions()
    chunks = [build_job_header()]
    n = len(pages)
    for i, lines in enumerate(pages):
        chunks.append(build_page(lines, tape, first=(i == 0), last=(i == n - 1), opt=opt))
    return chunks
