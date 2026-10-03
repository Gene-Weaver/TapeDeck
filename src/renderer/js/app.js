import { tape, mmToDots, dotsToMm, FEED_MM_PER_S } from './tape.js';
import { counterValues, templateValues, batchValues } from './pattern.js';
import { renderLabel, measureLabelWidth, simpleTextLayout, canvasToPng, hydrateLayout, serializeLayout, FONTS } from './render.js';
import { Designer } from './designer.js';
import { PrintTheater } from './printer-anim.js';
import { api, canvasToPixels } from './api.js';

const $ = (id) => document.getElementById(id);
const CSS_PER_DOT = 96 / 180;            // zoom 1 = real size on a 96 dpi screen
const LEADER_MM = 24.5;                  // head-to-cutter distance: blank tape at the start of every job

// ---------------------------------------------------------------- state
const DEFAULTS = {
  tapeMm: 6, tab: 'single', dataMode: 'single', useDesigner: false, zoom: 1.5,
  single: { text: 'Hello tape', copies: 1 },
  pattern: { kind: 'counter', prefix: 'LEAF-', suffix: '', start: 1, end: 20, step: 1, pad: 4, tpl: 'LEAF-{n:06}', tStart: 1, tCount: 20, tStep: 1 },
  batch: { text: '', header: false, tpl: '' },
  style: { font: 'Helvetica', bold: false, italic: false, invert: false, auto: true, size: 22, align: 'center', border: false, lenMode: 'auto', lenMm: 30, padMm: 1 },
  options: { autoCut: true, cutEach: 1, marginMm: 2, mirror: false, flip: false, check: true, sound: false, mock: false, mockTape: 6, leader: 'chain' },
  designer: { sampleText: 'LEAF-000042', sampleN: 42, zoom: 6 },
};
let S = loadState();
let layout = loadLayout();
let config = { mock: false, version: '' };
let values = [];
let widths = [];
let previewToken = 0;

function loadState() {
  try { const j = JSON.parse(localStorage.getItem('tapedeck.state') || 'null'); if (j) return deepMerge(structuredClone(DEFAULTS), j); } catch {}
  return structuredClone(DEFAULTS);
}
function deepMerge(a, b) { for (const k in b) { if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k])) a[k] = deepMerge(a[k] || {}, b[k]); else a[k] = b[k]; } return a; }
function saveState() { try { localStorage.setItem('tapedeck.state', JSON.stringify(S)); } catch {} }
function loadLayout() {
  try { const j = JSON.parse(localStorage.getItem('tapedeck.layout') || 'null'); if (j && j.elements) return j; } catch {}
  const l = simpleTextLayout({ tapeMm: S.tapeMm }); l.name = 'My layout'; Object.assign(l.elements[0], { hCenter: false, x: 6, align: 'left' }); return l;
}
function saveLayout() { try { localStorage.setItem('tapedeck.layout', serializeLayout(layout)); } catch {} }
function templates() { try { return JSON.parse(localStorage.getItem('tapedeck.templates') || '{}'); } catch { return {}; } }
function saveTemplates(t) { localStorage.setItem('tapedeck.templates', JSON.stringify(t)); }

// ---------------------------------------------------------------- helpers
let toastTimer;
function toast(msg, err = false, ms = 3500) {
  const t = $('toast'); t.textContent = msg; t.classList.toggle('err', err); t.classList.remove('hidden');
  clearTimeout(toastTimer); if (ms) toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}
const debounce = (fn, ms) => { let h; return (...a) => { clearTimeout(h); h = setTimeout(() => fn(...a), ms); }; };
const fmtLen = (dots) => { const mm = dotsToMm(dots); return mm >= 1000 ? `${(mm / 1000).toFixed(2)} m` : mm >= 100 ? `${(mm / 10).toFixed(1)} cm` : `${mm.toFixed(1)} mm`; };
async function chunked(n, fn, { perChunk = 150, onProgress } = {}) {
  for (let i = 0; i < n; i += perChunk) {
    const end = Math.min(n, i + perChunk);
    for (let k = i; k < end; k++) fn(k);
    onProgress?.(end, n);
    if (end < n) await new Promise(r => requestAnimationFrame(r));
  }
}

