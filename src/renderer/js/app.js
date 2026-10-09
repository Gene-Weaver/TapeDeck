import { tape, TAPES, mmToDots, dotsToMm, printSeconds, PRINT } from './tape.js';
import { batchValues, patternSeries, patternSample, spread, defaultPattern, tableValues, normalizeCell, rowComplete, parseTableText } from './pattern.js';
import { renderLabel, measureLabelWidth, canvasToPng, hydrateLayout, setSeries, readImageFile, FONTS } from './render.js';
import { fromFile, toFileText, snapshot, signature } from './layout.js';
import { Designer } from './designer.js';
import { Panel } from './panel.js';
import { Library } from './library.js';
import { History } from './history.js';
import { PrintTheater } from './printer-anim.js';
import { api, canvasToPixels, cleanError } from './api.js';

const $ = (id) => document.getElementById(id);
const CSS_PER_DOT = 96 / 180;            // zoom 1 = real size on a 96 dpi screen

// ---------------------------------------------------------------- settings (settings.json in the user data folder)
const DEFAULTS = {
  tapeMm: 6, mode: 'pattern', zoom: 1.5, layoutId: 'label-wrap',
  pattern: defaultPattern(), patternVersion: 2,
  single: { text: 'Hello tape', copies: 1 },
  batch: { text: '', header: false, tpl: '' },
  table: { rows: [] },
  options: { autoCut: true, cutEach: 1, marginMm: 2, mirror: false, flip: false, check: true, mock: false, mockTape: 6, offsetDots: 2, mmPerS: null },   // mmPerS: measured on real jobs
  designer: { zoom: 6, manualZoom: false, snap: true },
};
const boot = api.boot();
const config = boot.config || { mock: false, version: '', packaged: false };
if (boot.error) console.error('boot:', boot.error);
let firstRun = false;
const S = loadSettings(boot.settings);
let mock = !!(config.mock || S.options.mock);   // --mock applies to this session only and is never saved

function loadSettings(stored) {
  let s = stored;
  if (!s) { firstRun = true; s = fromLocalStorage(); }
  const out = deepMerge(structuredClone(DEFAULTS), s || {});
  if (out.patternVersion !== 2) { out.pattern = defaultPattern(); out.patternVersion = 2; }   // 2026-10-02: Number before Letter
  if (!TAPES[out.tapeMm]) out.tapeMm = 6;
  if (out.options.speedModel !== 2) out.options.mmPerS = null;   // a speed measured under the old timing model (0.35 s cuts) does not fit the new one
  if (!['pattern', 'table', 'single', 'batch'].includes(out.mode)) out.mode = 'pattern';
  if (!Array.isArray(out.table?.rows)) out.table = { rows: [] };
  out.table.rows = out.table.rows.filter(Array.isArray).map(r => r.map(c => String(c ?? '')));
  delete out.wrap;
  return out;
}
/** TapeDeck 0.1 kept its state in localStorage; carry it over once. */
function fromLocalStorage() {
  try {
    const old = JSON.parse(localStorage.getItem('tapedeck.state.v2') || 'null');
    if (!old) return null;
    const s = { ...old, layoutId: old.wrap === false ? 'plain' : 'label-wrap' };
    delete s.wrap;
    s.options = { ...(old.options || {}), mock: false };     // 0.1 saved a --mock launch as a setting
    s.designer = { zoom: (old.designer && old.designer.zoom) || 6, manualZoom: !!(old.designer && old.designer.manualZoom), snap: true };
    return s;
  } catch { return null; }
}
function deepMerge(a, b) { for (const k in b) { if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k])) a[k] = deepMerge(a[k] && typeof a[k] === 'object' ? a[k] : {}, b[k]); else a[k] = b[k]; } return a; }

let settingsDirty = false, settingsTimer = null;
function saveState() { settingsDirty = true; clearTimeout(settingsTimer); settingsTimer = setTimeout(flushSettings, 300); }
async function flushSettings() {
  clearTimeout(settingsTimer);
  if (!settingsDirty) return;
  settingsDirty = false;
  try { await api.saveSettings(S); } catch (e) { settingsDirty = true; console.error('saving settings', e); }
}

// ---------------------------------------------------------------- helpers
let toastTimer;
function toast(msg, err = false, ms = 3500) {
  const t = $('toast'); t.textContent = msg; t.classList.toggle('err', err); t.classList.remove('hidden');
  clearTimeout(toastTimer); if (ms) toastTimer = setTimeout(() => t.classList.add('hidden'), err ? Math.max(ms, 6000) : ms);
}
const debounce = (fn, ms) => { let h; return (...a) => { clearTimeout(h); h = setTimeout(() => fn(...a), ms); }; };
const fmtLen = (dots) => { const mm = dotsToMm(dots); return mm >= 1000 ? `${(mm / 1000).toFixed(2)} m` : mm >= 100 ? `${(mm / 10).toFixed(1)} cm` : `${mm.toFixed(1)} mm`; };
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
async function chunked(n, fn, { perChunk = 150, onProgress } = {}) {
  for (let i = 0; i < n; i += perChunk) {
    const end = Math.min(n, i + perChunk);
    for (let k = i; k < end; k++) fn(k);
    onProgress?.(end, n);
    if (end < n) await new Promise(r => requestAnimationFrame(r));
  }
}

// ---------------------------------------------------------------- label values
let values = [], widths = [], seriesTotal = 0, previewToken = 0;
function computeValues() {
  if (S.mode === 'single') {
    const n = Math.max(1, Math.min(999, Number(S.single.copies) || 1));
    seriesTotal = n;
    return Array.from({ length: n }, (_, i) => ({ text: S.single.text, n: i + 1, i: i + 1, fields: {} }));
  }
  if (S.mode === 'pattern') { const r = patternSeries(S.pattern); seriesTotal = r.total; return r.values; }
  if (S.mode === 'table') { const v = tableValues(S.table.rows, S.pattern); seriesTotal = S.table.rows.length; return v; }
  const v = batchValues({ text: S.batch.text, header: S.batch.header, template: S.batch.tpl }); seriesTotal = v.length; return v;
}
function sampleValue() { return values[0] || { text: 'UM-001-A', n: 1, i: 1, fields: {} }; }

