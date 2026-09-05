/**
 * 渲染进程 API 适配层
 * - Electron：通过 preload 暴露的 cipherzip 调用主进程真实引擎
 * - 浏览器预览：使用演示模式（不真正写盘，但走相同 UI 流程）
 */

export interface PackRequest {
  inputs: string[]
  output: string
  password?: string
  keyfilePath?: string
  format?: string
  encryptFilenames?: boolean
  level?: number
}

export interface UnpackRequest {
  archive: string
  outputDir: string
  password?: string
  keyfilePath?: string
}

type ElectronAPI = {
  pickFiles: () => Promise<string[]>
  pickDir: () => Promise<string | null>
  pickSave: (defaultName: string) => Promise<string | null>
  pack: (req: PackRequest) => Promise<{ ok: boolean; output?: string; error?: string }>
  unpack: (req: UnpackRequest) => Promise<{ ok: boolean; files?: string[]; error?: string }>
  listCcz: (archive: string, password?: string, keyfilePath?: string) => Promise<{ ok: boolean; entries?: Array<{ path: string; size: number; isDir: boolean }>; error?: string }>
  p2pStart: (port?: number, nick?: string) => Promise<{ ok: boolean; port?: number; code?: string; error?: string }>
  p2pStop: () => Promise<{ ok: boolean }>
  p2pConnect: (code: string) => Promise<{ ok: boolean; nick?: string; error?: string }>
  p2pChat: (text: string) => Promise<{ ok: boolean }>
  p2pSendFile: (path: string) => Promise<{ ok: boolean; error?: string }>
  p2pEvents: (cb: (ev: { type: string; data: unknown }) => void) => () => void
  meshInit: (willing: boolean, maxGb: number) => Promise<{ ok: boolean; info?: unknown; error?: string }>
  meshPut: (filePath: string) => Promise<{ ok: boolean; hashes?: string[]; error?: string }>
  bridgeHealth: (baseUrl: string) => Promise<{ ok: boolean; data?: unknown }>
  bridgeRegister: (baseUrl: string) => Promise<{ ok: boolean; data?: unknown; error?: string }>
  getSettings: () => Promise<Record<string, unknown>>
  saveSettings: (s: Record<string, unknown>) => Promise<{ ok: boolean }>
  platform: string
}

declare global {
  interface Window {
    cipherzip?: ElectronAPI
  }
}

const hasElectron = () => typeof window !== 'undefined' && !!window.cipherzip

const demo = {
  p2pCode: 'able-acid-acre-aged-also-atom-aunt-auto-away-axis-back-bail-bake-ball-band-bank',
  listeners: new Set<(ev: { type: string; data: unknown }) => void>(),
}