// ---------------------------------------------------------------- data + layout
function currentValues() {
  if (S.dataMode === 'single') {
    const n = Math.max(1, Math.min(999, Number(S.single.copies) || 1));
    return Array.from({ length: n }, (_, i) => ({ text: S.single.text, n: i + 1, i: i + 1, fields: {} }));
  }
  if (S.dataMode === 'pattern') {
    const p = S.pattern;
    return p.kind === 'template' ? templateValues({ template: p.tpl, start: p.tStart, count: p.tCount, step: p.tStep })
      : counterValues({ prefix: p.prefix, suffix: p.suffix, start: p.start, end: p.end, step: p.step, padWidth: p.pad });
  }
  return batchValues({ text: S.batch.text, header: S.batch.header, template: S.batch.tpl });
}
function usingDesigner() { return S.tab === 'designer' || S.useDesigner; }
function simpleLayout() {
  const st = S.style;
  const l = simpleTextLayout({ tapeMm: S.tapeMm, font: st.font, bold: st.bold, autoSize: st.auto, size: st.size, border: st.border,
    lengthMode: st.lenMode, lengthDots: mmToDots(st.lenMm), padding: mmToDots(st.padMm) });
  const el = l.elements[0]; el.italic = st.italic; el.invert = st.invert; el.align = st.align;
  return l;
}
function currentLayout() { return usingDesigner() ? layout : simpleLayout(); }

// ---------------------------------------------------------------- tape preview strip
const strip = $('strip');
const io = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const el = e.target;
    if (e.isIntersecting) paintLab(el); else unpaintLab(el);
  }
}, { root: $('dock').querySelector('.strip-wrap'), rootMargin: '0px 600px 0px 600px' });

function paintLab(el) {
  if (el.dataset.token !== String(previewToken)) return;
  const i = +el.dataset.i; if (el._painted) return;
  const res = renderLabel(currentLayout(), values[i], S.tapeMm);
  const c = el.querySelector('canvas.tape'); if (!c) return;
  c.width = res.width; c.height = res.height;
  c.getContext('2d').drawImage(res.canvas, 0, 0);
  c.classList.remove('pending'); el._painted = true;
}
function unpaintLab(el) {
  const c = el.querySelector('canvas.tape'); if (!c || !el._painted) return;
  c.width = 1; c.height = 1; c.classList.add('pending'); el._painted = false;
}

