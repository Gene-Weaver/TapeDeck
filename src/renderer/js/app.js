import { tape, mmToDots, dotsToMm, FEED_MM_PER_S } from './tape.js';
import { batchValues, patternSeries, defaultPattern } from './pattern.js';
import { renderLabel, measureLabelWidth, canvasToPng, hydrateLayout, serializeLayout, wrapLayout, plainLayout, FONTS } from './render.js';
import { Designer } from './designer.js';
import { PrintTheater } from './printer-anim.js';
import { api, canvasToPixels } from './api.js';

const $ = (id) => document.getElementById(id);
const CSS_PER_DOT = 96 / 180;            // zoom 1 = real size on a 96 dpi screen
const STATE_KEY = 'tapedeck.state.v2', LAYOUT_KEY = 'tapedeck.layout.v4', TPL_KEY = 'tapedeck.templates';

// ---------------------------------------------------------------- state
const DEFAULTS = {
  tapeMm: 6, mode: 'pattern', zoom: 1.5, wrap: true,
  pattern: defaultPattern(),
  single: { text: 'Hello tape', copies: 1 },
  batch: { text: '', header: false, tpl: '' },
  options: { autoCut: true, cutEach: 1, marginMm: 2, mirror: false, flip: false, check: true, mock: false, mockTape: 6, offsetDots: 2 },
  designer: { zoom: 6 },
};
let S = loadState();
if (S.patternVersion !== 2) { S.pattern = defaultPattern(); S.patternVersion = 2; }   // 2026-10-02: Number before Letter (flag is never in DEFAULTS, so a merge can't fake it)
let layout = loadLayout();
let config = { mock: false, version: '' };
let values = [], widths = [], seriesTotal = 0, previewToken = 0;

function loadState() {
  try { const j = JSON.parse(localStorage.getItem(STATE_KEY) || 'null'); if (j) return deepMerge(structuredClone(DEFAULTS), j); } catch {}
  return structuredClone(DEFAULTS);
}
function deepMerge(a, b) { for (const k in b) { if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k])) a[k] = deepMerge(a[k] || {}, b[k]); else a[k] = b[k]; } return a; }
function saveState() { try { localStorage.setItem(STATE_KEY, JSON.stringify(S)); } catch {} }
function loadLayout() {
  try { const j = JSON.parse(localStorage.getItem(LAYOUT_KEY) || 'null'); if (j && j.elements) return j; } catch {}
  return null;   // built after the first series is known (needs the longest text to size the boxes)
}
function saveLayout() { try { localStorage.setItem(LAYOUT_KEY, serializeLayout(layout)); } catch {} }
function templates() { try { return JSON.parse(localStorage.getItem(TPL_KEY) || '{}'); } catch { return {}; } }
function saveTemplates(t) { localStorage.setItem(TPL_KEY, JSON.stringify(t)); }

