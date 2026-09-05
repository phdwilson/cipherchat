'use client'
// 聊天状态管理：加入/消息/在线设备/正在输入/上传/删除
import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { io, Socket } from 'socket.io-client'
import { toast } from 'sonner'
import {
  ChatKeys,
  deriveChatKeys,
  deriveProbeHash,
  sealJSON,
  openJSON,
  uploadEncryptedFile,
  randomNick,
  type UploadResumeState,
} from '@/lib/crypto'
import { randomGreeting, timeAgo } from '@/lib/greetings'

export { timeAgo }

export interface RuntimeConfig {
  appName: string
  wsPort: number
  chunkSize: number
  maxChatFileBytes: number
  maxDriveFileBytes: number
  driveQuotaBytes: number
  voiceEnabled?: boolean
  whisperEnabled?: boolean
  friendEnabled?: boolean
  avatarUploadEnabled?: boolean
  p2pEnabled?: boolean
  allowHiddenGeo?: boolean // v1.4.3：是否允许普通用户选择「不披露 IP/地区」（管理员开关）
}

export interface ChatFileMeta {
  fileId: string
  name: string
  size: number
  mime: string
  viewOnce?: boolean // v1.7.0 闪照：阅后即焚（服务器首次下载后真焚毁）
}

export interface VoiceClipMeta {
  fileId: string
  duration: number // 秒
  size: number
}

export interface ReactionGroup {
  emoji: string
  readerIds: string[] // 回应者 pubId 列表（含自己时高亮）
}

export interface ChatMsg {
  id: string
  senderId: string
  mine: boolean
  createdAt: string
  // system = 本地系统提示；sticker = 大表情贴纸；voice = 语音消息；toy = v1.6.0 玩具指令结果
  kind: 'text' | 'file' | 'system' | 'sticker' | 'voice' | 'toy'
  text?: string
  nick?: string
  file?: ChatFileMeta
  voice?: VoiceClipMeta
  toy?: import('@/lib/toys').ToyPayload // v1.6.0 骰子/硬币/猜拳等
  replyToId?: string | null
  clientId?: string | null
  status?: 'sending' | 'sent' | 'read' | 'failed' // 仅自己消息的状态：转圈/送达单勾/已读双勾/失败
  burnAt?: string | null // v1.5.0 阅后即焚到期时间
  readers?: Array<{ readerId: string; readAt: string }> // v1.5.0 谁读了我发的消息（懒加载填充）
  reactions?: ReactionGroup[] // v1.6.0 表情回应
  pollVotes?: Record<string, number> // v1.7.0 加密投票：pubId -> optionIndex
}

export interface PresenceDevice {
  deviceId: string
  ua: { deviceType: string; label: string; os: string; browser: string }
  ip: string
  region: string
  flagEmoji?: string
  networkType?: 'lan' | 'wan' | 'unknown' // 局域网 / 公网
  deviceInfoEnc?: string // 加密的设备详情（型号/屏幕/触摸）
  nickEnc?: string
  avatarEnc?: string // 加密的自定义头像（base64 data URL）
  moodEnc?: string // v1.7.0 加密心情状态
  joinedAt: number
  online?: boolean
  lastSeen?: string
  geoDisclosure?: 'full' | 'region' | 'hidden' // v1.4.3：该成员的 IP 披露级别
}

export interface DeviceInfo {
  browser: string
  os: string
  model: string
  screen: string
  touch: boolean
}

export interface ChatUpload {
  localId: string
  name: string
  size: number
  mime: string
  progress: number
  status: 'uploading' | 'sending' | 'done' | 'error'
  error?: string
}

interface Envelope {
  v: number
  nick: string
  kind: 'text' | 'file' | 'sticker' | 'voice' | 'toy'
  text?: string
  file?: ChatFileMeta
  voice?: VoiceClipMeta
  toy?: import('@/lib/toys').ToyPayload
}

export interface ChatStore {
  config: RuntimeConfig | null
  joined: boolean
  joining: boolean
  channelId: string
  nickname: string
  password: string // 当前会话持有的频道密码（仅内存；用于免密钥邀请与轮换后自动重进）
  connectionMode: 'relay' | 'p2p' // v1.4.3：连接模式（加入时选定；同频道 ID 不同模式互不可见）
  deviceId: string
  token: string
  channelKey: CryptoKey | null
  messages: ChatMsg[]
  presence: PresenceDevice[]
  typing: { deviceId: string; at: number }[]
  memberRoles: Map<string, 'owner' | 'admin' | 'member' | 'observer'> // v1.5.0 成员角色缓存
  uploads: ChatUpload[]
  wsStatus: 'connecting' | 'online' | 'offline' | 'error'
  errorMsg: string | null
  hasMore: boolean
  loadingHistory: boolean
  wiped: boolean // 自毁已触发（页面层监听后重置到首页）
  adminVerified: boolean // /admin 超级密钥验证通过（仅本会话内存）
  adminKeyHashCache: string | null
  unreadCount: number // v1.6.0 未读消息计数（页面不可见或未查看频道时累积，标题栏提醒）

  setConfig: (c: RuntimeConfig) => void
  join: (channelId: string, password: string, nickname: string, mode?: 'relay' | 'p2p', geoDisclosure?: 'full' | 'region' | 'hidden') => Promise<void>
  leave: () => void
  sendText: (text: string, replyToId?: string | null, burnAfterSec?: number | null) => Promise<void>
  sendToy: (toy: import('@/lib/toys').ToyPayload) => Promise<void> // v1.6.0 玩具指令
  toggleReaction: (messageId: string, emoji: string) => void // v1.6.0 表情回应（再点一次取消）
  markViewed: () => void // v1.6.0 清零未读
  sendSticker: (emoji: string) => Promise<void>
  sendVoiceClip: (blob: Blob, durationSec: number) => Promise<void>
  uploadAndSendFile: (file: File, replyToId?: string | null, opts?: { viewOnce?: boolean }) => Promise<void>
  deleteMessages: (ids: string[]) => Promise<void>
  clearChannel: () => Promise<void>
  loadHistory: () => Promise<void>
  setTyping: (on: boolean) => void
  removeUpload: (localId: string) => void
  setNickname: (nick: string) => Promise<void>
  setAvatar: (b64: string | null) => Promise<void>
  setMood: (mood: string) => Promise<void> // v1.7.0 心情状态（空串清除）
  addSystem: (text: string) => void
  fetchReaders: (ids: string[]) => Promise<void> // v1.5.0 懒加载「谁读了」
  sendVote: (messageId: string, optionIndex: number) => void // v1.7.0 加密投票
  myRole: () => 'owner' | 'admin' | 'member' | 'observer' // v1.5.0 查询我的角色（异步结果写入 memberRoles）
}

let socket: Socket | null = null
let typingEmitAt = 0

// v1.7.0：加入纪元计数器 —— 每次 join/leave 自增；
// loadHistory 等异步路径回包后与当前纪元比对，防止慢响应把旧频道消息并入新频道
let joinEpoch = 0