const refreshPreview = debounce(async () => {
  const token = ++previewToken;
  values = currentValues();
  const L = currentLayout(), t = tape(S.tapeMm), cpd = CSS_PER_DOT * S.zoom, marginDots = mmToDots(S.options.marginMm);
  const stats = $('previewStats');
  stats.textContent = values.length ? `Measuring ${values.length} labels…` : 'No labels yet';
  widths = new Array(values.length);
  await chunked(values.length, (k) => { widths[k] = measureLabelWidth(L, values[k], S.tapeMm); }, { perChunk: 200,
    onProgress: (d, n) => { if (n > 400) stats.textContent = `Measuring ${d} / ${n}…`; } });
  if (token !== previewToken) return;
  io.disconnect();
  strip.innerHTML = '';
  const H = t.pins, hCss = H * cpd;
  const frag = document.createDocumentFragment();
  let total = 0;
  const leader = S.options.leader || 'chain', leaderDots = mmToDots(LEADER_MM);
  if (values.length && leader !== 'chain') {
    const chip = leaderDots + 2 * marginDots; total += chip;
    const el = document.createElement('div'); el.className = 'lab waste'; el.style.width = `${chip * cpd}px`;
    el.innerHTML = `<div class="tape" style="height:${hCss}px;width:${chip * cpd}px;opacity:.55"></div><div class="cut" style="height:${hCss + 28}px"></div><div class="cap" title="The PT-P700 always cuts its blank leader off before the first label of a job. Use Chain mode in settings to avoid it.">leader chip (printer) · ${fmtLen(chip)}</div>`;
    frag.appendChild(el);
  }
  const MAX_DOM = 3000;
  const shown = Math.min(values.length, MAX_DOM);
  for (let i = 0; i < shown; i++) {
    const W = widths[i], lead = 0, phys = W + 2 * marginDots;
    total += phys;
    const lab = document.createElement('div'); lab.className = 'lab'; lab.dataset.i = i; lab.dataset.token = token;
    lab.style.width = `${phys * cpd}px`;
    const row = document.createElement('div'); row.style.cssText = `display:flex;height:${hCss}px;align-items:stretch`;
    const m1 = document.createElement('div'); m1.className = 'tape'; m1.style.cssText = `width:${(marginDots + lead) * cpd}px;opacity:.75`;
    const c = document.createElement('canvas'); c.className = 'tape pending'; c.width = 1; c.height = 1; c.style.cssText = `width:${W * cpd}px;height:${hCss}px`;
    const m2 = document.createElement('div'); m2.className = 'tape'; m2.style.cssText = `width:${marginDots * cpd}px;opacity:.75`;
    row.append(m1, c, m2); lab.appendChild(row);
    const cut = document.createElement('div'); cut.className = 'cut'; cut.style.height = `${hCss + 28}px`; lab.appendChild(cut);
    const cap = document.createElement('div'); cap.className = 'cap'; cap.title = values[i].text;
    cap.textContent = `${values[i].text.replace(/\n/g, ' ')} · ${fmtLen(phys)}${lead ? ' (incl. leader)' : ''}`; lab.appendChild(cap);
    frag.appendChild(lab);
  }
  for (let i = shown; i < values.length; i++) total += widths[i] + 2 * marginDots;
  // ruler
  const ruler = document.createElement('div'); ruler.className = 'ruler'; ruler.style.width = `${total * cpd}px`;
  const totalMm = dotsToMm(total), stepMm = totalMm > 4000 ? 100 : totalMm > 1500 ? 50 : totalMm > 400 ? 20 : 10;
  for (let mm = 0; mm <= totalMm; mm += stepMm / 2) {
    const x = mm * (180 / 25.4) * cpd, big = (mm % stepMm) === 0;
    const tick = document.createElement('i'); tick.className = big ? 'big' : ''; tick.style.left = `${x}px`; ruler.appendChild(tick);
    if (big && (stepMm * (180 / 25.4) * cpd) > 28) { const s = document.createElement('span'); s.style.left = `${x}px`; s.textContent = mm >= 1000 ? `${(mm / 1000).toFixed(1)} m` : `${mm}`; ruler.appendChild(s); }
  }
  strip.appendChild(ruler); strip.appendChild(frag);
  if (values.length > shown) { const m = document.createElement('div'); m.className = 'more'; m.textContent = `… ${values.length - shown} more (all will print)`; strip.appendChild(m); }
  strip.querySelectorAll('.lab').forEach(el => io.observe(el));
  const secs = Math.round(dotsToMm(total) / FEED_MM_PER_S + values.length * 1.2);
  stats.textContent = values.length ? `${values.length} label${values.length === 1 ? '' : 's'} · ${t.label} tape · ${fmtLen(total)} of tape · ≈ ${secs >= 60 ? `${Math.floor(secs / 60)} min ${secs % 60} s` : `${secs} s`} · ${usingDesigner() ? 'Designer layout' : 'simple text'}` : 'No labels yet';
  $('btnPrint').textContent = values.length ? `Print ${values.length} label${values.length === 1 ? '' : 's'}` : 'Print';
  $('btnPrint').disabled = !values.length; $('btnExport').disabled = !values.length;
}, 120);

