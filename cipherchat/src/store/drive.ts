'use client'
// 隐私网盘状态管理：解锁/创建、文件列表、加密上传下载、删除重命名、多端同步
import { create } from 'zustand'
import { io, Socket } from 'socket.io-client'
import { toast } from 'sonner'
import { deriveDriveKeys, deriveAdminKeyHash, deriveProbeHash, sealJSON, openJSON, uploadEncryptedFile } from '@/lib/crypto'
import { explainError, errorToastDescription, explainStatus } from '@/lib/errors'
import { useChatStore, RuntimeConfig } from './chat'

export interface DriveFileItem {
  id: string
  name: string
  size: number
  mime: string
  createdAt: string
  totalChunks: number
}

export interface DriveUpload {
  localId: string
  name: string
  size: number
  progress: number
  status: 'uploading' | 'finishing' | 'done' | 'error'
  error?: string
}

interface DriveStore {
  unlocked: boolean
  unlocking: boolean
  driveId: string
  token: string
  deviceId: string
  driveKey: CryptoKey | null
  files: DriveFileItem[]
  usedBytes: number
  quotaBytes: number
  uploads: DriveUpload[]
  errorMsg: string | null
  listLoading: boolean
  wiped: boolean // 自毁已触发（页面层监听后重置）

  unlock: (driveId: string, secretKey: string, create: boolean, adminKey?: string) => Promise<{ newId?: string }>
  lock: () => void
  refresh: () => Promise<void>
  uploadFiles: (files: File[]) => Promise<void>
  deleteFiles: (ids: string[]) => Promise<void>
  deleteAll: () => Promise<void>
  rename: (id: string, newName: string) => Promise<void>
  notifyChanged: () => void
}

interface DriveMeta {
  name: string
  size: number
  mime: string
  createdAt?: string
}

let dsocket: Socket | null = null

