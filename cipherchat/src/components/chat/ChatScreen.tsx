'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  ArrowLeft, LogOut, Trash2, Search, Download, Wifi, WifiOff, Loader2, X, MoreVertical, Users,
  QrCode, RefreshCcw, Volume2, VolumeX, CheckCheck, ShieldCheck, EyeOff,
} from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { MessageBubble } from './MessageBubble'
import { Composer } from './Composer'
import { MembersSheet, usePresenceDetails } from './MembersSheet'
import { ShareDialog } from './ShareDialog'
import { KeyRotationDialog } from './KeyRotationDialog'
import { VoiceBar } from '../voice/VoiceBar'
import { DMPanel } from './DMPanel'
import { FriendsPanel } from './FriendsPanel'
import { FxCanvas, type FxKind } from './FxCanvas'
import { useChatStore, useFeatureFlags, type ChatMsg } from '@/store/chat'
import { validateTttMove, judgeTttBoard, type TttPayload } from '@/lib/toys'
import { cn } from '@/lib/utils'
import { isTtsAuto, setTtsAuto, stopSpeaking } from '@/lib/tts'

function formatDay(iso: string) {
  const d = new Date(iso)
  const today = new Date()
  const yest = new Date(Date.now() - 86400_000)
  if (d.toDateString() === today.toDateString()) return '今天'
  if (d.toDateString() === yest.toDateString()) return '昨天'
  return d.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })
}

function StatusIcon({ s }: { s: string }) {
  if (s === 'online') return <Wifi className="h-3 w-3 text-emerald-500" />
  if (s === 'connecting') return <Loader2 className="h-3 w-3 animate-spin text-amber-500" />
  return <WifiOff className="h-3 w-3 text-red-500" />
}

