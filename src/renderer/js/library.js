// The layouts library: which layout file is open, saving edits back to it (debounced), and the
// New / Duplicate / Rename / Delete / Import / Export / Revert actions. The files live in the
// per-user data folder (see src/main/store.js), never inside the app, so updates cannot touch them.
import { fromFile, toFileText, newLayout, newElement } from './layout.js';
import { cleanError } from './api.js';

const SAVE_DELAY = 400;

export class Library {
  /**
   * hooks: onOpen(layout, id, { reason }) when a different layout (or a new version of this one) becomes
   * current; onList(list) when the list of files changes; onState('pending' | 'saved' | 'error');
   * toast(message, isError).
   */
  constructor(api, hooks) {
    this.api = api;
    Object.assign(this, { onOpen: () => {}, onList: () => {}, onState: () => {}, toast: () => {} }, hooks);
    this.list = []; this.presets = new Set(); this.id = null; this.layout = null; this.lastText = null; this.dirty = false; this.timer = null;
  }

  /** Synchronous start from the boot payload (main.js 'boot'). */
  init(boot) {
    this.list = boot.layouts || [];
    this.presets = new Set(boot.presets || []);
    this.dir = boot.dir || '';
    if (boot.current) { try { this._load(boot.current.id, boot.current.text, 'boot'); return; } catch (e) { this.toast(`Could not open “${boot.current.id}”: ${e.message}`, true); } }
    // nothing usable on disk: start from a blank layout and save it so there is always one file
    this.layout = starterLayout('Label');
    this.id = null;
    this.onOpen(this.layout, null, { reason: 'boot' });
    this.create(this.layout.name, this.layout).catch(() => {});
  }

  get current() { return this.list.find(l => l.id === this.id) || null; }
  get isPreset() { return !!this.id && this.presets.has(this.id); }

  _load(id, text, reason) {
    const L = fromFile(JSON.parse(text));
    const warnings = L._warnings; delete L._warnings;
    this.id = id; this.layout = L; this.lastText = text; this.dirty = false;
    clearTimeout(this.timer); this.timer = null;
    this.onOpen(L, id, { reason });
    this.onState('saved');
    if (warnings && warnings.length) this.toast(`“${L.name}”: skipped ${warnings.length} problem${warnings.length === 1 ? '' : 's'} in its file (${warnings[0]}${warnings.length > 1 ? ', …' : ''}).`, true);
  }