function emit(type: string, data: unknown) {
  demo.listeners.forEach((cb) => cb({ type, data }))
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

export const api = {
  isElectron: hasElectron,

  async pickFiles(): Promise<string[]> {
    if (hasElectron()) return window.cipherzip!.pickFiles()
    return new Promise((resolve) => {
      const input = document.createElement('input')
      input.type = 'file'
      input.multiple = true
      input.onchange = () => {
        const names = [...(input.files || [])].map((f) => f.name)
        resolve(names.length ? names : ['demo/hello.txt', 'demo/photo.jpg'])
      }
      input.click()
    })
  },

  async pickDir(): Promise<string | null> {
    if (hasElectron()) return window.cipherzip!.pickDir()
    return 'demo-output'
  },

  async pickSave(defaultName: string): Promise<string | null> {
    if (hasElectron()) return window.cipherzip!.pickSave(defaultName)
    return defaultName
  },

  async pack(req: PackRequest) {
    if (hasElectron()) return window.cipherzip!.pack(req)
    await sleep(600)
    if (!req.password && !req.keyfilePath && (req.format === 'ccz' || !req.format)) {
      return { ok: false, error: '.ccz 强制加密，请设置密码或密钥文件' }
    }
    return { ok: true, output: req.output || 'demo.ccz' }
  },

  async unpack(req: UnpackRequest) {
    if (hasElectron()) return window.cipherzip!.unpack(req)
    await sleep(500)
    if (!req.password && !req.keyfilePath) return { ok: false, error: '需要密码或密钥文件' }
    return { ok: true, files: ['hello.txt', 'photo.jpg'] }
  },

  async listCcz(archive: string, password?: string, keyfilePath?: string) {
    if (hasElectron()) return window.cipherzip!.listCcz(archive, password, keyfilePath)
    if (!password && !keyfilePath) return { ok: false, error: '需要密钥' }
    return {
      ok: true,
      entries: [
        { path: 'hello.txt', size: 1024, isDir: false },
        { path: 'docs/', size: 0, isDir: true },
        { path: 'docs/readme.md', size: 2048, isDir: false },
      ],
    }
  },

  async p2pStart(port?: number, nick?: string) {
    if (hasElectron()) return window.cipherzip!.p2pStart(port, nick)
    emit('log', '演示模式 P2P 已启动')
    return { ok: true, port: port || 41234, code: demo.p2pCode }
  },

  async p2pStop() {
    if (hasElectron()) return window.cipherzip!.p2pStop()
    return { ok: true }
  },

  async p2pConnect(code: string) {
    if (hasElectron()) return window.cipherzip!.p2pConnect(code)
    emit('peer', { nick: '演示好友', joined: true })
    return { ok: true, nick: '演示好友' }
  },

  async p2pChat(text: string) {
    if (hasElectron()) return window.cipherzip!.p2pChat(text)
    emit('chat', { nick: '我', text })
    setTimeout(() => emit('chat', { nick: '演示好友', text: '收到：' + text }), 400)
    return { ok: true }
  },

  async p2pSendFile(path: string) {
    if (hasElectron()) return window.cipherzip!.p2pSendFile(path)
    emit('file', { path })
    return { ok: true }
  },

  p2pEvents(cb: (ev: { type: string; data: unknown }) => void) {
    if (hasElectron()) return window.cipherzip!.p2pEvents(cb)
    demo.listeners.add(cb)
    return () => { demo.listeners.delete(cb) }
  },

  async meshInit(willing: boolean, maxGb: number) {
    if (hasElectron()) return window.cipherzip!.meshInit(willing, maxGb)
    return { ok: true, info: { nodeId: 'demo-node', willing, maxGb, shardCount: 0 } }
  },

  async meshPut(filePath: string) {
    if (hasElectron()) return window.cipherzip!.meshPut(filePath)
    return { ok: true, hashes: ['abc', 'def'] }
  },

  async bridgeHealth(baseUrl: string) {
    if (hasElectron()) return window.cipherzip!.bridgeHealth(baseUrl)
    try {
      const r = await fetch(baseUrl.replace(/\/$/, '') + '/api/health')
      return { ok: r.ok, data: await r.json().catch(() => ({})) }
    } catch (e) {
      return { ok: false, data: { error: String(e) } }
    }
  },

  async bridgeRegister(baseUrl: string) {
    if (hasElectron()) return window.cipherzip!.bridgeRegister(baseUrl)
    try {
      const r = await fetch(baseUrl.replace(/\/$/, '') + '/api/client/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          clientId: 'web-preview',
          version: '1.0.0',
          features: ['compress', 'p2p', 'mesh'],
        }),
      })
      const data = await r.json().catch(() => ({}))
      return { ok: r.ok, data, error: data.error }
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  },

  async getSettings() {
    if (hasElectron()) return window.cipherzip!.getSettings()
    const raw = localStorage.getItem('cipherzip:settings')
    return raw ? JSON.parse(raw) : {}
  },

  async saveSettings(s: Record<string, unknown>) {
    if (hasElectron()) return window.cipherzip!.saveSettings(s)
    localStorage.setItem('cipherzip:settings', JSON.stringify(s))
    return { ok: true }
  },
}