// ---------------------------------------------------------------- rendering for output
async function renderAllForOutput() {
  const L = currentLayout(), out = new Array(values.length);
  toast(`Rendering ${values.length} labels…`, false, 0);
  await chunked(values.length, (k) => {
    const r = renderLabel(L, values[k], S.tapeMm);
    out[k] = { canvas: r.canvas, width: r.width, height: r.height, name: values[k].text.replace(/\n/g, ' ') };
  }, { perChunk: 60, onProgress: (d, n) => { if (n > 120) toast(`Rendering ${d} / ${n} labels…`, false, 0); } });
  $('toast').classList.add('hidden');
  return out;
}
function printBody(labels) {
  const o = S.options;
  return { tapeMm: S.tapeMm, labels: labels.map(l => ({ pixels: canvasToPixels(l.canvas), width: l.width, height: l.height, name: l.name })),
    autoCut: o.autoCut, cutEach: Number(o.cutEach) || 1, mirror: o.mirror, marginDots: Math.max(14, mmToDots(o.marginMm)),
    flip: o.flip, checkMedia: o.check, mock: o.mock, mockTape: Number(o.mockTape) || 6, leader: o.leader || 'chain' };
}

// ---------------------------------------------------------------- print flow
const theater = new PrintTheater($('theater'));
let currentJob = null;
async function doPrint() {
  if (!values.length) return;
  const labels = await renderAllForOutput();
  const t = tape(S.tapeMm);
  theater.open({ labels, tapeMm: S.tapeMm, tapeLabel: t.label, onCancel: async () => { if (currentJob) await api.cancel(currentJob); } });
  let job;
  try {
    job = await api.print(printBody(labels));
  } catch (e) {
    theater.update({ state: 'error', error: (e.message || String(e)).replace(/^Error invoking remote method 'print': Error: /, ''), printed: 0, index: 0, phase: '' }); return;
  }
  currentJob = job.id;
  theater.update(job, { chain: (S.options.leader || 'chain') === 'chain' });
}
api.onJobProgress((j) => { if (j.id === currentJob) { theater.update(j, { chain: (S.options.leader || 'chain') === 'chain' }); if (j.state !== 'printing' && j.state !== 'queued') currentJob = null; } });
$('thClose').onclick = () => theater.close();
async function doFeedCut(btn) {
  const o = S.options; btn && (btn.disabled = true);
  try { await api.feedAndCut({ tapeMm: S.tapeMm, mock: o.mock, mockTape: Number(o.mockTape) || 6 }); toast('Fed and cut.'); }
  catch (e) { toast((e.message || String(e)).replace(/^Error invoking remote method '[^']+': Error: /, ''), true, 6000); }
  finally { btn && (btn.disabled = false); }
}
$('btnFeedCut').onclick = () => doFeedCut($('btnFeedCut'));
$('thFeedCut').onclick = () => doFeedCut($('thFeedCut'));
$('btnPrint').onclick = doPrint;
$('btnExport').onclick = async () => {
  if (!values.length) return;
  const labels = await renderAllForOutput();
  const j = await api.exportPngs({ labels: labels.map(l => ({ png: canvasToPng(l.canvas), name: l.name })), suggestedName: S.dataMode === 'single' ? 'label' : S.dataMode });
  if (j.ok) { toast(`Saved ${j.count} PNGs to ${j.dir}`, false, 6000); api.openPath(j.dir); }
  else if (!j.cancelled) toast(j.error || 'Export failed', true);
};

// ---------------------------------------------------------------- printer status
async function pollStatus() {
  const pill = $('printerPill'), txt = pill.querySelector('.txt');
  try {
    const j = await api.status({ mock: S.options.mock, mockTape: Number(S.options.mockTape) || 6 });
    pill.classList.remove('pill-on', 'pill-off', 'pill-mock');
    if (j.connected) {
      const st = j.status;
      pill.classList.add(j.mock ? 'pill-mock' : 'pill-on');
      if (!st) { txt.textContent = j.busy ? 'Printing…' : 'Connected'; return; }
      txt.textContent = `${j.mock ? 'Mock printer' : 'PT-P700'} · ${st.hasMedia ? `${st.mediaWidthMm} mm ${st.mediaType.toLowerCase()}` : 'no tape'}${st.errors.length ? ' · ' + st.errors.join(', ') : ''}${j.busy ? ' · printing' : ''}`;
      if (st.hasMedia && st.mediaWidthMm !== S.tapeMm) txt.textContent += `  (app set to ${tape(S.tapeMm).label})`;
    } else { pill.classList.add('pill-off'); txt.textContent = j.error || 'Printer not found'; }
    pill.title = j.error || JSON.stringify(j.status || {}, null, 1);
  } catch (e) { pill.classList.add('pill-off'); pill.querySelector('.txt').textContent = `Bridge error: ${e.message}`; }
}

// ---------------------------------------------------------------- UI wiring
function bindInput(id, get, set, evt = 'input') {
  const el = $(id);
  const apply = () => { const v = get(); if (el.type === 'checkbox') el.checked = !!v; else el.value = v ?? ''; };
  apply();
  el.addEventListener(evt, () => { set(el.type === 'checkbox' ? el.checked : el.type === 'number' ? (el.value === '' ? '' : Number(el.value)) : el.value); saveState(); afterInput(id); });
  return apply;
}
function afterInput(id) {
  if (id === 'stAuto') $('stSize').disabled = S.style.auto;
  if (id === 'stLenMode') $('stLenMm').disabled = S.style.lenMode !== 'fixed';
  if (id.startsWith('pat')) renderPatternSample();
  if (id.startsWith('batch')) renderBatchSample();
  if (id.startsWith('opt')) {/* print options only */} else refreshPreview();
}
// tape
$('tapeMm').value = S.tapeMm;
$('tapeMm').addEventListener('change', () => { S.tapeMm = Number($('tapeMm').value); saveState(); updateTapeInfo(); refreshPreview(); designer.render(); designer.renderProps(); pollStatus(); });
function updateTapeInfo() { const t = tape(S.tapeMm); $('tapeInfo').textContent = `${t.pins} dots tall · printable ${(t.pins / (180 / 25.4)).toFixed(1)} mm`; }
updateTapeInfo();
// tabs
$('tabs').querySelectorAll('button').forEach(b => b.onclick = () => switchTab(b.dataset.tab));
function switchTab(name) {
  S.tab = name; if (name !== 'designer') S.dataMode = name;
  $('tabs').querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach(s => s.classList.toggle('active', s.id === `tab-${name}`));
  $('main').classList.toggle('no-style', name === 'designer');
  $('stylePanel').classList.toggle('hidden', name === 'designer');
  $('useDesigner').disabled = name === 'designer';
  if (name === 'designer') { designer.render(); designer.renderProps(); }
  saveState(); refreshPreview();
}
// single
bindInput('singleText', () => S.single.text, v => S.single.text = v);
bindInput('singleCopies', () => S.single.copies, v => S.single.copies = v);
// pattern
$('patternKind').querySelectorAll('button').forEach(b => b.onclick = () => { S.pattern.kind = b.dataset.kind; applyPatternKind(); saveState(); renderPatternSample(); refreshPreview(); });
function applyPatternKind() {
  $('patternKind').querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.kind === S.pattern.kind));
  $('patCounter').classList.toggle('hidden', S.pattern.kind !== 'counter'); $('patTemplate').classList.toggle('hidden', S.pattern.kind !== 'template');
}
applyPatternKind();
for (const [id, key] of [['patPrefix', 'prefix'], ['patSuffix', 'suffix'], ['patStart', 'start'], ['patEnd', 'end'], ['patStep', 'step'], ['patPad', 'pad'], ['patTpl', 'tpl'], ['patTStart', 'tStart'], ['patTCount', 'tCount'], ['patTStep', 'tStep']])
  bindInput(id, () => S.pattern[key], v => S.pattern[key] = v);