// ---------------------------------------------------------------- helpers
let toastTimer;
function toast(msg, err = false, ms = 3500) {
  const t = $('toast'); t.textContent = msg; t.classList.toggle('err', err); t.classList.remove('hidden');
  clearTimeout(toastTimer); if (ms) toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
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
const longest = (arr) => arr.reduce((m, v) => (v.text.length > m.length ? v.text : m), '');

// ---------------------------------------------------------------- label values
function computeValues() {
  if (S.mode === 'single') {
    const n = Math.max(1, Math.min(999, Number(S.single.copies) || 1));
    seriesTotal = n;
    return Array.from({ length: n }, (_, i) => ({ text: S.single.text, n: i + 1, i: i + 1, fields: {} }));
  }
  if (S.mode === 'pattern') { const r = patternSeries(S.pattern); seriesTotal = r.total; return r.values; }
  const v = batchValues({ text: S.batch.text, header: S.batch.header, template: S.batch.tpl }); seriesTotal = v.length; return v;
}
function sampleValue() { return values[0] || { text: 'UM-001-A', n: 1, i: 1, fields: {} }; }

// ---------------------------------------------------------------- tape preview strip
const strip = $('strip');
const io = new IntersectionObserver((entries) => { for (const e of entries) { if (e.isIntersecting) paintLab(e.target); else unpaintLab(e.target); } },
  { root: $('dock').querySelector('.strip-wrap'), rootMargin: '0px 600px 0px 600px' });
function paintLab(el) {
  if (el.dataset.token !== String(previewToken) || el._painted) return;
  const res = renderLabel(layout, values[+el.dataset.i], S.tapeMm);
  const c = el.querySelector('canvas.tape'); if (!c) return;
  c.width = res.width; c.height = res.height; c.getContext('2d').drawImage(res.canvas, 0, 0);
  c.classList.remove('pending'); el._painted = true;
}
function unpaintLab(el) { const c = el.querySelector('canvas.tape'); if (!c || !el._painted) return; c.width = 1; c.height = 1; c.classList.add('pending'); el._painted = false; }

const refreshPreview = debounce(async () => {
  const token = ++previewToken;
  values = computeValues();
  fitDesignerZoom(); designer.render();
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
  const secs = Math.round(dotsToMm(total) / FEED_MM_PER_S + values.length * 1.2);
  const range = S.mode === 'pattern' && seriesTotal > values.length ? ` (labels ${S.pattern.from}–${S.pattern.to} of ${seriesTotal})` : '';
  stats.textContent = values.length ? `${values.length} label${values.length === 1 ? '' : 's'}${range} · ${t.label} tape · ${fmtLen(total)} of tape (+ one blank lead piece per job) · ≈ ${secs >= 60 ? `${Math.floor(secs / 60)} min ${secs % 60} s` : `${secs} s`}` : 'No labels yet';
  $('btnPrint').textContent = values.length ? `Print ${values.length} label${values.length === 1 ? '' : 's'}` : 'Print';
  $('btnPrint').disabled = !values.length; $('btnExport').disabled = !values.length;
}, 120);

// ---------------------------------------------------------------- output
async function renderAllForOutput() {
  const out = new Array(values.length);
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
    flip: o.flip, checkMedia: o.check, mock: o.mock, mockTape: Number(o.mockTape) || 6, offsetDots: Number(o.offsetDots) || 0 };
}
const theater = new PrintTheater($('theater'));
let currentJob = null;
async function doPrint() {
  if (!values.length || currentJob) return;
  const labels = await renderAllForOutput();
  const t = tape(S.tapeMm);
  theater.open({ labels, tapeMm: S.tapeMm, tapeLabel: t.label, onCancel: async () => { if (currentJob) await api.cancel(currentJob); } });
  let job;
  try { job = await api.print(printBody(labels)); }
  catch (e) { theater.update({ state: 'error', error: (e.message || String(e)).replace(/^Error invoking remote method '[^']+': Error: /, ''), printed: 0, index: 0, phase: '' }); return; }
  currentJob = job.id; theater.update(job, { chain: false });
}
api.onJobProgress((j) => { if (j.id === currentJob) { theater.update(j, { chain: false }); if (j.state !== 'printing' && j.state !== 'queued') currentJob = null; } });
$('thClose').onclick = () => theater.close();
$('btnPrint').onclick = doPrint;
$('btnExport').onclick = async () => {
  if (!values.length) return;
  const labels = await renderAllForOutput();
  const j = await api.exportPngs({ labels: labels.map(l => ({ png: canvasToPng(l.canvas), name: l.name })), suggestedName: S.mode === 'single' ? 'label' : S.mode });
  if (j.ok) { toast(`Saved ${j.count} PNGs to ${j.dir}`, false, 6000); api.openPath(j.dir); } else if (!j.cancelled) toast(j.error || 'Export failed', true);
};
async function doFeedCut(btn) {
  const o = S.options; if (btn) btn.disabled = true;
  try { await api.feedAndCut({ tapeMm: S.tapeMm, mock: o.mock, mockTape: Number(o.mockTape) || 6 }); toast('Fed and cut.'); }
  catch (e) { toast((e.message || String(e)).replace(/^Error invoking remote method '[^']+': Error: /, ''), true, 6000); }
  finally { if (btn) btn.disabled = false; }
}
$('btnFeedCut').onclick = () => doFeedCut($('btnFeedCut'));
$('thFeedCut').onclick = () => doFeedCut($('thFeedCut'));

// ---------------------------------------------------------------- printer status
async function pollStatus() {
  const pill = $('printerPill'), txt = pill.querySelector('.txt');
  try {
    const j = await api.status({ mock: S.options.mock, mockTape: Number(S.options.mockTape) || 6 });
    pill.classList.remove('pill-on', 'pill-off', 'pill-mock');
    if (j.connected) {
      const st = j.status; pill.classList.add(j.mock ? 'pill-mock' : 'pill-on');
      if (!st) { txt.textContent = j.busy ? 'Printing…' : 'Connected'; return; }
      txt.textContent = `${j.mock ? 'Mock printer' : 'PT-P700'} · ${st.hasMedia ? `${st.mediaWidthMm} mm ${st.mediaType.toLowerCase()}` : 'no tape'}${st.errors.length ? ' · ' + st.errors.join(', ') : ''}${j.busy ? ' · printing' : ''}`;
      if (st.hasMedia && st.mediaWidthMm !== S.tapeMm) txt.textContent += `  (app set to ${tape(S.tapeMm).label})`;
    } else { pill.classList.add('pill-off'); txt.textContent = j.error || 'Printer not found'; }
    pill.title = j.error || JSON.stringify(j.status || {}, null, 1);
  } catch (e) { pill.classList.add('pill-off'); pill.querySelector('.txt').textContent = `Bridge error: ${e.message}`; }
}

// ---------------------------------------------------------------- inputs
function bindInput(id, get, set, evt = 'input', after) {
  const el = $(id);
  if (el.type === 'checkbox') el.checked = !!get(); else el.value = get() ?? '';
  el.addEventListener(evt, () => { set(el.type === 'checkbox' ? el.checked : el.type === 'number' ? (el.value === '' ? '' : Number(el.value)) : el.value); saveState(); after ? after() : refreshPreview(); });
}
// tape
$('tapeMm').value = S.tapeMm;
$('tapeMm').addEventListener('change', () => { S.tapeMm = Number($('tapeMm').value); saveState(); updateTapeInfo(); fitLayoutToTape(); refreshPreview(); designer.renderProps(); pollStatus(); });
function updateTapeInfo() { const t = tape(S.tapeMm); $('tapeInfo').textContent = `${t.pins} dots · ${(t.pins / (180 / 25.4)).toFixed(1)} mm printable`; }
function fitLayoutToTape() {   // keep full-height lines/boxes full height when the tape changes
  const t = tape(S.tapeMm);
  for (const el of layout.elements) if ((el.type === 'line' || el.type === 'rect') && el.vCenter && el.h >= (el._tapePins || t.pins) - 2) el.h = t.pins;
  layout.elements.forEach(el => { el._tapePins = t.pins; });
  saveLayout();
}
// mode
$('modeSeg').querySelectorAll('button').forEach(b => b.onclick = () => setMode(b.dataset.mode));
function setMode(m) {
  S.mode = m; saveState();
  $('modeSeg').querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.mode === m));
  for (const k of ['pattern', 'single', 'batch']) $(`mode-${k}`).classList.toggle('hidden', k !== m);
  renderTokenHint(); refreshPreview();
}
function renderTokenHint() {
  let toks = [];
  if (S.mode === 'pattern') toks = S.pattern.segments.map(sg => `{${sg.name}}`);
  else if (S.mode === 'batch') { const v = batchValues({ text: S.batch.text, header: S.batch.header }); if (v[0]) toks = Object.keys(v[0].fields).map(k => `{${k}}`); }
  $('dzTokens').innerHTML = toks.map(t => `<code>${esc(t)}</code>`).join(' ');
  $('tokenHint').textContent = S.mode === 'pattern' ? 'Each segment is also available in the layout as a token, e.g. {Item}. The last segment cycles fastest.' : S.mode === 'batch' ? 'Columns are available in the layout as tokens.' : '';
}
// single
bindInput('singleText', () => S.single.text, v => S.single.text = v);
bindInput('singleCopies', () => S.single.copies, v => S.single.copies = v);
// batch
bindInput('batchText', () => S.batch.text, v => S.batch.text = v, 'input', () => { renderBatchSample(); renderTokenHint(); refreshPreview(); });
bindInput('batchHeader', () => S.batch.header, v => S.batch.header = v, 'change', () => { renderBatchSample(); renderTokenHint(); refreshPreview(); });
bindInput('batchTpl', () => S.batch.tpl, v => S.batch.tpl = v, 'input', () => { renderBatchSample(); refreshPreview(); });
$('btnBatchFile').onclick = () => $('batchFile').click();
$('batchFile').onchange = async () => { const f = $('batchFile').files[0]; if (!f) return; S.batch.text = await f.text(); $('batchText').value = S.batch.text; $('batchFile').value = ''; saveState(); renderBatchSample(); renderTokenHint(); refreshPreview(); };
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
      : sg.type === 'letters' ? `<input data-k="start" value="${esc(sg.start ?? 'AA')}" placeholder="AA" style="width:4.5em"><span class="muted">→</span><input data-k="end" value="${esc(sg.end ?? 'BZ')}" placeholder="BZ" style="width:4.5em">`
      : `<input data-k="start" type="number" value="${sg.start ?? 1}" style="width:4em"><span class="muted">→</span><input data-k="end" type="number" value="${sg.end ?? 3}" style="width:4em"><input data-k="pad" type="number" class="pad" min="0" max="9" value="${sg.pad ?? 2}" title="zero-pad to this many digits">`;
    row.innerHTML = `<input data-k="name" value="${esc(sg.name ?? '')}" placeholder="name">
      <select data-k="type"><option value="text" ${sg.type === 'text' ? 'selected' : ''}>Text</option><option value="letters" ${sg.type === 'letters' ? 'selected' : ''}>Letters</option><option value="number" ${sg.type === 'number' ? 'selected' : ''}>Numbers</option></select>
      <div class="vals">${vals}</div><button class="x" title="Remove segment">×</button>`;
    row.querySelectorAll('[data-k]').forEach(inp => {
      const h = () => {
        const key = inp.dataset.k; let v = inp.value;
        if (inp.type === 'number') v = v === '' ? '' : Number(v);
        if (key === 'type' && v !== sg.type) { sg.type = v; if (v === 'letters') { sg.start = sg.start && isNaN(sg.start) ? sg.start : 'AA'; sg.end = sg.end && isNaN(sg.end) ? sg.end : 'BZ'; } if (v === 'number') { sg.start = Number(sg.start) || 1; sg.end = Number(sg.end) || 3; sg.pad = sg.pad ?? 2; } renderSegments(); }
        else sg[key] = v;
        if (key === 'start' || key === 'end') { if (sg.type === 'letters') sg[key] = String(v).toUpperCase(); }
        saveState(); afterPatternChange();
      };
      inp.addEventListener(inp.tagName === 'SELECT' ? 'change' : 'input', h);
    });
    row.querySelector('.x').onclick = () => { S.pattern.segments.splice(k, 1); saveState(); renderSegments(); afterPatternChange(); };
    root.appendChild(row);
  });
}
function afterPatternChange() {
  const r = patternSeries({ ...S.pattern, from: 1, to: undefined });
  const total = r.total;
  if (!S.pattern.to || S.pattern.to > total) S.pattern.to = Math.min(total, Math.max(1, S.pattern.to || 3));
  if (S.pattern.from > total) S.pattern.from = 1;
  $('patFrom').value = S.pattern.from; $('patTo').value = S.pattern.to; $('patOf').textContent = `of ${total}`;
  const first = r.values[0]?.text ?? '', last = r.values[total - 1]?.text ?? '';
  const sel = patternSeries(S.pattern).values;
  $('patSummary').textContent = total ? `${total} labels in the series: ${first} … ${last}\nSelected ${sel.length}: ${sel.slice(0, 4).map(v => v.text).join(', ')}${sel.length > 4 ? ' …' : ''}` : 'Add a segment to build a series.';
  renderTokenHint(); refreshPreview();
}
$('segAdd').onclick = () => { S.pattern.segments.push({ name: `Part${S.pattern.segments.length + 1}`, type: 'number', start: 1, end: 9, pad: 0 }); saveState(); renderSegments(); afterPatternChange(); };
bindInput('patSep', () => S.pattern.separator, v => S.pattern.separator = v, 'input', afterPatternChange);
bindInput('patFrom', () => S.pattern.from, v => S.pattern.from = Math.max(1, Number(v) || 1), 'input', afterPatternChange);
bindInput('patTo', () => S.pattern.to, v => S.pattern.to = Math.max(1, Number(v) || 1), 'input', afterPatternChange);
$('patAll').onclick = () => { S.pattern.from = 1; S.pattern.to = patternSeries({ ...S.pattern, from: 1, to: undefined }).total; saveState(); afterPatternChange(); };
renderSegments();

