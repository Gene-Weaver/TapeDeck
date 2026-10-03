'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { JobManager } = require('./jobs');
const { Printer } = require('./ptouch/printer');
const { TransportError } = require('./ptouch/transport');
const { tapeForMm } = require('./ptouch/tapes');
const updater = require('./updater');

const CLI_MOCK = process.argv.includes('--mock');
const jobs = new JobManager();
let win = null;
let lastStatus = null;

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

function createWindow() {
  win = new BrowserWindow({
    width: 1400, height: 980, minWidth: 980, minHeight: 700,
    title: 'TapeDeck', backgroundColor: '#15171c',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.on('closed', () => { win = null; });
  updater.setup(() => win);
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ label: app.name, submenu: [{ role: 'about' }, { label: 'Check for Updates…', click: () => updater.check(true) }, { type: 'separator' }, { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] }] : []),
    { label: 'File', submenu: [{ label: 'Print', accelerator: 'CmdOrCtrl+P', click: () => win && win.webContents.send('menu', 'print') }, { type: 'separator' }, isMac ? { role: 'close' } : { role: 'quit' }] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
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

// ---- IPC ---------------------------------------------------------------------
ipcMain.handle('config', () => ({ version: app.getVersion(), mock: CLI_MOCK, platform: process.platform, packaged: app.isPackaged, repo: 'https://github.com/Gene-Weaver/TapeDeck' }));

ipcMain.handle('status', async (_e, { mock, mockTape } = {}) => {
  if (jobs.busy) return { connected: true, mock, busy: true, status: lastStatus };
  let printer = null;
  try {
    printer = mock ? Printer.mock({ tapeMm: mockTape || 6 }) : Printer.usb();
    const st = await printer.status();
    lastStatus = st;
    return { connected: true, mock, status: st };
  } catch (e) {
    return { connected: false, mock, error: (e instanceof TransportError || e.name === 'PrintError') ? e.message : `${e.name || 'Error'}: ${e.message}` };
  } finally { if (printer) { try { await printer.t.close(); } catch {} } }
});

ipcMain.handle('print', (e, body) => {
  if (!body || !body.labels || !body.labels.length) throw new Error('No labels in job');
  tapeForMm(body.tapeMm);
  const pages = body.labels.map((l, i) => {
    const px = l.pixels instanceof Uint8Array ? l.pixels : new Uint8Array(l.pixels);
    if (px.length !== l.width * l.height) throw new Error(`Label ${i + 1}: pixel buffer size mismatch`);
    let ink = 0; for (let k = 0; k < px.length; k++) ink += px[k];
    console.log(`[print] label ${i + 1}: ${l.width}x${l.height} dots, ${ink} black (${l.pixels && l.pixels.constructor && l.pixels.constructor.name})`);
    return { width: l.width, height: l.height, pixels: px };
  });
  const names = body.labels.map(l => l.name || '');
  const options = { tapeMm: body.tapeMm, autoCut: body.autoCut !== false, cutEach: body.cutEach || 1, mirror: !!body.mirror, marginDots: Math.max(14, body.marginDots || 14), flip: !!body.flip, checkMedia: body.checkMedia !== false, chain: true, offsetDots: Number(body.offsetDots) || 0 };
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
ipcMain.handle('check-updates', () => updater.check(true));
ipcMain.handle('install-update', () => updater.install());

app.whenReady().then(() => {
  buildMenu();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
