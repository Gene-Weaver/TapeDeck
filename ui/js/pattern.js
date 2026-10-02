// Expand Single / Pattern / Batch inputs into a list of label values.
// A value is { text, n, i, fields } where `fields` holds CSV columns.

export function pad(num, width) {
  const s = String(Math.abs(num));
  return (num < 0 ? '-' : '') + (width > s.length ? '0'.repeat(width - s.length) + s : s);
}

export function letters(n, upper = true) {   // 0 -> A, 25 -> Z, 26 -> AA
  let s = '';
  n = Math.max(0, Math.floor(n));
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return upper ? s : s.toLowerCase();
}

function isoDate(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)}`;
}
function isoTime(d = new Date()) {
  return `${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}`;
}

/** Replace {tokens} in a template with values. Supported:
 *  {n} {n:06}       counter (and zero padded)
 *  {i} {i:03}       1-based index within the batch
 *  {A} {a}          letters from the counter (0 -> A)
 *  {text}           the batch line / single text
 *  {date} {time}    now
 *  {col}            any CSV column by header name
 */
export function expand(template, value) {
  if (template == null) return '';
  return String(template).replace(/\{([^{}:]+)(?::([^{}]*))?\}/g, (m, key, fmt) => {
    key = key.trim();
    const num = (v) => (fmt && /^\d+$/.test(fmt) ? pad(v, parseInt(fmt, 10)) : String(v));
    switch (key) {
      case 'n': return num(value.n ?? 0);
      case 'i': return num(value.i ?? 1);
      case 'A': return letters(value.n ?? 0, true);
      case 'a': return letters(value.n ?? 0, false);
      case 'text': return value.text ?? '';
      case 'date': return isoDate();
      case 'time': return isoTime();
      default:
        if (value.fields && key in value.fields) return value.fields[key];
        return m;   // leave unknown tokens visible so the user notices
    }
  });
}

export function hasTokens(s) { return /\{[^{}]+\}/.test(String(s ?? '')); }

/** Counter pattern: prefix + padded counter + suffix. */
export function counterValues({ prefix = '', suffix = '', start = 1, end = 10, step = 1, padWidth = 0, count = null }) {
  start = Number(start) || 0; step = Number(step) || 1; padWidth = Number(padWidth) || 0;
  const out = [];
  let total;
  if (count != null && count !== '') total = Math.max(0, Math.floor(Number(count)));
  else total = step === 0 ? 0 : Math.max(0, Math.floor((Number(end) - start) / step) + 1);
  total = Math.min(total, 100000);
  for (let k = 0; k < total; k++) {
    const n = start + k * step;
    out.push({ text: `${prefix}${pad(n, padWidth)}${suffix}`, n, i: k + 1, fields: {} });
  }
  return out;
}

/** Template pattern: template with tokens, iterated over a counter range. */
export function templateValues({ template = 'LEAF-{n:06}', start = 1, count = 10, step = 1 }) {
  start = Number(start) || 0; step = Number(step) || 1;
  count = Math.min(100000, Math.max(0, Math.floor(Number(count) || 0)));
  const out = [];
  for (let k = 0; k < count; k++) {
    const v = { n: start + k * step, i: k + 1, text: '', fields: {} };
    v.text = expand(template, v);
    out.push(v);
  }
  return out;
}

/** Minimal CSV parser (handles quotes, commas/tabs/semicolons). */
export function parseCsv(text, delimiter = null) {
  const rows = [];
  let row = [], cell = '', q = false;
  const d = delimiter || detectDelimiter(text);
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === d) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim() !== ''));
}

export function detectDelimiter(text) {
  const first = text.split(/\r?\n/).find(l => l.trim()) || '';
  const counts = [[',', (first.match(/,/g) || []).length], ['\t', (first.match(/\t/g) || []).length], [';', (first.match(/;/g) || []).length]];
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ',';
}

/** Batch values from pasted text. With header=true the first row names the columns. */
export function batchValues({ text = '', header = false, template = '' }) {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  let cols = null;
  if (header) cols = rows.shift().map(c => c.trim());
  return rows.map((r, k) => {
    const fields = {};
    if (cols) cols.forEach((c, j) => { fields[c] = r[j] ?? ''; });
    else r.forEach((c, j) => { fields[`c${j + 1}`] = c; });
    const v = { n: k + 1, i: k + 1, text: r[0] ?? '', fields };
    if (template && template.trim()) v.text = expand(template, v);
    return v;
  });
}
