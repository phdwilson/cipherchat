'use client'
// 私聊语音通话弹窗：发起 / 接听 / 拒绝 / 挂断
// 通过 useChatStore 的 channelKey + getChatSocket() 建立连接
// 信令：voice:call:invite/accept/reject/end/signal，payload 全部用 channelKey 加密
//
// 设计：socket 上全局只注册一次 call handler（综合处理 incoming/outgoing 全场景）
// 通话状态通过模块级 activeCallRef + setExternalCall 协调
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { motion, AnimatePresence } from 'framer-motion'
import { Mic, MicOff, Phone, PhoneOff, X, Headphones } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useChatStore, getChatSocket } from '@/store/chat'
import { VoiceManager, registerCallSocket, unregisterCallSocket, rejectCall, fetchIceServers } from '@/lib/webrtc'
import { pickAvatarBySeed } from '@/lib/avatar-library'

type CallState = 'outgoing' | 'incoming' | 'connecting' | 'ongoing' | 'rejected' | 'ended' | 'missed'

interface ActiveCall {
  peerPubId: string
  peerNick: string
  state: CallState
  startedAt: number
  durationSec: number
}

// 模块级状态：与组件实例无关，确保 socket 上的 call handlers 能更新 UI
let activeCallRef: ActiveCall | null = null
let setExternalCall: ((c: ActiveCall | null) => void) | null = null
let mgrRef: { current: VoiceManager | null } = { current: null }
// 防止重复注册
let registeredSocket: any = null

function updateCall(c: ActiveCall | null) {
  activeCallRef = c
  setExternalCall?.(c)
}

function scheduleClear(delay = 2000) {
  setTimeout(() => {
    if (activeCallRef && (activeCallRef.state === 'rejected' || activeCallRef.state === 'ended' || activeCallRef.state === 'missed')) {
      updateCall(null)
    }
  }, delay)
}

// 注册综合 call handler（只注册一次/socket）
function ensureCallHandlerRegistered(sock: any, channelKey: any, deviceId: string) {
  if (registeredSocket === sock) return
  if (registeredSocket) unregisterCallSocket()
  registeredSocket = sock
  registerCallSocket(sock, channelKey, deviceId, {
    onIncoming: (fromPubId: string) => {
      if (activeCallRef) {
        // 已有通话，自动拒绝
        void rejectCall(channelKey, sock, deviceId, fromPubId)
        return
      }
      // 暂用末四位作为昵称（presence 里加密的昵称需要异步解密，简化处理）
      const c: ActiveCall = {
        peerPubId: fromPubId,
        peerNick: `#${fromPubId.slice(-4)}`,
        state: 'incoming',
        startedAt: Date.now(),
        durationSec: 0,
      }
      updateCall(c)
    },
    onAccepted: (peerPubId: string) => {
      // 由发起方收到：对方已接听，升级为 ongoing
      if (!activeCallRef || activeCallRef.peerPubId !== peerPubId) return
      updateCall({ ...activeCallRef, state: 'ongoing', startedAt: Date.now() })
    },
    onRejected: (peerPubId: string) => {
      // 由发起方收到：对方拒绝
      if (!activeCallRef || activeCallRef.peerPubId !== peerPubId) return
      updateCall({ ...activeCallRef, state: 'rejected' })
      // 清理 mgr
      mgrRef.current?.endCall()
      mgrRef.current = null
      scheduleClear()
    },
    onEnded: (peerPubId: string) => {
      // 任意一方收到对方挂断
      if (!activeCallRef || activeCallRef.peerPubId !== peerPubId) return
      updateCall({ ...activeCallRef, state: 'ended' })
      mgrRef.current?.endCall()
      mgrRef.current = null
      scheduleClear()
    },
  })
}