// Text boxes set to "same width for all labels" are sized over the whole series, not just the print range.
let seriesSig = null;
function updateSeries() {
  const sig = JSON.stringify(S.mode === 'pattern' ? ['p', S.pattern.segments, S.pattern.separator] : S.mode === 'table' ? ['t', S.table.rows, S.pattern.segments, S.pattern.separator] : S.mode === 'batch' ? ['b', S.batch] : ['s', S.single.text]);
  if (sig === seriesSig) return;
  seriesSig = sig;
  setSeries(S.mode === 'pattern' ? patternSample(S.pattern) : (S.mode === 'batch' || S.mode === 'table') ? spread(values) : values.slice(0, 1));
}
values = computeValues(); updateSeries();

// ---------------------------------------------------------------- tape preview strip
const strip = $('strip');
const io = new IntersectionObserver((entries) => { for (const e of entries) { if (e.isIntersecting) paintLab(e.target); else unpaintLab(e.target); } },
  { root: $('dock').querySelector('.strip-wrap'), rootMargin: '0px 600px 0px 600px' });
function paintLab(el) {
  if (el.dataset.token !== String(previewToken) || el._painted) return;
  const res = renderLabel(library.layout, values[+el.dataset.i], S.tapeMm);
  const c = el.querySelector('canvas.tape'); if (!c) return;
  c.width = res.width; c.height = res.height; c.getContext('2d').drawImage(res.canvas, 0, 0);
  c.classList.remove('pending'); el._painted = true;
}
function unpaintLab(el) { const c = el.querySelector('canvas.tape'); if (!c || !el._painted) return; c.width = 1; c.height = 1; c.classList.add('pending'); el._painted = false; }

const refreshPreview = debounce(async () => {
  const token = ++previewToken;
  values = computeValues();
  updateSeries();
  autoFitZoom(); designer.render(); panel.sync();
  const layout = library.layout;
  const t = tape(S.tapeMm), cpd = CSS_PER_DOT * S.zoom, marginDots = mmToDots(S.options.marginMm);
  const stats = $('previewStats');
  stats.textContent = values.length ? `Measuring ${values.length} labels…` : 'No labels yet';
  widths = new Array(values.length);
  await chunked(values.length, (k) => { widths[k] = measureLabelWidth(layout, values[k], S.tapeMm); }, { perChunk: 200, onProgress: (d, n) => { if (n > 400) stats.textContent = `Measuring ${d} / ${n}…`; } });
  if (token !== previewToken) return;
  io.disconnect(); strip.innerHTML = '';
  const H = t.pins, hCss = H * cpd, frag = document.createDocumentFragment();
  let total = 0; const MAX_DOM = 3000, shown = Math.min(values.length, MAX_DOM);
  for (let i = 0; i < shown; i++) {
    const W = widths[i], phys = W + 2 * marginDots; total += phys;
    const lab = document.createElement('div'); lab.className = 'lab'; lab.dataset.i = i; lab.dataset.token = token; lab.style.width = `${phys * cpd}px`;
    const row = document.createElement('div'); row.style.cssText = `display:flex;height:${hCss}px;align-items:stretch`;
    const m1 = document.createElement('div'); m1.className = 'tape'; m1.style.cssText = `width:${marginDots * cpd}px;opacity:.75`;
    const c = document.createElement('canvas'); c.className = 'tape pending'; c.width = 1; c.height = 1; c.style.cssText = `width:${W * cpd}px;height:${hCss}px`;
    const m2 = m1.cloneNode(); row.append(m1, c, m2); lab.appendChild(row);
    const cut = document.createElement('div'); cut.className = 'cut'; cut.style.height = `${hCss + 28}px`; lab.appendChild(cut);
    const cap = document.createElement('div'); cap.className = 'cap'; cap.title = values[i].text; cap.textContent = `${values[i].text.replace(/\n/g, ' ')} · ${fmtLen(phys)}`; lab.appendChild(cap);
    frag.appendChild(lab);
  }
  for (let i = shown; i < values.length; i++) total += widths[i] + 2 * marginDots;
  const ruler = document.createElement('div'); ruler.className = 'ruler'; ruler.style.width = `${total * cpd}px`;
  const totalMm = dotsToMm(total), stepMm = totalMm > 4000 ? 100 : totalMm > 1500 ? 50 : totalMm > 400 ? 20 : 10;
  for (let mm = 0; mm <= totalMm; mm += stepMm / 2) {
    const x = mm * (180 / 25.4) * cpd, big = (mm % stepMm) === 0;
    const tick = document.createElement('i'); tick.className = big ? 'big' : ''; tick.style.left = `${x}px`; ruler.appendChild(tick);
    if (big && (stepMm * (180 / 25.4) * cpd) > 28) { const sp = document.createElement('span'); sp.style.left = `${x}px`; sp.textContent = mm >= 1000 ? `${(mm / 1000).toFixed(1)} m` : `${mm}`; ruler.appendChild(sp); }
  }
  strip.appendChild(ruler); strip.appendChild(frag);
  if (values.length > shown) { const m = document.createElement('div'); m.className = 'more'; m.textContent = `… ${values.length - shown} more (all will print)`; strip.appendChild(m); }
  strip.querySelectorAll('.lab').forEach(el => io.observe(el));
  const secs = Math.round(printSeconds(dotsToMm(total), values.length, S.options.mmPerS || undefined));
  const range = S.mode === 'pattern' && seriesTotal > values.length ? ` (labels ${S.pattern.from}–${S.pattern.to} of ${seriesTotal})` : S.mode === 'table' && seriesTotal > values.length ? ` (${seriesTotal - values.length} incomplete row${seriesTotal - values.length === 1 ? '' : 's'} skipped)` : '';
  stats.textContent = values.length ? `${values.length} label${values.length === 1 ? '' : 's'}${range} · ${t.label} tape · ${fmtLen(total)} of tape (+ one blank lead piece per job) · ≈ ${secs >= 60 ? `${Math.floor(secs / 60)} min ${secs % 60} s` : `${secs} s`}` : 'No labels yet';
  $('btnPrint').textContent = values.length ? `Print ${values.length} label${values.length === 1 ? '' : 's'}` : 'Print';
  $('btnPrint').disabled = !values.length; $('btnExport').disabled = !values.length;
}, 120);

