'use client'
// 语音开黑大厅：Discord 风格的临时语音房间
// 用户进入 lobby ID + 密钥后即可加入；房间不持久化（断开即销毁）
// 支持：自由讲话（VAD 自动检测）/ 按键讲话（PTT，按键可自定义）/ 静音 / 8 人 mesh
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { motion } from 'framer-motion'
import {
  Mic, MicOff, Headphones, PhoneOff, Loader2,
  ArrowLeft, Copy, Hash, Users, Settings2, Keyboard, Zap, Radio, AlertTriangle,
  MonitorUp, MonitorOff, Monitor, VenetianMask,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { ChatKeys, deriveChatKeys, deriveProbeHash, randomNick, sealJSON } from '@/lib/crypto'
import { VoiceManager, fetchIceServers, type PeerConnState } from '@/lib/webrtc'
import { io, Socket } from 'socket.io-client'
import { pickAvatarBySeed } from '@/lib/avatar-library'
import { LobbyChatSidebar } from './LobbyChatSidebar'

// PTT 按键本地存储
const PTT_KEY_STORAGE = 'cipherchat:ptt-key'
const LOBBY_MODE_STORAGE = 'cipherchat:lobby-mode'
type PttMode = 'free' | 'ptt'
// 大厅传输模式：relay=信令与音频均经服务器中转，p2p=WebRTC P2P 直传
// 关键约束：相同 lobbyId + 不同 mode 是两个完全隔离的频道，互不可见
export type LobbyMode = 'relay' | 'p2p'

interface LobbyParticipant {
  pubId: string
  muted: boolean
}

export function VoiceLobby({ onExit }: { onExit: () => void }) {
  const [stage, setStage] = useState<'join' | 'live'>('join')
  const [lobbyId, setLobbyId] = useState('')
  const [lobbyKey, setLobbyKey] = useState('')
  const [nickname, setNickname] = useState('')
  const [mode, setMode] = useState<LobbyMode>('p2p')
  const [connecting, setConnecting] = useState(false)

  const handleJoin = useCallback(async (id: string, key: string, nick: string, m: LobbyMode) => {
    setConnecting(true)
    setStage('live')
    setLobbyId(id)
    setLobbyKey(key)
    setNickname(nick)
    setMode(m)
    setConnecting(false)
  }, [])

  const handleLeave = useCallback(() => {
    setStage('join')
    setLobbyId('')
    setLobbyKey('')
    setMode('p2p')
    onExit()
  }, [onExit])

  if (stage === 'join') {
    return <LobbyJoinForm onJoin={handleJoin} onBack={onExit} busy={connecting} />
  }

  return (
    <LobbyLive
      lobbyId={lobbyId}
      lobbyKey={lobbyKey}
      nickname={nickname}
      mode={mode}
      onLeave={handleLeave}
    />
  )
}

// ============== 加入大厅表单 ==============
function LobbyJoinForm({ onJoin, onBack, busy }: {
  onJoin: (id: string, key: string, nick: string, mode: LobbyMode) => void
  onBack: () => void
  busy: boolean
}) {
  const [id, setId] = useState('')
  const [key, setKey] = useState('')
  const [nick, setNick] = useState(() => {
    try { return localStorage.getItem('cipherchat:last-nick') || '' } catch { return '' }
  })
  const [mode, setMode] = useState<LobbyMode>(() => {
    try {
      const v = localStorage.getItem(LOBBY_MODE_STORAGE)
      return v === 'relay' || v === 'p2p' ? v : 'p2p'
    } catch { return 'p2p' }
  })

  const genRandomId = () => {
    const rand = Math.random().toString(36).slice(2, 8).toUpperCase()
    setId(`LOBBY-${rand}`)
  }

  const submit = (e?: React.FormEvent) => {
    e?.preventDefault()
    if (!id.trim() || !key.trim()) {
      toast.error('请填写大厅 ID 与密钥')
      return
    }
    try { localStorage.setItem(LOBBY_MODE_STORAGE, mode) } catch { /* ignore */ }
    onJoin(id.trim(), key, nick.trim() || randomNick(), mode)
  }

  return (
    <div className="flex min-h-[calc(100dvh-120px)] flex-col items-center justify-center px-4 py-10">
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45 }}
        className="w-full max-w-md"
      >
        <div className="mb-6 flex items-center gap-2">
          <Button variant="ghost" size="icon" className="h-9 w-9 rounded-xl" onClick={onBack} aria-label="返回首页">
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">语音开黑大厅</h1>
            <p className="text-xs text-muted-foreground">Discord 风格 · WebRTC P2P 直传 · SRTP 加密 · 不留存</p>
          </div>
        </div>

        <form onSubmit={submit} className="glass rounded-3xl border p-6 space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs font-semibold flex items-center gap-1.5">
              <Hash className="h-3.5 w-3.5" /> 大厅 ID
            </label>
            <div className="flex gap-2">
              <Input
                value={id}
                onChange={(e) => setId(e.target.value)}
                placeholder="例：LOBBY-AB12CD"
                className="h-11 rounded-xl flex-1 font-mono"
                maxLength={32}
              />
              <Button type="button" variant="outline" size="sm" className="h-11 rounded-xl px-3 shrink-0" onClick={genRandomId}>
                随机
              </Button>
            </div>
            <p className="text-[10.5px] text-muted-foreground">相同 ID + 密钥进入同一大厅；密钥即加密密钥，服务器永不知晓</p>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-semibold">大厅密钥</label>
            <Input
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="输入密钥（同时是加密密钥）"
              className="h-11 rounded-xl"
              autoComplete="off"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-semibold">昵称（可选）</label>
            <Input
              value={nick}
              onChange={(e) => setNick(e.target.value)}
              placeholder={randomNick()}
              className="h-11 rounded-xl"
              maxLength={24}
            />
          </div>

          {/* 传输模式选择：relay 与 p2p 为两个互不可见的独立频道 */}
          <div className="space-y-1.5">
            <label className="text-xs font-semibold flex items-center gap-1.5">
              <Radio className="h-3.5 w-3.5" /> 传输模式
            </label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setMode('p2p')}
                className={cn(
                  'flex flex-col items-start gap-0.5 rounded-xl border p-3 text-left transition-all',
                  mode === 'p2p'
                    ? 'border-primary bg-primary/10 shadow-sm'
                    : 'border-border bg-card hover:bg-muted/40',
                )}
              >
                <span className={cn('text-xs font-bold flex items-center gap-1', mode === 'p2p' ? 'text-primary' : 'text-foreground')}>
                  <Zap className="h-3.5 w-3.5" /> P2P 直连
                </span>
                <span className="text-[10px] text-muted-foreground leading-tight">WebRTC SRTP 端到端，不经服务器</span>
              </button>
              <button
                type="button"
                onClick={() => setMode('relay')}
                className={cn(
                  'flex flex-col items-start gap-0.5 rounded-xl border p-3 text-left transition-all',
                  mode === 'relay'
                    ? 'border-primary bg-primary/10 shadow-sm'
                    : 'border-border bg-card hover:bg-muted/40',
                )}
              >
                <span className={cn('text-xs font-bold flex items-center gap-1', mode === 'relay' ? 'text-primary' : 'text-foreground')}>
                  <Radio className="h-3.5 w-3.5" /> 中继模式
                </span>
                <span className="text-[10px] text-muted-foreground leading-tight">经服务器转发，弱网更稳</span>
              </button>
            </div>
            <p className="text-[10px] text-amber-600 dark:text-amber-400 leading-relaxed">
              · 同一大厅 ID 在两种模式下互不可见：仅同模式成员能进入同一频道，保障隐私
            </p>
            <p className="text-[10px] font-medium text-red-500 dark:text-red-400">
              ⚠️ 所有成员必须选择<b>相同的传输模式</b>才能互相听见 —— P2P 与中继模式下是两个隔离的房间。
            </p>
          </div>

          <Button type="submit" disabled={busy} className="w-full h-11 rounded-xl grad-primary text-[15px] font-semibold shadow-lg shadow-violet-500/25">
            {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <Headphones className="h-5 w-5" />}
            进入大厅
          </Button>

          <div className="rounded-xl bg-primary/5 border border-primary/15 px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
            <p className="font-semibold text-primary mb-1">大厅特性</p>
            <ul className="space-y-0.5">
              <li>· 自由讲话（VAD 自动检测）/ 按键讲话（PTT 自定义键）</li>
              <li>· 最多 8 人 mesh 拓扑，端到端 SRTP 加密</li>
              <li>· 临时房间：所有人离开后自动销毁，不留任何数据</li>
              <li>· 双模式隔离：同 ID 在 P2P/中继模式下互不可见</li>
            </ul>
          </div>
        </form>
      </motion.div>
    </div>
  )
}

