// Tape geometry (mirror of tapedeck/ptouch/tapes.py). Units: dots at 180 dpi.
export const DPI = 180;
export const DOTS_PER_MM = DPI / 25.4;
export const HEAD_PINS = 128;
export const FEED_MM_PER_S = 20;          // rough PT-P700 print speed, used for the animation

// Full tape width is printable (capped by the 128-pin head). Keep in sync with src/main/ptouch/tapes.js.
const fullPins = (mm) => Math.min(HEAD_PINS, Math.round(mm * DOTS_PER_MM));
export const TAPES = {
  4:  { mm: 3.5, key: 4,  pins: fullPins(3.5), label: '3.5 mm' },
  6:  { mm: 6,   key: 6,  pins: fullPins(6),   label: '6 mm' },
  9:  { mm: 9,   key: 9,  pins: fullPins(9),   label: '9 mm' },
  12: { mm: 12,  key: 12, pins: fullPins(12),  label: '12 mm' },
  18: { mm: 18,  key: 18, pins: fullPins(18),  label: '18 mm' },
  24: { mm: 24,  key: 24, pins: fullPins(24),  label: '24 mm' },
};

export function tape(mm) {
  const t = TAPES[mm === 3.5 ? 4 : mm];
  if (!t) throw new Error(`Unsupported tape width ${mm}`);
  return t;
}
export const mmToDots = (mm) => Math.round(mm * DOTS_PER_MM);
export const dotsToMm = (d) => d / DOTS_PER_MM;
export const fmtMm = (d) => `${dotsToMm(d).toFixed(1)} mm`;
