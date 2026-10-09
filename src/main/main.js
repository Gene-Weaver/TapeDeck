'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { JobManager } = require('./jobs');
const { Printer } = require('./ptouch/printer');
const { TransportError, describeUsbError } = require('./ptouch/transport');
const { tapeForMm } = require('./ptouch/tapes');
const { Store, parseLayoutText } = require('./store');
const updater = require('./updater');

const CLI_MOCK = process.argv.includes('--mock');
// Separate profile (settings, layouts, single-instance lock) for tests or a second copy.
if (process.env.TAPEDECK_USER_DATA) { const dir = path.resolve(process.env.TAPEDECK_USER_DATA); app.setPath('userData', dir); app.setPath('sessionData', dir); }

// Every USB conversation (status poll, print job, feed & cut) runs one at a time: two overlapping
// ones would interleave commands on the wire, which can desync the PT-P700 until it is power-cycled.
let usbChain = Promise.resolve();
function withUsb(fn) { const run = usbChain.then(fn, fn); usbChain = run.catch(() => {}); return run; }

const jobs = new JobManager({ lock: withUsb });
let win = null;
let lastStatus = null;
let store = null;

// A second launch only focuses the running window. Electron still runs whenReady() after an early
// quit, so without the guard below a duplicate app would start and poll the printer alongside the first.
const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

function createWindow() {
  const background = !!process.env.TAPEDECK_BACKGROUND;   // automated UI tests: never show or focus the window
  if (background && app.dock) app.dock.hide();
  win = new BrowserWindow({
    width: 1400, height: 980, minWidth: 980, minHeight: 700,
    title: 'TapeDeck', backgroundColor: '#15171c', show: false,
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: !background },
  });
  // The UI is local files only: never navigate away (e.g. when a file is dropped on the window) and open web links in the browser.
  win.webContents.on('will-navigate', (e, url) => { if (url !== win.webContents.getURL()) e.preventDefault(); });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  if (!background) { win.maximize(); win.show(); }   // open maximized (fills the screen, menu bar and Dock stay)
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.on('closed', () => { win = null; });
  updater.setup(() => win);
}

