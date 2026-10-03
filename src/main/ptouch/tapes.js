'use strict';
// Tape geometry for the PT-P700 head (Brother Raster Command Reference, PT-H500/P700/E500).
// Keep in sync with src/renderer/js/tape.js.
const DPI = 180;
const DOTS_PER_MM = DPI / 25.4;
const HEAD_PINS = 128;
const RASTER_BYTES = HEAD_PINS / 8;

// The whole tape width is printable (verified on a PT-P700: ink lands right up to the tape edge),
// so the band is the full width in dots, capped by the 128-pin head, centred on the head.
// Brother's reference lists narrower "print areas" (6 mm -> 32 dots) which are just safe margins.
const fullPins = (mm) => Math.min(HEAD_PINS, Math.round(mm * DOTS_PER_MM));
const TAPES = {
  4: { widthMm: 3.5, pins: fullPins(3.5), label: '3.5 mm' },   // printer reports 3.5 mm tape as width 4
  6: { widthMm: 6, pins: fullPins(6), label: '6 mm' },
  9: { widthMm: 9, pins: fullPins(9), label: '9 mm' },
  12: { widthMm: 12, pins: fullPins(12), label: '12 mm' },
  18: { widthMm: 18, pins: fullPins(18), label: '18 mm' },
  24: { widthMm: 24, pins: fullPins(24), label: '24 mm' },
};

/**
 * offsetDots shifts the band along the head to match where the cassette actually holds the tape
 * (a PT-P700 measured ~0.5 mm off centre). Positive moves the band toward higher pin numbers,
 * which is toward the TOP of the label as printed (columns are packed bottom-up).
 */
function tapeForMm(mm, offsetDots = 0) {
  let key = Math.round(Number(mm));
  if (key === 3) key = 4;
  const t = TAPES[key];
  if (!t) throw new Error(`Unsupported tape width ${mm} mm; expected one of ${Object.keys(TAPES).join(', ')}`);
  const centred = Math.round((HEAD_PINS - t.pins) / 2);
  const marginPins = Math.max(0, Math.min(HEAD_PINS - t.pins, centred + Math.round(offsetDots || 0)));
  return { key, ...t, marginPins };
}

module.exports = { DPI, DOTS_PER_MM, HEAD_PINS, RASTER_BYTES, TAPES, tapeForMm };
