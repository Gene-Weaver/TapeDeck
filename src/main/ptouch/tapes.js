'use strict';
// Tape geometry for the PT-P700 head (Brother Raster Command Reference, PT-H500/P700/E500).
// Keep in sync with src/renderer/js/tape.js.
const DPI = 180;
const DOTS_PER_MM = DPI / 25.4;
const HEAD_PINS = 128;
const RASTER_BYTES = HEAD_PINS / 8;

const TAPES = {
  4: { widthMm: 3.5, pins: 24, marginPins: 52, label: '3.5 mm' },   // printer reports 3.5 mm tape as width 4
  6: { widthMm: 6, pins: 32, marginPins: 48, label: '6 mm' },
  9: { widthMm: 9, pins: 50, marginPins: 39, label: '9 mm' },
  12: { widthMm: 12, pins: 70, marginPins: 29, label: '12 mm' },
  18: { widthMm: 18, pins: 112, marginPins: 8, label: '18 mm' },
  24: { widthMm: 24, pins: 128, marginPins: 0, label: '24 mm' },
};

function tapeForMm(mm) {
  let key = Math.round(Number(mm));
  if (key === 3) key = 4;
  const t = TAPES[key];
  if (!t) throw new Error(`Unsupported tape width ${mm} mm; expected one of ${Object.keys(TAPES).join(', ')}`);
  return { key, ...t };
}

module.exports = { DPI, DOTS_PER_MM, HEAD_PINS, RASTER_BYTES, TAPES, tapeForMm };