// 全局方法：发起私聊通话（由 DMPanel 调用）
export function startDMCall(peerPubId: string, peerNick: string) {
  if (activeCallRef) {
    toast.error('已有通话进行中')
    return
  }
  const { channelKey, deviceId } = useChatStore.getState()
  const sock = getChatSocket()
  if (!channelKey || !sock || !deviceId) {
    toast.error('连接未就绪')
    return
  }
  ensureCallHandlerRegistered(sock, channelKey, deviceId)
  const c: ActiveCall = {
    peerPubId,
    peerNick,
    state: 'outgoing',
    startedAt: Date.now(),
    durationSec: 0,
  }
  updateCall(c)
  // 创建 VoiceManager 并发送 invite
  const mgr = new VoiceManager()
  // 异步注入 ICE 配置（不阻塞 invite 发送，配置将在 createPeer 时被读取）
  void fetchIceServers().then((cfg) => mgr.setIceConfig(cfg)).catch(() => {})
  mgr.onError = (msg) => {
    toast.error(msg)
    if (activeCallRef) {
      updateCall({ ...activeCallRef, state: 'ended' })
      scheduleClear(1500)
    }
    mgrRef.current = null
  }
  mgr.onCallError = (msg: string) => {
    toast.error(msg)
    if (activeCallRef) {
      updateCall({ ...activeCallRef, state: 'ended' })
      scheduleClear(1500)
    }
    mgrRef.current = null
  }
  mgrRef.current = mgr
  void mgr.startCall(sock, channelKey, deviceId, peerPubId).then((ok) => {
    if (!ok) {
      updateCall(null)
      mgrRef.current = null
    }
  })
}