// ---------------------------------------------------------------- output
async function renderAllForOutput() {
  const out = new Array(values.length), layout = library.layout;
  toast(`Rendering ${values.length} labels…`, false, 0);
  await chunked(values.length, (k) => { const r = renderLabel(layout, values[k], S.tapeMm); out[k] = { canvas: r.canvas, width: r.width, height: r.height, name: values[k].text.replace(/\n/g, ' ') }; },
    { perChunk: 60, onProgress: (d, n) => { if (n > 120) toast(`Rendering ${d} / ${n} labels…`, false, 0); } });
  $('toast').classList.add('hidden');
  return out;
}
function printBody(labels) {
  const o = S.options;
  return { tapeMm: S.tapeMm, labels: labels.map(l => ({ pixels: canvasToPixels(l.canvas), width: l.width, height: l.height, name: l.name })),
    autoCut: o.autoCut, cutEach: Number(o.cutEach) || 1, mirror: o.mirror, marginDots: Math.max(14, mmToDots(o.marginMm)),
    flip: o.flip, checkMedia: o.check, mock, mockTape: Number(o.mockTape) || 6, offsetDots: Number(o.offsetDots) || 0 };
}
const theater = new PrintTheater($('theater'));
let currentJob = null, printStarting = false;
const jobUpdates = new Map();   // progress can arrive before the print call returns the job id
const finished = (j) => j && !['printing', 'queued'].includes(j.state);
async function doPrint() {
  if (!values.length || currentJob || printStarting) return;   // Print pressed twice, or menu and button together
  printStarting = true;
  try {
    const labels = await renderAllForOutput();
    const t = tape(S.tapeMm);
    theater.open({ labels, tapeMm: S.tapeMm, tapeLabel: t.label, onCancel: async () => { if (currentJob) await api.cancel(currentJob); },
      marginMm: dotsToMm(Math.max(14, mmToDots(S.options.marginMm))),
      mmPerS: (!mock && S.options.mmPerS) || PRINT.mmPerS,
      onSpeed: (v) => { if (!mock) { S.options.mmPerS = Math.round(v * 10) / 10; S.options.speedModel = 2; saveState(); refreshPreview(); } } });
    let job;
    try { job = await api.print(printBody(labels)); }
    catch (e) { theater.update({ state: 'error', error: cleanError(e), printed: 0, index: 0, phase: '' }); return; }
    const latest = jobUpdates.get(job.id) || job;
    currentJob = finished(latest) ? null : job.id;
    theater.update(latest);
  } finally { printStarting = false; }
}
api.onJobProgress((j) => {
  jobUpdates.set(j.id, j);
  if (jobUpdates.size > 20) jobUpdates.delete(jobUpdates.keys().next().value);
  if (j.id === currentJob) { theater.update(j); if (finished(j)) currentJob = null; }
});
$('thClose').onclick = () => theater.close();
$('btnPrint').onclick = doPrint;
$('btnExport').onclick = async () => {
  if (!values.length) return;
  const labels = await renderAllForOutput();
  const j = await api.exportPngs({ labels: labels.map(l => ({ png: canvasToPng(l.canvas), name: l.name })), suggestedName: S.mode === 'single' ? 'label' : S.mode === 'table' ? 'table' : S.mode });
  if (j.ok) { toast(`Saved ${j.count} PNGs to ${j.dir}`, false, 6000); api.openPath(j.dir); } else if (!j.cancelled) toast(j.error || 'Export failed', true);
};
async function doFeedCut(btn) {
  if (btn) btn.disabled = true;
  try { await api.feedAndCut({ tapeMm: S.tapeMm, mock, mockTape: Number(S.options.mockTape) || 6 }); toast('Fed and cut.'); }
  catch (e) { toast(cleanError(e), true, 6000); }
  finally { if (btn) btn.disabled = false; }
}
$('btnFeedCut').onclick = () => doFeedCut($('btnFeedCut'));
$('thFeedCut').onclick = () => doFeedCut($('thFeedCut'));

// ---------------------------------------------------------------- printer status
let polling = false;
async function pollStatus() {
  if (polling) return;          // never stack polls behind a slow USB answer
  polling = true;
  const pill = $('printerPill'), txt = pill.querySelector('.txt');
  try {
    const j = await api.status({ mock, mockTape: Number(S.options.mockTape) || 6 });
    pill.classList.remove('pill-on', 'pill-off', 'pill-mock');
    if (j.connected) {
      const st = j.status; pill.classList.add(j.mock ? 'pill-mock' : 'pill-on');
      if (!st) { txt.textContent = j.busy ? 'Printing…' : 'Connected'; return; }
      txt.textContent = `${j.mock ? 'Mock printer' : 'PT-P700'} · ${st.hasMedia ? `${st.mediaWidthMm} mm ${st.mediaType.toLowerCase()}` : 'no tape'}${st.errors.length ? ' · ' + st.errors.join(', ') : ''}${j.busy ? ' · printing' : ''}`;
      if (st.hasMedia && st.mediaWidthMm !== S.tapeMm) txt.textContent += `  (app set to ${tape(S.tapeMm).label})`;
    } else { pill.classList.add('pill-off'); txt.textContent = j.error || 'Printer not found'; }
    pill.title = j.error || JSON.stringify(j.status || {}, null, 1);
  } catch (e) { pill.classList.remove('pill-on', 'pill-mock'); pill.classList.add('pill-off'); txt.textContent = `Bridge error: ${cleanError(e)}`; }
  finally { polling = false; }
}

