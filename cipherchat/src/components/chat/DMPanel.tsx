'use client'
// 私聊面板（频道内 whisper：消息用频道密钥加密，服务器只定向投递不存储）
import { useEffect, useRef, useState } from 'react'
import { X, Send, UserRound, Plus, Check, Phone } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useChatStore, getChatSocket, useFeatureFlags } from '@/store/chat'
import { sealJSON, openJSON } from '@/lib/crypto'
import { addFriend } from './FriendsPanel'
import { Avatar } from './MessageBubble'
import { startDMCall } from '../voice/DMCallModal'

interface WhisperMsg {
  id: string
  fromPubId: string
  toPubId: string
  text: string
  createdAt: string
  mine: boolean
}

const FRIENDS_KEY = 'cipherchat:friends'

interface Friend { pubId: string; nick: string; addedAt: string }

function getFriends(): Friend[] {
  try { return JSON.parse(localStorage.getItem(FRIENDS_KEY) || '[]') } catch { return [] }
}

export function DMPanel({ targetPubId, targetNick, onClose }: {
  targetPubId: string
  targetNick: string
  onClose: () => void
}) {
  const { channelKey, deviceId } = useChatStore()
  const flags = useFeatureFlags()
  const [messages, setMessages] = useState<WhisperMsg[]>([])
  const [text, setText] = useState('')
  const [isFriend, setIsFriend] = useState(() => getFriends().some((f) => f.pubId === targetPubId))
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const send = async () => {
    const t = text.trim()
    if (!t || !channelKey) return
    setText('')
    const clientId = crypto.randomUUID()
    const payload = await sealJSON(channelKey, { v: 1, kind: 'whisper', text: t, from: deviceId })
    // 乐观插入
    setMessages((prev) => [...prev, {
      id: clientId, fromPubId: deviceId, toPubId: targetPubId,
      text: t, createdAt: new Date().toISOString(), mine: true,
    }])
    const sock = getChatSocket()
    sock?.emit('chat:whisper', { payload, toPubId: targetPubId, clientId }, (r: { ok?: boolean }) => {
      if (!r?.ok) setMessages((prev) => prev.map((m) => m.id === clientId ? { ...m, text: '⚠️ ' + m.text } : m))
    })
  }

  // 接收 whisper 消息
  useEffect(() => {
    if (!channelKey) return
    const sock = getChatSocket()
    if (!sock) return
    const handler = async (d: { fromPubId: string; toPubId: string; payload: string; clientId?: string | null }) => {
      if (d.toPubId !== deviceId) return // 不是给我的 whisper
      if (d.fromPubId !== targetPubId) return // 不是当前 DM 对话方的
      const env = await openJSON<{ text: string }>(channelKey, d.payload)
      if (!env?.text) return
      setMessages((prev) => {
        if (prev.some((m) => m.id === d.clientId)) return prev
        return [...prev, {
          id: d.clientId || crypto.randomUUID(),
          fromPubId: d.fromPubId, toPubId: deviceId,
          text: env.text, createdAt: new Date().toISOString(), mine: false,
        }]
      })
    }
    sock.on('chat:whisper', handler)
    return () => { sock.off('chat:whisper', handler) }
  }, [channelKey, deviceId, targetPubId])

  const addAsFriend = () => {
    addFriend({ pubId: targetPubId, nick: targetNick, addedAt: new Date().toISOString() })
    setIsFriend(true)
  }

  return (
    <div className="absolute right-0 top-0 z-30 flex h-full w-full max-w-[400px] flex-col border-l border-black/5 dark:border-white/10 glass">
      {/* 头部 */}
      <div className="flex items-center gap-2 border-b border-black/5 dark:border-white/10 px-4 py-3">
        <Avatar deviceId={targetPubId} nickname={targetNick} size={32} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{targetNick}</p>
          <p className="text-[10px] text-muted-foreground">#{targetPubId.slice(-4)} · 私聊（不留存）</p>
        </div>
        {!isFriend && (
          <Button variant="ghost" size="icon" className="h-8 w-8 rounded-lg shrink-0" onClick={addAsFriend} title="添加好友">
            <Plus className="h-4 w-4" />
          </Button>
        )}
        {isFriend && (
          <Check className="h-4 w-4 shrink-0 text-emerald-500" aria-label="已是好友" />
        )}
        {/* 语音通话按钮（语音开关开启时） */}
        {flags.voiceEnabled && (
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 rounded-lg shrink-0 text-emerald-500 hover:bg-emerald-500/10"
            onClick={() => startDMCall(targetPubId, targetNick)}
            aria-label="语音通话"
            title="发起语音通话"
          >
            <Phone className="h-4 w-4" />
          </Button>
        )}
        <Button variant="ghost" size="icon" className="h-8 w-8 rounded-lg shrink-0" onClick={onClose} aria-label="关闭私聊">
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* 消息区 */}
      <div className="flex-1 overflow-y-auto scroll-slim px-3 py-3 space-y-2">
        {messages.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <UserRound className="h-10 w-10 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">与 {targetNick} 的私聊已建立</p>
            <p className="text-[11px] text-muted-foreground/70">消息用频道密钥加密，服务器只定向投递不存储</p>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`flex ${m.mine ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm ${m.mine ? 'grad-primary text-white rounded-br-md' : 'bg-muted rounded-bl-md'}`}>
              <p className="whitespace-pre-wrap break-words">{m.text}</p>
              <p className={`mt-0.5 text-[9px] ${m.mine ? 'text-white/50' : 'text-muted-foreground/50'}`}>{new Date(m.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</p>
            </div>
          </div>
        ))}
      </div>

      {/* 输入 */}
      <div className="border-t border-black/5 dark:border-white/10 p-3 flex items-center gap-2">
        <Input
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() } }}
          placeholder="输入私聊消息…"
          className="h-10 rounded-xl text-sm flex-1"
        />
        <Button size="icon" className="h-10 w-10 rounded-xl grad-primary shrink-0" onClick={() => void send()} disabled={!text.trim()} aria-label="发送">
          <Send className="h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}