function renderPatternSample() {
  const p = S.pattern;
  const v = p.kind === 'template' ? templateValues({ template: p.tpl, start: p.tStart, count: p.tCount, step: p.tStep })
    : counterValues({ prefix: p.prefix, suffix: p.suffix, start: p.start, end: p.end, step: p.step, padWidth: p.pad });
  const head = v.slice(0, 6).map(x => x.text), tail = v.length > 8 ? ['…', ...v.slice(-2).map(x => x.text)] : v.slice(6).map(x => x.text);
  $('patSample').textContent = v.length ? `${v.length} labels:\n${[...head, ...tail].join('\n')}` : 'No labels: check start/end/count.';
}
renderPatternSample();
// batch
bindInput('batchText', () => S.batch.text, v => S.batch.text = v);
bindInput('batchHeader', () => S.batch.header, v => S.batch.header = v, 'change');
bindInput('batchTpl', () => S.batch.tpl, v => S.batch.tpl = v);
$('btnBatchFile').onclick = () => $('batchFile').click();
$('batchFile').onchange = async () => { const f = $('batchFile').files[0]; if (!f) return; S.batch.text = await f.text(); $('batchText').value = S.batch.text; $('batchFile').value = ''; saveState(); renderBatchSample(); refreshPreview(); };
function renderBatchSample() {
  const v = batchValues({ text: S.batch.text, header: S.batch.header, template: S.batch.tpl });
  if (!v.length) { $('batchSample').textContent = 'Paste lines above.'; return; }
  const cols = Object.keys(v[0].fields);
  $('batchSample').textContent = `${v.length} labels · columns: ${cols.map(c => `{${c}}`).join(' ')}\n${v.slice(0, 5).map(x => x.text).join('\n')}${v.length > 5 ? '\n…' : ''}`;
}
renderBatchSample();
// style panel
const fl = $('fontList'); FONTS.forEach(f => { const o = document.createElement('option'); o.value = f; fl.appendChild(o); });
for (const [id, key, evt] of [['stFont', 'font'], ['stBold', 'bold', 'change'], ['stItalic', 'italic', 'change'], ['stInvert', 'invert', 'change'], ['stAuto', 'auto', 'change'], ['stSize', 'size'],
  ['stAlign', 'align', 'change'], ['stBorder', 'border', 'change'], ['stLenMode', 'lenMode', 'change'], ['stLenMm', 'lenMm'], ['stPadMm', 'padMm']])
  bindInput(id, () => S.style[key], v => S.style[key] = v, evt || 'input');