// ---------------------------------------------------------------- inputs
function bindInput(id, get, set, evt = 'input', after) {
  const el = $(id);
  if (el.type === 'checkbox') el.checked = !!get(); else el.value = get() ?? '';
  el.addEventListener(evt, () => { set(el.type === 'checkbox' ? el.checked : el.type === 'number' ? (el.value === '' ? '' : Number(el.value)) : el.value); saveState(); after ? after() : refreshPreview(); });
}
// tape
$('tapeMm').value = S.tapeMm;
$('tapeMm').addEventListener('change', () => { S.tapeMm = Number($('tapeMm').value); saveState(); updateTapeInfo(); designer.render(); panel.refresh(); refreshPreview(); pollStatus(); });
function updateTapeInfo() { const t = tape(S.tapeMm); $('tapeInfo').textContent = `${t.pins} dots · ${(t.pins / (180 / 25.4)).toFixed(1)} mm printable`; }
// mode
$('modeSeg').querySelectorAll('button').forEach(b => b.onclick = () => setMode(b.dataset.mode));
function setMode(m) {
  S.mode = m; saveState();
  $('modeSeg').querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.mode === m));
  for (const k of ['pattern', 'table', 'single', 'batch']) $(`mode-${k}`).classList.toggle('hidden', k !== m);
  if (m === 'table') renderTable();
  renderTokenHint(); refreshPreview();
}
function renderTokenHint() {
  let toks = [];
  if (S.mode === 'pattern' || S.mode === 'table') toks = S.pattern.segments.map(sg => `{${sg.name}}`);
  else if (S.mode === 'batch') { const v = batchValues({ text: S.batch.text, header: S.batch.header }); if (v[0]) toks = Object.keys(v[0].fields).map(k => `{${k}}`); }
  $('dzTokens').innerHTML = toks.map(t => `<code>${esc(t)}</code>`).join(' ');
  $('tokenHint').textContent = S.mode === 'pattern' ? 'Each segment is also available in the layout as a token, e.g. {Number}. The last segment cycles fastest.' : S.mode === 'table' ? 'Columns are the Pattern’s segments. Only rows with every cell filled print; cells are formatted like the Pattern on leaving them.' : S.mode === 'batch' ? 'Columns are available in the layout as tokens.' : '';
}
// single
bindInput('singleText', () => S.single.text, v => { S.single.text = v; });
bindInput('singleCopies', () => S.single.copies, v => { S.single.copies = v; });
// batch
bindInput('batchText', () => S.batch.text, v => { S.batch.text = v; }, 'input', () => { renderBatchSample(); renderTokenHint(); refreshPreview(); });
bindInput('batchHeader', () => S.batch.header, v => { S.batch.header = v; }, 'change', () => { renderBatchSample(); renderTokenHint(); refreshPreview(); });
bindInput('batchTpl', () => S.batch.tpl, v => { S.batch.tpl = v; }, 'input', () => { renderBatchSample(); refreshPreview(); });
$('btnBatchFile').onclick = () => $('batchFile').click();
$('batchFile').onchange = async () => { const f = $('batchFile').files[0]; if (!f) return; await loadList(f); $('batchFile').value = ''; };
async function loadList(f) { S.batch.text = await f.text(); $('batchText').value = S.batch.text; saveState(); setMode('batch'); renderBatchSample(); renderTokenHint(); refreshPreview(); }
function renderBatchSample() {
  const v = batchValues({ text: S.batch.text, header: S.batch.header, template: S.batch.tpl });
  $('batchSample').textContent = v.length ? `${v.length} labels\n${v.slice(0, 5).map(x => x.text).join('\n')}${v.length > 5 ? '\n…' : ''}` : 'Paste lines above.';
}
renderBatchSample();

