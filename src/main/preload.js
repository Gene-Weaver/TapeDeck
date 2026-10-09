'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => { const h = (_e, v) => cb(v); ipcRenderer.on(channel, h); return () => ipcRenderer.removeListener(channel, h); };

contextBridge.exposeInMainWorld('tapedeck', {
  boot: () => ipcRenderer.sendSync('boot'),
  flushSync: (payload) => ipcRenderer.sendSync('store:flush-sync', payload),
  config: () => ipcRenderer.invoke('config'),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
  layouts: {
    list: () => ipcRenderer.invoke('layouts:list'),
    read: (id) => ipcRenderer.invoke('layouts:read', id),
    write: (id, text) => ipcRenderer.invoke('layouts:write', { id, text }),
    create: (name, text) => ipcRenderer.invoke('layouts:create', { name, text }),
    rename: (id, name) => ipcRenderer.invoke('layouts:rename', { id, name }),
    remove: (id, name) => ipcRenderer.invoke('layouts:delete', { id, name }),
    revert: (id, name) => ipcRenderer.invoke('layouts:revert', { id, name }),
    restore: () => ipcRenderer.invoke('layouts:restore'),
    reveal: () => ipcRenderer.invoke('layouts:reveal'),
    importFiles: () => ipcRenderer.invoke('layouts:import'),
    exportFile: (text, fileName) => ipcRenderer.invoke('layouts:export', { text, fileName }),
  },
  status: (opts) => ipcRenderer.invoke('status', opts),
  print: (body) => ipcRenderer.invoke('print', body),
  job: (id) => ipcRenderer.invoke('job', id),
  cancel: (id) => ipcRenderer.invoke('cancel', id),
  feedAndCut: (body) => ipcRenderer.invoke('feed-cut', body),
  exportPngs: (body) => ipcRenderer.invoke('export', body),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  openPath: (p) => ipcRenderer.invoke('open-path', p),
  nativeEdit: (cmd) => ipcRenderer.invoke('native-edit', cmd),
  checkUpdates: () => ipcRenderer.invoke('check-updates'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  onJobProgress: on('job-progress'),
  onUpdate: on('update'),
  onMenu: on('menu'),
});
