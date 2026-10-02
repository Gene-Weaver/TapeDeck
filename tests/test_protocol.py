import random

from tapedeck.ptouch import protocol as P
from tapedeck.ptouch.tapes import tape_for_mm, TAPES, RASTER_BYTES
from tapedeck.ptouch.status import parse_status, fake_status
from tapedeck.ptouch.printer import Printer, PrintOptions, PrintError
from tapedeck.ptouch.transport import MockTransport
from tapedeck.imaging import image_to_columns, columns_to_image
from PIL import Image, ImageDraw
import pytest


def test_packbits_roundtrip():
    rnd = random.Random(1)
    for _ in range(200):
        n = rnd.randint(0, 64)
        data = bytes(rnd.choice([0, 0, 0, 255, rnd.randint(0, 255)]) for _ in range(n))
        assert P.unpack_bits(P.pack_bits(data)) == data


def test_packbits_known():
    assert P.pack_bits(b"\x00" * 16) == b"\xf1\x00"            # run of 16 -> (-(15)) & 0xff = 0xf1
    assert P.pack_bits(b"\x01\x02") == b"\x01\x01\x02"
    assert P.pack_bits(b"") == b""


def test_tape_table_sums_to_head():
    for t in TAPES.values():
        assert t.pins + 2 * t.margin_pins == 128


def test_columns_to_raster_lines_places_pixels():
    tape = tape_for_mm(6)
    col = [False] * tape.pins
    col[0] = True                      # top pixel of label
    col[-1] = True                     # bottom pixel
    [line] = P.columns_to_raster_lines([col], tape)
    assert len(line) == RASTER_BYTES
    set_pins = [i for i in range(128) if line[i // 8] & (1 << (7 - i % 8))]
    assert set_pins == [tape.margin_pins, tape.margin_pins + tape.pins - 1]
    [flipped] = P.columns_to_raster_lines([col], tape, flip=True)
    assert flipped == line             # symmetric column is unaffected by flip
    col2 = [False] * tape.pins
    col2[0] = True
    [a] = P.columns_to_raster_lines([col2], tape)
    [b] = P.columns_to_raster_lines([col2], tape, flip=True)
    assert a != b


def test_print_information_layout():
    tape = tape_for_mm(12)
    cmd = P.print_information(tape, 0x010203, first_page=False, media_type=0x01)
    assert cmd[:3] == b"\x1biz"
    assert cmd[3] == 0x86 and cmd[4] == 0x01 and cmd[5] == 12
    assert cmd[7:11] == bytes([0x03, 0x02, 0x01, 0x00])
    assert cmd[11] == 0x01


def test_build_job_structure():
    tape = tape_for_mm(6)
    blank = [[False] * tape.pins for _ in range(10)]
    dot = [[False] * tape.pins for _ in range(10)]
    dot[3][5] = True
    pages = [P.columns_to_raster_lines(blank, tape), P.columns_to_raster_lines(dot, tape)]
    chunks = P.build_job(pages, tape)
    assert chunks[0].startswith(b"\x00" * 100 + b"\x1b@\x1bia\x01")
    assert chunks[1].endswith(b"\x0c") and chunks[2].endswith(b"\x1a")
    assert chunks[1].count(b"Z") >= 10                       # blank page is all zero lines
    assert b"\x1biK\x00" in chunks[1] and b"\x1biK\x08" in chunks[2]
    assert b"\x1biM\x40" in chunks[1]                        # auto cut on
    assert b"M\x02" in chunks[1]


def test_status_parse():
    st = parse_status(fake_status(12))
    assert st.media_width_mm == 12 and st.has_media and st.ok
    bad = bytearray(fake_status(12)); bad[8] = 0x01; bad[9] = 0x10
    st = parse_status(bytes(bad))
    assert st.errors == ["No media", "Cover open"]


def test_image_to_columns_and_back():
    tape = tape_for_mm(9)
    img = Image.new("L", (40, tape.pins), 255)
    ImageDraw.Draw(img).rectangle([5, 5, 10, 10], fill=0)
    cols = image_to_columns(img, 9)
    assert len(cols) == 40 and len(cols[0]) == tape.pins
    assert cols[5][5] and not cols[0][0]
    back = columns_to_image(cols)
    assert back.size == (40, tape.pins)
    tall = Image.new("L", (80, tape.pins * 2), 255)
    assert len(image_to_columns(tall, 9)) == 40


def test_mock_print_end_to_end():
    t = MockTransport(tape_mm=6, realtime=False)
    p = Printer(t)
    tape = tape_for_mm(6)
    pages = []
    for _ in range(3):
        img = Image.new("L", (60, tape.pins), 255)
        ImageDraw.Draw(img).text((2, 2), "ab", fill=0)
        pages.append(image_to_columns(img, 6))
    events = []
    n = p.print_pages(pages, PrintOptions(tape_mm=6), progress=lambda i, tot, ph: events.append((i, ph)))
    assert n == 3 and t.pages_printed == 3
    assert (2, "done") in events


def test_mock_rejects_wrong_tape():
    p = Printer(MockTransport(tape_mm=12, realtime=False))
    tape = tape_for_mm(6)
    with pytest.raises(PrintError, match="12 mm"):
        p.print_pages([[[False] * tape.pins] * 5], PrintOptions(tape_mm=6))