// pattern segments
function renderSegments() {
  const root = $('segments'); root.innerHTML = '';
  S.pattern.segments.forEach((sg, k) => {
    const row = document.createElement('div'); row.className = 'segrow';
    const vals = sg.type === 'text' ? `<input data-k="value" value="${esc(sg.value ?? '')}" placeholder="text">`
      : sg.type === 'letters' ? `<input data-k="start" value="${esc(sg.start ?? 'AA')}" placeholder="AA" style="width:4.5em" title="Lowercase start gives lowercase letters"><span class="muted">→</span><input data-k="end" value="${esc(sg.end ?? 'BZ')}" placeholder="BZ" style="width:4.5em">`
      : `<input data-k="start" type="number" value="${sg.start ?? 1}" style="width:4em"><span class="muted">→</span><input data-k="end" type="number" value="${sg.end ?? 3}" style="width:4em"><input data-k="pad" type="number" class="pad" min="0" max="9" value="${sg.pad ?? 2}" title="Zero-pad to this many digits">`;
    row.innerHTML = `<input data-k="name" value="${esc(sg.name ?? '')}" placeholder="name">
      <select data-k="type"><option value="text" ${sg.type === 'text' ? 'selected' : ''}>Text</option><option value="letters" ${sg.type === 'letters' ? 'selected' : ''}>Letters</option><option value="number" ${sg.type === 'number' ? 'selected' : ''}>Numbers</option></select>
      <div class="vals">${vals}</div><button class="x" title="Remove segment">×</button>`;
    row.querySelectorAll('[data-k]').forEach(inp => {
      const h = () => {
        const key = inp.dataset.k; let v = inp.value;
        if (inp.type === 'number') v = v === '' ? '' : Number(v);
        if (key === 'type' && v !== sg.type) {
          sg.type = v;
          if (v === 'letters') { sg.start = sg.start && isNaN(sg.start) ? sg.start : 'AA'; sg.end = sg.end && isNaN(sg.end) ? sg.end : 'BZ'; }
          if (v === 'number') { sg.start = Number(sg.start) || 1; sg.end = Number(sg.end) || 3; sg.pad = sg.pad ?? 2; }
          renderSegments();
        } else sg[key] = v;
        saveState(); afterPatternChange();
      };
      inp.addEventListener(inp.tagName === 'SELECT' ? 'change' : 'input', h);
    });
    row.querySelector('.x').onclick = () => { S.pattern.segments.splice(k, 1); saveState(); renderSegments(); afterPatternChange(); };
    root.appendChild(row);
  });
}
function afterPatternChange() {
  const head = patternSeries({ ...S.pattern, from: 1, to: 1 }), total = head.total;
  if (!S.pattern.to || S.pattern.to > total) S.pattern.to = Math.min(total, Math.max(1, S.pattern.to || 3));
  if (S.pattern.from > total) S.pattern.from = 1;
  // never rewrite a range box while it is being typed in (clearing it to type a new number must work)
  if (document.activeElement !== $('patFrom')) $('patFrom').value = S.pattern.from;
  if (document.activeElement !== $('patTo')) $('patTo').value = S.pattern.to;
  $('patOf').textContent = `of ${total}`;
  const first = head.values[0]?.text ?? '', last = total ? patternSeries({ ...S.pattern, from: total, to: total }).values[0]?.text ?? '' : '';
  const sel = patternSeries(S.pattern).values;
  $('patSummary').textContent = !total ? 'Add a segment to build a series.'
    : `${total} labels in the series: ${first} … ${last}\n` + (sel.length ? `Selected ${sel.length}: ${sel.slice(0, 4).map(v => v.text).join(', ')}${sel.length > 4 ? ' …' : ''}` : '“From” is after “to”: nothing selected.');
  if (S.mode === 'table') renderTable();
  renderTokenHint(); refreshPreview();
}
$('segAdd').onclick = () => { S.pattern.segments.push({ name: `Part${S.pattern.segments.length + 1}`, type: 'number', start: 1, end: 9, pad: 0 }); saveState(); renderSegments(); afterPatternChange(); };
bindInput('patSep', () => S.pattern.separator, v => { S.pattern.separator = v; }, 'input', afterPatternChange);
bindInput('patFrom', () => S.pattern.from, v => { if (v !== '') S.pattern.from = Math.max(1, Math.floor(Number(v)) || 1); }, 'input', afterPatternChange);
bindInput('patTo', () => S.pattern.to, v => { if (v !== '') S.pattern.to = Math.max(1, Math.floor(Number(v)) || 1); }, 'input', afterPatternChange);
for (const id of ['patFrom', 'patTo']) $(id).addEventListener('blur', () => afterPatternChange());
$('patAll').onclick = () => { S.pattern.from = 1; S.pattern.to = patternSeries({ ...S.pattern, from: 1, to: 1 }).total; saveState(); afterPatternChange(); };
renderSegments();