const send = (cmd) => { if (win && !win.isDestroyed()) win.webContents.send('menu', cmd); };

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ label: app.name, submenu: [{ role: 'about' }, { label: 'Check for Updates…', click: () => updater.check(true) }, { type: 'separator' }, { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] }] : []),
    { label: 'File', submenu: [
      { label: 'New Layout…', accelerator: 'CmdOrCtrl+N', click: () => send('layout-new') },
      { label: 'Duplicate Layout', click: () => send('layout-duplicate') },
      { label: 'Import Layout…', click: () => send('layout-import') },
      { label: 'Export Layout…', click: () => send('layout-export') },
      { label: 'Show Layouts Folder', click: () => store && shell.openPath(store.layoutsDir) },
      { type: 'separator' },
      { label: 'Print', accelerator: 'CmdOrCtrl+P', click: () => send('print') },
      { type: 'separator' }, isMac ? { role: 'close' } : { role: 'quit' }] },
    // Undo/Redo go to the page, which undoes text typing in a field or else the last layout edit.
    { label: 'Edit', submenu: [
      { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => send('undo') },
      { label: 'Redo', accelerator: 'Shift+CmdOrCtrl+Z', click: () => send('redo') },
      { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { label: 'Help', submenu: [
      ...(isMac ? [] : [{ label: 'Check for Updates…', click: () => updater.check(true) }, { type: 'separator' }]),
      { label: 'TapeDeck on GitHub', click: () => shell.openExternal('https://github.com/Gene-Weaver/TapeDeck') },
      { label: 'Releases', click: () => shell.openExternal('https://github.com/Gene-Weaver/TapeDeck/releases') },
      { label: 'Open logs folder', click: () => shell.openPath(app.getPath('logs')) },
    ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---- IPC: config, settings and layout files ------------------------------------------------------
const config = () => ({ version: app.getVersion(), mock: CLI_MOCK, platform: process.platform, packaged: app.isPackaged, repo: 'https://github.com/Gene-Weaver/TapeDeck', test: !!process.env.TAPEDECK_BACKGROUND });
ipcMain.handle('config', config);

// Synchronous so the page has its settings and layout before it draws anything.
ipcMain.on('boot', (e) => {
  try {
    const settings = store.readSettingsSync();
    const layouts = store.listSync();
    const want = settings && typeof settings.layoutId === 'string' ? settings.layoutId : 'label-wrap';
    const pick = layouts.find(l => l.id === want && !l.error) || layouts.find(l => l.id === 'label-wrap' && !l.error) || layouts.find(l => !l.error);
    let current = null;
    if (pick) { try { current = store.readSync(pick.id); } catch {} }
    e.returnValue = { config: config(), settings, layouts, presets: store.presetIds, dir: store.layoutsDir, userDir: store.userDir, current };
  } catch (err) { e.returnValue = { config: config(), error: err.message, settings: null, layouts: [], presets: [], current: null }; }
});
ipcMain.on('store:flush-sync', (e, payload) => {
  try { store.flushSync(payload || {}); e.returnValue = { ok: true }; } catch (err) { e.returnValue = { ok: false, error: err.message }; }
});
ipcMain.handle('settings:save', (_e, s) => store.writeSettings(s));
ipcMain.handle('layouts:list', () => store.list());
ipcMain.handle('layouts:read', (_e, id) => store.read(id));
ipcMain.handle('layouts:write', (_e, { id, text }) => store.write(id, text));
ipcMain.handle('layouts:create', (_e, { name, text }) => store.create(name, text));
ipcMain.handle('layouts:rename', (_e, { id, name }) => store.rename(id, name));
ipcMain.handle('layouts:delete', async (_e, { id, name }) => {
  const r = await dialog.showMessageBox(win, { type: 'warning', buttons: ['Move to Trash', 'Cancel'], defaultId: 1, cancelId: 1,
    message: `Delete the layout “${name || id}”?`, detail: 'Its file goes to the Trash, so you can still get it back from there.' });
  if (r.response !== 0) return { deleted: false };
  await store.remove(id);
  return { deleted: true };
});
ipcMain.handle('layouts:revert', async (_e, { id, name }) => {
  const r = await dialog.showMessageBox(win, { type: 'question', buttons: ['Revert', 'Cancel'], defaultId: 0, cancelId: 1,
    message: `Revert “${name || id}” to the built-in version?`, detail: 'Your changes to this layout are replaced. Undo (⌘Z) brings them back while TapeDeck stays open.' });
  if (r.response !== 0) return { reverted: false };
  return { reverted: true, ...(await store.revert(id)) };
});
ipcMain.handle('layouts:restore', () => store.restoreMissing());
ipcMain.handle('layouts:reveal', () => shell.openPath(store.layoutsDir));
// Import returns the files' text; the page validates and upgrades them before saving them as layouts.
ipcMain.handle('layouts:import', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Import layouts', properties: ['openFile', 'multiSelections'], filters: [{ name: 'TapeDeck layout', extensions: ['json'] }] });
  if (r.canceled) return [];
  return r.filePaths.map((p) => { try { return { file: path.basename(p), text: fs.readFileSync(p, 'utf8') }; } catch (e) { return { file: path.basename(p), error: e.message }; } });
});
ipcMain.handle('layouts:export', async (_e, { text, fileName }) => {
  parseLayoutText(text);
  const r = await dialog.showSaveDialog(win, { title: 'Export layout', defaultPath: fileName || 'layout.json', filters: [{ name: 'TapeDeck layout', extensions: ['json'] }] });
  if (r.canceled || !r.filePath) return { ok: false, canceled: true };
  fs.writeFileSync(r.filePath, text);
  return { ok: true, file: r.filePath };
});

// ---- IPC: printer ----------------------------------------------------------------------------------
const errText = (e) => ((e instanceof TransportError || e.name === 'PrintError') ? e.message : describeUsbError(e));

ipcMain.handle('status', async (_e, { mock, mockTape } = {}) => {
  if (jobs.busy) return { connected: true, mock, busy: true, status: lastStatus };
  return withUsb(async () => {
    if (jobs.busy) return { connected: true, mock, busy: true, status: lastStatus };
    let printer = null;
    try {
      printer = mock ? Printer.mock({ tapeMm: mockTape || 6 }) : Printer.usb();
      const st = await printer.status();
      lastStatus = st;
      return { connected: true, mock, status: st };
    } catch (e) {
      return { connected: false, mock, error: errText(e) };
    } finally { if (printer) { try { await printer.t.close(); } catch {} } }
  });
});

ipcMain.handle('print', (e, body) => {
  if (!body || !body.labels || !body.labels.length) throw new Error('No labels in job');
  tapeForMm(body.tapeMm);
  const pages = body.labels.map((l, i) => {
    const px = l.pixels instanceof Uint8Array ? l.pixels : new Uint8Array(l.pixels);
    if (px.length !== l.width * l.height) throw new Error(`Label ${i + 1}: pixel buffer size mismatch`);
    return { width: l.width, height: l.height, pixels: px };
  });
  console.log(`[print] ${pages.length} label(s), ${pages[0].width}x${pages[0].height} dots first`);
  const names = body.labels.map(l => l.name || '');
  const options = { tapeMm: body.tapeMm, autoCut: body.autoCut !== false, cutEach: body.cutEach || 1, mirror: !!body.mirror, marginDots: Math.max(14, body.marginDots || 14), flip: !!body.flip, checkMedia: body.checkMedia !== false, chain: false, offsetDots: Number(body.offsetDots) || 0 };
  const wc = e.sender;
  return jobs.start({ pages, names, options, mock: !!body.mock, mockTape: body.mockTape }, (job) => { if (!wc.isDestroyed()) wc.send('job-progress', job); });
});
ipcMain.handle('job', (_e, id) => jobs.get(id));
ipcMain.handle('feed-cut', (_e, body) => jobs.feedAndCut(body || {}));
ipcMain.handle('cancel', (_e, id) => jobs.cancel(id));

ipcMain.handle('export', async (_e, { labels, suggestedName }) => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose a folder for the label PNGs', properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return { ok: false, cancelled: true };
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15).replace('T', '_');
  const dir = path.join(r.filePaths[0], `${(suggestedName || 'labels').replace(/[^\w-]+/g, '_')}_${stamp}`);
  fs.mkdirSync(dir, { recursive: true });
  labels.forEach((l, i) => {
    const safe = String(l.name || '').replace(/[^\w.-]+/g, '_').slice(0, 40);
    fs.writeFileSync(path.join(dir, `${String(i + 1).padStart(4, '0')}_${safe}.png`), Buffer.from(l.png.split(',')[1], 'base64'));
  });
  return { ok: true, dir, count: labels.length };
});
ipcMain.handle('open-external', (_e, url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); });
ipcMain.handle('open-path', (_e, p) => shell.openPath(p));
ipcMain.handle('native-edit', (e, cmd) => { if (cmd === 'undo') e.sender.undo(); else if (cmd === 'redo') e.sender.redo(); });
ipcMain.handle('check-updates', () => updater.check(true));
ipcMain.handle('install-update', () => updater.install());

app.whenReady().then(() => {
  if (!primary) return;
  store = new Store({ userDir: app.getPath('userData'), presetsDir: path.join(__dirname, '..', 'presets'), trash: (f) => shell.trashItem(f) });
  try { store.initSync(); } catch (e) { console.error('could not prepare the layouts folder', e); }
  buildMenu();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
