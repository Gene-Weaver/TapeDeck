'use strict';
// Auto-update from GitHub Releases (Gene-Weaver/TapeDeck) via electron-updater.
// Windows (NSIS) and Linux (AppImage) download and install in place. macOS builds are unsigned,
// and Squirrel.Mac refuses to install unsigned updates, so on macOS we only *check* and offer the
// download page. A .deb install gets the same "download" treatment because apt owns the files.
const { app, dialog, shell } = require('electron');
const RELEASES = 'https://github.com/Gene-Weaver/TapeDeck/releases/latest';

let autoUpdater = null;
let getWin = () => null;
let manualOnly = false;
let pendingVersion = null;
let downloaded = false;

function send(info) { const w = getWin(); if (w && !w.isDestroyed()) w.webContents.send('update', info); }

function setup(winGetter) {
  getWin = winGetter;
  if (!app.isPackaged) { send({ state: 'disabled', reason: 'development build' }); return; }
  try { ({ autoUpdater } = require('electron-updater')); } catch (e) { console.error('updater unavailable', e); return; }
  manualOnly = process.platform === 'darwin' || (process.platform === 'linux' && !process.env.APPIMAGE);
  autoUpdater.autoDownload = !manualOnly;
  autoUpdater.autoInstallOnAppQuit = !manualOnly;
  autoUpdater.allowPrerelease = false;
  autoUpdater.logger = null;

  autoUpdater.on('checking-for-update', () => send({ state: 'checking' }));
  autoUpdater.on('update-not-available', () => send({ state: 'none', version: app.getVersion() }));
  autoUpdater.on('update-available', (info) => {
    pendingVersion = info.version;
    send({ state: 'available', version: info.version, manual: manualOnly, url: RELEASES });
    if (manualOnly) offerDownload(info.version);
  });
  autoUpdater.on('download-progress', (p) => send({ state: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => {
    downloaded = true; pendingVersion = info.version;
    send({ state: 'downloaded', version: info.version });
    const w = getWin();
    dialog.showMessageBox(w, { type: 'info', buttons: ['Restart now', 'Later'], defaultId: 0, cancelId: 1,
      title: 'Update ready', message: `TapeDeck ${info.version} has been downloaded.`, detail: 'Restart to install it. It will also install the next time you quit.' })
      .then(r => { if (r.response === 0) autoUpdater.quitAndInstall(); });
  });
  autoUpdater.on('error', (err) => {
    const msg = String(err && err.message || err);
    if (/No published versions/i.test(msg)) return send({ state: 'none', version: app.getVersion() });   // repo has no release yet
    send({ state: 'error', message: msg });
  });

  setTimeout(() => check(false), 6000);
  setInterval(() => check(false), 6 * 60 * 60 * 1000);
}

function offerDownload(version) {
  const w = getWin();
  dialog.showMessageBox(w, { type: 'info', buttons: ['Open download page', 'Later'], defaultId: 0, cancelId: 1,
    title: 'Update available', message: `TapeDeck ${version} is available (you have ${app.getVersion()}).`,
    detail: process.platform === 'darwin' ? 'macOS builds are not code-signed, so updates are installed by downloading the new DMG and replacing the app.' : 'Download the new package from GitHub Releases.' })
    .then(r => { if (r.response === 0) shell.openExternal(RELEASES); });
}

async function check(interactive) {
  if (!autoUpdater) {
    if (interactive) dialog.showMessageBox(getWin(), { type: 'info', message: 'Updates are only checked in packaged builds.', detail: `Running TapeDeck ${app.getVersion()} from source.` });
    return { state: 'disabled' };
  }
  try {
    const r = await autoUpdater.checkForUpdates();
    const latest = r && r.updateInfo && r.updateInfo.version;
    const isNewer = latest && latest !== app.getVersion() && pendingVersion === latest;
    if (interactive && !isNewer) dialog.showMessageBox(getWin(), { type: 'info', message: 'TapeDeck is up to date.', detail: `Version ${app.getVersion()}` });
    else if (interactive && isNewer && downloaded) dialog.showMessageBox(getWin(), { type: 'info', buttons: ['Restart now', 'Later'], message: `TapeDeck ${latest} is downloaded.` }).then(x => { if (x.response === 0) autoUpdater.quitAndInstall(); });
    return { state: isNewer ? 'available' : 'none', version: latest };
  } catch (e) {
    const msg = String(e && e.message || e);
    if (/No published versions/i.test(msg)) { if (interactive) dialog.showMessageBox(getWin(), { type: 'info', message: 'TapeDeck is up to date.', detail: `Version ${app.getVersion()} (no releases published yet)` }); return { state: 'none' }; }
    if (interactive) dialog.showMessageBox(getWin(), { type: 'warning', message: 'Could not check for updates.', detail: msg });
    return { state: 'error', message: String(e && e.message || e) };
  }
}

function install() { if (autoUpdater && downloaded) autoUpdater.quitAndInstall(); }

module.exports = { setup, check, install };