export function ChatScreen({ onExit }: { onExit: () => void }) {
  // v1.7.0：细粒度订阅 —— 此前整店订阅，任何上传进度/typing/presence 变化都会
  // 让整个消息列表重渲染；现在只订阅本组件真正用到的字段
  const {
    channelId, messages, typing, wsStatus, loadHistory, hasMore, loadingHistory,
    unreadCount, markViewed,
  } = useChatStore(useShallow((s) => ({
    channelId: s.channelId,
    messages: s.messages,
    typing: s.typing,
    wsStatus: s.wsStatus,
    loadHistory: s.loadHistory,
    hasMore: s.hasMore,
    loadingHistory: s.loadingHistory,
    unreadCount: s.unreadCount,
    markViewed: s.markViewed,
  })))
  const presence = useChatStore((s) => s.presence)
  const leave = useChatStore((s) => s.leave)
  const clearChannel = useChatStore((s) => s.clearChannel)
  const deviceId = useChatStore((s) => s.deviceId)
  const sendToy = useChatStore((s) => s.sendToy)
  const { nicks } = usePresenceDetails()
  const flags = useFeatureFlags()
  const [replyTo, setReplyTo] = useState<ChatMsg | null>(null)
  const [readersMsg, setReadersMsg] = useState<ChatMsg | null>(null) // v1.5.0 谁读了我的消息弹窗
  const [search, setSearch] = useState<string | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [flashId, setFlashId] = useState<string | null>(null) // v1.6.0 引用跳转高亮
  // v1.7.0：全屏特效（彩带/烟花）状态 —— 由玩具消息触发
  const [fx, setFx] = useState<{ kind: FxKind; text?: string; seq: number } | null>(null)
  const playedFxIds = useRef<Set<string>>(new Set())
  const [shieldOn, setShieldOn] = useState<boolean>(() => {
    try { return localStorage.getItem('cipherchat:shield') === '1' } catch { return false }
  })
  const [shielded, setShielded] = useState(false) // 切后台后的模糊状态
  const [clearConfirm, setClearConfirm] = useState(false)
  const [dmTarget, setDmTarget] = useState<{ pubId: string; nick: string } | null>(null)
  const [friendsOpen, setFriendsOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [rotateOpen, setRotateOpen] = useState(false)
  const [ttsAuto, setTtsAutoState] = useState(isTtsAuto())
  const channelKey = useChatStore((s) => s.channelKey)
  const token = useChatStore((s) => s.token)
  const currentPassword = useChatStore((s) => s.password)
  const nicknameState = useChatStore((s) => s.nickname)
  const connectionMode = useChatStore((s) => s.connectionMode)

  // 密钥轮换完成后：以新密码无缝重进频道（保留昵称）
  // v1.7.0 修复：此前调用 join 时未传 connectionMode，relay 模式用户轮换后
  // 被静默丢进 `-p2p-mode` 幽灵频道（空房间）
  const rejoinWithPassword = async (newPw: string) => {
    const st = useChatStore.getState()
    const mode = st.connectionMode
    st.leave()
    try {
      await useChatStore.getState().join(channelId, newPw, nicknameState, mode)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '重新进入频道失败，请手动加入')
    }
  }
  const listRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const stickBottom = useRef(true)
  const lastCount = useRef(0)
  const [newPill, setNewPill] = useState(false)

  const onlineCount = presence.filter((d) => d.online !== false).length

  // ---------- v1.7.0：性能与玩法的支撑数据 ----------
  // 回复消息查找映射：替代此前每个气泡各自 messages.find() 的 O(n²) 模式
  const replyMap = useMemo(() => {
    const m = new Map<string, ChatMsg>()
    for (const msg of messages) m.set(msg.id, msg)
    return m
  }, [messages])

  // 每个 gameId 的最新一条棋局消息（旧棋局只读展示）
  const latestTtt = useMemo(() => {
    const m = new Map<string, string>() // gameId -> messageId
    for (const msg of messages) {
      if (msg.kind === 'toy' && msg.toy?.toy === 'ttt') m.set((msg.toy as TttPayload).gameId, msg.id)
    }
    return m
  }, [messages])

  // 投票回调（稳定引用，避免打爆 memo 化的气泡）
  const onVote = useCallback((messageId: string, optionIndex: number) => {
    useChatStore.getState().sendVote(messageId, optionIndex)
  }, [])

  // 井字棋落子：校验合法性 → 生成新棋盘 → 作为新玩具消息广播（全频道围观）
  const onTttMove = useCallback((msgId: string, moveIdx: number) => {
    const st = useChatStore.getState()
    const msg = st.messages.find((m) => m.id === msgId)
    if (!msg || msg.kind !== 'toy' || msg.toy?.toy !== 'ttt') return
    const toy = msg.toy as TttPayload
    const myId = st.deviceId
    // v1.7.0 补丁：X 固定为对局发起者（challengerId），O 为应战者；
    // 此前按「当前消息的 sender」判身份，应战者落子后双方视角都会算错棋子归属
    const myMark: 0 | 1 = toy.challengerId === myId ? 0 : 1
    if (!validateTttMove(toy.board, myMark, moveIdx).ok) return
    const board = [...toy.board]
    board[moveIdx] = myMark
    const winner = judgeTttBoard(board)
    st.sendToy({
      toy: 'ttt',
      gameId: toy.gameId,
      board,
      lastMove: moveIdx,
      winner: winner ?? null,
      status: winner === null ? 'playing' : 'over',
      challengerId: toy.challengerId,
      challengerNick: toy.challengerNick,
      // 应战者落第一子时补充自己的昵称，棋局卡片从此显示双方名字
      opponentNick: toy.challengerId === myId ? toy.opponentNick : (st.nickname || '应战者'),
    })
  }, [])

  // 彩带/烟花特效：监听到新的 fx 玩具消息即全屏播放一次（每条消息只播一次）
  useEffect(() => {
    for (const msg of messages) {
      if (msg.kind === 'toy' && msg.toy?.toy === 'fx' && !playedFxIds.current.has(msg.id)) {
        playedFxIds.current.add(msg.id)
        const p = msg.toy as { toy: 'fx'; effect: 'confetti' | 'fireworks'; text?: string }
        setFx({ kind: p.effect, text: p.text, seq: Date.now() + Math.random() })
      }
    }
  }, [messages])

  // 点击他人头像 → 打开私聊（受 whisperEnabled 开关控制）
  const openDM = (pubId: string, fallbackNick: string) => {
    if (pubId === deviceId) return
    if (!flags.whisperEnabled) {
      toast.message('管理员已关闭私聊功能')
      return
    }
    setDmTarget({ pubId, nick: nicks[pubId] || fallbackNick })
  }

  // 自动滚动：靠近底部跟随，否则显示「新消息」悬浮提示
  useEffect(() => {
    const list = messages.filter((m) => m.kind !== 'system')
    if (list.length === 0) return
    const last = list[list.length - 1]
    const isMine = last.mine
    const delta = list.length - lastCount.current
    lastCount.current = list.length
    requestAnimationFrame(() => {
      if (stickBottom.current || isMine) {
        bottomRef.current?.scrollIntoView({ behavior: delta === 1 ? 'smooth' : 'auto' })
        setNewPill(false)
      } else if (delta > 0) {
        setNewPill(true)
      }
    })
  }, [messages])

  useEffect(() => {
    const el = listRef.current
    if (!el) return
    const onScroll = () => {
      stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
      if (el.scrollTop < 60 && hasMore && !loadingHistory) loadHistory()
      if (stickBottom.current) setNewPill(false)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [hasMore, loadingHistory, loadHistory])

  // v1.6.0 引用跳转：滚动定位到原消息并闪烁高亮
  useEffect(() => {
    const onJump = (e: Event) => {
      const id = (e as CustomEvent<{ id: string }>).detail?.id
      if (!id) return
      const el = document.getElementById(`msg-${id}`)
      if (!el) {
        toast.message('原消息不在已加载范围，上滑加载更早消息后再试')
        return
      }
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      setFlashId(id)
      window.setTimeout(() => setFlashId((cur) => (cur === id ? null : cur)), 1700)
    }
    window.addEventListener('cipherchat:jump', onJump)
    return () => window.removeEventListener('cipherchat:jump', onJump)
  }, [])

  // v1.6.0 未读数写入浏览器标签标题；回到页面/频道可见时清零
  useEffect(() => {
    const base = `密讯 · ${channelId}`
    document.title = unreadCount > 0 ? `(${unreadCount}) ${base}` : base
    return () => { document.title = '密讯 CipherChat · 端到端加密中继' }
  }, [unreadCount, channelId])

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        markViewed()
        setShielded(false)
      } else if (shieldOn) {
        setShielded(true)
      }
    }
    const onBlur = () => { if (shieldOn) setShielded(true) }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('blur', onBlur)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('blur', onBlur)
    }
  }, [shieldOn, markViewed])

  // v1.6.0 快捷键：Ctrl/Cmd+F 聚焦频道内搜索；Esc 取消搜索/回复
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setSearch((s) => (s === null ? '' : s))
        requestAnimationFrame(() => searchInputRef.current?.focus())
      } else if (e.key === 'Escape') {
        setSearch(null)
        setReplyTo(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const toggleShield = () => {
    const next = !shieldOn
    setShieldOn(next)
    try { localStorage.setItem('cipherchat:shield', next ? '1' : '0') } catch { /* ignore */ }
    toast.message(next ? '屏幕安全模式已开启：切后台/失焦时自动模糊消息区' : '屏幕安全模式已关闭')
  }

  const typingLabel = useMemo(() => {    const names = typing
      .filter((t) => t.deviceId !== deviceId && Date.now() - t.at < 5000)
      .map((t) => nicks[t.deviceId] || '对方')
    if (names.length === 0) return null
    if (names.length === 1) return `${names[0]} 正在输入`
    if (names.length === 2) return `${names[0]} 与 ${names[1]} 正在输入`
    return `${names.length} 位成员正在输入`
  }, [typing, nicks, deviceId, messages])

  // 搜索过滤（已加载消息中匹配）
  const filtered = useMemo(() => {
    if (search === null || search.trim() === '') return messages
    const q = search.trim().toLowerCase()
    return messages.filter((m) => {
      if (m.kind === 'system') return false
      if (m.kind === 'text') return (m.text || '').toLowerCase().includes(q) || (m.nick || '').toLowerCase().includes(q)
      if (m.kind === 'sticker') return '表情贴纸'.includes(q)
      if (m.kind === 'file') return (m.file?.name || '').toLowerCase().includes(q)
      if (m.kind === 'voice') return '语音消息'.includes(q) || (m.nick || '').toLowerCase().includes(q)
      if (m.kind === 'toy') return '玩具 骰子 硬币 猜拳 魔球 投票 井字棋 彩带 烟花'.includes(q)
      return false
    })
  }, [messages, search])

  // 导出聊天记录（仅本地已解密部分；导出内容包含明文，请注意保管）
  const exportChat = () => {
    const data = messages
      .filter((m) => m.kind !== 'system' && m.status !== 'sending')
      .map((m) => ({
        time: m.createdAt,
        sender: m.nick || '未知',
        deviceId: m.senderId,
        type: m.kind,
        text: m.kind === 'text' ? m.text : m.kind === 'sticker' ? `[贴纸] ${m.text}` : m.kind === 'voice' ? `[语音] ${m.voice?.duration}s (${m.voice?.size}B)` : m.kind === 'toy' ? '[频道玩具]' : `[文件] ${m.file?.name} (${m.file?.size}B)`,
      }))
    const blob = new Blob(
      [JSON.stringify({ channel: channelId, exportedAt: new Date().toISOString(), messages: data }, null, 2)],
      { type: 'application/json' }
    )
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `chat-${channelId}.json`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 10000)
    toast.success('聊天记录已导出（仅含已加载部分，明文请注意保管）')
  }

  const doLeave = () => {
    leave()
    onExit()
  }

  const contentMessages = filtered.filter((m) => m.kind !== 'system')
  const hasContent = messages.some((m) => m.kind !== 'system')

  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden">
      {/* 头部（玻璃条，全幅） */}
      <header className="glass z-20 border-b px-3 pt-safe sm:px-5">
        <div className="mx-auto flex h-14 max-w-4xl items-center gap-1.5 sm:gap-2">
          <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0 rounded-xl" onClick={doLeave} aria-label="返回首页">
            <ArrowLeft className="h-5 w-5" />
          </Button>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-[15px] font-bold">{channelId}</h1>
              {/* v1.4.3：当前连接方式徽章 —— 提醒成员模式必须一致才能互相可见 */}
              <Badge
                variant="outline"
                title={connectionMode === 'p2p'
                  ? 'P2P 直连：文字经 WebRTC DataChannel 端到端直传，服务器不留存；双方需同时在线'
                  : '服务器中继：密文经服务器转发并留存，支持离线消息与历史回看'}
                className={cn('hidden shrink-0 rounded-full px-2 py-0 text-[10px] font-medium sm:inline-flex',
                  connectionMode === 'p2p'
                    ? 'border-violet-500/30 bg-violet-500/10 text-violet-600 dark:text-violet-300'
                    : 'border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-300')}
              >
                {connectionMode === 'p2p' ? '⚡ P2P' : '📡 中继'}
              </Badge>
              <Badge variant="outline" className="hidden shrink-0 rounded-full border-primary/30 bg-primary/5 px-2 py-0 text-[10px] font-medium text-primary md:inline-flex">
                AES-256 已加密
              </Badge>
            </div>
            <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <StatusIcon s={wsStatus} />
              <span>
                {wsStatus === 'online' ? (
                  <span className="text-emerald-600 dark:text-emerald-400">已连接</span>
                ) : wsStatus === 'connecting' ? (
                  <span className="text-amber-600 dark:text-amber-400">连接中…</span>
                ) : (
                  <span className="text-red-500">已断开·重连中</span>
                )}
              </span>
              <span>·</span>
              <span>{onlineCount} 台设备在线</span>
            </p>
          </div>

          <MembersSheet compact />

          <Button
            variant="ghost"
            size="icon"
            className="relative h-9 w-9 shrink-0 rounded-xl"
            onClick={() => setSearch(search === null ? '' : null)}
            aria-label="搜索消息"
          >
            <Search className="h-[18px] w-[18px]" />
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0 rounded-xl" aria-label="更多操作">
                <MoreVertical className="h-5 w-5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="rounded-xl">
              <DropdownMenuItem onClick={() => setShareOpen(true)}>
                <QrCode className="mr-2 h-4 w-4" /> 分享频道 / 邀请二维码
              </DropdownMenuItem>
              {channelKey && token && (
                <DropdownMenuItem onClick={() => setRotateOpen(true)}>
                  <RefreshCcw className="mr-2 h-4 w-4" /> 重新协商密钥（换密码迁移）
                </DropdownMenuItem>
              )}
              {/* v1.5.0 安全审计页 */}
              <DropdownMenuItem onClick={() => window.open('/security', '_blank')}>
                <ShieldCheck className="mr-2 h-4 w-4" /> 安全审计
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => {
                  const next = !ttsAuto
                  setTtsAuto(next)
                  setTtsAutoState(next)
                  toast.message(next ? '已开启自动朗读：收到文字消息将自动朗读' : '已关闭自动朗读')
                }}
              >
                {ttsAuto ? <VolumeX className="mr-2 h-4 w-4" /> : <Volume2 className="mr-2 h-4 w-4" />}
                {ttsAuto ? '关闭自动朗读' : '开启自动朗读'}
              </DropdownMenuItem>
              {/* v1.6.0 屏幕安全模式：切后台/失焦自动模糊消息区，防偷窥 */}
              <DropdownMenuItem onClick={toggleShield}>
                <EyeOff className="mr-2 h-4 w-4" />
                {shieldOn ? '关闭屏幕安全模式' : '开启屏幕安全模式'}
              </DropdownMenuItem>
              {flags.friendEnabled && (
                <DropdownMenuItem onClick={() => setFriendsOpen(true)}>
                  <Users className="mr-2 h-4 w-4" /> 好友列表
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={exportChat}>
                <Download className="mr-2 h-4 w-4" /> 导出聊天记录
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => setClearConfirm(true)}>
                <Trash2 className="mr-2 h-4 w-4" /> 清空全部记录
              </DropdownMenuItem>
              <DropdownMenuItem onClick={doLeave}>
                <LogOut className="mr-2 h-4 w-4" /> 退出频道
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* 搜索条（激活时展开） */}
        {search !== null && (
          <div className="mx-auto flex max-w-4xl items-center gap-2 pb-2.5">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                ref={searchInputRef}
                autoFocus
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索已加载的消息 / 文件名 / 成员…（Ctrl+F 快捷聚焦）"
                className="h-9 rounded-xl pl-9"
              />
            </div>
            <Button variant="ghost" size="icon" className="h-9 w-9 rounded-xl" onClick={() => setSearch(null)} aria-label="关闭搜索">
              <X className="h-4 w-4" />
            </Button>
          </div>
        )}
      </header>

      {/* 消息区 */}
      <main className="relative mx-auto flex w-full max-w-4xl flex-1 flex-col overflow-hidden">
        {dmTarget && flags.whisperEnabled && (
          <DMPanel targetPubId={dmTarget.pubId} targetNick={dmTarget.nick} onClose={() => setDmTarget(null)} />
        )}
        {friendsOpen && flags.friendEnabled && (
          <FriendsPanel onClose={() => setFriendsOpen(false)} onOpenDM={(pubId, nick) => { setFriendsOpen(false); openDM(pubId, nick) }} />
        )}
        {loadingHistory && contentMessages.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <p className="text-sm">正在解密聊天记录…</p>
          </div>
        ) : !hasContent ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center min-h-0 overflow-y-auto">
            {/* 仅有的系统消息（欢迎语录）也展示出来 */}
            {filtered.filter((m) => m.kind === 'system').length > 0 && (
              <div className="w-full max-w-md space-y-1.5">
                {filtered.filter((m) => m.kind === 'system').map((m) => (
                  <div key={m.id} className="flex justify-center py-1">
                    <span className="max-w-[85%] text-center text-[12px] leading-relaxed text-muted-foreground bg-muted/70 rounded-2xl px-3.5 py-1.5 select-text">{m.text}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="grid h-20 w-20 place-items-center rounded-3xl grad-primary-soft text-4xl">👋</div>
            <div>
              <p className="text-lg font-bold">频道已就绪，开启加密对话</p>
              <p className="mx-auto mt-1.5 max-w-xs text-sm leading-relaxed text-muted-foreground">
                发送第一条消息、丢一个表情包，或者直接 <b>Ctrl+V</b> 粘贴一张截图试试
              </p>
            </div>
          </div>
        ) : (
          <div
            ref={listRef}
            className={cn(
              'scroll-slim min-h-0 flex-1 overflow-y-auto px-3 py-4 transition-[filter] duration-200 sm:px-5',
              shielded && 'pointer-events-none select-none blur-xl grayscale',
            )}
          >
            {/* 加载更早 */}
            {hasMore && (
              <div className="mb-4 flex justify-center">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 rounded-full border-primary/30 text-xs text-primary hover:bg-primary/10"
                  onClick={() => loadHistory()}
                  disabled={loadingHistory}
                >
                  {loadingHistory ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                  加载更早的消息
                </Button>
              </div>
            )}
            {search !== null && search.trim() !== '' && (
              <div className="mb-4 flex justify-center">
                <span className="rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground">
                  匹配 {filtered.length} / {contentMessages.length} 条已加载消息
                </span>
              </div>
            )}
            {filtered.length === 0 && search !== null && search.trim() !== '' && (
              <div className="flex flex-col items-center gap-3 py-12 text-muted-foreground">
                <Search className="h-10 w-10 opacity-40" />
                <p className="text-sm">没有匹配「{search}」的消息</p>
              </div>
            )}

            <div className="mx-auto max-w-3xl space-y-0.5">
              {(() => {
                // 日期分隔 + 连续归组（同人 5 分钟内）
                const items: Array<{ kind: 'date'; key: string; label: string } | { kind: 'sys'; key: string; text: string } | { kind: 'msg'; key: string; msg: ChatMsg; grouped: boolean }> = []
                let prev: ChatMsg | null = null
                for (const m of filtered) {
                  if (m.kind === 'system') {
                    items.push({ kind: 'sys', key: m.id, text: m.text || '' })
                    prev = null
                    continue
                  }
                  const showDate = !prev || new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString()
                  if (showDate) items.push({ kind: 'date', key: `d-${m.id}`, label: formatDay(m.createdAt) })
                  const grouped =
                    !!prev &&
                    !showDate &&
                    prev.senderId === m.senderId &&
                    new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() < 5 * 60_000
                  items.push({ kind: 'msg', key: m.id, msg: m, grouped })
                  prev = m
                }
                return items.map((item) => {
                  if (item.kind === 'date') {
                    return (
                      <div key={item.key} className="flex items-center gap-3 py-3">
                        <div className="h-px flex-1 bg-border" />
                        <span className="rounded-full bg-muted px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground">{item.label}</span>
                        <div className="h-px flex-1 bg-border" />
                      </div>
                    )
                  }
                  if (item.kind === 'sys') {
                    return (
                      <div key={item.key} className="flex justify-center py-1.5">
                        <span className="max-w-[85%] whitespace-pre-wrap text-center text-[11.5px] leading-relaxed text-muted-foreground bg-muted/70 rounded-2xl px-3.5 py-1.5 select-text">
                          {item.text}
                        </span>
                      </div>
                    )
                  }
                  return (
                    <div
                      key={item.key}
                      id={`msg-${item.msg.id}`}
                      className={cn('-mx-2 scroll-mt-20 rounded-2xl px-2 transition-colors', flashId === item.msg.id && 'msg-flash')}
                    >
                      <MessageBubble
                        msg={item.msg}
                        grouped={item.grouped}
                        onReply={setReplyTo}
                        onOpenDM={openDM}
                        onShowReaders={setReadersMsg}
                        replyToMsg={item.msg.replyToId ? replyMap.get(item.msg.replyToId) || null : null}
                        tttInteractive={
                          item.msg.kind === 'toy' && item.msg.toy?.toy === 'ttt'
                            ? latestTtt.get((item.msg.toy as TttPayload).gameId) === item.msg.id
                            : false
                        }
                        onVote={onVote}
                        onTttMove={onTttMove}
                      />
                    </div>
                  )
                })
              })()}
              <div ref={bottomRef} className="h-1" />
            </div>
          </div>
        )}

        {/* 正在输入（悬浮玻璃胶囊，左下） */}
        {typingLabel && !shielded && (
          <div className="pointer-events-none absolute bottom-2 left-4 z-10 flex items-center gap-2 rounded-full glass border px-3 py-1.5 text-xs text-muted-foreground shadow-sm">
            <span className="flex gap-1">
              <span className="typing-dot h-1.5 w-1.5 rounded-full bg-primary" />
              <span className="typing-dot h-1.5 w-1.5 rounded-full bg-primary" />
              <span className="typing-dot h-1.5 w-1.5 rounded-full bg-primary" />
            </span>
            {typingLabel}
          </div>
        )}

        {/* v1.6.0 安全模式遮罩：点击恢复显示 */}
        {shielded && (
          <button
            onClick={() => setShielded(false)}
            className="absolute inset-0 z-20 grid place-items-center bg-background/40 backdrop-blur-[2px]"
            aria-label="点击恢复显示消息"
          >
            <span className="flex items-center gap-2 rounded-full glass border px-4 py-2 text-sm font-medium shadow-lg">
              <EyeOff className="h-4 w-4" /> 消息已隐藏 · 点击恢复
            </span>
          </button>
        )}

        {/* 新消息悬浮按钮（右下） */}
        {newPill && (
          <button
            onClick={() => {
              bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
              setNewPill(false)
            }}
            className="absolute bottom-3 right-4 z-10 flex items-center gap-1.5 rounded-full grad-primary px-3.5 py-2 text-xs font-semibold text-white shadow-lg shadow-violet-500/30 transition-transform hover:scale-105"
          >
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"/></svg>
            新消息
          </button>
        )}
      </main>

      {/* 输入区 */}
      <Composer replyTo={replyTo} onCancelReply={() => setReplyTo(null)} />

      {/* v1.7.0 全屏特效画布（彩带/烟花） */}
      <FxCanvas fx={fx} />

      {/* 语音频道底栏（功能开关开启时显示） */}
      {flags.voiceEnabled && <VoiceBar />}

      {/* 分享频道（二维码/邀请链接） */}
      {shareOpen && channelKey && token && (
        <ShareDialog
          channelId={channelId}
          password={currentPassword}
          token={token}
          onClose={() => setShareOpen(false)}
        />
      )}

      {/* 重新协商密钥 */}
      {rotateOpen && (
        <KeyRotationDialog
          channelId={channelId}
          onClose={() => setRotateOpen(false)}
          onDone={(newPw) => {
            void rejoinWithPassword(newPw)
          }}
        />
      )}

      {/* v1.5.0 谁读了我的消息（触屏点按弹窗） */}
      {readersMsg && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" onClick={() => setReadersMsg(null)}>
          <div className="glass w-full max-w-xs rounded-2xl border p-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-2 text-sm font-bold flex items-center gap-1.5">
              <CheckCheck className="h-4 w-4 text-emerald-500" /> 已读成员
              <span className="text-[11px] font-normal text-muted-foreground">({readersMsg.readers?.length || 0})</span>
            </h3>
            {readersMsg.readers && readersMsg.readers.length > 0 ? (
              <ul className="max-h-60 space-y-1.5 overflow-y-auto scroll-slim">
                {readersMsg.readers.map((r) => (
                  <li key={r.readerId} className="flex items-center justify-between rounded-lg bg-muted/60 px-3 py-1.5 text-[12.5px]">
                    <span className="font-medium">{nicks[r.readerId] || `#${r.readerId.slice(-4)}`}</span>
                    <span className="text-[10px] text-muted-foreground">
                      {new Date(r.readAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="py-4 text-center text-[12px] text-muted-foreground">暂无回执记录</p>
            )}
          </div>
        </div>
      )}

      {/* 清空确认（自定义模态） */}
      {clearConfirm && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4 backdrop-blur-sm" role="dialog" aria-modal="true">
          <div className="glass w-full max-w-sm rounded-2xl border p-6 shadow-2xl">
            <div className="mb-4 grid h-12 w-12 place-items-center rounded-xl bg-destructive/15 text-destructive">
              <Trash2 className="h-6 w-6" />
            </div>
            <h2 className="mb-2 text-lg font-bold">清空频道全部记录？</h2>
            <p className="mb-6 text-sm leading-relaxed text-muted-foreground">
              将删除频道「{channelId}」的 <b>全部聊天消息与已上传文件</b>，此操作不可撤销，所有成员的界面都会同步清空。
            </p>
            <div className="flex gap-3">
              <Button variant="outline" className="flex-1 rounded-xl" onClick={() => setClearConfirm(false)}>取消</Button>
              <Button
                variant="destructive"
                className="flex-1 rounded-xl"
                onClick={() => {
                  setClearConfirm(false)
                  clearChannel()
                }}
              >
                确认清空
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