// dock
$('zoom').value = S.zoom; $('zoomTxt').textContent = `${S.zoom}×`;
$('zoom').addEventListener('input', () => { S.zoom = Number($('zoom').value); $('zoomTxt').textContent = `${S.zoom}×`; saveState(); refreshPreview(); });

// settings
for (const [id, key, evt] of [['optAutoCut', 'autoCut', 'change'], ['optCutEach', 'cutEach'], ['optMarginMm', 'marginMm'], ['optOffset', 'offsetDots'], ['optMirror', 'mirror', 'change'], ['optFlip', 'flip', 'change'],
  ['optCheck', 'check', 'change'], ['optMock', 'mock', 'change'], ['optMockTape', 'mockTape', 'change']])
  bindInput(id, () => S.options[key], v => S.options[key] = v, evt || 'input', (id === 'optMarginMm') ? refreshPreview : (id === 'optMock' || id === 'optMockTape') ? pollStatus : () => {});
$('btnSettings').onclick = () => $('settings').classList.remove('hidden');
$('settingsClose').onclick = () => $('settings').classList.add('hidden');
$('settings').addEventListener('click', (e) => { if (e.target === $('settings')) $('settings').classList.add('hidden'); });
$('btnCheckUpdates').onclick = () => api.checkUpdates();
api.onUpdate((u) => {
  const el = $('updateTxt');
  el.textContent = u.state === 'available' ? `Update ${u.version} available${u.manual ? ' (download from GitHub)' : ', downloading…'}`
    : u.state === 'downloading' ? `Downloading update… ${u.percent}%` : u.state === 'downloaded' ? `Update ${u.version} ready. Restart to install.`
    : u.state === 'none' ? 'Up to date.' : u.state === 'error' ? `Update check failed: ${u.message}` : u.state === 'disabled' ? 'Updates are checked in packaged builds only.' : '';
});
api.onMenu((cmd) => { if (cmd === 'print') doPrint(); });