$('stSize').disabled = S.style.auto; $('stLenMm').disabled = S.style.lenMode !== 'fixed';
// dock
$('zoom').value = S.zoom; $('zoomTxt').textContent = `${S.zoom}×`;
$('zoom').addEventListener('input', () => { S.zoom = Number($('zoom').value); $('zoomTxt').textContent = `${S.zoom}×`; saveState(); refreshPreview(); });
bindInput('useDesigner', () => S.useDesigner, v => S.useDesigner = v, 'change');
// settings
for (const [id, key, evt] of [['optAutoCut', 'autoCut', 'change'], ['optCutEach', 'cutEach'], ['optMarginMm', 'marginMm'], ['optMirror', 'mirror', 'change'], ['optFlip', 'flip', 'change'],
  ['optCheck', 'check', 'change'], ['optMock', 'mock', 'change'], ['optMockTape', 'mockTape', 'change'], ['optLeader', 'leader', 'change']])
  bindInput(id, () => S.options[key], v => S.options[key] = v, evt || 'input');
$('optMarginMm').addEventListener('input', refreshPreview); $('optLeader').addEventListener('change', refreshPreview);
$('thSound').checked = S.options.sound; $('thSound').addEventListener('change', () => { S.options.sound = $('thSound').checked; saveState(); });
$('btnSettings').onclick = () => $('settings').classList.remove('hidden');
$('settingsClose').onclick = () => $('settings').classList.add('hidden');
$('settings').addEventListener('click', (e) => { if (e.target === $('settings')) $('settings').classList.add('hidden'); });
$('optMock').addEventListener('change', pollStatus); $('optMockTape').addEventListener('change', pollStatus);
$('btnCheckUpdates').onclick = () => api.checkUpdates();
$('verTxt').textContent = '';
api.onUpdate((u) => {
  const el = $('updateTxt');
  if (u.state === 'available') el.textContent = `Update ${u.version} available${u.manual ? ' (download from GitHub)' : ', downloading…'}`;
  else if (u.state === 'downloading') el.textContent = `Downloading update… ${u.percent}%`;
  else if (u.state === 'downloaded') el.textContent = `Update ${u.version} ready. Restart to install.`;
  else if (u.state === 'none') el.textContent = 'Up to date.';
  else if (u.state === 'error') el.textContent = `Update check failed: ${u.message}`;
  else if (u.state === 'disabled') el.textContent = 'Updates are checked in packaged builds only.';
});
api.onMenu((cmd) => { if (cmd === 'print') doPrint(); });