// v1.7.0：消息条数上限（本地内存保护，超出时裁剪最旧的非未读消息）
const MAX_LOCAL_MESSAGES = 2000

// v1.7.0：本地消息裁剪（保留最新的 MAX_LOCAL_MESSAGES 条）
function trimMessages(list: ChatMsg[]): ChatMsg[] {
  if (list.length <= MAX_LOCAL_MESSAGES) return list
  return list.slice(list.length - MAX_LOCAL_MESSAGES)
}

// v1.6.0：页面处于后台/失焦时收到的消息计入未读（SSR/无 document 环境视为聚焦）
function documentHasFocus(): boolean {
  try {
    return typeof document === 'undefined' || document.visibilityState === 'visible'
  } catch {
    return true
  }
}

// 已读回执上报（/readtip off 时不再上报）
let reportedReadIds = new Set<string>()
let pendingReadIds: string[] = [] // socket 未就绪时排队，连接建立后补发

function getOrCreatePubId(): string {
  try {
    let id = localStorage.getItem('cipherchat:devid')
    if (!id) {
      id = crypto.randomUUID()
      localStorage.setItem('cipherchat:devid', id)
    }
    return id
  } catch {
    return crypto.randomUUID()
  }
}

// 采集高精度设备信息（Chromium UA-CH 可得真实机型），加密后随加入请求提交
async function collectDeviceInfo(): Promise<DeviceInfo> {
  const ua = navigator.userAgent
  let browser = '未知浏览器'
  if (/Edg\//.test(ua)) browser = 'Edge'
  else if (/OPR\/|Opera/.test(ua)) browser = 'Opera'
  else if (/Firefox\//.test(ua)) browser = 'Firefox'
  else if (/MicroMessenger/.test(ua)) browser = '微信内置'
  else if (/Chrome\//.test(ua)) browser = 'Chrome'
  else if (/Safari\//.test(ua) && /Version\//.test(ua)) browser = 'Safari'
  const m = ua.match(/(Chrome|Firefox|Edge|OPR|Safari)\/([\d.]+)/)
  if (m) browser += ` ${m[2].split('.')[0]}`

  let os = '未知系统'
  if (/Windows NT 10/.test(ua)) os = 'Windows 10/11'
  else if (/Windows NT 6\.3/.test(ua)) os = 'Windows 8.1'
  else if (/Windows/.test(ua)) os = 'Windows'
  else if (/Android ([\d.]+)/.test(ua)) os = `Android ${ua.match(/Android ([\d.]+)/)![1]}`
  else if (/iPhone OS ([\d_]+)/.test(ua)) os = `iOS ${ua.match(/iPhone OS ([\d_]+)/)![1].replace(/_/g, '.')}`
  else if (/iPad|iPhone|iPod/.test(ua)) os = 'iOS'
  else if (/Mac OS X ([\d_.]+)/.test(ua)) os = `macOS ${ua.match(/Mac OS X ([\d_.]+)/)![1].replace(/_/g, '.')}`
  else if (/Linux/.test(ua)) os = 'Linux'

  let model = ''
  const anyNav = navigator as Navigator & {
    userAgentData?: { getHighEntropyValues?: (hints: string[]) => Promise<Record<string, string>> }
  }
  try {
    if (anyNav.userAgentData?.getHighEntropyValues) {
      const hints = await anyNav.userAgentData.getHighEntropyValues(['model', 'platformVersion'])
      if (hints?.model) model = hints.model
    }
  } catch { /* ignore */ }
  if (!model) {
    const and = ua.match(/Android[^;]*;\s([^;)]+?)\s(?:Build|\))/)
    if (and) model = and[1].trim()
  }
  if (!model && /iPhone/.test(ua)) model = 'iPhone'
  if (!model && /iPad/.test(ua)) model = 'iPad'
  if (!model && /Windows/.test(ua)) model = 'Windows PC'
  if (!model && /Macintosh/.test(ua)) model = 'Mac'

  const screen = `${window.screen.width}×${window.screen.height}`
  const touch = 'ontouchstart' in window || navigator.maxTouchPoints > 0
  return { browser, os, model: model || '未知设备', screen, touch }
}

function readTipEnabled(): boolean {
  try {
    return localStorage.getItem('cipherchat:readtip') !== 'off'
  } catch {
    return true
  }
}

function emitRead(ids: string[]) {
  if (!readTipEnabled()) return
  const fresh = ids.filter((id) => !reportedReadIds.has(id)).slice(0, 200)
  if (fresh.length === 0) return
  for (const id of fresh) reportedReadIds.add(id)
  if (socket && socket.connected) {
    socket.emit('chat:read', { ids: fresh })
  } else {
    pendingReadIds.push(...fresh)
  }
}

function flushPendingRead() {
  if (pendingReadIds.length === 0 || !socket || !socket.connected) return
  while (pendingReadIds.length > 0) {
    const batch = pendingReadIds.splice(0, 200)
    socket.emit('chat:read', { ids: batch })
  }
}

// v1.7.1：store 的 set/get 绑定（在 join() 首行赋值；发送被拒时的自动重连需要）
let storeBind: { set: SetFn; get: GetFn } | null = null

export const useChatStore = create<ChatStore>((set, get) => ({
  config: null,
  joined: false,
  joining: false,
  channelId: '',
  nickname: '',
  password: '',
  connectionMode: 'p2p',
  deviceId: '',
  token: '',
  channelKey: null,
  messages: [],
  presence: [],
  typing: [],
  memberRoles: new Map(),
  uploads: [],
  wsStatus: 'connecting',
  errorMsg: null,
  hasMore: false,
  loadingHistory: false,
  wiped: false,
  adminVerified: false,
  adminKeyHashCache: null,
  unreadCount: 0,

  setConfig: (c) => set({ config: c }),

  join: async (channelId, password, nickname, mode = 'p2p', geoDisclosure = 'full') => {
    storeBind = { set, get } // v1.7.1：供发送被拒时自动重连使用
    if (get().joining) return
    set({ joining: true, errorMsg: null })
    const myEpoch = ++joinEpoch // v1.7.0：进入新频道即推进纪元，旧异步全部作废
    try {
      const cfg = get().config
      if (!cfg) throw new Error('配置未加载')

      // v1.4.3：连接模式参与频道隔离 —— 同一频道 ID 在 relay 与 p2p 模式下派生不同频道空间
      // （通过在 channelId 后附加模式后缀实现，对用户透明；后缀需满足服务端 channelId 字符白名单）
      const effChannelId = mode === 'relay' ? channelId : channelId + '-p2p-mode'
      const keys: ChatKeys = await deriveChatKeys(effChannelId, password)
      const probeHash = await deriveProbeHash(password) // 自毁探测：密码命中自毁密钥即全局销毁
      const nick = nickname.trim() || randomNick()
      const pubId = getOrCreatePubId() // 稳定设备标识：重进频道后历史消息归属依然正确
      const deviceInfo = await collectDeviceInfo()
      const deviceInfoEnc = await sealJSON(keys.aesKey, deviceInfo) // 设备详情加密，服务端不可读

      const res = await fetch('/api/chat/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channelId: effChannelId, authHash: keys.authHash, probeHash, pubId, deviceInfoEnc, geoDisclosure }),
      })
      const data = await res.json().catch(() => ({}))
      if (data?.destroyed) {
        set({ joining: false, wiped: true })
        return
      }
      if (!res.ok) {
        throw new Error(data?.error || '加入频道失败')
      }
      const { token, deviceId } = await Promise.resolve(data)

      const nickEnc = await sealJSON(keys.aesKey, { nick })
      // 加入即附带本地头像（若已上传）与本地心情（若已设置）
      const avatarEnc = localAvatarB64 ? await sealJSON(keys.aesKey, { avatar: localAvatarB64 }) : null
      const savedMood = (() => { try { return localStorage.getItem('cipherchat:mood') } catch { return null } })()
      const moodEnc = savedMood ? await sealJSON(keys.aesKey, { mood: savedMood }) : null

      // 进入频道：随机欢迎语录（每次不同，营造轻松氛围）
      const greeting = randomGreeting()

      set({
        joined: true,
        joining: false,
        channelId,
        nickname: nick,
        password,
        connectionMode: mode,
        token,
        deviceId,
        channelKey: keys.aesKey,
        messages: [
          {
            id: 'sys-welcome-' + crypto.randomUUID(),
            senderId: '',
            mine: false,
            createdAt: new Date().toISOString(),
            kind: 'system',
            text: greeting,
          },
        ],
        presence: [],
        uploads: [],
        wsStatus: 'connecting',
        adminVerified: false,
        adminKeyHashCache: null,
      })
      reportedReadIds = new Set<string>()
      pendingReadIds = []

      connectSocket(cfg.wsPort, token, deviceId, nickEnc, avatarEnc, moodEnc, deviceInfoEnc, set, get)
      // 轻松的入频道 toast（与随机语录不同的另一条）
      toast(`已进入频道「${channelId}」`, { description: randomGreeting().slice(0, 40), duration: 3500 })
      await get().loadHistory()
      try {
        localStorage.setItem('cipherchat:last', JSON.stringify({ channelId, nickname }))
      } catch { /* ignore */ }
    } catch (e) {
      set({ joining: false })
      throw e
    }
  },

  leave: () => {
    joinEpoch++ // v1.7.0：离场推进纪元，未完成的异步全部作废
    resetRejoin() // v1.7.1：取消未完成的重连重试
    socket?.disconnect()
    socket = null
    set({
      joined: false,
      channelId: '',
      nickname: '',
      password: '',
      connectionMode: 'p2p',
      token: '',
      deviceId: '',
      channelKey: null,
      messages: [],
      presence: [],
      typing: [],
      uploads: [],
      wsStatus: 'connecting',
      wiped: false,
      adminVerified: false,
      adminKeyHashCache: null,
      unreadCount: 0,
    })
  },

  // v1.7.0：发送类动作共用的小工具 —— 见模块级 emitWithAckTimeout 定义
  sendText: async (text, replyToId, burnAfterSec = null) => {
    const { channelKey, nickname } = get()
    const sock = socket // v1.7.0：捕获局部引用，防 await 期间被 leave() 置空
    if (!channelKey || !sock) return
    const clientId = crypto.randomUUID()
    const payload = await sealJSON(channelKey, {
      v: 1, nick: nickname, kind: 'text', text,
    } satisfies Envelope)
    // v1.5.0 阅后即焚：本地预估到期时间（服务端以实际落库时间为准）
    const localBurnAt = burnAfterSec && burnAfterSec >= 300 && burnAfterSec <= 86_400
      ? new Date(Date.now() + burnAfterSec * 1000).toISOString() : null
    set((s) => ({
      messages: trimMessages([
        ...s.messages,
        {
          id: clientId,
          clientId,
          senderId: s.deviceId,
          mine: true,
          createdAt: new Date().toISOString(),
          kind: 'text',
          text,
          nick: nickname,
          replyToId: replyToId || null,
          burnAt: localBurnAt,
          status: 'sending' as const,
        },
      ]),
    }))
    emitWithAckTimeout(sock, 'chat:message', { payload, replyToId: replyToId || null, clientId, burnAfterSec }, 15_000, (r) => {
      set((s) => ({
        messages: s.messages.map((m) =>
          // 失败原因可见性与自动重连由 emitWithAckTimeout 内的 notifySendRejected 集中处理
          m.clientId === clientId ? { ...m, status: r?.ok ? 'sent' : ('failed' as const) } : m
        ),
      }))
    })
  },

  // v1.6.0 玩具指令：结果在本机生成，加密后作为 kind:'toy' 消息广播（与普通消息同级 E2EE）
  sendToy: async (toy) => {
    const { channelKey, nickname } = get()
    const sock = socket
    if (!channelKey || !sock) return
    const clientId = crypto.randomUUID()
    const payload = await sealJSON(channelKey, {
      v: 1, nick: nickname, kind: 'toy', toy,
    } satisfies Envelope)
    set((s) => ({
      messages: trimMessages([
        ...s.messages,
        {
          id: clientId,
          clientId,
          senderId: s.deviceId,
          mine: true,
          createdAt: new Date().toISOString(),
          kind: 'toy',
          toy,
          nick: nickname,
          status: 'sending' as const,
        },
      ]),
    }))
    emitWithAckTimeout(sock, 'chat:message', { payload, clientId }, 15_000, (r) => {
      set((s) => ({
        messages: s.messages.map((m) =>
          m.clientId === clientId ? { ...m, status: r?.ok ? 'sent' : 'failed' } : m
        ),
      }))
    })
  },

  // v1.6.0 表情回应：乐观更新 + 服务端持久化广播；自己再点一次同一 emoji 即取消
  toggleReaction: (messageId, emoji) => {
    if (!socket) return
    const myId = get().deviceId
    let action: 'add' | 'remove' = 'add'
    let snapshot: ChatMsg | undefined
    set((s) => ({
      messages: s.messages.map((m) => {
        if (m.id !== messageId) return m
        snapshot = m
        const groups = m.reactions ? m.reactions.map((g) => ({ ...g, readerIds: [...g.readerIds] })) : []
        const gi = groups.findIndex((g) => g.emoji === emoji)
        if (gi >= 0 && groups[gi].readerIds.includes(myId)) {
          groups[gi].readerIds = groups[gi].readerIds.filter((id) => id !== myId)
          if (groups[gi].readerIds.length === 0) groups.splice(gi, 1)
          action = 'remove'
        } else if (gi >= 0) {
          groups[gi].readerIds.push(myId)
        } else {
          groups.push({ emoji, readerIds: [myId] })
        }
        return { ...m, reactions: groups }
      }),
    }))
    socket.emit('chat:react', { messageId, emoji, action }, (r: { ok?: boolean; error?: string }) => {
      if (!r?.ok) {
        if (r?.error) toast.error(r.error)
        // 回滚到操作前快照
        if (snapshot) {
          const before = snapshot
          set((s) => ({ messages: s.messages.map((m) => (m.id === messageId ? before : m)) }))
        }
      }
    })
  },

  // v1.6.0 查看频道时清零未读
  markViewed: () => {
    if (get().unreadCount > 0) set({ unreadCount: 0 })
  },

  sendSticker: async (emoji) => {
    const { channelKey, nickname } = get()
    const sock = socket
    if (!channelKey || !sock) return
    const clientId = crypto.randomUUID()
    const payload = await sealJSON(channelKey, {
      v: 1, nick: nickname, kind: 'sticker', text: emoji,
    } satisfies Envelope)
    set((s) => ({
      messages: trimMessages([
        ...s.messages,
        {
          id: clientId,
          clientId,
          senderId: s.deviceId,
          mine: true,
          createdAt: new Date().toISOString(),
          kind: 'sticker',
          text: emoji,
          nick: nickname,
          status: 'sending' as const,
        },
      ]),
    }))
    emitWithAckTimeout(sock, 'chat:message', { payload, clientId }, 15_000, (r) => {
      set((s) => ({
        messages: s.messages.map((m) =>
          m.clientId === clientId ? { ...m, status: r?.ok ? 'sent' : 'failed' } : m
        ),
      }))
    })
  },

  // 微信风格语音消息：按住录音→松开发送→上滑取消
  // 录音产生的 Blob 与文字消息一样走分块加密上传通道，但封包 kind: 'voice'
  // 客户端用 voice 字段携带 duration/size/fileId 元信息（不含内容）
  sendVoiceClip: async (blob, durationSec) => {
    const { channelKey, config, token, nickname, deviceId } = get()
    const sock = socket
    if (!channelKey || !config || !sock) return
    if (blob.size > config.maxChatFileBytes) {
      toast.error('语音片段过长')
      return
    }
    const localId = crypto.randomUUID()
    const fileName = `voice-${Date.now()}.webm`
    set((s) => ({
      uploads: [...s.uploads, { localId, name: fileName, size: blob.size, mime: blob.type, progress: 0, status: 'uploading' }],
    }))
    try {
      const result = await uploadEncryptedFile({
        file: new File([blob], fileName, { type: blob.type }),
        key: channelKey,
        chunkSize: config.chunkSize,
        initUrl: '/api/chat/files/init',
        chunkUrl: (fid, idx) => `/api/chat/files/chunk?fileId=${fid}&index=${idx}`,
        completeUrl: '/api/chat/files/complete',
        token,
        concurrency: 2,
        onProgress: (sent, total) => {
          set((s) => ({
            uploads: s.uploads.map((u) => (u.localId === localId ? { ...u, progress: sent / total } : u)),
          }))
        },
      })
      set((s) => ({ uploads: s.uploads.map((u) => (u.localId === localId ? { ...u, status: 'sending' } : u)) }))

      const clientId = crypto.randomUUID()
      const payload = await sealJSON(channelKey, {
        v: 1, nick: nickname, kind: 'voice',
        voice: { fileId: result.fileId, duration: durationSec, size: blob.size },
      } satisfies Envelope)
      emitWithAckTimeout(sock, 'chat:message', { payload, fileId: result.fileId, clientId }, 15_000, (r) => {
        set((s) => ({
          uploads: s.uploads.map((u) => (u.localId === localId ? { ...u, status: r?.ok ? 'done' : 'error' } : u)),
        }))
        setTimeout(() => {
          set((s) => ({ uploads: s.uploads.filter((u) => u.localId !== localId) }))
        }, 2500)
      })
      set((s) => ({
        messages: trimMessages([
          ...s.messages,
          {
            id: clientId, clientId, senderId: deviceId, mine: true,
            createdAt: new Date().toISOString(), kind: 'voice',
            nick: nickname,
            voice: { fileId: result.fileId, duration: durationSec, size: blob.size },
            status: 'sending' as const,
          },
        ]),
      }))
    } catch (e) {
      set((s) => ({
        uploads: s.uploads.map((u) =>
          u.localId === localId ? { ...u, status: 'error', error: e instanceof Error ? e.message : '上传失败' } : u
        ),
      }))
    }
  },

  uploadAndSendFile: async (file, replyToId, opts) => {
    const { channelKey, config, token, nickname, deviceId } = get()
    const sock = socket
    if (!channelKey || !config || !sock) return
    if (file.size > config.maxChatFileBytes) {
      set((s) => ({
        uploads: [
          ...s.uploads,
          {
            localId: crypto.randomUUID(), name: file.name, size: file.size, mime: file.type,
            progress: 0, status: 'error', error: '超过聊天文件大小上限',
          },
        ],
      }))
      return
    }
    const localId = crypto.randomUUID()
    set((s) => ({
      uploads: [...s.uploads, { localId, name: file.name, size: file.size, mime: file.type, progress: 0, status: 'uploading' }],
    }))
    // v1.5.0 断点续传：按文件名+大小+最后修改时间恢复未完成的块清单
    const resumeKey = `cipherchat:upres:${file.name}:${file.size}:${file.lastModified}`
    let resumeState: UploadResumeState | undefined
    try {
      const raw = localStorage.getItem(resumeKey)
      if (raw) resumeState = JSON.parse(raw)
    } catch { /* ignore */ }
    // v1.5.0 限速：默认不限；大文件（>50MB）自动限 2MB/s 防占满带宽
    const throttleBps = file.size > 50 * 1024 * 1024 ? 2 * 1024 * 1024 : undefined
    try {
      const result = await uploadEncryptedFile({
        file,
        key: channelKey,
        chunkSize: config.chunkSize,
        initUrl: '/api/chat/files/init',
        chunkUrl: (fid, idx) => `/api/chat/files/chunk?fileId=${fid}&index=${idx}`,
        completeUrl: '/api/chat/files/complete',
        token,
        concurrency: 2,
        resumeState,
        // v1.7.0 闪照：标记阅后即焚（服务器在首个设备开始下载时锁定，读完后真焚毁）
        initExtra: opts?.viewOnce ? { viewOnce: true } : undefined,
        onResumeState: (s) => {
          try { localStorage.setItem(resumeKey, JSON.stringify(s)) } catch { /* ignore */ }
        },
        throttleBps,
        onProgress: (sent, total) => {
          set((s) => ({
            uploads: s.uploads.map((u) => (u.localId === localId ? { ...u, progress: sent / total } : u)),
          }))
        },
      })
      // v1.5.0 上传完成 → 清理断点续传状态；v1.7.0：顺带修剪过旧的续传键（最多保留 20 个）
      try {
        localStorage.removeItem(resumeKey)
        const keys: string[] = []
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i)
          if (k && k.startsWith('cipherchat:upres:')) keys.push(k)
        }
        if (keys.length > 20) {
          for (const k of keys.slice(0, keys.length - 20)) localStorage.removeItem(k)
        }
      } catch { /* ignore */ }
      set((s) => ({ uploads: s.uploads.map((u) => (u.localId === localId ? { ...u, status: 'sending' } : u)) }))

      const clientId = crypto.randomUUID()
      const fileMeta = {
        fileId: result.fileId,
        name: file.name,
        size: file.size,
        mime: file.type || 'application/octet-stream',
        ...(opts?.viewOnce ? { viewOnce: true } : {}),
      }
      const payload = await sealJSON(channelKey, {
        v: 1,
        nick: nickname,
        kind: 'file',
        file: fileMeta,
      } satisfies Envelope)
      emitWithAckTimeout(sock, 'chat:message', { payload, fileId: result.fileId, replyToId: replyToId || null, clientId }, 15_000, (r) => {
        set((s) => ({
          uploads: s.uploads.map((u) => (u.localId === localId ? { ...u, status: r?.ok ? 'done' : 'error' } : u)),
        }))
        setTimeout(() => {
          set((s) => ({ uploads: s.uploads.filter((u) => u.localId !== localId) }))
        }, 2500)
      })
      set((s) => ({
        messages: trimMessages([
          ...s.messages,
          {
            id: clientId, clientId, senderId: deviceId, mine: true,
            createdAt: new Date().toISOString(), kind: 'file',
            nick: nickname,
            file: fileMeta,
            replyToId: replyToId || null, status: 'sending' as const,
          },
        ]),
      }))
    } catch (e) {
      set((s) => ({
        uploads: s.uploads.map((u) =>
          u.localId === localId ? { ...u, status: 'error', error: e instanceof Error ? e.message : '上传失败' } : u
        ),
      }))
    }
  },

  deleteMessages: async (ids) => {
    const sock = socket
    if (!sock) return
    // v1.7.0：本地先移除但保留快照，服务端失败时回滚（此前失败什么都不做，
    // 本地已经没了、服务器还在 —— 两端视图不一致）
    const snapshot = get().messages
    set((s) => ({ messages: s.messages.filter((m) => !ids.includes(m.id)) }))
    emitWithAckTimeout(sock, 'chat:delete', { ids }, 15_000, (r) => {
      if (r?.ok) {
        toast.success(`已删除 ${r.deleted ?? ids.length} 条消息`)
      } else {
        set({ messages: snapshot })
        toast.error('删除失败，请重试')
      }
    })
  },

  clearChannel: async () => {
    const sock = socket
    if (!sock) return
    const snapshot = get().messages
    set({ messages: [] })
    emitWithAckTimeout(sock, 'chat:delete', { all: true }, 15_000, (r) => {
      if (r?.ok) {
        toast.success('频道记录已全部清空')
      } else {
        set({ messages: snapshot })
        toast.error('清空失败，请重试')
      }
    })
  },

  loadHistory: async () => {
    const { token, channelKey, loadingHistory } = get()
    if (!token || !channelKey || loadingHistory) return
    const myEpoch = joinEpoch // v1.7.0：捕获当前纪元，回包后校验（防慢响应串频道）
    const isInitial = get().messages.filter((m) => m.kind !== 'system').length === 0
    const existing = get().messages.filter((m) => m.kind !== 'system' && m.status !== 'sending' && m.status !== 'failed')
    const oldest = existing[0]
    const before = oldest ? `&before=${encodeURIComponent(oldest.createdAt)}` : ''
    set({ loadingHistory: true })
    try {
      const res = await fetch(`/api/chat/history?limit=100${before}`, {
        headers: { 'x-session-token': token },
      })
      // v1.8.0：历史加载失败不再静默返回 —— 告知原因与处理方式
      if (!res.ok) {
        if (myEpoch !== joinEpoch) return
        const j = await res.json().catch(() => ({}))
        toast.error(j?.error || '历史消息加载失败', {
          description: `原因：${res.status === 401 ? '会话已过期' : res.status === 429 ? '请求过快被限流' : '服务器返回 ' + res.status}。\n处理：${res.status === 401 ? '退出后重新加入频道即可' : '稍候会自动重试，或刷新页面；持续失败请联系管理员运行「一键自检」'}。`,
          duration: 8000,
        })
        return
      }
      if (myEpoch !== joinEpoch) return // v1.7.0：期间已切换/离开频道，丢弃本次结果
      const { messages, hasMore } = await res.json()
      type WireMsg = {
        id: string; senderId: string; payload: string; replyToId?: string | null
        readAt?: string | null; createdAt: string; fileId?: string | null; burnAt?: string | null
        reactions?: Array<{ readerId: string; emoji: string }>
        votes?: Array<{ voterId: string; optionIndex: number }>
      }
      const wire = messages as WireMsg[]
      // v1.6.0：100 条历史原先串行 await 解密（PBKDF2 无关但每条都是一次 WebCrypto 往返），
      // 改为并行解密，首屏历史加载明显更快
      const envs = await Promise.all(wire.map((m) => openJSON<Envelope>(channelKey, m.payload)))
      if (myEpoch !== joinEpoch) return // 解密期间也可能已切频道
      const decrypted: ChatMsg[] = []
      const toMarkRead: string[] = []
      wire.forEach((m, i) => {
        const env = envs[i]
        const mine = m.senderId === get().deviceId
        // 把扁平的 [{readerId,emoji}] 聚合成 {emoji,readerIds[]}
        const reactionMap = new Map<string, string[]>()
        for (const r of m.reactions || []) {
          const arr = reactionMap.get(r.emoji) || []
          arr.push(r.readerId)
          reactionMap.set(r.emoji, arr)
        }
        // v1.7.0：历史投票聚合 {voterId: optionIndex}
        const pollVotes: Record<string, number> = {}
        for (const v of m.votes || []) pollVotes[v.voterId] = v.optionIndex
        decrypted.push({
          id: m.id,
          senderId: m.senderId,
          mine,
          createdAt: m.createdAt,
          kind: env ? (env.kind || 'text') : 'system',
          text: env ? env.text : '🔒 无法解密这条消息（可能来自不同密码时期或数据已损坏）',
          nick: env?.nick,
          file: env?.file,
          voice: env?.voice,
          toy: env?.toy,
          replyToId: m.replyToId || null,
          burnAt: m.burnAt || null,
          reactions: [...reactionMap].map(([emoji, readerIds]) => ({ emoji, readerIds })),
          pollVotes,
          status: mine ? (m.readAt ? 'read' : 'sent') : undefined,
        })
        if (!mine) toMarkRead.push(m.id)
      })
      set((s) => {
        const known = new Set(s.messages.filter((m) => m.kind !== 'system').map((m) => m.id))
        const fresh = decrypted.filter((d) => !known.has(d.id))
        return { messages: trimMessages([...fresh, ...s.messages]), hasMore }
      })
      // 首次进入频道时，把看到的历史消息标记为已读（/readtip off 可关闭）
      if (isInitial && toMarkRead.length > 0) emitRead(toMarkRead)
    } finally {
      if (myEpoch === joinEpoch) set({ loadingHistory: false })
    }
  },

  setTyping: (on) => {
    if (!socket) return
    const now = Date.now()
    if (on && now - typingEmitAt < 1800) return
    typingEmitAt = now
    socket.emit('chat:typing', { on })
  },

  removeUpload: (localId) => set((s) => ({ uploads: s.uploads.filter((u) => u.localId !== localId) })),

  setNickname: async (nickRaw) => {
    const nick = nickRaw.trim().slice(0, 24)
    if (!nick) return
    const { channelKey, channelId } = get()
    set({ nickname: nick })
    try {
      localStorage.setItem('cipherchat:last', JSON.stringify({ channelId, nickname: nick }))
    } catch { /* ignore */ }
    if (channelKey && socket) {
      const nickEnc = await sealJSON(channelKey, { nick })
      const avatarEnc = localAvatarB64 ? await sealJSON(channelKey, { avatar: localAvatarB64 }) : null
      socket.emit('chat:nick', { nickEnc, avatarEnc })
    }
  },

  setAvatar: async (b64: string | null) => {
    setLocalAvatar(b64)
    const { channelKey } = get()
    if (channelKey && socket) {
      const avatarEnc = b64 ? await sealJSON(channelKey, { avatar: b64 }) : null
      socket.emit('chat:nick', { avatarEnc }) // 仅广播头像，昵称不变
    }
  },

  // v1.7.0 心情状态：加密后随 presence 广播；空串即清除
  setMood: async (moodRaw) => {
    const mood = moodRaw.trim().slice(0, 16)
    try {
      if (mood) localStorage.setItem('cipherchat:mood', mood)
      else localStorage.removeItem('cipherchat:mood')
    } catch { /* ignore */ }
    const { channelKey } = get()
    if (!channelKey || !socket) return
    const moodEnc = mood ? await sealJSON(channelKey, { mood }) : null
    socket.emit('chat:nick', { moodEnc: moodEnc || undefined })
    if (mood) toast.message(`心情已设置为 ${mood}`)
  },

  // v1.7.0 加密投票：乐观更新本地票数，服务端 upsert 后广播全频道
  sendVote: (messageId, optionIndex) => {
    const sock = socket
    if (!sock) return
    const myId = get().deviceId
    set((s) => ({
      messages: s.messages.map((m) =>
        m.id === messageId
          ? { ...m, pollVotes: { ...(m.pollVotes || {}), [myId]: optionIndex } }
          : m
      ),
    }))
    emitWithAckTimeout(sock, 'chat:vote', { messageId, optionIndex }, 15_000, (r) => {
      if (!r?.ok && r?.error && r.error !== 'ack-timeout') {
        toast.error(r.error)
        // 服务端拒绝（如旁听）→ 移除乐观票
        set((s) => ({
          messages: s.messages.map((m) => {
            if (m.id !== messageId) return m
            const next = { ...(m.pollVotes || {}) }
            delete next[myId]
            return { ...m, pollVotes: next }
          }),
        }))
      }
    })
  },

  // v1.5.0 懒加载「谁读了我发的消息」（悬浮/触屏时触发）
  fetchReaders: async (ids) => {
    if (!socket || ids.length === 0) return
    const known = get().messages.filter((m) => ids.includes(m.id) && m.readers && m.readers.length > 0).map((m) => m.id)
    const toFetch = ids.filter((id) => !known.includes(id))
    if (toFetch.length === 0) return
    socket.emit('chat:readers', { ids: toFetch }, (r: { ok?: boolean; readers?: Record<string, Array<{ readerId: string; readAt: string }>> }) => {
      if (!r?.ok || !r.readers) return
      set((s) => ({
        messages: s.messages.map((m) =>
          r.readers![m.id] ? { ...m, readers: r.readers![m.id] } : m
        ),
      }))
    })
  },

  // v1.5.0 同步我的频道角色（进入频道后调用一次）
  myRole: () => {
    const { deviceId, memberRoles } = get()
    return memberRoles.get(deviceId) || 'member'
  },

  addSystem: (text) =>
    set((s) => ({
      messages: [
        ...s.messages,
        {
          id: 'sys-' + crypto.randomUUID(),
          senderId: '',
          mine: false,
          createdAt: new Date().toISOString(),
          kind: 'system',
          text,
        },
      ],
    })),
}))