export const useDriveStore = create<DriveStore>((set, get) => ({
  unlocked: false,
  unlocking: false,
  driveId: '',
  token: '',
  deviceId: '',
  driveKey: null,
  files: [],
  usedBytes: 0,
  quotaBytes: 0,
  uploads: [],
  errorMsg: null,
  listLoading: false,
  wiped: false,

  unlock: async (driveIdInput, secretKey, create, adminKey) => {
    if (get().unlocking) return {}
    set({ unlocking: true, errorMsg: null })
    try {
      const cfg: RuntimeConfig | null = useChatStore.getState().config
      if (!cfg) throw new Error('配置未加载')

      let driveId = driveIdInput.trim().toUpperCase()

      if (create && !driveId) {
        // 先向服务器要一个随机 ID
        const rid = await fetch('/api/drive/new-id', { method: 'POST' })
        if (!rid.ok) {
          const j = await rid.json().catch(() => ({}))
          throw new Error(j.error || '生成网盘 ID 失败')
        }
        const { driveId: newId } = await rid.json()
        driveId = newId
      }
      if (!/^[A-Z0-9]{8}$/.test(driveId)) throw new Error('网盘 ID 应为 8 位字母数字')

      const keys = await deriveDriveKeys(driveId, secretKey)
      const probeHash = await deriveProbeHash(secretKey) // 自毁探测：个人密钥命中自毁密钥即全局销毁
      const body: Record<string, unknown> = { driveId, keyHash: keys.keyHash, create, probeHash }
      if (create) {
        if (!adminKey) throw new Error('请输入管理员超级密钥')
        body.adminKeyHash = await deriveAdminKeyHash(adminKey) // 创建授权
        body.adminProbeHash = await deriveProbeHash(adminKey) // 超级密钥输入同样参与自毁探测
      }
      const res = await fetch('/api/drive/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))
      if (data?.destroyed) {
        set({ unlocking: false, wiped: true })
        return {}
      }
      if (!res.ok) {
        throw new Error(data?.error || '解锁失败')
      }

      set({
        unlocked: true,
        unlocking: false,
        driveId,
        token: data.token,
        deviceId: data.deviceId,
        driveKey: keys.aesKey,
        usedBytes: data.usedBytes,
        quotaBytes: data.quotaBytes,
        files: [],
        uploads: [],
      })
      try {
        localStorage.setItem('cipherdrive:last', JSON.stringify({ driveId }))
      } catch { /* ignore */ }

      // 多端同步 socket
      dsocket?.disconnect()
      dsocket = io(`/?XTransformPort=${cfg.wsPort}`, {
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionDelay: 800,
        timeout: 12000,
      })
      dsocket.on('connect', () => dsocket?.emit('drive:join', { token: data.token }))
      dsocket.on('drive:changed', () => get().refresh())
      dsocket.on('global:wipe', () => set({ wiped: true }))

      await get().refresh()
      return create ? { newId: driveId } : {}
    } catch (e) {
      set({ unlocking: false })
      throw e
    }
  },

  lock: () => {
    dsocket?.disconnect()
    dsocket = null
    const token = get().token
    if (token) {
      fetch('/api/drive/session', { method: 'DELETE', headers: { 'x-session-token': token } }).catch(() => {})
    }
    set({
      unlocked: false, driveId: '', token: '', deviceId: '', driveKey: null,
      files: [], usedBytes: 0, quotaBytes: 0, uploads: [], errorMsg: null, wiped: false,
    })
  },

  refresh: async () => {
    const { token, driveKey } = get()
    if (!token || !driveKey) return
    set({ listLoading: true })
    try {
      const res = await fetch('/api/drive/files', { headers: { 'x-session-token': token } })
      // v1.8.0：列表加载失败不再静默返回（否则用户看到旧列表却以为是最新的）
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        const ex = explainStatus(res.status, j?.error || '', '网盘列表')
        toast.error(ex.title, { description: errorToastDescription(ex) })
        // 会话过期时直接锁定（不锁定会让用户误以为还能操作）
        if (res.status === 401) get().lock()
        return
      }
      const { files, usedBytes, quotaBytes } = await res.json()
      // v1.7.0：并行解密所有文件元数据（此前串行 await，文件多时首屏明显变慢）
      const parsed = await Promise.all(
        (files as Array<{ id: string; totalChunks: number; totalBytes: number; meta: string; createdAt: string }>).map(async (f) => {
          const meta = await openJSON<DriveMeta>(driveKey, f.meta)
          if (!meta) return null
          return {
            id: f.id,
            name: meta.name,
            size: meta.size ?? f.totalBytes,
            mime: meta.mime || 'application/octet-stream',
            createdAt: f.createdAt,
            totalChunks: f.totalChunks,
          } satisfies DriveFileItem
        })
      )
      set({ files: parsed.filter(Boolean) as DriveFileItem[], usedBytes, quotaBytes })
    } finally {
      set({ listLoading: false })
    }
  },

  uploadFiles: async (files) => {
    const cfg: RuntimeConfig | null = useChatStore.getState().config
    const { driveKey, token, quotaBytes, usedBytes } = get()
    if (!driveKey || !token || !cfg) return

    // 预校验配额
    const incoming = files.reduce((s, f) => s + f.size, 0)
    if (usedBytes + incoming > quotaBytes) {
      set({ errorMsg: '剩余空间不足，无法一次性上传这些文件' })
      return
    }

    for (const file of files) {
      if (file.size > cfg.maxDriveFileBytes) {
        set((s) => ({
          uploads: [...s.uploads, {
            localId: crypto.randomUUID(), name: file.name, size: file.size,
            progress: 0, status: 'error', error: '超过单文件 5GB 上限',
          }],
        }))
        continue
      }
      const localId = crypto.randomUUID()
      set((s) => ({
        uploads: [...s.uploads, { localId, name: file.name, size: file.size, progress: 0, status: 'uploading' }],
      }))
      try {
        const result = await uploadEncryptedFile({
          file,
          key: driveKey,
          chunkSize: cfg.chunkSize,
          initUrl: '/api/drive/files',
          chunkUrl: (fid, idx) => `/api/drive/files/chunk?fileId=${fid}&index=${idx}`,
          completeUrl: '/api/drive/files/complete',
          token,
          concurrency: 2,
          meta: { name: file.name, size: file.size, mime: file.type || 'application/octet-stream' },
          onProgress: (sent, total) => {
            set((s) => ({
              uploads: s.uploads.map((u) => (u.localId === localId ? { ...u, progress: sent / total } : u)),
            }))
          },
        })
        void result
        set((s) => ({ uploads: s.uploads.map((u) => (u.localId === localId ? { ...u, status: 'done' } : u)) }))
        setTimeout(() => set((s) => ({ uploads: s.uploads.filter((u) => u.localId !== localId) })), 2500)
      } catch (e) {
        // v1.8.0：上传失败带原因与修复方式（此前仅一句 e.message，网络类英文错误直接裸奔）
        const ex = explainError(e, `上传「${file.name}」`)
        set((s) => ({
          uploads: s.uploads.map((u) =>
            u.localId === localId ? { ...u, status: 'error', error: ex.title + ' — ' + ex.reason } : u
          ),
        }))
        toast.error(ex.title, { description: errorToastDescription(ex), duration: 10000 })
      }
    }
    await get().refresh()
    get().notifyChanged()
  },

  deleteFiles: async (ids) => {
    const { token } = get()
    if (!token) return
    const res = await fetch('/api/drive/files', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json', 'x-session-token': token },
      body: JSON.stringify({ ids }),
    })
    if (res.ok) {
      const d = await res.json().catch(() => ({}))
      toast.success(`已删除 ${d.deleted ?? ids.length} 个文件`)
      await get().refresh()
      get().notifyChanged()
    } else {
      // v1.8.0：带原因与修复方式（配额扣减失败会在这里显式提示重算）
      const j = await res.json().catch(() => ({}))
      const ex = explainStatus(res.status, j?.error || '', '删除文件')
      toast.error(ex.title, { description: errorToastDescription(ex), duration: 10000 })
      await get().refresh()
    }
  },

  deleteAll: async () => {
    const { token } = get()
    if (!token) return
    const res = await fetch('/api/drive/files', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json', 'x-session-token': token },
      body: JSON.stringify({ all: true }),
    })
    if (res.ok) {
      toast.success('网盘已清空')
      set({ files: [], usedBytes: 0 })
      get().notifyChanged()
    } else {
      toast.error('清空失败，请重试')
    }
  },

  rename: async (id, newName) => {
    const { token, driveKey, files } = get()
    if (!token || !driveKey) return
    const target = files.find((f) => f.id === id)
    if (!target) return
    const meta = await sealJSON(driveKey, { name: newName, size: target.size, mime: target.mime })
    const res = await fetch(`/api/drive/files/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-session-token': token },
      body: JSON.stringify({ meta }),
    })
    if (res.ok) {
      set((s) => ({ files: s.files.map((f) => (f.id === id ? { ...f, name: newName } : f)) }))
      toast.success('已重命名')
      get().notifyChanged()
    }
  },

  notifyChanged: () => {
    dsocket?.emit('drive:changed', {})
  },
}))

// 供组件使用：拿到当前 socket（例如主动刷新）
export function getDriveSocket() {
  return dsocket
}