// ============== 大厅主界面 ==============
function LobbyLive({ lobbyId, lobbyKey, nickname, mode, onLeave }: {
  lobbyId: string
  lobbyKey: string
  nickname: string
  mode: LobbyMode
  onLeave: () => void
}) {
  const [deviceId, setDeviceId] = useState('')
  const [socket, setSocket] = useState<Socket | null>(null)
  const [mgr, setMgr] = useState<VoiceManager | null>(null)
  const [participants, setParticipants] = useState<LobbyParticipant[]>([])
  const [speaking, setSpeaking] = useState<Set<string>>(new Set())
  const [muted, setMuted] = useState(false)
  const [pttMode, setPttMode] = useState<PttMode>('free')
  const [pttActive, setPttActive] = useState(false)
  const [pttKey, setPttKey] = useState<string>(() => {
    try { return localStorage.getItem(PTT_KEY_STORAGE) || 'KeyV' } catch { return 'KeyV' }
  })
  const [capturingKey, setCapturingKey] = useState(false)
  const [connecting, setConnecting] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // ★ v1.3.1：每对 peer 的连接质量状态（用于显示 P2P / 中继 / 连接中 / 失败）
  const [peerStates, setPeerStates] = useState<Map<string, PeerConnState>>(new Map())
  // v1.4 新增：文字聊天侧栏 / 屏幕共享
  const [aesKey, setAesKey] = useState<CryptoKey | null>(null)
  const [sharing, setSharing] = useState(false)
  const [remoteScreens, setRemoteScreens] = useState<Map<string, MediaStream>>(new Map())
  const [viewingScreen, setViewingScreen] = useState<string | null>(null)
  const screenVideoRef = useRef<HTMLVideoElement | null>(null)

  // 用 ref 跟踪当前 socket/mgr 供 cleanup 用
  const socketRef = useRef<Socket | null>(null)
  const mgrRef = useRef<VoiceManager | null>(null)

  // 初始化：派生密钥 + 建立会话 + 连接 socket + 加入 voice lobby
  useEffect(() => {
    let alive = true
    const init = async () => {
      try {
        // 先拉取公开运行时配置获取 wsPort（客户端不能直接导入 server config）
        const cfg = await fetch('/api/config').then((r) => r.json()).catch(() => ({ wsPort: 3003 }))
        const wsPort = cfg?.wsPort || 3003

        // 复用 chat 派生流程，channelId = lobbyId
        const k = await deriveChatKeys(lobbyId, lobbyKey)
        const probeHash = await deriveProbeHash(lobbyKey)
        if (!alive) return

        // 持久化设备标识
        let pubId: string
        try {
          pubId = localStorage.getItem('cipherchat:devid') || crypto.randomUUID()
          localStorage.setItem('cipherchat:devid', pubId)
        } catch {
          pubId = crypto.randomUUID()
        }

        // 创建会话（lobby 复用 chat 会话通道；channelId 字段填 lobbyId）
        const res = await fetch('/api/chat/session', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            channelId: lobbyId,
            authHash: k.authHash,
            probeHash,
            pubId,
          }),
        })
        const data = await res.json().catch(() => ({}))
        if (!alive) return
        if (data?.destroyed) {
          setError('该密钥已触发自毁')
          return
        }
        if (!res.ok) throw new Error(data?.error || '加入失败')
        setDeviceId(data.deviceId || pubId)

        // 连接 socket
        const sock = io(`/?XTransformPort=${wsPort}`, {
          transports: ['websocket', 'polling'],
          reconnection: true,
          reconnectionDelay: 800,
          reconnectionDelayMax: 5000,
          timeout: 12000,
        })
        if (!alive) {
          sock.disconnect()
          return
        }
        socketRef.current = sock
        setSocket(sock)

        sock.on('connect', async () => {
          // 通知后端加入频道（presence 用）
          const nickEnc = await sealJSON(k.aesKey, { nick: nickname })
          sock.emit('chat:join', { token: data.token, nickEnc })
        })
        sock.on('chat:ready', async () => {
          // chat:ready 后才安全发起 voice:lobby:join（确保 sock.data.chat 已设置）
          const m = new VoiceManager()
          // ★ v1.3.1：注入 ICE 配置（管理员后台配置的 TURN + 默认 STUN）
          await m.setIceConfig(await fetchIceServers())
          m.onParticipantsChange = (list) => setParticipants(list)
          m.onSpeakingChange = (pubId, sp) => {
            setSpeaking((prev) => {
              const next = new Set(prev)
              if (sp) next.add(pubId); else next.delete(pubId)
              return next
            })
          }
          m.onMutedChange = (muted) => setMuted(muted)
          m.onPttActiveChange = (a) => setPttActive(a)
          // ★ v1.3.1：连接质量状态变化 → 更新 UI 徽章
          m.onPeerStateChange = (pubId, state) => {
            setPeerStates((prev) => {
              const next = new Map(prev)
              next.set(pubId, state)
              return next
            })
          }
          m.onError = (msg) => {
            // toast 即时提示，但不致命错误时不阻断连接
            toast.error(msg, { duration: 5000 })
            // 失败状态下不退出 lobby，仅显示在参与者头像旁
          }
          m.onScreenShareChange = (s) => setSharing(s)
          const prevOnRS = m.onRemoteStream
          m.onRemoteStream = (pubId, stream) => {
            prevOnRS?.(pubId, stream)
            setRemoteScreens((prev) => {
              const next = new Map(prev)
              if (stream && stream.getVideoTracks().length > 0) next.set(pubId, stream)
              else { next.delete(pubId); setViewingScreen((v) => (v === pubId ? null : v)) }
              return next
            })
          }
          setAesKey(k.aesKey)
          const ok = await m.joinLobby(sock, k.aesKey, deviceId || pubId, lobbyId, mode)
          if (ok) {
            mgrRef.current = m
            setMgr(m)
            // 应用初始 PTT 模式
            if (localStorage.getItem('cipherchat:ptt-mode') === 'ptt') {
              m.setPTTEnabled(true)
              setPttMode('ptt')
            }
            setConnecting(false)
            toast.success('已加入语音大厅')
          } else {
            setConnecting(false)
          }
        })
        sock.on('disconnect', () => setConnecting(true))
        sock.io.on('reconnect_attempt', () => setConnecting(true))
        sock.io.on('reconnect', async () => {
          // 重连后重新 chat:join
          if (data?.token && k.aesKey) {
            const nickEnc = await sealJSON(k.aesKey, { nick: nickname })
            sock.emit('chat:join', { token: data.token, nickEnc })
          }
        })
      } catch (e) {
        if (alive) {
          setError(e instanceof Error ? e.message : '初始化失败')
          setConnecting(false)
        }
      }
    }
    init()
    return () => {
      alive = false
      mgrRef.current?.leave()
      mgrRef.current = null
      socketRef.current?.disconnect()
      socketRef.current = null
    }
     
  }, [lobbyId, lobbyKey, nickname, mode])

  // PTT 按键监听（按键模式时）
  useEffect(() => {
    if (pttMode !== 'ptt' || !mgr) return
    const onDown = (e: KeyboardEvent) => {
      if (e.code !== pttKey) return
      // 避免重复触发（e.repeat）
      if (e.repeat) return
      // 忽略输入框焦点
      const t = e.target as HTMLElement
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      e.preventDefault()
      mgr.pttPress()
    }
    const onUp = (e: KeyboardEvent) => {
      if (e.code !== pttKey) return
      mgr.pttRelease()
    }
    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    return () => {
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp)
    }
  }, [pttMode, pttKey, mgr])

  // 自定义按键捕获
  useEffect(() => {
    if (!capturingKey) return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.code === 'Escape') {
        setCapturingKey(false)
        return
      }
      setPttKey(e.code)
      try { localStorage.setItem(PTT_KEY_STORAGE, e.code) } catch { /* ignore */ }
      setCapturingKey(false)
      toast.success(`PTT 按键已设为：${humanizeKey(e.code)}`)
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true } as any)
  }, [capturingKey])

  const toggleMute = () => mgr?.toggleMute()
  const togglePttMode = (mode: PttMode) => {
    setPttMode(mode)
    try { localStorage.setItem('cipherchat:ptt-mode', mode) } catch { /* ignore */ }
    if (mode === 'ptt') {
      mgr?.setPTTEnabled(true)
      toast.message('PTT 模式：按住按键发话，松开静音')
    } else {
      mgr?.setPTTEnabled(false)
      mgr?.setVadEnabled(true)
      toast.message('自由讲话：VAD 自动检测说话')
    }
  }

  const leave = () => {
    mgr?.leave()
    socket?.disconnect()
    onLeave()
  }

  const toggleShare = async () => {
    if (!mgr) return
    if (mgr.screenSharing) {
      await mgr.stopScreenShare()
      toast.message('已停止屏幕共享')
    } else {
      const ok = await mgr.startScreenShare()
      if (ok) toast.success('屏幕共享已开始')
    }
  }

  // v1.5.0 变声（实时 pitch shift，全部本地）
  const [maskOn, setMaskOn] = useState(false)
  const [maskRatio, setMaskRatio] = useState(1.3)
  const toggleMask = async () => {
    if (!mgr) return
    if (maskOn) {
      await mgr.disableVoiceMask()
      setMaskOn(false)
      toast.message('已关闭变声')
    } else {
      const ok = await mgr.enableVoiceMask(maskRatio)
      if (ok) { setMaskOn(true); toast.success(`变声已开启（${maskRatio >= 1 ? '升调' : '降调'}）`) }
      else toast.error('变声开启失败')
    }
  }
  const changeMaskRatio = async (r: number) => {
    setMaskRatio(r)
    if (maskOn) await mgr?.setVoiceMaskRatio(r)
  }

  useEffect(() => {
    if (viewingScreen && screenVideoRef.current) {
      const s = remoteScreens.get(viewingScreen)
      if (s) screenVideoRef.current.srcObject = s
    }
  }, [viewingScreen, remoteScreens])

  const copyLobbyId = () => {
    try {
      navigator.clipboard.writeText(lobbyId)
      toast.success('大厅 ID 已复制')
    } catch { /* ignore */ }
  }

  if (error) {
    return (
      <div className="flex min-h-[calc(100dvh-120px)] flex-col items-center justify-center gap-4 px-4">
        <div className="glass rounded-2xl border border-red-500/30 p-6 text-center max-w-sm">
          <p className="font-bold text-red-500 mb-2">无法加入大厅</p>
          <p className="text-sm text-muted-foreground">{error}</p>
        </div>
        <Button variant="outline" className="rounded-xl" onClick={onLeave}>返回</Button>
      </div>
    )
  }

  // 排序：自己优先 + 在线在前
  const sorted = [...participants].sort((a, b) => {
    if (a.pubId === deviceId) return -1
    if (b.pubId === deviceId) return 1
    return 0
  })

  return (
    <div className="flex min-h-[calc(100dvh-80px)] flex-col">
      {/* 顶部：大厅信息 */}
      <header className="glass border-b px-4 sm:px-6 py-3">
        <div className="mx-auto max-w-4xl flex items-center gap-3">
          <Button variant="ghost" size="icon" className="h-9 w-9 rounded-xl shrink-0" onClick={leave} aria-label="离开大厅">
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-base font-bold">{lobbyId}</h1>
              <button
                onClick={copyLobbyId}
                className="shrink-0 rounded-lg p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label="复制大厅 ID"
                title="复制大厅 ID"
              >
                <Copy className="h-3.5 w-3.5" />
              </button>
              {connecting ? (
                <Badge variant="outline" className="text-amber-600 dark:text-amber-400 border-amber-500/30 text-[10px]">
                  <Loader2 className="h-3 w-3 animate-spin mr-1" /> 连接中
                </Badge>
              ) : (
                <Badge variant="outline" className="text-emerald-600 dark:text-emerald-400 border-emerald-500/30 text-[10px]">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 mr-1 animate-pulse" /> 已连接
                </Badge>
              )}
              <Badge
                variant="outline"
                className={cn(
                  'text-[10px]',
                  mode === 'p2p'
                    ? 'border-violet-500/30 bg-violet-500/10 text-violet-600 dark:text-violet-300'
                    : 'border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-300',
                )}
                title={mode === 'p2p' ? 'P2P 直连模式：音频端到端 SRTP，不经服务器' : '中继模式：信令与音频经服务器转发'}
              >
                {mode === 'p2p' ? <Zap className="h-3 w-3 mr-0.5" /> : <Radio className="h-3 w-3 mr-0.5" />}
                {mode === 'p2p' ? 'P2P' : '中继'}
              </Badge>
            </div>
            <p className="text-[11px] text-muted-foreground">
              {sorted.length} 位成员 · {mode === 'p2p' ? 'SRTP 端到端加密 · P2P 直传' : '服务器中继转发 · 端到端加密'}
            </p>
          </div>
          <Badge variant="outline" className="hidden sm:inline-flex text-[10px] border-primary/30 bg-primary/5">
            AES-256
          </Badge>
        </div>
      </header>

      {/* 中央：成员头像宫格 */}
      <main className="flex-1 overflow-y-auto scroll-slim px-4 sm:px-6 py-6">
        <div className="mx-auto max-w-4xl">
          {sorted.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-4 py-20 text-center text-muted-foreground">
              <div className="grid h-20 w-20 place-items-center rounded-3xl grad-primary-soft">
                <Users className="h-10 w-10 text-primary" />
              </div>
              <div>
                <p className="text-lg font-bold">等待其他成员加入…</p>
                <p className="mt-1 text-sm">把大厅 ID 与密钥分享给队友即可加入</p>
              </div>
              <Button variant="outline" size="sm" className="rounded-xl gap-1.5" onClick={copyLobbyId}>
                <Copy className="h-3.5 w-3.5" /> 复制大厅 ID
              </Button>
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
              {sorted.map((p) => {
                const isMe = p.pubId === deviceId
                const isSpeaking = speaking.has(p.pubId)
                const avatar = pickAvatarBySeed(p.pubId)
                // ★ v1.3.1：连接质量徽章
                const peerState = isMe ? null : peerStates.get(p.pubId)
                const badge = peerState ? (
                  <span
                    className={cn(
                      'inline-flex items-center gap-0.5 rounded-full px-1.5 py-0 text-[9px] font-semibold leading-tight mt-1',
                      peerState === 'p2p' && 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
                      peerState === 'relay' && 'bg-sky-500/15 text-sky-600 dark:text-sky-400',
                      peerState === 'connecting' && 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
                      peerState === 'failed' && 'bg-red-500/15 text-red-500',
                      peerState === 'disconnected' && 'bg-amber-500/15 text-amber-600',
                      peerState === 'new' && 'bg-muted text-muted-foreground',
                      peerState === 'closed' && 'bg-muted text-muted-foreground',
                    )}
                  >
                    {peerState === 'p2p' && <Zap className="h-2.5 w-2.5" />}
                    {peerState === 'relay' && <Radio className="h-2.5 w-2.5" />}
                    {(peerState === 'connecting' || peerState === 'new') && <Loader2 className="h-2.5 w-2.5 animate-spin" />}
                    {(peerState === 'failed' || peerState === 'disconnected') && <AlertTriangle className="h-2.5 w-2.5" />}
                    {peerState === 'p2p' ? 'P2P' :
                     peerState === 'relay' ? '中继' :
                     peerState === 'connecting' ? '连接中' :
                     peerState === 'failed' ? '失败' :
                     peerState === 'disconnected' ? '断开' :
                     peerState === 'new' ? '初始化' : '已关闭'}
                  </span>
                ) : null
                return (
                  <motion.div
                    key={p.pubId}
                    layout
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    className={cn(
                      'glass relative flex flex-col items-center gap-3 rounded-2xl border p-5 transition-all',
                      isSpeaking && 'ring-2 ring-emerald-500/60 shadow-lg shadow-emerald-500/15',
                      peerState === 'failed' && 'ring-2 ring-red-500/40',
                    )}
                  >
                    <div className="relative">
                      <img
                        src={avatar}
                        alt={isMe ? `${nickname} (我)` : `#${p.pubId.slice(-4)}`}
                        className={cn(
                          'h-20 w-20 rounded-2xl object-cover transition-all',
                          p.muted ? 'opacity-60 grayscale' : '',
                          isSpeaking && 'scale-105',
                        )}
                        draggable={false}
                      />
                      {/* 说话指示器 */}
                      <span
                        className={cn(
                          'absolute -bottom-1 -right-1 grid h-7 w-7 place-items-center rounded-full border-2 border-card transition-all',
                          isSpeaking ? 'bg-emerald-500 scale-110' : 'bg-zinc-500/80',
                        )}
                      >
                        {p.muted ? (
                          <MicOff className="h-3.5 w-3.5 text-white" />
                        ) : isSpeaking ? (
                          <Radio className="h-3.5 w-3.5 text-white" />
                        ) : (
                          <Mic className="h-3.5 w-3.5 text-white" />
                        )}
                      </span>
                    </div>
                    <div className="text-center min-w-0 w-full">
                      <p className="truncate text-sm font-semibold">
                        {isMe ? `${nickname} (我)` : `#${p.pubId.slice(-4)}`}
                      </p>
                      <p className="text-[10px] text-muted-foreground">
                        {p.muted ? '已静音' : isSpeaking ? '说话中' : '在线'}
                      </p>
                      {badge}
                    </div>
                  </motion.div>
                )
              })}
              {/* 空槽位（最多 8 人） */}
              {sorted.length < 8 && Array.from({ length: Math.min(8 - sorted.length, 4) }).map((_, i) => (
                <div
                  key={`empty-${i}`}
                  className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-black/10 dark:border-white/10 p-5 opacity-50"
                >
                  <div className="grid h-20 w-20 place-items-center rounded-2xl bg-muted/40">
                    <Users className="h-8 w-8 text-muted-foreground" />
                  </div>
                  <p className="text-[11px] text-muted-foreground">空位</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>

      {/* 底部：控制台 */}
      <footer className="glass border-t px-4 sm:px-6 py-4 pb-safe">
        <div className="mx-auto max-w-4xl flex items-center gap-2 sm:gap-3">
          {/* 模式切换 */}
          <div className="flex items-center gap-1 rounded-2xl bg-muted/60 p-1">
            <button
              onClick={() => togglePttMode('free')}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-xl px-3 h-9 text-xs font-medium transition-all',
                pttMode === 'free' ? 'grad-primary text-white shadow-sm' : 'text-muted-foreground hover:text-foreground',
              )}
              title="自由讲话：VAD 自动检测说话"
            >
              <Zap className="h-3.5 w-3.5" /> 自由讲话
            </button>
            <button
              onClick={() => togglePttMode('ptt')}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-xl px-3 h-9 text-xs font-medium transition-all',
                pttMode === 'ptt' ? 'grad-primary text-white shadow-sm' : 'text-muted-foreground hover:text-foreground',
              )}
              title="按键讲话：按住 PTT 键发话"
            >
              <Keyboard className="h-3.5 w-3.5" /> 按键讲话
            </button>
          </div>

          {/* PTT 按键自定义 */}
          {pttMode === 'ptt' && (
            <button
              onClick={() => setCapturingKey(true)}
              className="inline-flex items-center gap-1.5 rounded-xl border bg-card px-3 h-9 text-xs font-medium hover:bg-primary/5"
              title="点击后按下任意键设置 PTT 按键"
            >
              <Settings2 className="h-3.5 w-3.5" />
              {capturingKey ? <span className="text-primary animate-pulse">按下任意键…</span> : humanizeKey(pttKey)}
            </button>
          )}

          <div className="flex-1" />

          {/* PTT 状态提示（按键模式时） */}
          {pttMode === 'ptt' && (
            <span className={cn(
              'hidden sm:inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-all',
              pttActive ? 'bg-emerald-500/20 text-emerald-600 dark:text-emerald-400' : 'bg-muted text-muted-foreground',
            )}>
              <span className={cn('h-1.5 w-1.5 rounded-full', pttActive ? 'bg-emerald-500 animate-pulse' : 'bg-muted-foreground/60')} />
              {pttActive ? '说话中' : `按住 ${humanizeKey(pttKey)} 说话`}
            </span>
          )}

          {/* 屏幕共享 */}
          <button
            onClick={toggleShare}
            className={cn(
              'inline-flex h-11 items-center justify-center gap-1.5 rounded-2xl px-3 text-xs font-semibold transition-all',
              sharing ? 'bg-sky-500/15 text-sky-500 ring-2 ring-sky-500/40' : 'bg-muted hover:bg-primary/10',
            )}
            aria-label={sharing ? '停止屏幕共享' : '共享屏幕'}
            title={sharing ? '停止屏幕共享' : '共享屏幕'}
          >
            {sharing ? <MonitorOff className="h-4.5 w-4.5" /> : <MonitorUp className="h-4.5 w-4.5" />}
          </button>

          {/* v1.5.0 变声面具（实时 pitch shift，本地处理） */}
          <div className="flex items-center gap-1.5">
            <button
              onClick={toggleMask}
              className={cn(
                'inline-flex h-11 items-center justify-center gap-1.5 rounded-2xl px-3 text-xs font-semibold transition-all',
                maskOn ? 'bg-fuchsia-500/15 text-fuchsia-500 ring-2 ring-fuchsia-500/40' : 'bg-muted hover:bg-primary/10',
              )}
              aria-label={maskOn ? '关闭变声' : '开启变声'}
              title="变声面具：实时改变你的音调，保护声音身份（本地处理）"
            >
              <VenetianMask className={cn('h-4.5 w-4.5', maskOn && 'animate-pulse')} />
            </button>
            {maskOn && (
              <input
                type="range"
                min={0.6}
                max={1.8}
                step={0.05}
                value={maskRatio}
                onChange={(e) => void changeMaskRatio(Number(e.target.value))}
                className="hidden sm:block w-24 accent-fuchsia-500"
                aria-label="音调调节"
                title={`音调：${maskRatio >= 1 ? '+' : ''}${Math.round((maskRatio - 1) * 100)}%`}
              />
            )}
          </div>

          {/* 静音 */}
          <button
            onClick={toggleMute}
            className={cn(
              'inline-flex h-11 w-11 items-center justify-center rounded-2xl transition-all',
              muted ? 'bg-red-500/15 text-red-500 ring-2 ring-red-500/40' : 'bg-muted text-foreground hover:bg-primary/10',
            )}
            aria-label={muted ? '取消静音' : '静音'}
            title={muted ? '已静音' : '静音'}
          >
            {muted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
          </button>

          {/* 离开 */}
          <button
            onClick={leave}
            className="inline-flex h-11 items-center justify-center gap-1.5 rounded-2xl bg-red-500/15 px-4 text-sm font-semibold text-red-500 hover:bg-red-500/25 transition-all"
            aria-label="离开大厅"
            title="离开大厅"
          >
            <PhoneOff className="h-5 w-5" />
            <span className="hidden sm:inline">离开</span>
          </button>
        </div>
      </footer>

      {/* 文字聊天侧栏（没麦/不想说话的队友） */}
      {socket && aesKey && (
        <LobbyChatSidebar
          socket={socket}
          aesKey={aesKey}
          lobbyId={lobbyId}
          mode={mode}
          myPubId={deviceId}
          myNick={nickname}
        />
      )}

      {/* 远端屏幕查看浮窗 */}
      {viewingScreen && remoteScreens.has(viewingScreen) && (
        <div className="fixed right-3 top-16 z-50 w-[min(520px,72vw)] overflow-hidden rounded-2xl border bg-black/95 shadow-2xl">
          <div className="flex items-center justify-between border-b border-white/10 px-3 py-1.5 text-xs text-white/80">
            <span className="flex items-center gap-1.5"><Monitor className="h-3.5 w-3.5" /> #{viewingScreen.slice(-4)} 的屏幕</span>
            <button onClick={() => setViewingScreen(null)} aria-label="关闭屏幕查看" className="rounded p-1 hover:bg-white/10">✕</button>
          </div>
          <video ref={screenVideoRef} autoPlay playsInline className="w-full rounded-b-2xl" />
        </div>
      )}
    </div>
  )
}

// 将 KeyboardEvent.code 转为人类可读
function humanizeKey(code: string): string {
  if (code.startsWith('Key')) return code.slice(3)
  if (code.startsWith('Digit')) return code.slice(5)
  if (code === 'Space') return '空格'
  if (code === 'ShiftLeft' || code === 'ShiftRight') return 'Shift'
  if (code === 'ControlLeft' || code === 'ControlRight') return 'Ctrl'
  if (code === 'AltLeft' || code === 'AltRight') return 'Alt'
  if (code === 'Enter') return '回车'
  if (code === 'Tab') return 'Tab'
  return code
}
