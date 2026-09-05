'use client'
// 语音大厅简易文字聊天侧栏（开黑时没麦/不想说话的队友用）
// 消息经大厅密钥 sealJSON 端到端加密，服务器只转发不存储
import { useEffect, useRef, useState } from 'react'
import { Send, MessageSquare, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { sealJSON, openJSON } from '@/lib/crypto'
import type { Socket } from 'socket.io-client'

export interface LobbyTextMsg {
  id: string
  fromPubId: string
  nick: string
  text: string
  at: number
}

export function LobbyChatSidebar({
  socket,
  aesKey,
  lobbyId,
  mode,
  myPubId,
  myNick,
  onUnreadChange,
}: {
  socket: Socket | null
  aesKey: CryptoKey
  lobbyId: string
  mode: string
  myPubId: string
  myNick: string
  onUnreadChange?: (n: number) => void
}) {
  const [open, setOpen] = useState(false)
  const [msgs, setMsgs] = useState<LobbyTextMsg[]>([])
  const [draft, setDraft] = useState('')
  const [unread, setUnread] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const openRef = useRef(false)

  useEffect(() => { openRef.current = open }, [open])
  useEffect(() => {
    if (open) { setUnread(0); onUnreadChange?.(0) }
  }, [open])  

  // 接收加密消息并解密
  useEffect(() => {
    if (!socket) return
    const handler = async (d: { lobbyId: string; mode: string; fromPubId: string; payload: string }) => {
      if (d.lobbyId !== lobbyId || d.mode !== mode) return
      const env = await openJSON<{ nick?: string; text?: string }>(aesKey, d.payload)
      if (!env?.text) return
      const msg: LobbyTextMsg = {
        id: crypto.randomUUID(),
        fromPubId: d.fromPubId,
        nick: env.nick || `#${d.fromPubId.slice(-4)}`,
        text: env.text.slice(0, 500),
        at: Date.now(),
      }
      setMsgs((prev) => [...prev.slice(-200), msg])
      if (!openRef.current) {
        setUnread((u) => {
          const n = u + 1
          onUnreadChange?.(n)
          return n
        })
      }
    }
    socket.on('voice:lobby:text', handler)
    return () => { socket.off('voice:lobby:text', handler) }
  }, [socket, aesKey, lobbyId, mode])  

  // 自动滚到底部
  useEffect(() => {
    if (open) requestAnimationFrame(() => listRef.current?.scrollTo({ top: listRef.current.scrollHeight }))
  }, [msgs, open])

  const send = () => {
    const text = draft.trim()
    if (!text || !socket) return
    setDraft('')
    void (async () => {
      try {
        const payload = await sealJSON(aesKey, { nick: myNick, text })
        const r = await socket.emitWithAck('voice:lobby:text', { lobbyId, mode, payload }) as { ok?: boolean; error?: string }
        if (!r?.ok) throw new Error(r?.error || '发送失败')
      } catch (e) {
        setMsgs((prev) => [...prev.slice(-200), {
          id: crypto.randomUUID(), fromPubId: myPubId, nick: myNick,
          text: '⚠️ ' + (e instanceof Error ? e.message : '发送失败'), at: Date.now(),
        }])
      }
    })()
  }

  return (
    <>
      {/* 侧栏开关按钮（未打开时显示） */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          className="relative inline-flex h-11 items-center gap-1.5 rounded-2xl bg-muted px-4 text-sm font-medium hover:bg-primary/10"
          aria-label="打开文字聊天侧栏"
          title="文字聊天（给没麦的队友）"
        >
          <MessageSquare className="h-5 w-5" />
          <span className="hidden sm:inline">文字</span>
          {unread > 0 && (
            <span className="absolute -right-1 -top-1 grid h-5 min-w-5 place-items-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </button>
      )}

      {/* 文字聊天侧栏 */}
      {open && (
        <div className="fixed right-0 top-0 z-40 flex h-[100dvh] w-[min(340px,88vw)] flex-col border-l bg-card shadow-2xl">
          <div className="flex items-center justify-between border-b px-3 py-2.5">
            <span className="flex items-center gap-2 text-sm font-semibold">
              <MessageSquare className="h-4 w-4 text-primary" /> 大厅文字聊天
            </span>
            <Button variant="ghost" size="icon" className="h-8 w-8 rounded-lg" onClick={() => setOpen(false)} aria-label="关闭侧栏">
              <X className="h-4 w-4" />
            </Button>
          </div>
          <div ref={listRef} className="scroll-slim flex-1 space-y-2 overflow-y-auto p-3">
            {msgs.length === 0 && (
              <p className="pt-8 text-center text-xs text-muted-foreground">还没有消息，说点什么吧<br />消息端到端加密，不留存</p>
            )}
            {msgs.map((m) => {
              const mine = m.fromPubId === myPubId
              return (
                <div key={m.id} className={cn('flex flex-col', mine ? 'items-end' : 'items-start')}>
                  <div className={cn(
                    'max-w-[85%] rounded-xl px-3 py-1.5 text-[13px] leading-snug',
                    mine ? 'grad-primary text-white rounded-br-sm' : 'bg-muted rounded-bl-sm',
                  )}>
                    {!mine && <span className="mb-0.5 block text-[10px] font-semibold opacity-70">{m.nick}</span>}
                    <span className="whitespace-pre-wrap break-words">{m.text}</span>
                  </div>
                  <span className="px-1 pt-0.5 text-[9.5px] text-muted-foreground/60">
                    {new Date(m.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
              )
            })}
          </div>
          <div className="border-t p-2.5 pb-safe">
            <form
              onSubmit={(e) => { e.preventDefault(); send() }}
              className="flex gap-2"
            >
              <Input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="输入消息…"
                maxLength={500}
                className="h-9 flex-1 rounded-xl text-[13px]"
              />
              <Button type="submit" size="icon" className="h-9 w-9 shrink-0 rounded-xl" disabled={!draft.trim()} aria-label="发送">
                <Send className="h-4 w-4" />
              </Button>
            </form>
          </div>
        </div>
      )}
    </>
  )
}
