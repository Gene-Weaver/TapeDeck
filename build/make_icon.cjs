// Builds build/icon.png and src/renderer/img/logo.svg: the yellow tile with the QR code for "TapeDeck" on it.
//   node build/make_icon.cjs          (needs ImageMagick's `magick`)
// The code is the smallest QR there is (version 1, 21 x 21 modules, error correction L), so its squares are as
// large as they can be. Made with the same vendored generator the app uses for labels.
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const qrcode = require('../src/renderer/vendor/qrcode.js');

const TEXT = 'TapeDeck', YELLOW = '#ffd84a', INK = '#14161c';
const SIZE = 1024, TILE = [64, 960], RADIUS = 200, MODULE = 34;          // the tile and its corners as before

const qr = qrcode(1, 'L');
qr.addData(TEXT); qr.make();
const n = qr.getModuleCount(), origin = Math.round((SIZE - n * MODULE) / 2);
const draw = [];
for (let r = 0; r < n; r++) {
  for (let c = 0; c < n; c++) {
    if (!qr.isDark(r, c)) continue;
    let end = c; while (end + 1 < n && qr.isDark(r, end + 1)) end++;      // one rectangle per run: no hairlines between squares
    draw.push('-draw', `rectangle ${origin + c * MODULE},${origin + r * MODULE} ${origin + (end + 1) * MODULE - 1},${origin + (r + 1) * MODULE - 1}`);
    c = end;
  }
}
// The same code as an SVG for the mark in the app's top-left corner (src/renderer/img/logo.svg): units are modules,
// with a 2-module margin inside the yellow tile.
const fs = require('node:fs');
const M = 2, U = n + 2 * M;
let d = '';
for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
  if (!qr.isDark(r, c)) continue;
  let end = c; while (end + 1 < n && qr.isDark(r, end + 1)) end++;
  d += `M${M + c} ${M + r}h${end - c + 1}v1h-${end - c + 1}z`; c = end;
}
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${U} ${U}"><rect width="${U}" height="${U}" rx="5" fill="${YELLOW}"/><path d="${d}" fill="${INK}" shape-rendering="crispEdges"/></svg>\n`;
fs.mkdirSync(path.join(__dirname, '..', 'src', 'renderer', 'img'), { recursive: true });
fs.writeFileSync(path.join(__dirname, '..', 'src', 'renderer', 'img', 'logo.svg'), svg);
const out = path.join(__dirname, 'icon.png');
execFileSync('magick', ['-size', `${SIZE}x${SIZE}`, 'xc:none', '-fill', YELLOW, '-draw', `roundrectangle ${TILE[0]},${TILE[0]} ${TILE[1]},${TILE[1]} ${RADIUS},${RADIUS}`,
  '+antialias', '-fill', INK, ...draw, out]);
console.log(`${out}: "${TEXT}" as a ${n} x ${n} QR code, ${MODULE} px modules, quiet zone ${((origin - TILE[0]) / MODULE).toFixed(1)} modules inside the tile`);