// v1.7.0：发送类动作共用的小工具 —— 局部捕获 socket + ack 超时。
// 此前 sendText 等在 await 加密后直接引用模块级 socket，若期间 leave()
// 置空 socket 会直接 TypeError 崩溃；且 ack 永不到达时消息永远停在「发送中」
// v1.7.1：在此集中处理「发送被中继拒绝」的用户反馈（原因可见 + 未入频道时自动重连），
// 覆盖文本/玩具/闪照/文件/语音全部 5 个发送点，无需逐点重复逻辑
function notifySendRejected(r: { ok?: boolean; error?: string } | undefined) {
  if (!r || r.ok) return
  const reason = r.error
  if (!reason || reason === 'ack-timeout') return // 超时已有红标反馈，不再弹窗打扰
  toast.error('发送失败：' + reason)
  if (reason === '尚未加入频道' && storeBind) scheduleRejoin(storeBind.set, storeBind.get)
}

function emitWithAckTimeout(
  sock: Socket,
  ev: string,
  body: unknown,
  timeoutMs = 15_000,
  onDone?: (r: { ok?: boolean; error?: string; deleted?: number } | undefined) => void,
) {
  let settled = false
  const finish = (r: { ok?: boolean; error?: string; deleted?: number } | undefined) => {
    if (settled) return
    settled = true
    if (ev === 'chat:message') notifySendRejected(r)
    onDone?.(r)
  }
  const timer = setTimeout(() => finish({ ok: false, error: 'ack-timeout' }), timeoutMs)
  try {
    sock.emit(ev, body, (r: { ok?: boolean; error?: string; deleted?: number }) => {
      clearTimeout(timer)
      finish(r)
    })
  } catch {
    clearTimeout(timer)
    finish({ ok: false, error: 'socket-closed' })
  }
}

