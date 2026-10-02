// Tape geometry (mirror of tapedeck/ptouch/tapes.py). Units: dots at 180 dpi.
export const DPI = 180;
export const DOTS_PER_MM = DPI / 25.4;
export const HEAD_PINS = 128;
export const FEED_MM_PER_S = 20;          // rough PT-P700 print speed, used for the animation

export const TAPES = {
  4:  { mm: 3.5, key: 4,  pins: 24,  margin: 52, label: '3.5 mm' },
  6:  { mm: 6,   key: 6,  pins: 32,  margin: 48, label: '6 mm' },
  9:  { mm: 9,   key: 9,  pins: 50,  margin: 39, label: '9 mm' },
  12: { mm: 12,  key: 12, pins: 70,  margin: 29, label: '12 mm' },
  18: { mm: 18,  key: 18, pins: 112, margin: 8,  label: '18 mm' },
  24: { mm: 24,  key: 24, pins: 128, margin: 0,  label: '24 mm' },
};

export function tape(mm) {
  const t = TAPES[mm === 3.5 ? 4 : mm];
  if (!t) throw new Error(`Unsupported tape width ${mm}`);
  return t;
}
export const mmToDots = (mm) => Math.round(mm * DOTS_PER_MM);
export const dotsToMm = (d) => d / DOTS_PER_MM;
export const fmtMm = (d) => `${dotsToMm(d).toFixed(1)} mm`;