// ---------------------------------------------------------------- table mode
function tableSave() { saveState(); renderTableSummary(); refreshPreview(); }
function renderTableSummary() {
  const segs = S.pattern.segments, rows = S.table.rows;
  const complete = rows.filter(r => rowComplete(r, segs.length)).length;
  const v = tableValues(rows, S.pattern);
  $('tblSummary').textContent = !rows.length ? 'No rows yet. Add rows, append the Pattern’s selection, or paste lines.'
    : `${complete} of ${rows.length} row${rows.length === 1 ? '' : 's'} complete → ${complete} label${complete === 1 ? '' : 's'}${rows.length - complete ? ` (${rows.length - complete} skipped)` : ''}\n${v.slice(0, 4).map(x => x.text).join(', ')}${v.length > 4 ? ' …' : ''}`;
  $('tbl').querySelectorAll('.tbl-row').forEach((rowEl, k) => rowEl.classList.toggle('incomplete', !rowComplete(rows[k], segs.length)));
}
function renderTable() {
  const root = $('tbl'), segs = S.pattern.segments, rows = S.table.rows;
  const cols = `26px ${segs.map(() => 'minmax(60px, 1fr)').join(' ')} 52px`;
  root.style.setProperty('--cols', cols);
  root.innerHTML = '';
  if (!segs.length) { root.innerHTML = '<div class="tbl-empty">Add segments in the Pattern first: they become the table’s columns.</div>'; renderTableSummary(); return; }
  const head = document.createElement('div'); head.className = 'tbl-head';
  head.innerHTML = `<span class="idx">#</span>${segs.map(sg => `<span>${esc(sg.name || '')}</span>`).join('')}<span></span>`;
  root.appendChild(head);
  if (!rows.length) { const e = document.createElement('div'); e.className = 'tbl-empty'; e.textContent = 'Empty. Use “+ Row” or paste lines.'; root.appendChild(e); }
  rows.forEach((row, k) => {
    const el = document.createElement('div'); el.className = 'tbl-row' + (rowComplete(row, segs.length) ? '' : ' incomplete'); el.dataset.k = k;
    el.innerHTML = `<span class="idx">${k + 1}</span>` + segs.map((sg, j) => `<input data-j="${j}" value="${esc(row[j] ?? '')}" placeholder="${esc(sg.type === 'text' ? (sg.value || sg.name) : sg.type === 'number' ? String(sg.start ?? '') : (sg.start ?? 'A'))}" spellcheck="false" autocomplete="off">`).join('')
      + `<span class="acts"><button class="dup" title="Duplicate row">⧉</button><button class="x" title="Delete row">×</button></span>`;
    el.querySelectorAll('input').forEach(inp => {
      const j = +inp.dataset.j;
      inp.addEventListener('input', () => { row[j] = inp.value; tableSave(); });
      inp.addEventListener('blur', () => { const n = normalizeCell(segs[j], inp.value); if (n !== inp.value) { inp.value = n; row[j] = n; tableSave(); } });
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); if (k === rows.length - 1) { tableAddRow(); } focusCell(k + 1, j); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); focusCell(k + 1, j); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); focusCell(k - 1, j); }
        else if (e.key === 'Backspace' && !inp.value && !row.some(c => c) && rows.length > 1) { e.preventDefault(); tableDeleteRow(k); focusCell(Math.max(0, k - 1), j); }
      });
      inp.addEventListener('paste', (e) => {
        const text = (e.clipboardData || window.clipboardData).getData('text');
        if (!/[\n\t]/.test(text)) return;          // a plain value pastes into the cell as usual
        e.preventDefault();
        const parsed = parseTableText(text, S.pattern.separator);
        if (!parsed.length) return;
        parsed.forEach((cells, r) => {
          const target = k + r;
          while (rows.length <= target) rows.push(segs.map(() => ''));
          cells.forEach((c, cj) => { if (j + cj < segs.length) rows[target][j + cj] = normalizeCell(segs[j + cj], c); });
        });
        renderTable(); tableSave(); focusCell(k + parsed.length - 1, j);
      });
    });
    el.querySelector('.dup').onclick = () => { rows.splice(k + 1, 0, [...row]); renderTable(); tableSave(); focusCell(k + 1, segs.length - 1); };
    el.querySelector('.x').onclick = () => { tableDeleteRow(k); };
    root.appendChild(el);
  });
  renderTableSummary();
}
function focusCell(k, j) { const inp = $('tbl').querySelector(`.tbl-row[data-k="${k}"] input[data-j="${j}"]`); if (inp) { inp.focus(); inp.select(); } }
function tableAddRow(cells) {
  const segs = S.pattern.segments, rows = S.table.rows;
  const last = rows[rows.length - 1];
  // a new row starts from the constant parts of the row above (e.g. "UM") so only the changing cells need typing
  const row = segs.map((sg, j) => cells ? (cells[j] ?? '') : (sg.type === 'text' ? ((last && last[j]) || sg.value || '') : ''));
  rows.push(row); renderTable(); tableSave();
  return rows.length - 1;
}
function tableDeleteRow(k) { S.table.rows.splice(k, 1); renderTable(); tableSave(); }
$('tblAdd').onclick = () => { const k = tableAddRow(); const segs = S.pattern.segments; const j = segs.findIndex(sg => sg.type !== 'text'); focusCell(k, j < 0 ? 0 : j); };
$('tblAddPattern').onclick = () => {
  const sel = patternSeries(S.pattern).values;
  if (!sel.length) { toast('The Pattern has nothing selected.', true); return; }
  const segs = S.pattern.segments;
  for (const v of sel) S.table.rows.push(segs.map(sg => v.fields[sg.name] ?? ''));
  renderTable(); tableSave(); toast(`Added ${sel.length} row${sel.length === 1 ? '' : 's'} from the Pattern.`);
};
$('tblPaste').onclick = async () => {
  let text = '';
  try { text = await navigator.clipboard.readText(); } catch { toast('Clipboard not readable; paste into a cell instead.', true); return; }
  const parsed = parseTableText(text, S.pattern.separator);
  if (!parsed.length) { toast('Nothing to paste.', true); return; }
  const segs = S.pattern.segments;
  for (const cells of parsed) S.table.rows.push(segs.map((sg, j) => normalizeCell(sg, cells[j] ?? '')));
  renderTable(); tableSave(); toast(`Pasted ${parsed.length} row${parsed.length === 1 ? '' : 's'}.`);
};
$('tblClear').onclick = () => { if (!S.table.rows.length) return; S.table.rows = []; renderTable(); tableSave(); };

// dock
$('zoom').value = S.zoom; $('zoomTxt').textContent = `${S.zoom}×`;
$('zoom').addEventListener('input', () => { S.zoom = Number($('zoom').value); $('zoomTxt').textContent = `${S.zoom}×`; saveState(); refreshPreview(); });

// settings
for (const [id, key, evt] of [['optAutoCut', 'autoCut', 'change'], ['optCutEach', 'cutEach'], ['optMarginMm', 'marginMm'], ['optOffset', 'offsetDots'], ['optMirror', 'mirror', 'change'], ['optFlip', 'flip', 'change'],
  ['optCheck', 'check', 'change'], ['optMockTape', 'mockTape', 'change']])
  bindInput(id, () => S.options[key], v => { S.options[key] = v; }, evt || 'input', (id === 'optMarginMm') ? refreshPreview : (id === 'optMockTape') ? pollStatus : () => {});
$('optMock').checked = mock;
$('optMock').addEventListener('change', () => { mock = $('optMock').checked; if (!config.mock) { S.options.mock = mock; saveState(); } pollStatus(); });
$('btnSettings').onclick = () => $('settings').classList.remove('hidden');
$('settingsClose').onclick = () => $('settings').classList.add('hidden');
$('settings').addEventListener('click', (e) => { if (e.target === $('settings')) $('settings').classList.add('hidden'); });
$('btnCheckUpdates').onclick = () => api.checkUpdates();
$('dataDir').textContent = boot.userDir || boot.dir || '';
$('btnShowData').onclick = () => (boot.userDir ? api.openPath(boot.userDir) : library.reveal());
api.onUpdate((u) => {
  const el = $('updateTxt');
  el.textContent = u.state === 'available' ? `Update ${u.version} available${u.manual ? ' (download from GitHub)' : ', downloading…'}`
    : u.state === 'downloading' ? `Downloading update… ${u.percent}%` : u.state === 'downloaded' ? `Update ${u.version} ready. Restart to install.`
    : u.state === 'none' ? 'Up to date.' : u.state === 'error' ? `Update check failed: ${u.message}` : u.state === 'disabled' ? 'Updates are checked in packaged builds only.' : '';
});

