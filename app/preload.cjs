// Sandboxed preload must be CommonJS. Exposes window.mk10; no Node access leaks to the page.
const { contextBridge, ipcRenderer, webUtils } = require('electron')

const call = (name) => (...args) => ipcRenderer.invoke(`mk10:${name}`, ...args)
const on = (channel) => (cb) => {
  const fn = (_e, data) => cb(data)
  ipcRenderer.on(`mk10:${channel}`, fn)
  return () => ipcRenderer.removeListener(`mk10:${channel}`, fn)
}

contextBridge.exposeInMainWorld('mk10', {
  open: call('open'),
  openPath: call('openPath'),
  save: call('save'),
  saveAs: call('saveAs'),
  summary: call('summary'),
  asset: call('asset'),
  setKeyTitle: call('setKeyTitle'),
  setKeyActionField: call('setKeyActionField'),
  setKeyImage: call('setKeyImage'),
  setBackgroundVideo: call('setBackgroundVideo'),
  push: call('push'),
  mcpToggle: call('mcpToggle'),
  settings: call('settings'),
  setSsh: call('setSsh'),
  setPref: call('setPref'),
  pathFor: (file) => webUtils.getPathForFile(file),
  onChange: on('change'),
  onStatus: on('status'),
  onLog: on('log'),
  onSelect: on('select'),
  onMcp: on('mcp'),
  onOpenSettings: on('openSettings'),
})
