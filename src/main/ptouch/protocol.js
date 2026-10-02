'use strict';
// Brother P-touch raster command builders for the PT-P700. Every function returns a Buffer.
const { RASTER_BYTES } = require('./tapes');
const ESC = 0x1b;

const invalidate = () => Buffer.alloc(100);                       // 100 NULs flush a partial command
const initialize = () => Buffer.from([ESC, 0x40]);                // ESC @
const statusRequest = () => Buffer.from([ESC, 0x69, 0x53]);       // ESC i S
const switchToRasterMode = () => Buffer.from([ESC, 0x69, 0x61, 0x01]); // ESC i a 01
const notifyMode = (enabled = true) => Buffer.from([ESC, 0x69, 0x21, enabled ? 0x00 : 0x01]);

/** ESC i z: media expectations + number of raster lines in this page. */
function printInformation(tape, rasterLines, firstPage, mediaType = null) {
  const PI_KIND = 0x02, PI_WIDTH = 0x04, PI_RECOVER = 0x80;
  let valid = PI_WIDTH | PI_RECOVER, kind = 0;
  if (mediaType != null) { valid |= PI_KIND; kind = mediaType; }
  const width = tape.widthMm >= 4 ? Math.round(tape.widthMm) : 4;
  const n = rasterLines;
  return Buffer.from([ESC, 0x69, 0x7a, valid, kind, width, 0x00, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff, firstPage ? 0x00 : 0x01, 0x00]);
}
/** ESC i M: bit6 auto cut, bit7 mirror. */
const variousMode = (autoCut = true, mirror = false) => Buffer.from([ESC, 0x69, 0x4d, (autoCut ? 0x40 : 0) | (mirror ? 0x80 : 0)]);
/** ESC i K: bit3 = no chain printing (feed + cut at the end of the job). */
const advancedMode = (noChainPrinting = true, specialTapeNoCut = false) => Buffer.from([ESC, 0x69, 0x4b, (noChainPrinting ? 0x08 : 0) | (specialTapeNoCut ? 0x10 : 0)]);
/** ESC i A: with auto cut on, cut after every n labels. */
const cutEvery = (n = 1) => Buffer.from([ESC, 0x69, 0x41, Math.max(1, Math.min(255, n))]);
/** ESC i d: feed amount in dots (PT-P700 minimum 14). */
function margin(dots = 14) { dots = Math.max(14, Math.min(0xffff, Math.round(dots))); return Buffer.from([ESC, 0x69, 0x64, dots & 0xff, dots >> 8]); }
const compression = (packbits = true) => Buffer.from([0x4d, packbits ? 0x02 : 0x00]);
const printPage = (last) => Buffer.from([last ? 0x1a : 0x0c]);

function packBits(data) {
  const out = [];
  let i = 0; const n = data.length;
  while (i < n) {
    let run = 1;
    while (i + run < n && data[i + run] === data[i] && run < 128) run++;
    if (run >= 2) { out.push((256 - (run - 1)) & 0xff, data[i]); i += run; continue; }
    const start = i; i++;
    while (i < n && (i - start) < 128) { if (i + 1 < n && data[i] === data[i + 1]) break; i++; }
    out.push(i - start - 1); for (let k = start; k < i; k++) out.push(data[k]);
  }
  return Buffer.from(out);
}
function unpackBits(data) {
  const out = []; let i = 0;
  while (i < data.length) {
    const h = data[i++];
    if (h < 128) { for (let k = 0; k <= h; k++) out.push(data[i++]); }
    else { const b = data[i++]; for (let k = 0; k < 257 - h; k++) out.push(b); }
  }
  return Buffer.from(out);
}

function rasterLine(line, packbits = true) {
  if (!line.some(b => b)) return Buffer.from([0x5a]);                  // Z: zero raster line
  const payload = packbits ? packBits(line) : Buffer.from(line);
  return Buffer.concat([Buffer.from([0x47, payload.length & 0xff, payload.length >> 8]), payload]);
}

/**
 * pixels: Uint8Array(width*height), row-major, 1 = black; height must equal tape.pins.
 * Returns one 16-byte raster line per column. Pin 0 (bit 7 of byte 0) is the pin at the tape's
 * bottom edge, so each column is reversed (unless `flip`) and offset by the tape's margin.
 */
function pixelsToRasterLines(pixels, width, height, tape, flip = false) {
  if (height !== tape.pins) throw new Error(`label is ${height} px tall, ${tape.label} tape needs ${tape.pins}`);
  const lines = [];
  for (let x = 0; x < width; x++) {
    const line = Buffer.alloc(RASTER_BYTES);
    for (let y = 0; y < height; y++) {
      if (!pixels[y * width + x]) continue;
      const k = flip ? y : (height - 1 - y);
      const p = tape.marginPins + k;
      line[p >> 3] |= 1 << (7 - (p & 7));
    }
    lines.push(line);
  }
  return lines;
}

function buildPage(lines, tape, first, last, opt) {
  const parts = [
    printInformation(tape, lines.length, first, opt.mediaType ?? null),
    variousMode(opt.autoCut !== false, !!opt.mirror),
    advancedMode(last),
    cutEvery(opt.cutEach || 1),
    margin(opt.marginDots ?? 14),
    compression(opt.packbits !== false),
  ];
  for (const ln of lines) parts.push(rasterLine(ln, opt.packbits !== false));
  parts.push(printPage(last));
  return Buffer.concat(parts);
}
const buildJobHeader = () => Buffer.concat([invalidate(), initialize(), switchToRasterMode()]);
/** pages: array of raster-line arrays. Returns [header, page1, page2, ...]. */
function buildJob(pages, tape, opt = {}) {
  const chunks = [buildJobHeader()];
  pages.forEach((lines, i) => chunks.push(buildPage(lines, tape, i === 0, i === pages.length - 1, opt)));
  return chunks;
}

module.exports = { invalidate, initialize, statusRequest, switchToRasterMode, notifyMode, printInformation, variousMode, advancedMode, cutEvery, margin, compression, printPage, packBits, unpackBits, rasterLine, pixelsToRasterLines, buildPage, buildJobHeader, buildJob };
