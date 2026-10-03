'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tapedeck', {
  config: () => ipcRenderer.invoke('config'),
  status: (opts) => ipcRenderer.invoke('status', opts),
  print: (body) => ipcRenderer.invoke('print', body),
  job: (id) => ipcRenderer.invoke('job', id),
  cancel: (id) => ipcRenderer.invoke('cancel', id),
  feedAndCut: (body) => ipcRenderer.invoke('feed-cut', body),
  exportPngs: (body) => ipcRenderer.invoke('export', body),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  openPath: (p) => ipcRenderer.invoke('open-path', p),
  checkUpdates: () => ipcRenderer.invoke('check-updates'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  onJobProgress: (cb) => { const h = (_e, job) => cb(job); ipcRenderer.on('job-progress', h); return () => ipcRenderer.removeListener('job-progress', h); },
  onUpdate: (cb) => { const h = (_e, info) => cb(info); ipcRenderer.on('update', h); return () => ipcRenderer.removeListener('update', h); },
  onMenu: (cb) => { const h = (_e, cmd) => cb(cmd); ipcRenderer.on('menu', h); return () => ipcRenderer.removeListener('menu', h); },
});
