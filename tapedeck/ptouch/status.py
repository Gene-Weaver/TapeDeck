"""Parse the 32-byte status block returned by ESC i S."""
from dataclasses import dataclass, field, asdict

ERROR1 = {
    0x01: "No media",
    0x02: "End of media",
    0x04: "Cutter jam",
    0x08: "Weak batteries",
    0x10: "Printer in use",
    0x20: "Printer turned off",
    0x40: "High-voltage adapter",
    0x80: "Fan motor error",
}
ERROR2 = {
    0x01: "Replace media",
    0x02: "Expansion buffer full",
    0x04: "Communication error",
    0x08: "Communication buffer full",
    0x10: "Cover open",
    0x20: "Overheating",
    0x40: "Media cannot be fed",
    0x80: "System error",
}
MEDIA_TYPES = {
    0x00: "No media",
    0x01: "Laminated tape",
    0x03: "Non-laminated tape",
    0x11: "Heat-shrink tube",
    0x13: "Fle tape",
    0x14: "Flexible ID tape",
    0x15: "Satin tape",
    0xFF: "Incompatible tape",
}
STATUS_TYPES = {
    0x00: "Reply to status request",
    0x01: "Printing completed",
    0x02: "Error occurred",
    0x06: "Phase change",
}
PHASE = {
    (0x00, 0x00, 0x00): "Editing state (receiving)",
    (0x01, 0x00, 0x00): "Printing state",
}


@dataclass
class PrinterStatus:
    raw: bytes
    model_code: int
    media_width_mm: int
    media_type_code: int
    media_type: str
    media_length_mm: int
    tape_color_code: int
    text_color_code: int
    status_type_code: int
    status_type: str
    phase_type: int
    phase_number: int
    errors: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.errors

    @property
    def has_media(self) -> bool:
        return self.media_type_code not in (0x00, 0xFF) and self.media_width_mm > 0

    def to_dict(self) -> dict:
        d = asdict(self)
        d["raw"] = self.raw.hex()
        d["ok"] = self.ok
        d["has_media"] = self.has_media
        return d


def parse_status(buf: bytes) -> PrinterStatus:
    if len(buf) < 32:
        raise ValueError(f"Status block too short: {len(buf)} bytes")
    if buf[0] != 0x80 or buf[1] != 0x20:
        raise ValueError(f"Not a status block (header {buf[0]:02x} {buf[1]:02x})")
    errors = [name for bit, name in ERROR1.items() if buf[8] & bit]
    errors += [name for bit, name in ERROR2.items() if buf[9] & bit]
    return PrinterStatus(
        raw=bytes(buf[:32]),
        model_code=buf[4],
        media_width_mm=buf[10],
        media_type_code=buf[11],
        media_type=MEDIA_TYPES.get(buf[11], f"Unknown (0x{buf[11]:02x})"),
        media_length_mm=buf[17],
        tape_color_code=buf[24],
        text_color_code=buf[25],
        status_type_code=buf[18],
        status_type=STATUS_TYPES.get(buf[18], f"Unknown (0x{buf[18]:02x})"),
        phase_type=buf[19],
        phase_number=(buf[20] << 8) | buf[21],
        errors=errors,
    )


def fake_status(width_mm: int = 6, media_type: int = 0x01, status_type: int = 0x00,
                phase_type: int = 0x00) -> bytes:
    """Build a plausible status block for the mock transport."""
    b = bytearray(32)
    b[0], b[1], b[2], b[3] = 0x80, 0x20, 0x42, 0x30
    b[4] = 0x67               # model code reported by a PT-P700
    b[10] = width_mm if width_mm != 4 else 4
    b[11] = media_type
    b[18] = status_type
    b[19] = phase_type
    b[24] = 0x01              # white tape
    b[25] = 0x08              # black text
    return bytes(b)
