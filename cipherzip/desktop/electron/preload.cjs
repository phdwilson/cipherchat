const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('cipherzip', {
  platform: process.platform,
  pickFiles: () => ipcRenderer.invoke('pick-files'),
  pickDir: () => ipcRenderer.invoke('pick-dir'),
  pickSave: (defaultName) => ipcRenderer.invoke('pick-save', defaultName),
  pack: (req) => ipcRenderer.invoke('pack', req),
  unpack: (req) => ipcRenderer.invoke('unpack', req),
  listCcz: (archive, password, keyfilePath) => ipcRenderer.invoke('list-ccz', archive, password, keyfilePath),
  p2pStart: (port, nick) => ipcRenderer.invoke('p2p-start', port, nick),
  p2pStop: () => ipcRenderer.invoke('p2p-stop'),
  p2pConnect: (code) => ipcRenderer.invoke('p2p-connect', code),
  p2pChat: (text) => ipcRenderer.invoke('p2p-chat', text),
  p2pSendFile: (path) => ipcRenderer.invoke('p2p-send-file', path),
  p2pEvents: (cb) => {
    const listener = (_e, payload) => cb(payload)
    ipcRenderer.on('p2p-event', listener)
    return () => ipcRenderer.removeListener('p2p-event', listener)
  },
  meshInit: (willing, maxGb) => ipcRenderer.invoke('mesh-init', willing, maxGb),
  meshPut: (filePath) => ipcRenderer.invoke('mesh-put', filePath),
  bridgeHealth: (baseUrl) => ipcRenderer.invoke('bridge-health', baseUrl),
  bridgeRegister: (baseUrl) => ipcRenderer.invoke('bridge-register', baseUrl),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (s) => ipcRenderer.invoke('save-settings', s),
})
