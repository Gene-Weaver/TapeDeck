// Thin adapter over the preload bridge so the rest of the UI never touches IPC directly.
const bridge = window.tapedeck;
if (!bridge) throw new Error('TapeDeck must run inside the Electron app (preload bridge missing).');

export const api = {
  config: () => bridge.config(),
  status: (opts) => bridge.status(opts),
  print: (body) => bridge.print(body),
  job: (id) => bridge.job(id),
  cancel: (id) => bridge.cancel(id),
  feedAndCut: (body) => bridge.feedAndCut(body),
  exportPngs: (body) => bridge.exportPngs(body),
  openExternal: (url) => bridge.openExternal(url),
  openPath: (p) => bridge.openPath(p),
  checkUpdates: () => bridge.checkUpdates(),
  installUpdate: () => bridge.installUpdate(),
  onJobProgress: (cb) => bridge.onJobProgress(cb),
  onUpdate: (cb) => bridge.onUpdate(cb),
  onMenu: (cb) => bridge.onMenu(cb),
};

/** 1-bit canvas -> Uint8Array(width*height), 1 = black. */
export function canvasToPixels(canvas) {
  const { width, height } = canvas;
  const d = canvas.getContext('2d').getImageData(0, 0, width, height).data;
  const out = new Uint8Array(width * height);
  for (let i = 0, p = 0; p < out.length; i += 4, p++) out[p] = d[i] < 128 ? 1 : 0;
  return out;
}