  // ---- saving ------------------------------------------------------------------------------------
  /** The open layout was edited: save it shortly. */
  changed() {
    if (!this.id) return;
    this.dirty = true;
    this.onState('pending');
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), SAVE_DELAY);
  }

  /** Swap in a new in-memory version of the open layout (undo / redo) and save it. */
  replace(L) { this.layout = L; this.changed(); }

  async flush() {
    clearTimeout(this.timer); this.timer = null;
    if (!this.dirty || !this.id) return;
    const id = this.id, text = toFileText(this.layout);
    this.dirty = false;
    if (text === this.lastText) { this.onState('saved'); return; }
    try {
      await this.api.layouts.write(id, text);
      if (id === this.id) this.lastText = text;
      this.onState(this.dirty ? 'pending' : 'saved');
    } catch (e) {
      if (id === this.id) this.dirty = true;
      this.onState('error');
      this.toast(`Could not save the layout: ${cleanError(e)}`, true);
    }
  }

  /** For a synchronous save as the window closes: { id, text } if there are unsaved edits. */
  pendingSync() {
    if (!this.dirty || !this.id) return null;
    const text = toFileText(this.layout);
    return text === this.lastText ? null : { id: this.id, text };
  }

  // ---- the list ----------------------------------------------------------------------------------
  async refreshList() {
    try { this.list = await this.api.layouts.list(); } catch (e) { this.toast(`Could not read the layouts folder: ${cleanError(e)}`, true); }
    this.onList(this.list);
    return this.list;
  }

  uniqueName(base) {
    const names = new Set(this.list.map(l => l.name.toLowerCase()));
    if (!names.has(base.toLowerCase())) return base;
    for (let n = 2; ; n++) if (!names.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`;
  }

  async open(id) {
    if (id === this.id) return;
    await this.flush();
    try { const r = await this.api.layouts.read(id); this._load(id, r.text, 'open'); }
    catch (e) { this.toast(`Could not open that layout: ${cleanError(e)}`, true); this.onList(this.list); }
  }

  /** Save a layout as a new file and open it. */
  async create(name, L) {
    await this.flush();
    L.name = name;
    const text = toFileText(L);
    try {
      const { id } = await this.api.layouts.create(name, text);
      await this.refreshList();
      this._load(id, text, 'create');
      return id;
    } catch (e) { this.toast(`Could not create the layout: ${cleanError(e)}`, true); return null; }
  }

  createNew() { return this.create(this.uniqueName('New layout'), starterLayout('New layout')); }

  duplicate() {
    const copy = fromFile(JSON.parse(toFileText(this.layout)));
    return this.create(this.uniqueName(`${this.layout.name} copy`), copy);
  }

  /** Rename the open layout; its file is renamed to match. */
  async rename(name) {
    name = String(name || '').trim();
    if (!this.id || !name) return;
    await this.flush();
    const cur = this.current;
    if (cur && cur.name === name && this.layout.name === name) return;
    try {
      const oldId = this.id, L = this.layout;
      const r = await this.api.layouts.rename(oldId, name);
      if (this.id !== oldId) { await this.refreshList(); return; }      // another layout was opened meanwhile
      L.name = name;
      this.id = r.id; this.lastText = r.text;
      await this.refreshList();
      this.onOpen(this.layout, this.id, { reason: 'rename', oldId });
    } catch (e) { this.toast(`Could not rename the layout: ${cleanError(e)}`, true); }
  }

  async remove() {
    if (!this.id) return;
    await this.flush();
    const id = this.id, name = this.layout.name;
    let r;
    try { r = await this.api.layouts.remove(id, name); } catch (e) { this.toast(`Could not delete the layout: ${cleanError(e)}`, true); return; }
    if (!r.deleted) return;
    this.dirty = false;
    this.toast(`Moved “${name}” to the Trash.`);
    let list = await this.refreshList();
    if (!list.some(l => !l.error)) { await this.api.layouts.restore(); list = await this.refreshList(); }
    const next = list.find(l => l.id === 'label-wrap' && !l.error) || list.find(l => !l.error);
    this.id = null;
    if (next) await this.open(next.id);
  }

  async revert() {
    if (!this.isPreset) return;
    await this.flush();
    try {
      const r = await this.api.layouts.revert(this.id, this.layout.name);
      if (r.reverted) { this._load(this.id, r.text, 'revert'); await this.refreshList(); this.toast(`“${this.layout.name}” is back to the built-in version.`); }
    } catch (e) { this.toast(`Could not revert: ${cleanError(e)}`, true); }
  }

  async restoreBuiltins() {
    try {
      const ids = await this.api.layouts.restore();
      await this.refreshList();
      this.toast(ids.length ? `Restored ${ids.length} built-in layout${ids.length === 1 ? '' : 's'}.` : 'All built-in layouts are already there.');
    } catch (e) { this.toast(`Could not restore: ${cleanError(e)}`, true); }
  }

  // ---- import / export -----------------------------------------------------------------------------
  /** Add a layout from file text (import dialog or a dropped file). Accepts 0.1 exports too. */
  async importText(text, fileName = 'layout.json') {
    let L;
    try { L = fromFile(JSON.parse(text)); } catch (e) { this.toast(`${fileName} is not a TapeDeck layout (${e.message}).`, true); return null; }
    delete L._warnings;
    const base = L.name && L.name !== 'Untitled' ? L.name : fileName.replace(/\.(tapedeck\.)?json$/i, '');
    return this.create(this.uniqueName(base), L);
  }

  async importFiles() {
    let files;
    try { files = await this.api.layouts.importFiles(); } catch (e) { this.toast(cleanError(e), true); return; }
    let n = 0;
    for (const f of files) {
      if (f.error) { this.toast(`Could not read ${f.file}: ${f.error}`, true); continue; }
      if (await this.importText(f.text, f.file)) n++;
    }
    if (n) this.toast(`Imported ${n} layout${n === 1 ? '' : 's'}.`);
  }

  async exportCurrent() {
    const slug = (this.layout.name || 'layout').replace(/[^\w-]+/g, '_');
    try {
      const r = await this.api.layouts.exportFile(toFileText(this.layout), `${slug}.json`);
      if (r.ok) this.toast(`Exported to ${r.file}`);
    } catch (e) { this.toast(`Export failed: ${cleanError(e)}`, true); }
  }

  reveal() { return this.api.layouts.reveal(); }

  /** When the window regains focus: pick up files added, removed or edited outside the app. */
  async refreshFromDisk() {
    const list = await this.refreshList();
    if (!this.id) return;
    if (!list.some(l => l.id === this.id)) {
      this.toast(`“${this.layout.name}” was removed from the layouts folder.`, true);
      this.dirty = false; clearTimeout(this.timer);
      const next = list.find(l => !l.error);
      this.id = null;
      if (next) await this.open(next.id);
      return;
    }
    if (this.dirty) return;
    try {
      const r = await this.api.layouts.read(this.id);
      if (r.text !== this.lastText) { this._load(this.id, r.text, 'external'); this.toast(`Reloaded “${this.layout.name}”: its file changed on disk.`); }
    } catch {}
  }
}

/** A new layout: one name text in the row. */
export function starterLayout(name) {
  const L = newLayout(name);
  const t = newElement('text');
  t.bold = true; t.name = 'Name';
  L.elements.push(t);
  return L;
}