// ---------------------------------------------------------------- layouts: library, designer, panel, undo
const histories = new Map();     // layout id -> History, so switching layouts keeps each one's undo
let lastSig = '';
function hist() {
  const key = library.id || '_';
  let h = histories.get(key);
  if (!h) { h = new History(); h.reset(snapshot(library.layout)); histories.set(key, h); }
  return h;
}

const library = new Library(api, {
  onOpen: (L, id, info) => {
    if (info.reason === 'rename' && info.oldId && histories.has(info.oldId)) { histories.set(id, histories.get(info.oldId)); histories.delete(info.oldId); }
    if (info.reason !== 'rename') { designer.cancelDrag(); designer.selectedId = null; }
    if (id && id !== S.layoutId) { S.layoutId = id; saveState(); }
    const had = histories.has(id || '_');
    lastSig = signature(L);
    if (had && (info.reason === 'revert' || info.reason === 'external')) hist().push(snapshot(L));
    else hist();
    hydrateLayout(L).then(() => { if (library.layout === L) { designer.render(); panel.renderProps(); refreshPreview(); } });
    S.designer.manualZoom = S.designer.manualZoom && info.reason === 'boot';
    autoFitZoom(); designer.render(); panel.renderAll(); refreshPreview();
    updatePicker(); updateUndo();
  },
  onList: () => updatePicker(),
  onState: (s) => { const el = $('libState'); el.textContent = s === 'pending' ? 'Saving…' : s === 'error' ? 'Not saved' : 'Saved'; el.className = `lib-state ${s}`; },
  toast,
});

const designer = new Designer({
  canvas: $('dzCanvas'), stage: $('dzStage'),
  getTapeMm: () => S.tapeMm, getLayout: () => library.layout, getSample: sampleValue,
  onSelect: () => { panel.renderProps(); panel.renderList(); },
  onCommit: (kind, key) => commit(kind, key, false),
  onZoom: (z) => { S.designer.zoom = z; S.designer.manualZoom = true; $('dzZoom').value = z; saveState(); },
  onFit: () => fitNow(),
  onEdit: (id) => { designer.select(id); panel.focusMain(); },
});
designer.zoom = S.designer.zoom; designer.snap = S.designer.snap !== false;

const panel = new Panel({
  listEl: $('dzList'), layoutEl: $('dzLayout'), propsEl: $('dzProps'), designer, getLayout: () => library.layout,
  onCommit: (kind, key) => commit(kind, key, true),
  onRename: (name) => { if (name) library.rename(name); else panel.renderLayout(); },
  onPickImage: (el) => pickImage(el),
});

/** An edit happened (canvas, panel, list): record it for undo, save the file, refresh the preview. */
function commit(kind, key = null, fromPanel = false) {
  const L = library.layout, sig = signature(L);
  if (sig !== lastSig) {
    lastSig = sig;
    hist().push(snapshot(L), key);
    library.changed();
    refreshPreview();
    if (kind === 'l:name') updatePicker();
  }
  if (!fromPanel) panel.refresh();
  updateUndo();
}
function restoreSnapshot(s) {
  const L = snapshot(s);                       // a copy, so later edits never change the history entry
  hydrateLayout(L).then(() => { if (library.layout === L) designer.render(); });
  library.replace(L);
  lastSig = signature(L);
  if (designer.selectedId && !L.elements.some(e => e.id === designer.selectedId)) designer.selectedId = null;
  designer.render(); panel.renderAll(); refreshPreview(); updatePicker(); updateUndo();
}
function undo() { const s = hist().undo(); if (s) restoreSnapshot(s); }
function redo() { const s = hist().redo(); if (s) restoreSnapshot(s); }
function updateUndo() { const h = hist(); $('btnUndo').disabled = !h.canUndo; $('btnRedo').disabled = !h.canRedo; }
$('btnUndo').onclick = undo;
$('btnRedo').onclick = redo;

function updatePicker() {
  const sel = $('libSelect'), cur = library.id;
  const opts = library.list.map(l => `<option value="${esc(l.id)}" ${l.error ? 'disabled' : ''} ${l.id === cur ? 'selected' : ''}>${esc(l.id === cur ? library.layout.name : l.name)}${l.error ? ' (unreadable file)' : ''}</option>`);
  if (!cur || !library.list.some(l => l.id === cur)) opts.unshift(`<option value="" selected>${esc(library.layout ? library.layout.name : '—')}</option>`);
  sel.innerHTML = opts.join('');
  sel.title = library.dir ? `Layouts are JSON files in ${library.dir}` : '';
  $('libMenu').querySelector('[data-lib="revert"]').disabled = !library.isPreset;
}
$('libSelect').onchange = () => { const id = $('libSelect').value; if (id) library.open(id); };
$('libNew').onclick = () => libAction('new');
const closeMenu = () => $('libMenu').classList.add('hidden');
$('libMenuBtn').onclick = (e) => { e.stopPropagation(); $('libMenu').classList.toggle('hidden'); };
document.addEventListener('pointerdown', (e) => { if (!e.target.closest('.menu-wrap')) closeMenu(); });
$('libMenu').querySelectorAll('[data-lib]').forEach(b => { b.onclick = () => { closeMenu(); libAction(b.dataset.lib); }; });
async function libAction(a) {
  switch (a) {
    case 'new': if (await library.createNew()) panel.focusName(); break;
    case 'duplicate': if (await library.duplicate()) panel.focusName(); break;
    case 'rename': panel.focusName(); break;
    case 'revert': await library.revert(); break;
    case 'import': await library.importFiles(); break;
    case 'export': await library.exportCurrent(); break;
    case 'folder': await library.reveal(); break;
    case 'restore': await library.restoreBuiltins(); break;
    case 'delete': await library.remove(); break;
  }
}

