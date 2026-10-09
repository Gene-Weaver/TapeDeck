// Tape geometry for the renderer (mirror of src/main/ptouch/tapes.js). Units: dots at 180 dpi.
export const DPI = 180;
export const DOTS_PER_MM = DPI / 25.4;
export const HEAD_PINS = 128;
// How the PT-P700 moves tape during a job, for the print animation and time estimates. The print
// head sits leaderMm behind the cutter, so a job first pushes out that blank stretch (cut off as the
// lead piece), every label comes out with its feed margins, and the tape stops for each cut.
// Measured on a real PT-P700 (2026-10-03, 6 mm tape, 72 mm Label wrap labels): 17.4 mm/s and 1.0 s
// per cut, which predicted 3- and 21-label jobs to within 0.05 s. The animation still refines the
// speed from each job's own reports and remembers it.
export const PRINT = { mmPerS: 17.4, leaderMm: 24.5, cutS: 1.0, startS: 0.05 };

/** Seconds a job takes: lead piece + every label (already including margins) at `mmPerS`, plus the cuts. */
export function printSeconds(labelsMm, count, mmPerS = PRINT.mmPerS) {
  return PRINT.startS + (PRINT.leaderMm + labelsMm) / mmPerS + (count + 1) * PRINT.cutS;
}

// Full tape width is printable (capped by the 128-pin head). Keep in sync with src/main/ptouch/tapes.js.
const fullPins = (mm) => Math.min(HEAD_PINS, Math.floor(mm * DOTS_PER_MM));   // never wider than the tape
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
