"""USB and mock transports. Both expose write(bytes), read(n, timeout_ms) -> bytes, close()."""
from __future__ import annotations

import os
import time
from pathlib import Path

from .status import fake_status

VENDOR_ID = 0x04F9
PRODUCT_ID = 0x2061           # PT-P700 in normal (raster) mode; 0x2060 when P-Lite is on? (mass storage)


class TransportError(RuntimeError):
    pass


class UsbTransport:
    def __init__(self, vendor=VENDOR_ID, product=PRODUCT_ID, timeout_ms=5000):
        try:
            import usb.core
            import usb.util
        except ImportError as e:  # pragma: no cover
            raise TransportError("pyusb is not installed (pip install pyusb; brew install libusb)") from e
        self._usb = usb
        self.timeout_ms = timeout_ms
        dev = usb.core.find(idVendor=vendor, idProduct=product)
        if dev is None:
            raise TransportError(
                "PT-P700 not found on USB. Check the cable, that the printer is on, and that the "
                "green P-Lite light is OFF (hold the P-Lite button ~2 s to switch to raster mode)."
            )
        self.dev = dev
        try:
            if dev.is_kernel_driver_active(0):
                dev.detach_kernel_driver(0)
        except Exception:
            pass  # not supported on macOS; usually unnecessary
        try:
            dev.set_configuration()
        except Exception as e:
            raise TransportError(
                f"Could not claim the printer ({e}). On macOS, quit P-touch Editor and any Brother "
                "driver software, or run with sudo if libusb reports access denied."
            ) from e
        cfg = dev.get_active_configuration()
        intf = cfg[(0, 0)]
        self.ep_out = usb.util.find_descriptor(
            intf, custom_match=lambda ep: usb.util.endpoint_direction(ep.bEndpointAddress) == usb.util.ENDPOINT_OUT)
        self.ep_in = usb.util.find_descriptor(
            intf, custom_match=lambda ep: usb.util.endpoint_direction(ep.bEndpointAddress) == usb.util.ENDPOINT_IN)
        if self.ep_out is None or self.ep_in is None:
            raise TransportError("Printer interface has no bulk endpoints")

    def write(self, data: bytes) -> None:
        mv = memoryview(data)
        chunk = 16 * 1024
        for i in range(0, len(mv), chunk):
            self.ep_out.write(mv[i:i + chunk], timeout=self.timeout_ms)

    def read(self, n: int = 32, timeout_ms: int | None = None) -> bytes:
        try:
            return bytes(self.ep_in.read(n, timeout=timeout_ms or self.timeout_ms))
        except self._usb.core.USBTimeoutError:
            return b""
        except self._usb.core.USBError as e:
            if "timed out" in str(e).lower() or getattr(e, "errno", None) in (110, 60):
                return b""
            raise

    def close(self) -> None:
        try:
            self._usb.util.dispose_resources(self.dev)
        except Exception:
            pass


class MockTransport:
    """Pretends to be a PT-P700. Records everything written, answers status
    requests, and 'prints' at roughly 20 mm/s so the UI animation can be timed."""

    def __init__(self, tape_mm: int = 6, out_dir: str | Path | None = None, realtime: bool = True):
        self.tape_mm = tape_mm
        self.realtime = realtime
        self.out_dir = Path(out_dir) if out_dir else None
        self.written = bytearray()
        self._pending: list[bytes] = []
        self._lines_in_page = 0
        self._pages_printed = 0

    def write(self, data: bytes) -> None:
        self.written += data
        i = 0
        while i < len(data):
            b = data[i]
            if data[i:i + 3] == b"\x1biS":
                self._pending.append(fake_status(self.tape_mm))
                i += 3
            elif b == 0x47:               # G n1 n2 payload
                n = data[i + 1] | (data[i + 2] << 8)
                self._lines_in_page += 1
                i += 3 + n
            elif b == 0x5A:
                self._lines_in_page += 1
                i += 1
            elif b in (0x0C, 0x1A):       # print page
                lines = self._lines_in_page
                self._lines_in_page = 0
                self._pages_printed += 1
                if self.realtime:
                    mm = lines / 7.0866 + 4
                    time.sleep(min(6.0, mm / 20.0))
                self._pending.append(fake_status(self.tape_mm, status_type=0x06, phase_type=0x01))
                self._pending.append(fake_status(self.tape_mm, status_type=0x01))
                self._pending.append(fake_status(self.tape_mm, status_type=0x06, phase_type=0x00))
                i += 1
            elif data[i:i + 2] == b"\x1bi" and i + 2 < len(data):
                cmd = data[i + 2]
                i += {0x7A: 13, 0x4D: 4, 0x4B: 4, 0x41: 4, 0x64: 5, 0x61: 4, 0x21: 4}.get(cmd, 3)
            else:
                i += 1

    def read(self, n: int = 32, timeout_ms: int | None = None) -> bytes:
        if self._pending:
            return self._pending.pop(0)
        return b""

    def close(self) -> None:
        pass

    @property
    def pages_printed(self) -> int:
        return self._pages_printed
