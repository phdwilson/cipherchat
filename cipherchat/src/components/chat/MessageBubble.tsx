'use client'

import { memo, useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { Copy, Reply, Trash2, Check, CheckCheck, Loader2, AlertCircle, Volume2, Flame, SmilePlus } from 'lucide-react'
import { FileBubble } from './FileBubble'
import { VoiceBubble } from './VoiceBubble'
import { ToyBubble, type ToyBubbleExtras } from './ToyBubble'
import { useChatStore, type ChatMsg, type PresenceDevice } from '@/store/chat'
import { openJSON } from '@/lib/crypto'
import { parseSegments } from '@/lib/textfmt'
import { speakText } from '@/lib/tts'
import { getOrInitDefaultAvatar } from '@/lib/avatar-library'
import { cn } from '@/lib/utils'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

// v1.6.0 快捷回应 emoji
const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏']

// v1.6.0 点击引用块跳转到原消息（MessageList 监听该事件并滚动高亮）
export function jumpToMessage(id: string) {
  window.dispatchEvent(new CustomEvent('cipherchat:jump', { detail: { id } }))
}

// v1.6.0 富文本：支持 ||剧透遮罩||（点击揭示）
function RichText({ text, mine }: { text: string; mine: boolean }) {
  const [revealed, setRevealed] = useState<Set<number>>(() => new Set())
  const segs = parseSegments(text)
  return (
    <p className="whitespace-pre-wrap break-words">
      {segs.map((seg, i) =>
        seg.type === 'text' ? (
          <span key={i}>{seg.value}</span>
        ) : (
          <span
            key={i}
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation()
              setRevealed((prev) => new Set(prev).add(i))
            }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setRevealed((prev) => new Set(prev).add(i)) }}
            title="点击揭示"
            className={cn(
              'cursor-pointer rounded px-1 transition-all select-none',
              mine ? 'bg-black/20' : 'bg-primary/15',
              !revealed.has(i) && 'blur-[5px] hover:blur-[3px]',
            )}
          >
            {seg.value}
          </span>
        ),
      )}
    </p>
  )
}