// ---------------------------------------------------------------- designer
const designer = new Designer({
  canvas: $('dzCanvas'), propsEl: $('dzProps'), imageInput: $('dzImageFile'),
  getTapeMm: () => S.tapeMm, getLayout: () => layout, getSample: sampleValue,
  onChange: () => { saveLayout(); refreshPreview(); },
});
designer.zoom = S.designer.zoom; $('dzZoom').value = S.designer.zoom;
$('dzZoom').addEventListener('input', () => { designer.zoom = S.designer.zoom = Number($('dzZoom').value); S.designer.manualZoom = true; saveState(); designer.render(); });
/** Pick a zoom that shows the whole label in the stage (until the user moves the slider). */
function fitDesignerZoom() {
  if (S.designer.manualZoom) return;
  const w = measureLabelWidth(layout, sampleValue(), S.tapeMm);
  const avail = Math.max(200, $('dzStage').clientWidth - 48 - 60);
  const z = Math.max(1, Math.min(12, Math.floor((avail / Math.max(1, w)) * 2) / 2));
  if (z !== designer.zoom) { designer.zoom = S.designer.zoom = z; $('dzZoom').value = z; }
}
$('dzStage').addEventListener('dblclick', () => { S.designer.manualZoom = false; fitDesignerZoom(); designer.render(); });
document.querySelectorAll('[data-add]').forEach(b => b.onclick = () => designer.add(b.dataset.add));
const fl = document.createElement('datalist'); fl.id = 'fontList'; FONTS.forEach(f => { const o = document.createElement('option'); o.value = f; fl.appendChild(o); }); document.body.appendChild(fl);
function refreshTplList() { const sel = $('tplList'); sel.innerHTML = '<option value="">Layouts…</option>' + Object.keys(templates()).sort().map(n => `<option>${esc(n)}</option>`).join(''); }
refreshTplList();
async function useLayout(l, name) { layout = l; await hydrateLayout(layout); $('tplName').value = name ?? (layout.name || ''); designer.selectedId = null; fitLayoutToTape(); designer.render(); designer.renderProps(); saveLayout(); refreshPreview(); }
$('tplSave').onclick = () => { const name = $('tplName').value.trim() || layout.name || 'Untitled'; const t = templates(); layout.name = name; t[name] = JSON.parse(serializeLayout(layout)); saveTemplates(t); refreshTplList(); $('tplList').value = name; toast(`Saved layout “${name}”`); };
$('tplList').onchange = () => { const name = $('tplList').value; const t = templates(); if (name && t[name]) useLayout(structuredClone(t[name]), name); };
$('tplDelete').onclick = () => { const name = $('tplList').value; if (!name) return; const t = templates(); delete t[name]; saveTemplates(t); refreshTplList(); toast(`Deleted “${name}”`); };
$('tplExport').onclick = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([serializeLayout(layout)], { type: 'application/json' })); a.download = `${(layout.name || 'layout').replace(/[^\w-]+/g, '_')}.tapedeck.json`; a.click(); };
$('tplImport').onclick = () => $('tplImportFile').click();
$('tplImportFile').onchange = async () => { const f = $('tplImportFile').files[0]; $('tplImportFile').value = ''; if (!f) return; try { const j = JSON.parse(await f.text()); if (!j.elements) throw new Error('not a layout'); await useLayout(j); toast('Layout imported'); } catch (e) { toast(`Import failed: ${e.message}`, true); } };
function builtLayout() { values = computeValues(); return S.wrap ? wrapLayout(S.tapeMm, longest(values) || 'UM-052-C') : plainLayout(S.tapeMm); }
$('tplReset').onclick = () => { S.designer.manualZoom = false; useLayout(builtLayout(), ''); };
$('optWrap').checked = S.wrap;
$('optWrap').addEventListener('change', () => { S.wrap = $('optWrap').checked; saveState(); S.designer.manualZoom = false; useLayout(builtLayout(), ''); });

// ---------------------------------------------------------------- boot
(async () => {
  try { config = await api.config(); if (config.mock) { S.options.mock = true; $('optMock').checked = true; } $('verTxt').textContent = `TapeDeck ${config.version}${config.packaged ? '' : ' (dev)'}`; } catch (e) { toast(`Startup error: ${e.message}`, true, 0); }
  values = computeValues();
  if (!layout) layout = S.wrap ? wrapLayout(S.tapeMm, longest(patternSeries({ ...S.pattern, from: 1, to: undefined }).values) || 'UM-052-C') : plainLayout(S.tapeMm);
  await hydrateLayout(layout); saveLayout();
  $('tplName').value = layout.name || '';
  updateTapeInfo(); setMode(S.mode); afterPatternChange();
  fitDesignerZoom(); designer.render(); designer.renderProps();
  pollStatus(); setInterval(pollStatus, 8000);
  document.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'p') { e.preventDefault(); doPrint(); } });
})();
