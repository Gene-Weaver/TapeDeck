"""Tape geometry for the PT-P700 print head.

Source: Brother "Raster Command Reference, PT-H500/P700/E500", print-area table.
The head has 128 pins at 180 dpi. Narrow tapes use only the central pins, so a
raster line always carries 16 bytes and narrow tapes are padded on both sides.
"""
from dataclasses import dataclass

DPI = 180
DOTS_PER_MM = DPI / 25.4          # 7.0866 dots per mm
HEAD_PINS = 128                   # 24 mm tape uses every pin
RASTER_BYTES = HEAD_PINS // 8     # 16 bytes per raster line


@dataclass(frozen=True)
class TapeSpec:
    width_mm: float      # nominal tape width as reported by the printer status
    pins: int            # printable dots across the tape
    margin_pins: int     # unused pins on each side of the printable band
    label: str

    @property
    def printable_mm(self) -> float:
        return self.pins / DOTS_PER_MM


TAPES: dict[int, TapeSpec] = {
    4:  TapeSpec(3.5, 24, 52, "3.5 mm"),   # printer reports 3.5 mm tape as width 4
    6:  TapeSpec(6, 32, 48, "6 mm"),
    9:  TapeSpec(9, 50, 39, "9 mm"),
    12: TapeSpec(12, 70, 29, "12 mm"),
    18: TapeSpec(18, 112, 8, "18 mm"),
    24: TapeSpec(24, 128, 0, "24 mm"),
}


def tape_for_mm(width_mm: int | float) -> TapeSpec:
    key = int(round(width_mm))
    if key == 3:
        key = 4
    if key not in TAPES:
        raise ValueError(f"Unsupported tape width {width_mm} mm; expected one of {sorted(TAPES)}")
    return TAPES[key]


def tape_table() -> list[dict]:
    return [
        {"mm": k, "label": t.label, "pins": t.pins, "margin_pins": t.margin_pins,
         "printable_mm": round(t.printable_mm, 2)}
        for k, t in sorted(TAPES.items())
    ]