// designer toolbar
document.querySelectorAll('[data-add]').forEach(b => {
  b.onclick = async () => {
    if (b.dataset.add !== 'image') { designer.add(b.dataset.add); return; }
    const r = await choosePhoto();
    if (r) designer.add('image', r);
  };
});
function choosePhoto() {
  return new Promise((resolve) => {
    const inp = $('dzImageFile');
    inp.value = '';
    inp.onchange = async () => { const f = inp.files[0]; inp.value = ''; if (!f) return resolve(null); try { resolve(await readImageFile(f)); } catch (e) { toast(e.message, true); resolve(null); } };
    inp.oncancel = () => resolve(null);
    inp.click();
  });
}
async function pickImage(el) {
  const r = await choosePhoto();
  if (!r) return;
  el.src = r.src; el._img = r.img;
  designer.render(); commit('photo');
}
$('dzSnap').checked = designer.snap;
$('dzSnap').addEventListener('change', () => { designer.snap = S.designer.snap = $('dzSnap').checked; saveState(); });
$('dzZoom').value = S.designer.zoom;
$('dzZoom').addEventListener('input', () => { designer.setZoom(Number($('dzZoom').value)); S.designer.zoom = designer.zoom; S.designer.manualZoom = true; saveState(); });
$('dzFit').onclick = () => fitNow();
/** Show the whole label in the designer (until the zoom slider is moved). */
function autoFitZoom() {
  if (S.designer.manualZoom) return;
  const z = designer.fitZoom();
  if (z !== designer.zoom) { designer.zoom = z; $('dzZoom').value = z; }
}
function fitNow() { S.designer.manualZoom = false; saveState(); autoFitZoom(); designer.redraw(); }
const fl = document.createElement('datalist'); fl.id = 'fontList'; FONTS.forEach(f => { const o = document.createElement('option'); o.value = f; fl.appendChild(o); }); document.body.appendChild(fl);
window.addEventListener('resize', debounce(() => { autoFitZoom(); designer.redraw(); }, 150));

// keyboard: the designer gets keys after a click in the layout card, unless a field has focus
let designerActive = false;
document.addEventListener('pointerdown', (e) => { designerActive = !!e.target.closest('#cardLayout'); }, true);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('libMenu').classList.contains('hidden')) { closeMenu(); return; }
  if (!$('theater').classList.contains('hidden') || !$('settings').classList.contains('hidden')) return;
  if (e.target.closest && e.target.closest('input, textarea, select, [contenteditable]')) return;
  if (designerActive && designer.key(e)) e.preventDefault();
});
const isTextField = (t) => t && (t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && !['checkbox', 'radio', 'range', 'button', 'file'].includes(t.type)));
api.onMenu((cmd) => {
  if (cmd === 'undo' || cmd === 'redo') {
    if (isTextField(document.activeElement)) api.nativeEdit(cmd);     // typing in a field: undo the typing
    else if (cmd === 'undo') undo(); else redo();
    return;
  }
  if (cmd === 'print') doPrint();
  else if (cmd === 'layout-new') libAction('new');
  else if (cmd === 'layout-duplicate') libAction('duplicate');
  else if (cmd === 'layout-import') libAction('import');
  else if (cmd === 'layout-export') libAction('export');
});

// drop a photo on the label, a layout .json to import it, or a CSV/TXT list to print from
document.addEventListener('dragover', (e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; $('dzStage').classList.toggle('drop', !!(e.target.closest && e.target.closest('#dzStage'))); });
document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) $('dzStage').classList.remove('drop'); });
document.addEventListener('drop', async (e) => {
  e.preventDefault();
  $('dzStage').classList.remove('drop');
  const onStage = !!(e.target.closest && e.target.closest('#dzStage'));
  for (const f of [...((e.dataTransfer && e.dataTransfer.files) || [])]) {
    try {
      if (/\.json$/i.test(f.name)) await library.importText(await f.text(), f.name);
      else if (/^image\//.test(f.type)) { const r = await readImageFile(f); designer.add('image', { ...r, slot: onStage ? designer.slotAt(e.clientX) : null }); }
      else if (/\.(csv|tsv|txt)$/i.test(f.name)) { await loadList(f); toast(`Loaded ${f.name} into the List.`); }
      else toast(`${f.name}: drop a photo, a CSV/TXT list or a layout .json file.`, true);
    } catch (err) { toast(`${f.name}: ${err.message}`, true); }
  }
});

// pick up layout files edited, added or removed outside the app; save everything before the window goes away
window.addEventListener('focus', () => { library.refreshFromDisk(); });
window.addEventListener('beforeunload', () => {
  const payload = {};
  if (settingsDirty) payload.settings = S;
  const lay = library.pendingSync();
  if (lay) payload.layout = lay;
  if (payload.settings || payload.layout) { try { api.flushSync(payload); } catch {} }
});

/** First run of 0.2: named layouts saved by 0.1 (localStorage) become layout files. */
async function migrateOldTemplates() {
  let t;
  try { t = JSON.parse(localStorage.getItem('tapedeck.templates') || 'null'); } catch { t = null; }
  if (!t || typeof t !== 'object') return;
  let n = 0;
  for (const [name, j] of Object.entries(t)) {
    try { const L = fromFile(j); delete L._warnings; L.name = library.uniqueName(name); await api.layouts.create(L.name, toFileText(L)); n++; }
    catch (e) { console.warn('could not migrate layout', name, e); }
  }
  if (n) { await library.refreshList(); toast(`Moved ${n} saved layout${n === 1 ? '' : 's'} into the layouts folder.`); }
}

// ---------------------------------------------------------------- boot
library.init(boot);
$('verTxt').textContent = `TapeDeck ${config.version}${config.packaged ? '' : ' (dev)'}`;
updateTapeInfo(); setMode(S.mode); afterPatternChange();
pollStatus(); setInterval(pollStatus, 8000);
if (firstRun) { saveState(); migrateOldTemplates(); }
if (config.test) window.__tapedeck = { designer, panel, library, S, hist };   // automated UI tests only
