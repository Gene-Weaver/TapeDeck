"""Convert label images (PNG from the browser canvas) into pin columns."""
from __future__ import annotations

import base64
import io

from PIL import Image

from .ptouch.tapes import tape_for_mm


def decode_data_url(data_url: str) -> Image.Image:
    if "," in data_url and data_url.startswith("data:"):
        data_url = data_url.split(",", 1)[1]
    return Image.open(io.BytesIO(base64.b64decode(data_url)))


def image_to_columns(img: Image.Image, tape_mm: int, threshold: int = 128) -> list[list[bool]]:
    """Image is label-oriented: width = length along the tape, height = tape pins.
    Any height is resampled to the tape's pin count (should already match)."""
    tape = tape_for_mm(tape_mm)
    if img.mode in ("RGBA", "LA", "P"):
        bg = Image.new("RGBA", img.size, (255, 255, 255, 255))
        bg.alpha_composite(img.convert("RGBA"))
        img = bg
    g = img.convert("L")
    if g.height != tape.pins:
        new_w = max(1, round(g.width * tape.pins / g.height))
        g = g.resize((new_w, tape.pins), Image.LANCZOS)
    w, h = g.size
    px = g.load()
    return [[px[x, y] < threshold for y in range(h)] for x in range(w)]


def columns_to_image(columns: list[list[bool]]) -> Image.Image:
    if not columns:
        return Image.new("1", (1, 1), 1)
    w, h = len(columns), len(columns[0])
    img = Image.new("1", (w, h), 1)
    px = img.load()
    for x, col in enumerate(columns):
        for y, black in enumerate(col):
            if black:
                px[x, y] = 0
    return img
