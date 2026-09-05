'use client'
// 语音频道底栏：加入/离开/静音/说话指示 + 连接质量徽章
import { useEffect, useRef, useState } from 'react'
import { Mic, MicOff, Headphones, PhoneOff, Volume2, Zap, Radio, AlertTriangle, Loader2, MonitorUp, MonitorOff, Monitor } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { VoiceManager, fetchIceServers, type PeerConnState } from '@/lib/webrtc'
import { useChatStore, getChatSocket } from '@/store/chat'
import { toast } from 'sonner'

// 连接质量徽章颜色与文字
const STATE_BADGE: Record<PeerConnState, { text: string; cls: string; icon: React.ReactNode }> = {
  new: { text: '新建', cls: 'bg-muted text-muted-foreground', icon: <Loader2 className="h-2.5 w-2.5 animate-spin" /> },
  connecting: { text: '连接中', cls: 'bg-amber-500/15 text-amber-600 dark:text-amber-400', icon: <Loader2 className="h-2.5 w-2.5 animate-spin" /> },
  p2p: { text: 'P2P', cls: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400', icon: <Zap className="h-2.5 w-2.5" /> },
  relay: { text: '中继', cls: 'bg-sky-500/15 text-sky-600 dark:text-sky-400', icon: <Radio className="h-2.5 w-2.5" /> },
  failed: { text: '失败', cls: 'bg-red-500/15 text-red-500', icon: <AlertTriangle className="h-2.5 w-2.5" /> },
  disconnected: { text: '断开', cls: 'bg-amber-500/15 text-amber-600', icon: <AlertTriangle className="h-2.5 w-2.5" /> },
  closed: { text: '已关', cls: 'bg-muted text-muted-foreground', icon: null },
}

export function VoiceBar() {
  const { channelKey, deviceId, wsStatus } = useChatStore()
  const [joined, setJoined] = useState(false)
  const [muted, setMuted] = useState(false)
  const [participants, setParticipants] = useState<{ pubId: string; muted: boolean }[]>([])
  const [speaking, setSpeaking] = useState<Set<string>>(new Set())
  const [connecting, setConnecting] = useState(false)
  const [peerStates, setPeerStates] = useState<Map<string, PeerConnState>>(new Map())
  const [iceReady, setIceReady] = useState(false)
  const [sharing, setSharing] = useState(false)
  const [remoteScreens, setRemoteScreens] = useState<Map<string, MediaStream>>(new Map())
  const [viewingScreen, setViewingScreen] = useState<string | null>(null)
  const mgrRef = useRef<VoiceManager | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)

  // 预拉取 ICE 配置（管理员后台是否已启用 TURN）
  useEffect(() => {
    void fetchIceServers().then(() => setIceReady(true))
  }, [])

  const join = async () => {
    if (!channelKey) return
    setConnecting(true)
    const sock = getChatSocket()
    if (!sock) { toast.error('连接未就绪'); setConnecting(false); return }
    const mgr = new VoiceManager()
    // 注入 ICE 配置（必须先 fetch 过）
    await mgr.setIceConfig(await fetchIceServers())
    mgr.onParticipantsChange = (list) => setParticipants(list)
    mgr.onSpeakingChange = (pubId, isSpeaking) => {
      setSpeaking((prev) => {
        const next = new Set(prev)
        if (isSpeaking) next.add(pubId); else next.delete(pubId)
        return next
      })
    }
    mgr.onMutedChange = (m) => setMuted(m)
    // ★ v1.3.1：连接状态变化 → 更新 peerStates Map
    mgr.onPeerStateChange = (pubId, state) => {
      setPeerStates((prev) => {
        const next = new Map(prev)
        next.set(pubId, state)
        return next
      })
    }
    mgr.onError = (msg) => { toast.error(msg, { duration: 5000 }); setConnecting(false) }
    // 屏幕共享状态
    const prevOnSS = mgr.onRemoteStream
    mgr.onRemoteStream = (pubId, stream) => {
      prevOnSS?.(pubId, stream)
      setRemoteScreens((prev) => {
        const next = new Map(prev)
        if (stream && stream.getVideoTracks().length > 0) next.set(pubId, stream)
        else next.delete(pubId)
        return next
      })
    }
    mgr.onScreenShareChange = (s) => setSharing(s)
    mgrRef.current = mgr
    const ok = await mgr.join(sock, channelKey, deviceId)
    if (ok) { setJoined(true); toast.success('已加入语音频道') }
    setConnecting(false)
  }

  const leave = () => {
    mgrRef.current?.leave()
    mgrRef.current = null
    setJoined(false)
    setParticipants([])
    setSpeaking(new Set())
    setMuted(false)
    setPeerStates(new Map())
  }

  const toggleMute = () => {
    mgrRef.current?.toggleMute()
  }

  const toggleShare = async () => {
    const mgr = mgrRef.current
    if (!mgr) return
    if (mgr.screenSharing) {
      await mgr.stopScreenShare()
      toast.message('已停止屏幕共享')
    } else {
      const ok = await mgr.startScreenShare()
      if (ok) toast.success('屏幕共享已开始')
    }
  }

  // 远端屏幕视频渲染（浮动窗口）
  useEffect(() => {
    if (viewingScreen && videoRef.current) {
      const s = remoteScreens.get(viewingScreen)
      if (s) videoRef.current.srcObject = s
    }
  }, [viewingScreen, remoteScreens])

  useEffect(() => {
    return () => { mgrRef.current?.leave() }
  }, [])

  if (!joined) {
    return (
      <div className="border-t border-black/5 dark:border-white/10 px-3 sm:px-5 py-2.5 flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="rounded-xl gap-1.5 h-9"
          onClick={join}
          disabled={connecting || !iceReady || wsStatus !== 'online'}
        >
          {connecting ? <Volume2 className="h-4 w-4 animate-pulse" /> : <Headphones className="h-4 w-4" />}
          {connecting ? '连接中…' : '加入语音'}
        </Button>
        <span className="text-[11px] text-muted-foreground">语音 WebRTC · SRTP 加密 · 不留存</span>
      </div>
    )
  }

  return (
    <div className="border-t border-primary/20 bg-primary/5 px-3 sm:px-5 py-2 flex items-center gap-2">
      <div className="flex items-center gap-1.5 min-w-0 flex-1 overflow-x-auto no-scrollbar">
        {participants.map((p) => {
          const isMe = p.pubId === deviceId
          const isSpeaking = speaking.has(p.pubId)
          const state = isMe ? null : peerStates.get(p.pubId)
          const badge = state ? STATE_BADGE[state] : null
          return (
            <div
              key={p.pubId}
              className={cn(
                'flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium shrink-0 transition-all',
                isSpeaking ? 'bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 ring-2 ring-emerald-500/40' : 'bg-muted'
              )}
            >
              {p.muted ? <MicOff className="h-3 w-3 text-red-400" /> : <Mic className="h-3 w-3" />}
              <span className="truncate max-w-[60px]">#{p.pubId.slice(-4)}{isMe ? ' (你)' : ''}</span>
              {badge && (
                <span className={cn('inline-flex items-center gap-0.5 rounded-full px-1.5 py-0 text-[9px] font-semibold leading-tight', badge.cls)}>
                  {badge.icon}{badge.text}
                </span>
              )}
            </div>
          )
        })}
      </div>
      <Button
        variant="ghost"
        size="icon"
        className={cn('h-9 w-9 rounded-xl shrink-0', sharing && 'bg-sky-500/15 text-sky-500')}
        onClick={toggleShare}
        aria-label={sharing ? '停止屏幕共享' : '共享屏幕'}
        title={sharing ? '停止屏幕共享' : '共享屏幕（getDisplayMedia）'}
      >
        {sharing ? <MonitorOff className="h-4 w-4" /> : <MonitorUp className="h-4 w-4" />}
      </Button>
      {remoteScreens.size > 0 && (
        <Button
          variant="ghost"
          size="sm"
          className="h-9 rounded-xl gap-1.5 shrink-0 text-sky-600 dark:text-sky-400"
          onClick={() => setViewingScreen(viewingScreen || [...remoteScreens.keys()][0])}
          aria-label="查看对方屏幕"
        >
          <Monitor className="h-4 w-4" /> 查看{remoteScreens.size > 1 ? ` (${remoteScreens.size})` : ''}屏幕
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon"
        className={cn('h-9 w-9 rounded-xl shrink-0', muted && 'bg-red-500/15 text-red-500')}
        onClick={toggleMute}
        aria-label={muted ? '取消静音' : '静音'}
      >
        {muted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-9 w-9 rounded-xl shrink-0 text-red-500 hover:bg-red-500/10"
        onClick={leave}
        aria-label="离开语音"
      >
        <PhoneOff className="h-4 w-4" />
      </Button>

      {/* 远端屏幕查看浮窗 */}
      {viewingScreen && remoteScreens.has(viewingScreen) && (
        <div className="fixed bottom-24 right-4 z-50 w-[min(560px,80vw)] overflow-hidden rounded-2xl border bg-black/95 shadow-2xl">
          <div className="flex items-center justify-between border-b border-white/10 px-3 py-1.5 text-xs text-white/80">
            <span className="flex items-center gap-1.5"><Monitor className="h-3.5 w-3.5" /> #{viewingScreen.slice(-4)} 的屏幕</span>
            <button onClick={() => setViewingScreen(null)} aria-label="关闭屏幕查看" className="rounded p-1 hover:bg-white/10">✕</button>
          </div>
          { }
          <video ref={videoRef} autoPlay playsInline className="w-full rounded-b-2xl" />
        </div>
      )}
    </div>
  )
}
