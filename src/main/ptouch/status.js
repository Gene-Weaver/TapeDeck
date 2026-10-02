'use strict';
// Parse the 32-byte status block the printer returns for ESC i S (and sends as notifications).
const ERROR1 = { 0x01: 'No media', 0x02: 'End of media', 0x04: 'Cutter jam', 0x08: 'Weak batteries', 0x10: 'Printer in use', 0x20: 'Printer turned off', 0x40: 'High-voltage adapter', 0x80: 'Fan motor error' };
const ERROR2 = { 0x01: 'Replace media', 0x02: 'Expansion buffer full', 0x04: 'Communication error', 0x08: 'Communication buffer full', 0x10: 'Cover open', 0x20: 'Overheating', 0x40: 'Media cannot be fed', 0x80: 'System error' };
const MEDIA_TYPES = { 0x00: 'No media', 0x01: 'Laminated tape', 0x03: 'Non-laminated tape', 0x11: 'Heat-shrink tube', 0x13: 'Fle tape', 0x14: 'Flexible ID tape', 0x15: 'Satin tape', 0xFF: 'Incompatible tape' };
const STATUS_TYPES = { 0x00: 'Reply to status request', 0x01: 'Printing completed', 0x02: 'Error occurred', 0x06: 'Phase change' };

function parseStatus(buf) {
  if (!buf || buf.length < 32) throw new Error(`Status block too short: ${buf ? buf.length : 0} bytes`);
  if (buf[0] !== 0x80 || buf[1] !== 0x20) throw new Error(`Not a status block (header ${buf[0].toString(16)} ${buf[1].toString(16)})`);
  const errors = [];
  for (const [bit, name] of Object.entries(ERROR1)) if (buf[8] & Number(bit)) errors.push(name);
  for (const [bit, name] of Object.entries(ERROR2)) if (buf[9] & Number(bit)) errors.push(name);
  const mediaTypeCode = buf[11], mediaWidthMm = buf[10];
  return {
    raw: Buffer.from(buf.subarray(0, 32)).toString('hex'),
    modelCode: buf[4],
    mediaWidthMm,
    mediaTypeCode,
    mediaType: MEDIA_TYPES[mediaTypeCode] || `Unknown (0x${mediaTypeCode.toString(16)})`,
    mediaLengthMm: buf[17],
    tapeColorCode: buf[24],
    textColorCode: buf[25],
    statusTypeCode: buf[18],
    statusType: STATUS_TYPES[buf[18]] || `Unknown (0x${buf[18].toString(16)})`,
    phaseType: buf[19],
    phaseNumber: (buf[20] << 8) | buf[21],
    errors,
    ok: errors.length === 0,
    hasMedia: mediaTypeCode !== 0x00 && mediaTypeCode !== 0xFF && mediaWidthMm > 0,
  };
}

function fakeStatus({ widthMm = 6, mediaType = 0x01, statusType = 0x00, phaseType = 0x00 } = {}) {
  const b = Buffer.alloc(32);
  b[0] = 0x80; b[1] = 0x20; b[2] = 0x42; b[3] = 0x30; b[4] = 0x67;
  b[10] = widthMm; b[11] = mediaType; b[18] = statusType; b[19] = phaseType; b[24] = 0x01; b[25] = 0x08;
  return b;
}

module.exports = { parseStatus, fakeStatus, ERROR1, ERROR2, MEDIA_TYPES, STATUS_TYPES };
