// Code 128 encoder (subsets B and C, auto-switching) and a QR helper.

const CODE128 = [
  '212222','222122','222221','121223','121322','131222','122213','122312','132212','221213',
  '221312','231212','112232','122132','122231','113222','123122','123221','223211','221132',
  '221231','213212','223112','312131','311222','321122','321221','312212','322112','322211',
  '212123','212321','232121','111323','131123','131321','112313','132113','132311','211313',
  '231113','231311','112133','112331','132131','113123','113321','133121','313121','211331',
  '231131','213113','213311','213131','311123','311321','331121','312113','312311','332111',
  '314111','221411','431111','111224','111422','121124','121421','141122','141221','112214',
  '112412','122114','122411','142112','142211','241211','221114','413111','241112','134111',
  '111242','121142','121241','114212','124112','124211','411212','421112','421211','212141',
  '214121','412121','111143','111341','131141','114113','114311','411113','411311','113141',
  '114131','311141','411131','211412','211214','211232','2331112',
];
const START_B = 104, START_C = 105, CODE_B = 100, CODE_C = 99, STOP = 106;

/** Returns an array of module widths alternating bar, space, bar, ... */
export function code128(text) {
  text = String(text ?? '');
  if (!text) return [];
  for (const ch of text) if (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) > 126) throw new Error('Code 128B supports printable ASCII only');
  const codes = [];
  let i = 0, subset = null;
  const digitsAhead = (k) => { let n = 0; while (k + n < text.length && /\d/.test(text[k + n])) n++; return n; };
  while (i < text.length) {
    const d = digitsAhead(i);
    if (d >= 4 || (d >= 2 && i + d === text.length && subset === 'C')) {
      if (subset !== 'C') { codes.push(subset === null ? START_C : CODE_C); subset = 'C'; }
      const take = d - (d % 2);
      for (let k = 0; k < take; k += 2) codes.push(parseInt(text.substr(i + k, 2), 10));
      i += take;
    } else {
      if (subset !== 'B') { codes.push(subset === null ? START_B : CODE_B); subset = 'B'; }
      codes.push(text.charCodeAt(i) - 32);
      i++;
    }
  }
  let sum = codes[0];
  for (let k = 1; k < codes.length; k++) sum += codes[k] * k;
  codes.push(sum % 103, STOP);
  const widths = [];
  for (const c of codes) for (const w of CODE128[c]) widths.push(parseInt(w, 10));
  return widths;
}

/** Draw a Code 128 barcode into ctx within (x, y, w, h). Module width is an integer
 *  number of dots for crisp printing; the barcode is centred horizontally. */
export function drawCode128(ctx, text, x, y, w, h) {
  let widths;
  try { widths = code128(text); } catch (e) { widths = []; }
  if (!widths.length) { ctx.strokeRect(x + .5, y + .5, w - 1, h - 1); return { ok: false, modules: 0 }; }
  const total = widths.reduce((a, b) => a + b, 0) + 20;   // quiet zones 10 each side
  const mod = Math.max(1, Math.floor(w / total));
  const bw = total * mod;
  let cx = x + Math.floor((w - bw) / 2) + 10 * mod;
  ctx.fillStyle = '#000';
  widths.forEach((m, k) => { if (k % 2 === 0) ctx.fillRect(cx, y, m * mod, h); cx += m * mod; });
  return { ok: true, modules: total, width: bw };
}

/** QR matrix via the vendored qrcode-generator (global `qrcode`). */
export function qrMatrix(text, ecc = 'M') {
  if (typeof qrcode !== 'function') throw new Error('qrcode library not loaded');
  const qr = qrcode(0, ecc);
  qr.addData(String(text ?? ''));
  qr.make();
  const n = qr.getModuleCount();
  const rows = [];
  for (let r = 0; r < n; r++) { const row = []; for (let c = 0; c < n; c++) row.push(qr.isDark(r, c)); rows.push(row); }
  return rows;
}

export function drawQr(ctx, text, x, y, size, ecc = 'M', quiet = 1) {
  let m;
  try { m = qrMatrix(text, ecc); } catch (e) { ctx.strokeRect(x + .5, y + .5, size - 1, size - 1); return { ok: false }; }
  const n = m.length + quiet * 2;
  const mod = Math.max(1, Math.floor(size / n));
  const px = mod * n;
  const ox = x + Math.floor((size - px) / 2) + quiet * mod, oy = y + Math.floor((size - px) / 2) + quiet * mod;
  ctx.fillStyle = '#000';
  for (let r = 0; r < m.length; r++) for (let c = 0; c < m.length; c++) if (m[r][c]) ctx.fillRect(ox + c * mod, oy + r * mod, mod, mod);
  return { ok: true, modules: m.length, module: mod };
}
