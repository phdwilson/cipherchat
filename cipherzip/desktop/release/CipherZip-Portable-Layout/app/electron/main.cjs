/**
 * CipherZip Electron 主进程
 * 负责：窗口、系统对话框、调用 @cipherzip/core 引擎、P2P/Mesh 生命周期
 */
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')

let mainWindow = null
let p2pNode = null
let currentPeer = null
let mesh = null
let core = null

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json')
}

async function loadCore() {
  if (core) return core
  // workspace 开发：从 monorepo core dist 加载；打包后从 resources
  const candidates = [
    path.join(__dirname, '..', '..', 'core', 'dist', 'index.js'),
    path.join(process.resourcesPath || '', 'core', 'index.js'),
    path.join(__dirname, '..', 'node_modules', '@cipherzip', 'core', 'dist', 'index.js'),
  ]
  let lastErr
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) {
        core = await import(pathToFileURL(c).href)
        return core
      }
    } catch (e) {
      lastErr = e
    }
  }
  // 尝试 package name
  try {
    core = await import('@cipherzip/core')
    return core
  } catch (e) {
    lastErr = e
  }
  throw lastErr || new Error('无法加载 @cipherzip/core')
}

function pathToFileURL(p) {
  const { pathToFileURL: f } = require('url')
  return f(p)
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 960,
    minHeight: 640,
    title: 'CipherZip 密匣',
    backgroundColor: '#f5f6f8',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    show: false,
  })
  mainWindow.once('ready-to-show', () => mainWindow.show())

  const devUrl = process.env.VITE_DEV_SERVER_URL
  if (devUrl) {
    mainWindow.loadURL(devUrl)
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }
}

function sendP2P(type, data) {
  mainWindow?.webContents.send('p2p-event', { type, data })
}

function keyFrom(password, keyfilePath) {
  if (password && keyfilePath) return { type: 'hybrid', password, keyfilePath }
  if (keyfilePath) return { type: 'keyfile', path: keyfilePath }
  if (password) return { type: 'password', password }
  return undefined
}

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', async () => {
  try { await p2pNode?.stop() } catch {}
})

ipcMain.handle('pick-files', async () => {
  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openFile', 'multiSelections'] })
  return r.canceled ? [] : r.filePaths
})

ipcMain.handle('pick-dir', async () => {
  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] })
  return r.canceled ? null : r.filePaths[0]
})

ipcMain.handle('pick-save', async (_e, defaultName) => {
  const r = await dialog.showSaveDialog(mainWindow, { defaultPath: defaultName })
  return r.canceled ? null : r.filePath
})

ipcMain.handle('pack', async (_e, req) => {
  try {
    const c = await loadCore()
    const key = keyFrom(req.password, req.keyfilePath)
    const output = await c.packArchive({
      inputs: req.inputs,
      output: req.output,
      format: req.format,
      password: req.password,
      keyfilePath: req.keyfilePath,
      key,
      encryptFilenames: req.encryptFilenames,
      level: req.level,
    })
    return { ok: true, output }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
})

ipcMain.handle('unpack', async (_e, req) => {
  try {
    const c = await loadCore()
    const files = await c.unpackArchive({
      archive: req.archive,
      outputDir: req.outputDir,
      password: req.password,
      keyfilePath: req.keyfilePath,
      key: keyFrom(req.password, req.keyfilePath),
    })
    return { ok: true, files }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
})

ipcMain.handle('list-ccz', async (_e, archive, password, keyfilePath) => {
  try {
    const c = await loadCore()
    const key = keyFrom(password, keyfilePath)
    if (!key) return { ok: false, error: '需要密码或密钥文件' }
    const { entries } = await c.listCcz(archive, key)
    return { ok: true, entries }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
})

ipcMain.handle('p2p-start', async (_e, port, nick) => {
  try {
    const c = await loadCore()
    if (p2pNode) await p2pNode.stop()
    p2pNode = new c.P2PNode({
      nick: nick || undefined,
      downloadDir: path.join(app.getPath('documents'), 'CipherZip', 'inbox'),
      events: {
        onLog: (m) => sendP2P('log', m),
        onChat: (peer, text) => sendP2P('chat', { nick: peer.nick, text }),
        onFileReceived: (_p, pth) => sendP2P('file', { path: pth }),
        onPeer: (peer, joined) => sendP2P('peer', { nick: peer.nick, joined }),
      },
    })
    const listen = await p2pNode.start(port || 0, '0.0.0.0')
    const host = '127.0.0.1'
    const share = p2pNode.makeShare(host)
    return { ok: true, port: listen, code: share.code, qr: share.qr }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
})

ipcMain.handle('p2p-stop', async () => {
  await p2pNode?.stop()
  p2pNode = null
  currentPeer = null
  return { ok: true }
})

ipcMain.handle('p2p-connect', async (_e, code) => {
  try {
    if (!p2pNode) return { ok: false, error: '请先启动节点' }
    currentPeer = await p2pNode.connectShare(code)
    return { ok: true, nick: currentPeer.nick }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
})

ipcMain.handle('p2p-chat', async (_e, text) => {
  if (!p2pNode || !currentPeer) return { ok: false, error: '未连接' }
  p2pNode.sendChat(currentPeer, text)
  sendP2P('chat', { nick: '我', text })
  return { ok: true }
})

ipcMain.handle('p2p-send-file', async (_e, filePath) => {
  try {
    if (!p2pNode || !currentPeer) return { ok: false, error: '未连接' }
    await p2pNode.sendFile(currentPeer, filePath)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
})

ipcMain.handle('mesh-init', async (_e, willing, maxGb) => {
  try {
    const c = await loadCore()
    const dir = path.join(app.getPath('userData'), 'mesh')
    mesh = new c.MeshStorage({
      dataDir: dir,
      willing: !!willing,
      maxStorageBytes: (maxGb || 5) * 1024 ** 3,
    })
    await mesh.init()
    return { ok: true, info: mesh.info() }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
})

ipcMain.handle('mesh-put', async (_e, filePath) => {
  try {
    if (!mesh) return { ok: false, error: '请先初始化 Mesh' }
    const data = fs.readFileSync(filePath)
    const hashes = await mesh.putObject(data)
    return { ok: true, hashes }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
})

ipcMain.handle('bridge-health', async (_e, baseUrl) => {
  try {
    const c = await loadCore()
    const b = new c.CipherChatBridge({ baseUrl })
    return await b.health()
  } catch (e) {
    return { ok: false, data: { error: String(e) } }
  }
})

ipcMain.handle('bridge-register', async (_e, baseUrl) => {
  try {
    const c = await loadCore()
    const b = new c.CipherChatBridge({ baseUrl })
    const data = await b.register({
      version: app.getVersion(),
      features: ['compress', 'p2p', 'mesh', 'ccz'],
      p2pPort: p2pNode?.listenPort,
      meshWilling: mesh?.willing,
      nodeId: mesh?.nodeId,
    })
    return { ok: true, data }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
})

ipcMain.handle('get-settings', async () => {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))
  } catch {
    return {}
  }
})

ipcMain.handle('save-settings', async (_e, s) => {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true })
  fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2))
  return { ok: true }
})