// designer
const designer = new Designer({
  canvas: $('dzCanvas'), propsEl: $('dzProps'), imageInput: $('dzImageFile'),
  getTapeMm: () => S.tapeMm, getLayout: () => layout,
  getSample: () => ({ text: S.designer.sampleText, n: Number(S.designer.sampleN) || 0, i: 1, fields: {} }),
  onChange: () => { saveLayout(); refreshPreview(); },
});
designer.zoom = S.designer.zoom;
$('dzZoom').value = S.designer.zoom;
$('dzZoom').addEventListener('input', () => { designer.zoom = S.designer.zoom = Number($('dzZoom').value); saveState(); designer.render(); });
bindInput('dzSampleText', () => S.designer.sampleText, v => S.designer.sampleText = v);
bindInput('dzSampleN', () => S.designer.sampleN, v => S.designer.sampleN = v);
document.querySelectorAll('[data-add]').forEach(b => b.onclick = () => designer.add(b.dataset.add));
function refreshTplList() {
  const sel = $('tplList'); const names = Object.keys(templates()).sort();
  sel.innerHTML = '<option value="">Load…</option>' + names.map(n => `<option>${n.replace(/</g, '&lt;')}</option>`).join('');
}
refreshTplList();
$('tplSave').onclick = () => {
  const name = $('tplName').value.trim() || layout.name || 'Untitled';
  const t = templates(); layout.name = name; t[name] = JSON.parse(serializeLayout(layout)); saveTemplates(t); refreshTplList(); $('tplList').value = name; toast(`Saved template “${name}”`);
};
$('tplList').onchange = async () => {
  const name = $('tplList').value; if (!name) return;
  const t = templates(); if (!t[name]) return;
  layout = structuredClone(t[name]); await hydrateLayout(layout); $('tplName').value = name;
  designer.selectedId = null; designer.render(); designer.renderProps(); saveLayout(); refreshPreview();
};
$('tplDelete').onclick = () => { const name = $('tplList').value; if (!name) return; const t = templates(); delete t[name]; saveTemplates(t); refreshTplList(); toast(`Deleted “${name}”`); };
$('tplExport').onclick = () => {
  const blob = new Blob([serializeLayout(layout)], { type: 'application/json' }); const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `${(layout.name || 'layout').replace(/[^\w-]+/g, '_')}.tapedeck.json`; a.click();
};
$('tplImport').onclick = () => $('tplImportFile').click();
$('tplImportFile').onchange = async () => {
  const f = $('tplImportFile').files[0]; $('tplImportFile').value = ''; if (!f) return;
  try { const j = JSON.parse(await f.text()); if (!j.elements) throw new Error('not a layout'); layout = j; await hydrateLayout(layout); $('tplName').value = layout.name || ''; designer.selectedId = null; designer.render(); designer.renderProps(); saveLayout(); refreshPreview(); toast('Layout imported'); }
  catch (e) { toast(`Import failed: ${e.message}`, true); }
};
$('tplReset').onclick = () => { layout = simpleTextLayout({ tapeMm: S.tapeMm }); layout.name = 'New layout'; Object.assign(layout.elements[0], { hCenter: false, x: 6, align: 'left' }); $('tplName').value = ''; designer.selectedId = null; designer.render(); designer.renderProps(); saveLayout(); refreshPreview(); };

// ---------------------------------------------------------------- boot
(async () => {
  try { config = await api.config(); if (config.mock) { S.options.mock = true; $('optMock').checked = true; } $('verTxt').textContent = `TapeDeck ${config.version}${config.packaged ? '' : ' (dev)'}`; } catch (e) { toast(`Startup error: ${e.message}`, true, 0); }
  await hydrateLayout(layout);
  $('tplName').value = layout.name || '';
  switchTab(S.tab);
  pollStatus(); setInterval(pollStatus, 8000);
  // Enter in single-line inputs triggers print
  document.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'p') { e.preventDefault(); doPrint(); } });
})();
