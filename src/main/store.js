'use strict';
// Settings and layouts are plain JSON files in the per-user data folder, which app updates never touch:
//   <userData>/settings.json        app state: tape, label inputs, printer options, current layout
//   <userData>/layouts/<id>.json    one file per layout (see src/renderer/js/layout.js for the format)
// Built-in layouts ship in src/presets and are copied into layouts/ once, the first time a release
// containing them runs. After that the user's copy is theirs: a newer release never overwrites or
// re-creates it (layouts/.seeded.json remembers what was already offered).
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');

const SEEDED = '.seeded.json';

function checkId(id) {
  if (typeof id !== 'string' || !id || id.length > 120 || id[0] === '.' || /[/\\\0:*?"<>|]/.test(id) || path.basename(id) !== id) throw new Error(`Invalid layout id "${id}"`);
  return id;
}

function slugify(name) {
  return String(name || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'layout';
}

function parseLayoutText(text) {
  const j = JSON.parse(text);
  if (!j || typeof j !== 'object' || !Array.isArray(j.elements)) throw new Error('not a layout (no "elements" list)');
  return j;
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const RETRY = new Set(['EPERM', 'EBUSY', 'EACCES']);   // Windows: target briefly held by an indexer or antivirus

function renameSyncRetry(from, to) {
  for (let i = 0; ; i++) {
    try { fs.renameSync(from, to); return; } catch (e) { if (!RETRY.has(e.code) || i >= 6) throw e; sleepSync(25 * (i + 1)); }
  }
}

function writeFileAtomicSync(file, text) {
  const tmp = `${file}.${process.pid}-${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text);
  try { renameSyncRetry(tmp, file); } catch (e) { try { fs.rmSync(tmp, { force: true }); } catch {} throw e; }
}

class Store {
  /** trash(file) moves a file to the OS trash (Electron's shell.trashItem); without it files are deleted. */
  constructor({ userDir, presetsDir, trash = null }) {
    this.userDir = userDir;
    this.layoutsDir = path.join(userDir, 'layouts');
    this.settingsFile = path.join(userDir, 'settings.json');
    this.presetsDir = presetsDir;
    this.trash = trash;
    this.gen = new Map();       // file -> generation of the newest write, so an older write never lands last
    this.queue = new Map();     // file -> promise chain of async writes
    this.presets = this._readPresets();
  }

  file(id) { return path.join(this.layoutsDir, `${checkId(id)}.json`); }
  get presetIds() { return this.presets.map(p => p.id); }

  _readPresets() {
    let names = [];
    try { names = fs.readdirSync(this.presetsDir).filter(f => f.endsWith('.json')).sort(); } catch { return []; }
    const out = [];
    for (const f of names) {
      const text = fs.readFileSync(path.join(this.presetsDir, f), 'utf8');
      try { parseLayoutText(text); out.push({ id: f.slice(0, -5), text }); } catch (e) { console.error(`preset ${f} is invalid:`, e.message); }
    }
    return out;
  }

  /** Create folders and copy in built-in layouts this profile has never been offered. Safe to call on every launch. */
  initSync() {
    fs.mkdirSync(this.layoutsDir, { recursive: true });
    const seededFile = path.join(this.layoutsDir, SEEDED);
    let seeded = [];
    try { seeded = JSON.parse(fs.readFileSync(seededFile, 'utf8')); } catch {}
    const done = new Set(Array.isArray(seeded) ? seeded : []);
    let changed = false;
    for (const p of this.presets) {
      if (done.has(p.id)) continue;
      if (!fs.existsSync(this.file(p.id))) writeFileAtomicSync(this.file(p.id), p.text);
      done.add(p.id); changed = true;
    }
    if (changed) writeFileAtomicSync(seededFile, JSON.stringify([...done], null, 2) + '\n');
  }

  // ---- settings ---------------------------------------------------------------------------------
  readSettingsSync() {
    let text;
    try { text = fs.readFileSync(this.settingsFile, 'utf8'); } catch { return null; }
    try { const j = JSON.parse(text); return j && typeof j === 'object' ? j : null; }
    catch {   // keep the damaged file for inspection rather than silently overwriting it
      try { fs.renameSync(this.settingsFile, `${this.settingsFile}.damaged-${Date.now()}`); } catch {}
      return null;
    }
  }
  writeSettings(obj) { return this._write(this.settingsFile, JSON.stringify(obj, null, 2) + '\n'); }

  // ---- layouts ----------------------------------------------------------------------------------
  _ids() {
    try { return fs.readdirSync(this.layoutsDir).filter(f => f.endsWith('.json') && f[0] !== '.').map(f => f.slice(0, -5)); } catch { return []; }
  }

  /** [{ id, name, preset, error? }] sorted by name. */
  listSync() {
    const presets = new Set(this.presetIds);
    const out = this._ids().map((id) => {
      try {
        const j = parseLayoutText(fs.readFileSync(this.file(id), 'utf8'));
        return { id, name: typeof j.name === 'string' && j.name.trim() ? j.name.trim() : id, preset: presets.has(id) };
      } catch (e) { return { id, name: id, preset: presets.has(id), error: e.message }; }
    });
    return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) || a.id.localeCompare(b.id));
  }
  async list() { return this.listSync(); }

  readSync(id) { return { id, text: fs.readFileSync(this.file(id), 'utf8') }; }
  async read(id) { return { id, text: await fsp.readFile(this.file(id), 'utf8') }; }

  async write(id, text) { parseLayoutText(text); await this._write(this.file(id), text); return { id }; }

  _unique(base, except = null) {
    const taken = new Set(this._ids().filter(i => i !== except).map(i => i.toLowerCase()));
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  }

  /** Save a new layout file; the id comes from the name and never replaces an existing file. */
  async create(name, text) {
    parseLayoutText(text);
    const id = this._unique(slugify(name));
    await this._write(this.file(id), text);
    return { id };
  }

  /** Rename: updates the name inside the file and moves the file to match it when that id is free. */
  async rename(id, name) {
    const j = parseLayoutText(await fsp.readFile(this.file(id), 'utf8'));
    j.name = String(name).trim() || j.name;
    const text = JSON.stringify(j, null, 2) + '\n';
    let newId = slugify(j.name);
    if (newId === id.toLowerCase()) newId = id;
    if (newId !== id) newId = this._unique(newId, id);
    await this._write(this.file(newId), text);
    if (newId !== id) { this.gen.set(this.file(id), (this.gen.get(this.file(id)) || 0) + 1); await fsp.rm(this.file(id), { force: true }); }
    return { id: newId, text };
  }

  async remove(id) {
    const file = this.file(id);
    this.gen.set(file, (this.gen.get(file) || 0) + 1);   // cancel queued writes
    await (this.queue.get(file) || Promise.resolve()).catch(() => {});
    if (this.trash) { try { await this.trash(file); return { trashed: true }; } catch {} }
    await fsp.rm(file, { force: true });
    return { trashed: false };
  }

  /** Overwrite a layout with the built-in version of the same id. */
  async revert(id) {
    const p = this.presets.find(x => x.id === id);
    if (!p) throw new Error(`"${id}" is not a built-in layout`);
    await this._write(this.file(id), p.text);
    return { id, text: p.text };
  }

  /** Copy back built-in layouts whose files are missing. Returns the ids restored. */
  async restoreMissing() {
    const have = new Set(this._ids().map(i => i.toLowerCase()));
    const restored = [];
    for (const p of this.presets) if (!have.has(p.id)) { await this._write(this.file(p.id), p.text); restored.push(p.id); }
    return restored;
  }

  // ---- writes -------------------------------------------------------------------------------------
  /** Atomic write (temp file + rename). Writes to one file run in order, and a write that has been superseded is dropped. */
  _write(file, text) {
    const gen = (this.gen.get(file) || 0) + 1;
    this.gen.set(file, gen);
    const job = (this.queue.get(file) || Promise.resolve()).catch(() => {}).then(async () => {
      if (this.gen.get(file) !== gen) return false;
      const tmp = `${file}.${process.pid}-${gen}.tmp`;
      await fsp.writeFile(tmp, text);
      for (let i = 0; ; i++) {
        // check and rename with no await in between, so a synchronous flush can never be overtaken
        if (this.gen.get(file) !== gen) { await fsp.rm(tmp, { force: true }); return false; }
        try { fs.renameSync(tmp, file); return true; }
        catch (e) { if (!RETRY.has(e.code) || i >= 6) { await fsp.rm(tmp, { force: true }).catch(() => {}); throw e; } await new Promise(r => setTimeout(r, 25 * (i + 1))); }
      }
    });
    this.queue.set(file, job);
    return job;
  }

  /** Synchronous last-moment save (window closing or reloading): settings object and/or { id, text } of the open layout. */
  flushSync({ settings, layout } = {}) {
    if (settings) this._writeSync(this.settingsFile, JSON.stringify(settings, null, 2) + '\n');
    if (layout && layout.id && typeof layout.text === 'string') { parseLayoutText(layout.text); this._writeSync(this.file(layout.id), layout.text); }
  }
  _writeSync(file, text) { this.gen.set(file, (this.gen.get(file) || 0) + 1); writeFileAtomicSync(file, text); }

  /** Wait for queued writes (tests, shutdown). */
  async idle() { await Promise.all([...this.queue.values()].map(p => p.catch(() => {}))); }
}

module.exports = { Store, slugify, checkId, parseLayoutText };