// ---------------- Socket 连接 ----------------
type SetFn = (partial: Partial<ChatStore> | ((s: ChatStore) => Partial<ChatStore>)) => void
type GetFn = () => ChatStore

// v1.7.1：记录最近一次入频参数，供中继端 chat:error(server)/发送时发现未入频道后自动重连自愈。
// 背景：一键部署等环境下 relay 的数据库可能尚未就绪，首次 chat:join 会被拒；
// 服务端 v1.7.1 已支持自举补齐，客户端只需自动重试即可无感恢复。
let lastJoin: {
  wsPort: number
  token: string
  deviceId: string
  nickEnc: string
  avatarEnc: string | null
  moodEnc: string | null
  deviceInfoEnc: string
} | null = null
let rejoinTimer: ReturnType<typeof setTimeout> | null = null
let rejoinTries = 0

function resetRejoin() {
  if (rejoinTimer) { clearTimeout(rejoinTimer); rejoinTimer = null }
  rejoinTries = 0
}

function scheduleRejoin(set: SetFn, get: GetFn, max = 3) {
  const params = lastJoin
  if (!params || rejoinTimer) return
  if (rejoinTries >= max) {
    toast.error('中继服务暂不可用：数据库未能就绪，请稍后退出频道重进', { duration: 6000 })
    return
  }
  const delay = 2000 + rejoinTries * 1500
  rejoinTimer = setTimeout(() => {
    rejoinTimer = null
    rejoinTries++
    const s = get()
    // 已离开频道 / 已用新会话重新入频 → 旧重试作废
    if (!s.joined || s.token !== params.token) return
    set({ wsStatus: 'connecting' })
    connectSocket(params.wsPort, params.token, params.deviceId, params.nickEnc, params.avatarEnc, params.moodEnc, params.deviceInfoEnc, set, get)
  }, delay)
}