export function DMCallModal() {
  const [call, setCall] = useState<ActiveCall | null>(null)
  const [muted, setMuted] = useState(false)
  const channelKey = useChatStore((s) => s.channelKey)
  const deviceId = useChatStore((s) => s.deviceId)

  // 把 setCall 注册到外部模块
  useEffect(() => {
    setExternalCall = setCall
    return () => {
      setExternalCall = null
    }
  }, [])

  // 通话计时
  useEffect(() => {
    if (!call || call.state !== 'ongoing') return
    const id = setInterval(() => {
      setCall((c) => c && c.state === 'ongoing' ? { ...c, durationSec: Math.floor((Date.now() - c.startedAt) / 1000) } : c)
    }, 1000)
    return () => clearInterval(id)
  }, [call?.state])

  // 注册综合 call handler（channelKey/deviceId 变化时）
  useEffect(() => {
    if (!channelKey || !deviceId) return
    const sock = getChatSocket()
    if (!sock) return
    ensureCallHandlerRegistered(sock, channelKey, deviceId)
    // 注意：不在这里 unregister，避免 socket 重连时丢失 handler
    return () => {
      // 仅在组件卸载且没有活跃通话时清理
      if (!activeCallRef) {
        unregisterCallSocket()
        registeredSocket = null
      }
    }
  }, [channelKey, deviceId])

  // 接听 incoming
  const acceptIncoming = async () => {
    if (!call || !channelKey || !deviceId) return
    const sock = getChatSocket()
    if (!sock) return
    updateCall({ ...call, state: 'connecting' })
    const mgr = new VoiceManager()
    // 异步注入 ICE 配置（不阻塞接听，配置将在 createPeer 时被读取）
    void fetchIceServers().then((cfg) => mgr.setIceConfig(cfg)).catch(() => {})
    mgr.onMutedChange = (m) => setMuted(m)
    mgr.onError = (msg) => {
      toast.error(msg)
      if (activeCallRef) {
        updateCall({ ...activeCallRef, state: 'ended' })
        scheduleClear(1500)
      }
      mgrRef.current = null
    }
    mgr.onCallError = (msg: string) => {
      toast.error(msg)
      if (activeCallRef) {
        updateCall({ ...activeCallRef, state: 'ended' })
        scheduleClear(1500)
      }
      mgrRef.current = null
    }
    mgrRef.current = mgr
    const ok = await mgr.acceptCall(sock, channelKey, deviceId, call.peerPubId)
    if (!ok) {
      updateCall(null)
      mgrRef.current = null
      return
    }
    updateCall({ ...call, state: 'ongoing', startedAt: Date.now() })
  }

  // 拒绝 incoming
  const rejectIncoming = async () => {
    if (!call || !channelKey || !deviceId) return
    const sock = getChatSocket()
    if (!sock) return
    await rejectCall(channelKey, sock, deviceId, call.peerPubId)
    updateCall(null)
    mgrRef.current = null
  }

  // 挂断 outgoing/ongoing
  const hangUp = () => {
    mgrRef.current?.endCall()
    mgrRef.current = null
    if (activeCallRef && (activeCallRef.state === 'ongoing' || activeCallRef.state === 'outgoing' || activeCallRef.state === 'connecting')) {
      updateCall({ ...activeCallRef, state: 'ended' })
      scheduleClear(1500)
    }
  }

  const toggleMute = () => mgrRef.current?.toggleMute()

  if (!call) return null

  const avatar = pickAvatarBySeed(call.peerPubId)
  const statusText = (() => {
    switch (call.state) {
      case 'outgoing': return '正在呼叫…'
      case 'incoming': return '来电中…'
      case 'connecting': return '正在建立连接…'
      case 'ongoing': return formatDuration(call.durationSec)
      case 'rejected': return '对方已拒绝'
      case 'ended': return '通话已结束'
      case 'missed': return '未接来电'
    }
  })()

  return (
    <AnimatePresence>
      {call && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 grid place-items-center bg-black/60 backdrop-blur-md p-4"
        >
          <motion.div
            initial={{ scale: 0.95, opacity: 0, y: 20 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.95, opacity: 0, y: 20 }}
            transition={{ type: 'spring', stiffness: 280, damping: 24 }}
            className="glass w-full max-w-sm rounded-3xl border p-6 shadow-2xl"
          >
            {/* 头像 */}
            <div className="flex flex-col items-center gap-4 pb-6">
              <div className="relative">
                <img
                  src={avatar}
                  alt={call.peerNick}
                  className={cn(
                    'h-24 w-24 rounded-3xl object-cover transition-all',
                    (call.state === 'ongoing' || call.state === 'outgoing' || call.state === 'incoming' || call.state === 'connecting') && 'ring-4 ring-primary/30',
                  )}
                  draggable={false}
                />
                {/* 振铃光环 */}
                {(call.state === 'outgoing' || call.state === 'incoming') && (
                  <span className="absolute -inset-2 -z-10 rounded-3xl bg-primary/30 animate-ping" />
                )}
              </div>
              <div className="text-center">
                <p className="text-base font-bold">{call.peerNick}</p>
                <p className="text-[11px] text-muted-foreground">#{call.peerPubId.slice(-4)}</p>
              </div>
              <p className={cn(
                'text-sm font-medium',
                call.state === 'rejected' || call.state === 'ended' ? 'text-red-500' : 'text-muted-foreground',
              )}>
                {statusText}
              </p>
            </div>

            {/* 控制按钮 */}
            <div className="flex items-center justify-center gap-3">
              {call.state === 'incoming' && (
                <>
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-12 w-12 rounded-full border-red-500/40 text-red-500 hover:bg-red-500/10"
                    onClick={() => void rejectIncoming()}
                    aria-label="拒接"
                  >
                    <PhoneOff className="h-5 w-5" />
                  </Button>
                  <Button
                    size="icon"
                    className="h-14 w-14 rounded-full grad-primary shadow-lg shadow-violet-500/30"
                    onClick={() => void acceptIncoming()}
                    aria-label="接听"
                  >
                    <Phone className="h-6 w-6" />
                  </Button>
                </>
              )}

              {(call.state === 'outgoing' || call.state === 'connecting') && (
                <Button
                  variant="outline"
                  size="icon"
                  className="h-12 w-12 rounded-full border-red-500/40 text-red-500 hover:bg-red-500/10"
                  onClick={hangUp}
                  aria-label="取消呼叫"
                >
                  <PhoneOff className="h-5 w-5" />
                </Button>
              )}

              {call.state === 'ongoing' && (
                <>
                  <Button
                    variant="outline"
                    size="icon"
                    className={cn(
                      'h-12 w-12 rounded-full',
                      muted && 'border-red-500/40 text-red-500 hover:bg-red-500/10',
                    )}
                    onClick={toggleMute}
                    aria-label={muted ? '取消静音' : '静音'}
                  >
                    {muted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
                  </Button>
                  <Button
                    size="icon"
                    className="h-14 w-14 rounded-full bg-red-500 hover:bg-red-600 shadow-lg shadow-red-500/30"
                    onClick={hangUp}
                    aria-label="挂断"
                  >
                    <PhoneOff className="h-6 w-6" />
                  </Button>
                </>
              )}

              {(call.state === 'rejected' || call.state === 'ended' || call.state === 'missed') && (
                <Button
                  variant="outline"
                  size="icon"
                  className="h-12 w-12 rounded-full"
                  onClick={() => updateCall(null)}
                  aria-label="关闭"
                >
                  <X className="h-5 w-5" />
                </Button>
              )}
            </div>

            {/* 加密提示 */}
            {(call.state === 'ongoing' || call.state === 'connecting') && (
              <p className="mt-4 text-center text-[10.5px] leading-relaxed text-muted-foreground/80">
                <Headphones className="inline h-3 w-3 mr-1" />
                SRTP 端到端加密 · P2P 直传或经 TURN 中继
              </p>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
}