function timeOf(iso: string) {
  const d = new Date(iso)
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

// 由设备 ID 生成稳定色相（每台设备头像颜色独一无二）
export function hueOf(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360
  return h
}

// v1.7.0：头像解密缓存 —— 此前每个消息气泡挂载都重复解密一次 avatarEnc
//（O(n) 次 WebCrypto 往返 / presence 事件），现在按密文缓存解密结果（上限 128 条）
const avatarCache = new Map<string, string>()
const AVATAR_CACHE_MAX = 128

// 头像组件：若 presence 中该设备有 avatarEnc，则解密后渲染自定义头像；否则回退色相渐变 + 首字母
export function Avatar({ deviceId, nickname, size = 34, onClick }: {
  deviceId: string
  nickname: string
  size?: number
  onClick?: () => void
}) {
  const presence = useChatStore((s) => s.presence)
  const channelKey = useChatStore((s) => s.channelKey)
  const entry: PresenceDevice | undefined = presence.find((p) => p.deviceId === deviceId)
  const avatarEnc = entry?.avatarEnc
  const [url, setUrl] = useState<string | null>(() => (avatarEnc ? avatarCache.get(avatarEnc) || null : null))

  useEffect(() => {
    let alive = true
    if (!channelKey || !avatarEnc) {
      // 异步清理旧 URL（避免同步 setState 触发 React 19 严格规则）
      queueMicrotask(() => { if (alive) setUrl(null) })
      return () => { alive = false }
    }
    const cached = avatarCache.get(avatarEnc)
    if (cached) {
      queueMicrotask(() => { if (alive) setUrl(cached) })
      return () => { alive = false }
    }
    openJSON<{ avatar: string }>(channelKey, avatarEnc).then((v) => {
      if (v?.avatar) {
        if (avatarCache.size >= AVATAR_CACHE_MAX) {
          const oldest = avatarCache.keys().next().value
          if (oldest !== undefined) avatarCache.delete(oldest)
        }
        avatarCache.set(avatarEnc, v.avatar)
      }
      queueMicrotask(() => { if (alive) setUrl(v?.avatar || null) })
    }).catch(() => { if (alive) setUrl(null) })
    return () => { alive = false }
  }, [avatarEnc, channelKey])

  const h = hueOf(deviceId)
  // 没有自定义头像时回退到默认头像库（按设备 ID 稳定挑选）
  const fallback = deviceId ? getOrInitDefaultAvatar(deviceId) : null
  return (
    <span
      aria-hidden={!onClick}
      onClick={onClick}
      className={cn(
        'grid shrink-0 select-none place-items-center overflow-hidden rounded-xl text-xs font-bold text-white shadow-sm',
        onClick && 'cursor-pointer ring-2 ring-transparent transition hover:ring-primary/40',
      )}
      style={{
        width: size,
        height: size,
        background: `linear-gradient(135deg, hsl(${h} 65% 58%), hsl(${(h + 45) % 360} 70% 48%))`,
        fontSize: size * 0.36,
      }}
    >
      {url ? (
        <img src={url} alt="" className="h-full w-full object-cover" draggable={false} />
      ) : fallback ? (
        <img src={fallback} alt="" className="h-full w-full object-cover" draggable={false} />
      ) : (
        nickname.slice(0, 1)
      )}
    </span>
  )
}

interface MessageBubbleProps {
  msg: ChatMsg
  grouped: boolean
  onReply: (m: ChatMsg) => void
  onOpenDM?: (pubId: string, nick: string) => void
  onShowReaders?: (m: ChatMsg) => void
  replyToMsg?: ChatMsg | null // v1.7.0：由父组件批量构建的回复映射（替代每气泡 find O(n²)）
  tttInteractive?: boolean // v1.7.0：是否是该 gameId 的最新棋局
  onVote?: (messageId: string, optionIndex: number) => void
  onTttMove?: (msgId: string, moveIdx: number) => void
}

function MessageBubbleInner({
  msg,
  grouped,
  onReply,
  onOpenDM,
  onShowReaders,
  replyToMsg,
  tttInteractive,
  onVote,
  onTttMove,
}: MessageBubbleProps) {
  const deviceId = useChatStore((s) => s.deviceId)
  const deleteMessages = useChatStore((s) => s.deleteMessages)
  const fetchReaders = useChatStore((s) => s.fetchReaders)
  const toggleReaction = useChatStore((s) => s.toggleReaction)
  const [copied, setCopied] = useState(false)
  const [hover, setHover] = useState(false)
  const [reactOpen, setReactOpen] = useState(false)

  const selfNick = useChatStore((s) => s.nickname)
  const nick = msg.mine ? msg.nick || selfNick : msg.nick || '匿名'

  const replied = replyToMsg ?? null
  const repliedPreview = replied
    ? replied.kind === 'file'
      ? `📎 ${replied.file?.name || '文件'}`
      : replied.kind === 'voice'
        ? `🎙️ 语音 ${replied.voice?.duration.toFixed(0)}″`
        : replied.kind === 'sticker'
          ? `[大表情] ${replied.text}`
          : replied.kind === 'toy'
            ? '🎲 [频道玩具]'
            : replied.text || ''
    : null

  const copy = async () => {
    if (!msg.text || msg.kind !== 'text') return
    try {
      await navigator.clipboard.writeText(msg.text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch { /* ignore */ }
  }

  const del = () => deleteMessages([msg.id])

  const tts = () => {
    if (msg.kind === 'text' && msg.text) speakText(msg.text)
  }

  const isSticker = msg.kind === 'sticker'

  // v1.7.0：投票 / 井字棋交互参数
  const toyExtras: ToyBubbleExtras | undefined = msg.kind === 'toy' && msg.toy
    ? {
        msgId: msg.id,
        senderId: msg.senderId,
        pollVotes: msg.pollVotes,
        myId: deviceId,
        onVote: onVote ? (idx) => onVote(msg.id, idx) : undefined,
        onTttMove: onTttMove ? (msgId, idx) => onTttMove(msgId, idx) : undefined,
        tttInteractive,
      }
    : undefined

  return (
    <div
      className={cn('group/msg flex w-full gap-2.5', msg.mine ? 'flex-row-reverse' : 'flex-row', grouped ? 'mt-0.5' : 'mt-2.5')}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {/* 头像（连续消息只显示一次） */}
      <div className="w-[34px] shrink-0 self-end">
        {!grouped && !msg.mine && (
          <Avatar
            deviceId={msg.senderId}
            nickname={nick}
            onClick={onOpenDM ? () => onOpenDM(msg.senderId, nick) : undefined}
          />
        )}
        {grouped && !msg.mine && <span className="block w-[34px]" />}
      </div>

      <div className={cn('flex min-w-0 max-w-[82%] flex-col sm:max-w-[68%]', msg.mine ? 'items-end' : 'items-start')}>
        {/* 名称与时间（连续消息也显示时间；状态对勾每条消息独立显示） */}
        {!grouped && (
          <div className={cn('mb-1 flex items-center gap-1.5 px-1', msg.mine && 'flex-row-reverse')}>
            <span className="text-xs font-semibold">{nick}</span>
            {timeOf(msg.createdAt)}
          </div>
        )}
        {grouped && (
          <div className={cn('px-1 text-[10px] text-muted-foreground/0 transition-colors group-hover/msg:text-muted-foreground', msg.mine && 'text-right')}>
            {timeOf(msg.createdAt)}
          </div>
        )}

        <div className={cn('flex items-end gap-1.5', msg.mine ? 'flex-row-reverse' : 'flex-row')}>
          {/* 气泡主体 */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <div
                // v1.6.0：双击消息快速点 👍（再双击取消）
                onDoubleClick={(e) => {
                  if (msg.kind !== 'sticker') {
                    e.preventDefault()
                    toggleReaction(msg.id, '👍')
                  }
                }}
                className={cn(
                  'animate-msg-in relative min-w-0 cursor-default select-text rounded-2xl px-3.5 py-2.5 text-[15px] leading-relaxed shadow-sm',
                  isSticker && 'bg-transparent! p-0! shadow-none!',
                  msg.mine
                    ? isSticker ? '' : 'grad-primary text-white rounded-br-md'
                    : isSticker ? '' : 'glass border rounded-bl-md',
                  msg.status === 'failed' && 'opacity-60',
                )}
              >
                {/* 引用回复（v1.6.0：点击跳转到原消息） */}
                {repliedPreview && !isSticker && (
                  <div
                    role={replied ? 'button' : undefined}
                    onClick={(e) => {
                      if (replied) {
                        e.stopPropagation()
                        jumpToMessage(replied.id)
                      }
                    }}
                    className={cn(
                      'mb-1.5 flex items-center gap-2 overflow-hidden rounded-lg bg-black/10 px-2.5 py-1.5 text-xs dark:bg-white/10',
                      replied && 'cursor-pointer hover:bg-black/15 dark:hover:bg-white/15',
                    )}
                  >
                    <Reply className="h-3 w-3 shrink-0 opacity-70" />
                    <span className="shrink-0 font-semibold opacity-90">{replied?.nick || '引用'}</span>
                    <span className="truncate opacity-70">{repliedPreview.slice(0, 40)}</span>
                  </div>
                )}

                {msg.kind === 'text' && <RichText text={msg.text || ''} mine={!!msg.mine} />}
                {isSticker && <span className="block select-none px-1 py-0.5 text-6xl leading-none">{msg.text}</span>}
                {msg.kind === 'file' && msg.file && <FileBubble file={msg.file} mine={!!msg.mine} />}
                {msg.kind === 'voice' && msg.voice && (
                  <div className="min-w-[200px] max-w-[280px]">
                    <VoiceBubble voice={msg.voice} mine={!!msg.mine} />
                  </div>
                )}
                {msg.kind === 'toy' && msg.toy && <ToyBubble toy={msg.toy} mine={!!msg.mine} extras={toyExtras} />}
              </div>
            </DropdownMenuTrigger>
            <DropdownMenuContent align={msg.mine ? 'end' : 'start'} className="rounded-xl">
              {msg.kind === 'text' && msg.text && (
                <DropdownMenuItem onClick={copy} className="gap-2 text-[13px]">
                  {copied ? <Check className="h-3.5 w-3.5 text-violet-500" /> : <Copy className="h-3.5 w-3.5" />}
                  {copied ? '已复制' : '复制'}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => onReply(msg)} className="gap-2 text-[13px]">
                <Reply className="h-3.5 w-3.5" /> 回复
              </DropdownMenuItem>
              {/* v1.6.0 表情回应 */}
              <div className="flex items-center gap-0.5 px-1.5 py-1">
                {QUICK_REACTIONS.map((emoji) => {
                  const active = msg.reactions?.some((g) => g.emoji === emoji && g.readerIds.includes(deviceId))
                  return (
                    <button
                      key={emoji}
                      onClick={(e) => {
                        e.preventDefault()
                        toggleReaction(msg.id, emoji)
                      }}
                      className={cn(
                        'rounded-full px-1 text-lg transition-transform hover:scale-125',
                        active && 'bg-primary/15 ring-1 ring-primary/40',
                      )}
                      aria-label={`回应 ${emoji}`}
                    >
                      {emoji}
                    </button>
                  )
                })}
              </div>
              {msg.kind === 'text' && msg.text && (
                <DropdownMenuItem onClick={tts} className="gap-2 text-[13px]">
                  <Volume2 className="h-3.5 w-3.5" /> 朗读这条消息
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={del} className="gap-2 text-[13px] text-red-500 focus:text-red-500">
                <Trash2 className="h-3.5 w-3.5" /> 删除
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* 悬浮快捷操作（桌面） */}
          {hover && (
            <div className="hidden sm:flex items-center gap-0.5 pb-1">
              <div className="relative">
                <button
                  onClick={() => setReactOpen((v) => !v)}
                  aria-label="表情回应"
                  className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <SmilePlus className="h-3.5 w-3.5" />
                </button>
                {reactOpen && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setReactOpen(false)} />
                    <div className={cn(
                      'absolute bottom-8 z-50 flex items-center gap-0.5 rounded-full glass border px-1.5 py-1 shadow-xl',
                      msg.mine ? 'right-0' : 'left-0',
                    )}>
                      {QUICK_REACTIONS.map((emoji) => (
                        <button
                          key={emoji}
                          onClick={() => { toggleReaction(msg.id, emoji); setReactOpen(false) }}
                          className="rounded-full px-1 text-lg transition-transform hover:scale-125"
                        >
                          {emoji}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
              {msg.kind === 'text' && (
                <button onClick={copy} aria-label="复制文本" className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">
                  {copied ? <Check className="h-3.5 w-3.5 text-violet-500" /> : <Copy className="h-3.5 w-3.5" />}
                </button>
              )}
              <button onClick={() => onReply(msg)} aria-label="引用回复" className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">
                <Reply className="h-3.5 w-3.5" />
              </button>
              <button onClick={del} aria-label="删除消息" className="rounded-lg p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </div>

        {/* v1.6.0 表情回应聚合条：点击同一 emoji 取消自己的回应 */}
        {msg.reactions && msg.reactions.length > 0 && (
          <div className={cn('mt-1 flex flex-wrap gap-1 px-1', msg.mine && 'justify-end')}>
            {msg.reactions.map((g) => {
              const mineReacted = g.readerIds.includes(deviceId)
              return (
                <motion.button
                  initial={{ scale: 0.6, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  key={g.emoji}
                  onClick={() => toggleReaction(msg.id, g.emoji)}
                  title={`${g.readerIds.length} 人回应`}
                  className={cn(
                    'flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11.5px] leading-none transition-colors',
                    mineReacted
                      ? 'border-primary/50 bg-primary/15 font-semibold text-primary'
                      : 'border-border bg-card text-muted-foreground hover:bg-muted',
                  )}
                >
                  <span className="text-[13px]">{g.emoji}</span>
                  <span>{g.readerIds.length}</span>
                </motion.button>
              )
            })}
          </div>
        )}

        {/* 每条消息独立的状态行：发送中转圈 / 单勾=送达 / 双勾=已读 / 红叹号=失败 */}
        {/* v1.5.0：已读状态可交互 —— 悬浮/触屏查看「谁读了」（成员级回执链） */}
        {msg.mine && msg.status && (
          <div
            data-msg-status={msg.status}
            title={
              msg.status === 'sending' ? '发送中…' :
              msg.status === 'failed' ? '发送失败' :
              msg.status === 'read' ? (msg.readers && msg.readers.length > 0
                ? `已读（${msg.readers.length} 人）：${msg.readers.map((r) => '#' + r.readerId.slice(-4)).join('、')}`
                : '已读 · 悬停/点按查看谁读了') : '已送达'
            }
            onClick={() => {
              // 触屏设备：点按已读状态 → 懒加载读者列表并弹出
              if (msg.status === 'read') {
                onShowReaders?.(msg)
                void fetchReaders([msg.id])
              }
            }}
            onMouseEnter={() => { if (msg.status === 'read') void fetchReaders([msg.id]) }}
            className={cn(
              'mt-0.5 flex items-center gap-1 px-1 text-[10px] text-muted-foreground/70',
              msg.mine && 'justify-end',
              msg.status === 'read' && 'cursor-pointer hover:text-muted-foreground',
            )}
          >
            {msg.status === 'read' ? (
              <>
                <CheckCheck className="h-3 w-3 text-emerald-500 dark:text-emerald-400" />
                <span>已读{msg.readers && msg.readers.length > 0 ? ` · ${msg.readers.length}人` : ''}</span>
              </>
            ) : msg.status === 'sent' ? (
              <>
                <CheckCheck className="h-3 w-3 text-muted-foreground/60" />
                <span>已送达</span>
              </>
            ) : msg.status === 'sending' ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin text-muted-foreground/70" />
                <span>发送中</span>
              </>
            ) : (
              <>
                <AlertCircle className="h-3 w-3 text-red-400" />
                <span>发送失败</span>
              </>
            )}
          </div>
        )}

        {/* v1.5.0 阅后即焚倒计时 */}
        {msg.burnAt && (
          <BurnCountdown burnAt={msg.burnAt} mine={!!msg.mine} />
        )}
      </div>
    </div>
  )
}

// v1.7.0：React.memo 化 —— 此前任何一个 store 变化（上传进度/typing/presence）
// 都会让所有气泡重渲染；现在只有 msg 自身或相关 props 变化才重渲染
export const MessageBubble = memo(MessageBubbleInner)

// v1.5.0 阅后即焚倒计时组件
function BurnCountdown({ burnAt, mine }: { burnAt: string; mine: boolean }) {
  const [remain, setRemain] = useState(() => Math.max(0, new Date(burnAt).getTime() - Date.now()))
  useEffect(() => {
    const t = setInterval(() => setRemain(Math.max(0, new Date(burnAt).getTime() - Date.now())), 1000)
    return () => clearInterval(t)
  }, [burnAt])
  const mm = Math.floor(remain / 60000)
  const ss = Math.floor((remain % 60000) / 1000)
  return (
    <div className={cn('mt-0.5 flex items-center gap-1 px-1 text-[10px] text-orange-500/80', mine && 'justify-end')}>
      <Flame className={cn('h-3 w-3', remain < 60000 && 'animate-pulse')} />
      <span>{mm > 0 ? `${mm}:${String(ss).padStart(2, '0')}` : `${ss}s`} 后焚毁</span>
    </div>
  )
}