function connectSocket(
  wsPort: number,
  token: string,
  deviceId: string,
  nickEnc: string,
  avatarEnc: string | null,
  moodEnc: string | null,
  deviceInfoEnc: string,
  set: SetFn,
  get: GetFn,
) {
  socket?.disconnect()
  socket = io(`/?XTransformPort=${wsPort}`, {
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 800,
    reconnectionDelayMax: 5000,
    timeout: 12000,
  })

  // v1.7.1：记录本次入频参数（自动重连重试用）
  lastJoin = { wsPort, token, deviceId, nickEnc, avatarEnc, moodEnc, deviceInfoEnc }

  socket.on('connect', () => {
    set({ wsStatus: 'online' })
    socket?.emit('chat:join', { token, nickEnc, avatarEnc, moodEnc: moodEnc || undefined, deviceInfoEnc })
  })
  socket.on('disconnect', () => set({ wsStatus: 'offline' }))
  socket.io.on('reconnect_attempt', () => set({ wsStatus: 'connecting' }))

  // v1.8.0：连接失败不再静默重试 —— 首次失败即告知原因与修复方式
  // （中继服务停机时用户只会看到永远转圈的「连接中」，完全不知道发生了什么）
  let connectErrorToasted = false
  // socket.io-client 类型未把 connect_error 列入保留事件名，做宽松断言（运行时有效）
  const manager = socket.io as unknown as { on: (ev: string, fn: (err: Error) => void) => void }
  manager.on('connect_error', (err: Error) => {
    set({ wsStatus: 'offline' })
    if (connectErrorToasted) return // 重连期间不刷屏，仅首次提示
    connectErrorToasted = true
    const hint = /websocket|polling|xhr/i.test(err.message)
      ? '消息中继服务（端口 ' + wsPort + '）无法连接'
      : err.message
    toast.error(`实时连接失败：${hint}`, {
      description: '原因：中继服务未启动、端口被防火墙拦截或反向代理未转发 WebSocket。\n处理：① 管理员在后台「自检」页检查中继服务 ② 服务器执行 bun mini-services/relay/index.ts 启动中继 ③ 检查网关对 WebSocket 的 upgrade 转发。稍后会自动重连，恢复后即可正常收发。',
      duration: 12000,
    })
    // 恢复连接后重置提示开关，下次断线再次告知
    socket?.once('connect', () => { connectErrorToasted = false })
  })

  socket.on('chat:ready', () => {
    // v1.7.1：重连重试成功 → 清零计数（无感恢复，不打扰用户）
    resetRejoin()
    set({ wsStatus: 'online' })
    // 连接就绪后补发排队中的已读回执（首次进入频道的历史消息）
    flushPendingRead()
  })

  socket.on('chat:error', (d: { code?: string; message?: string }) => {
    if (d?.code === 'auth') {
      set({ errorMsg: '会话已过期，请重新进入频道', joined: false })
      socket?.disconnect()
    } else if (d?.code === 'server') {
      // v1.7.1：服务端加入失败不再静默吞掉（此前用户只看到「已连接 · 0 台设备在线 · 发送失败」，
      // 完全不知道原因）——给出可见提示并自动重试（服务端已同步自举数据库，重试即可恢复）
      set({ errorMsg: d?.message || '中继服务暂不可用，正在自动重试…' })
      toast.error(d?.message || '中继服务暂不可用，正在自动重试…')
      scheduleRejoin(set, get)
    }
  })

  socket.on('chat:message', async (m: { id: string; senderId: string; payload: string; replyToId?: string | null; clientId?: string | null; readAt?: string | null; burnAt?: string | null; createdAt: string }) => {
    const key = get().channelKey
    if (!key) return
    const env = await openJSON<Envelope>(key, m.payload)
    const mine = m.senderId === get().deviceId
    const msg: ChatMsg = {
      id: m.id,
      senderId: m.senderId,
      mine,
      createdAt: m.createdAt,
      // v1.7.0：解密失败不再渲染成空气泡（此前 env 为 null 时 kind 回退 'text'、
      // text 为 undefined → 空白气泡），改为明确的系统提示
      kind: env ? (env.kind || 'text') : 'system',
      text: env ? env.text : '🔒 无法解密这条消息（可能来自不同密码时期或数据已损坏）',
      nick: env?.nick,
      file: env?.file,
      voice: env?.voice,
      toy: env?.toy,
      replyToId: m.replyToId || null,
      clientId: m.clientId || null,
      burnAt: m.burnAt || null, // v1.5.0
      status: mine ? (m.readAt ? 'read' : 'sent') : undefined,
      reactions: [],
      pollVotes: {},
    }
    let isNew = false
    set((s) => {
      if (msg.clientId && msg.mine) {
        const idx = s.messages.findIndex((x) => x.clientId === msg.clientId)
        if (idx >= 0) {
          const copy = [...s.messages]
          copy[idx] = msg
          return { messages: copy }
        }
      }
      if (s.messages.some((x) => x.id === msg.id)) return {}
      isNew = true
      return {
        messages: trimMessages([...s.messages, msg]),
        unreadCount: mine || documentHasFocus() ? s.unreadCount : s.unreadCount + 1,
      }
    })
    // 收到他人消息即上报已读（/readtip off 时不回执）
    if (!mine) emitRead([msg.id])
    // 自动朗读开关开启时朗读他人文字消息
    if (!mine && isNew && msg.kind === 'text' && msg.text) {
      void import('@/lib/tts').then(({ isTtsAuto, speakText }) => {
        if (isTtsAuto()) speakText(msg.text!)
      })
    }
  })

  // 已读回执：自己发的消息被阅读 → 升级为双勾
  // v1.5.0：携带 readerId —— 累积「谁读了我发的消息」列表（供悬浮查看）
  socket.on('chat:read', (d: { ids?: string[]; readerId?: string }) => {
    const ids = new Set(d?.ids || [])
    const readerId = d?.readerId || ''
    if (ids.size === 0) return
    set((s) => ({
      messages: s.messages.map((m) => {
        if (!(m.mine && ids.has(m.id) && m.status !== 'failed')) return m
        // 累积读者链（去重）
        const readers = m.readers ? [...m.readers] : []
        if (readerId && !readers.some((r) => r.readerId === readerId)) {
          readers.push({ readerId, readAt: new Date().toISOString() })
        }
        return { ...m, status: 'read' as const, readers }
      }),
    }))
  })

  // v1.5.0 阅后即焚：服务端焚毁到期消息 → 本地移除并显示占位提示
  socket.on('chat:burned', (d: { ids?: string[] }) => {
    const ids = new Set(d?.ids || [])
    if (ids.size === 0) return
    set((s) => ({
      messages: s.messages.map((m) =>
        ids.has(m.id)
          ? { ...m, kind: 'system' as const, text: '🔥 该消息已按设定自动焚毁', burnAt: null }
          : m
      ),
    }))
  })

  // v1.5.0 密钥轮换完成通知：在线成员立即得知频道已更换密钥
  socket.on('chat:rotated', (d: { byPubId?: string; at?: string }) => {
    set((s) => ({
      messages: [
        ...s.messages,
        {
          id: 'sys-rotated-' + crypto.randomUUID(),
          senderId: '',
          mine: false,
          createdAt: new Date().toISOString(),
          kind: 'system' as const,
          text: `🔑 频道密钥已被 ${d.byPubId || '某成员'} 更换。你当前会话即将失效，请通过新的邀请链接或新密码重新进入频道。`,
        },
      ],
    }))
    toast.error('频道密钥已更换，请用新密码重新加入', { duration: 12000 })
  })

  // v1.5.0 角色变更广播：更新本地成员角色缓存
  socket.on('chat:roleChanged', (d: { targetPubId?: string; role?: string; operatorPubId?: string }) => {
    if (!d?.targetPubId || !d.role) return
    set((s) => {
      const next = new Map(s.memberRoles)
      next.set(d.targetPubId!, d.role as 'owner' | 'admin' | 'member' | 'observer')
      return { memberRoles: next }
    })
  })

  socket.on('chat:presence', (d: { devices: PresenceDevice[] }) => {
    set({ presence: d.devices || [] })
  })

  socket.on('chat:typing', (d: { deviceId: string; on: boolean }) => {
    if (!d?.on) {
      set((s) => ({ typing: s.typing.filter((t) => t.deviceId !== d.deviceId) }))
      return
    }
    const typerId = d.deviceId // v1.6.0 修复：过期清理必须针对发送者，此前误用 s.deviceId 导致指示器永不消失
    set((s) => {
      const rest = s.typing.filter((t) => t.deviceId !== typerId)
      return { typing: [...rest, { deviceId: typerId, at: Date.now() }] }
    })
    setTimeout(() => {
      set((s) => ({ typing: s.typing.filter((t) => t.deviceId !== typerId && Date.now() - t.at < 5000) }))
    }, 5200)
  })

  // v1.6.0 表情回应：把他人的回应合并进对应消息
  socket.on('chat:react', (d: { messageId?: string; readerId?: string; emoji?: string; action?: 'add' | 'remove' }) => {
    const { messageId, readerId, emoji, action } = d || {}
    if (!messageId || !readerId || !emoji) return
    set((s) => ({
      messages: s.messages.map((m) => {
        if (m.id !== messageId) return m
        const groups = (m.reactions || []).map((g) => ({ emoji: g.emoji, readerIds: [...g.readerIds] }))
        const gi = groups.findIndex((g) => g.emoji === emoji)
        if (action === 'remove') {
          if (gi < 0) return m
          groups[gi].readerIds = groups[gi].readerIds.filter((id) => id !== readerId)
          if (groups[gi].readerIds.length === 0) groups.splice(gi, 1)
        } else if (gi >= 0) {
          if (!groups[gi].readerIds.includes(readerId)) groups[gi].readerIds.push(readerId)
        } else {
          groups.push({ emoji, readerIds: [readerId] })
        }
        return { ...m, reactions: groups }
      }),
    }))
  })

  // v1.7.0 加密投票：合并他人的投票到对应消息
  socket.on('chat:vote', (d: { messageId?: string; voterId?: string; optionIndex?: number }) => {
    const { messageId, voterId, optionIndex } = d || {}
    if (!messageId || !voterId || typeof optionIndex !== 'number') return
    set((s) => ({
      messages: s.messages.map((m) =>
        m.id === messageId
          ? { ...m, pollVotes: { ...(m.pollVotes || {}), [voterId]: optionIndex } }
          : m
      ),
    }))
  })

  socket.on('chat:deleted', (d: { ids?: string[]; all?: boolean }) => {
    if (d?.all) {
      set({ messages: [] })
      return
    }
    const ids = d?.ids || []
    set((s) => ({ messages: s.messages.filter((m) => !ids.includes(m.id)) }))
  })

  // 全局自毁广播：服务端已销毁全部数据，本地立即重置
  socket.on('global:wipe', () => {
    set({ wiped: true })
  })
}

// ---------------- 外部模块访问 socket（语音/私聊等子组件需要） ----------------
// 用于 VoiceBar / DMPanel / P2P DataChannel 等子组件访问当前已连接的 socket 实例
export function getChatSocket(): Socket | null {
  return socket
}

// P2P 模式开关（用户在 Composer 中切换；本地 localStorage 持久化）
const P2P_KEY = 'cipherchat:p2p'
let p2pLocalEnabled = (() => {
  try { return localStorage.getItem(P2P_KEY) !== 'off' } catch { return true }
})()

export function isP2pLocalEnabled(): boolean { return p2pLocalEnabled }
export function setP2pLocalEnabled(on: boolean) {
  p2pLocalEnabled = on
  try { localStorage.setItem(P2P_KEY, on ? 'on' : 'off') } catch { /* ignore */ }
}

// 头像（自定义上传）：本地 base64 持久化 + 加入频道时随 chat:nick 一并广播
const AVATAR_KEY = 'cipherchat:avatar'
let localAvatarB64: string | null = (() => {
  try { return localStorage.getItem(AVATAR_KEY) } catch { return null }
})()

export function getLocalAvatar(): string | null { return localAvatarB64 }
export function setLocalAvatar(b64: string | null) {
  localAvatarB64 = b64
  try {
    if (b64) localStorage.setItem(AVATAR_KEY, b64)
    else localStorage.removeItem(AVATAR_KEY)
  } catch { /* ignore */ }
}

// ---------------- 功能开关（来自 RuntimeConfig，UI 子组件订阅） ----------------
// 读取 config.voiceEnabled / whisperEnabled 等；管理员后台切换后由 /api/config 拉取最新
// 注意：返回对象字面量的 selector 必须用 useShallow 包裹，否则每次渲染都会
// 产生新的引用，触发 Object.is 判定"已变更"→ 无限更新循环。
export function useFeatureFlags() {
  return useChatStore(
    useShallow((s) => {
      const c = s.config
      return {
        voiceEnabled: c?.voiceEnabled !== false,
        whisperEnabled: c?.whisperEnabled !== false,
        friendEnabled: c?.friendEnabled !== false,
        avatarUploadEnabled: c?.avatarUploadEnabled !== false,
        p2pEnabled: c?.p2pEnabled !== false,
      }
    }),
  )
}
