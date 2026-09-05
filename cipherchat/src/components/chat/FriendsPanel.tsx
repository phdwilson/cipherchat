'use client'
// 好友列表面板（基于本地 localStorage 的联系人：pubId + 昵称 + 添加时间）
// 零服务器感知：好友列表不上传服务器；好友码 = 当前频道 + pubId 用于在频道内打开私聊
import { useMemo, useState } from 'react'
import { X, Trash2, UserPlus, Copy, Check, MessageCircle, UserRound, Share2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useChatStore } from '@/store/chat'
import { Avatar } from './MessageBubble'
import { timeAgo } from '@/lib/greetings'
import { toast } from 'sonner'

const FRIENDS_KEY = 'cipherchat:friends'

export interface Friend { pubId: string; nick: string; addedAt: string; channel?: string }

export function getFriends(): Friend[] {
  try { return JSON.parse(localStorage.getItem(FRIENDS_KEY) || '[]') } catch { return [] }
}
export function saveFriends(list: Friend[]) {
  try {
    localStorage.setItem(FRIENDS_KEY, JSON.stringify(list))
  } catch {
    // v1.7.0：存储配额溢出不再抛异常（此前保存好友会因 QuotaExceededError 崩溃）
  }
}
export function addFriend(f: Friend) {
  const list = getFriends().filter((x) => x.pubId !== f.pubId)
  list.push(f)
  saveFriends(list)
}

export function FriendsPanel({ onClose, onOpenDM }: {
  onClose: () => void
  onOpenDM: (pubId: string, nick: string) => void
}) {
  const channelId = useChatStore((s) => s.channelId)
  const deviceId = useChatStore((s) => s.deviceId)
  const presence = useChatStore((s) => s.presence)
  const [friends, setFriends] = useState<Friend[]>(() => getFriends())
  const [importCode, setImportCode] = useState('')
  const [copied, setCopied] = useState(false)

  const myCode = useMemo(() => `${channelId}::${deviceId}`, [channelId, deviceId])

  const removeFriend = (pubId: string) => {
    const list = getFriends().filter((f) => f.pubId !== pubId)
    saveFriends(list)
    setFriends(list)
    toast.success('已移除好友')
  }

  const copyMyCode = async () => {
    try {
      await navigator.clipboard.writeText(myCode)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      toast.error('复制失败')
    }
  }

  const importFriend = () => {
    const code = importCode.trim()
    if (!code) return
    const parts = code.split('::')
    if (parts.length !== 2 || parts[0].length < 2 || parts[1].length < 8) {
      toast.error('好友码格式应为：频道ID::设备ID')
      return
    }
    const [ch, pid] = parts
    addFriend({ pubId: pid, nick: `导入好友 ${pid.slice(-4)}`, addedAt: new Date().toISOString(), channel: ch })
    setFriends(getFriends())
    setImportCode('')
    toast.success(`已添加好友 ${pid.slice(-4)}`)
  }

  // 标记好友是否在当前频道在线
  const onlinePubIds = useMemo(() => new Set(presence.filter((p) => p.online !== false).map((p) => p.deviceId)), [presence])

  return (
    <div className="absolute right-0 top-0 z-30 flex h-full w-full max-w-[420px] flex-col border-l border-black/5 dark:border-white/10 glass">
      {/* 头部 */}
      <div className="flex items-center gap-2 border-b border-black/5 dark:border-white/10 px-4 py-3">
        <UserRound className="h-4 w-4 text-primary" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">好友列表</p>
          <p className="text-[10px] text-muted-foreground">{friends.length} 位好友 · 仅本地保存</p>
        </div>
        <Button variant="ghost" size="icon" className="h-8 w-8 rounded-lg shrink-0" onClick={onClose} aria-label="关闭">
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* 我的好友码 */}
      <div className="border-b border-black/5 dark:border-white/10 px-4 py-3">
        <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">我的好友码（请勿公开发布）</p>
        <div className="flex items-center gap-1.5">
          <code className="flex-1 truncate rounded-lg bg-muted px-2.5 py-2 text-[11px] font-mono">{myCode}</code>
          <Button size="icon" variant="outline" className="h-9 w-9 shrink-0 rounded-lg" onClick={copyMyCode} aria-label="复制好友码">
            {copied ? <Check className="h-4 w-4 text-emerald-500" /> : <Copy className="h-4 w-4" />}
          </Button>
        </div>
        <p className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground/80">
          好友可通过此码添加你；对方需在<b>同一频道</b>内才能与你私聊。
        </p>
      </div>

      {/* 导入好友码 */}
      <div className="border-b border-black/5 dark:border-white/10 px-4 py-3">
        <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">导入好友码</p>
        <div className="flex items-center gap-1.5">
          <Input
            value={importCode}
            onChange={(e) => setImportCode(e.target.value)}
            placeholder="频道ID::设备ID"
            className="h-9 rounded-lg text-xs font-mono flex-1"
          />
          <Button size="sm" variant="outline" className="h-9 shrink-0 rounded-lg gap-1" onClick={importFriend} disabled={!importCode.trim()}>
            <UserPlus className="h-3.5 w-3.5" /> 添加
          </Button>
        </div>
      </div>

      {/* 好友列表 */}
      <div className="flex-1 overflow-y-auto scroll-slim px-3 py-3 space-y-1.5">
        {friends.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center px-4">
            <Share2 className="h-10 w-10 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">还没有好友</p>
            <p className="text-[11px] leading-relaxed text-muted-foreground/70">
              在频道内点击他人头像打开私聊，然后点击「+」添加为好友；或让对方把好友码发给你导入。
            </p>
          </div>
        )}
        {[...friends].reverse().map((f) => {
          const online = onlinePubIds.has(f.pubId)
          const inThisChannel = f.channel === channelId || !f.channel
          return (
            <div key={f.pubId} className="flex items-center gap-2.5 rounded-xl border bg-card/60 p-2.5">
              <div className="relative shrink-0">
                <Avatar deviceId={f.pubId} nickname={f.nick} size={36} />
                <span
                  className={`absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-card ${online ? 'bg-emerald-500' : 'bg-zinc-400'}`}
                  aria-label={online ? '在线' : '离线'}
                />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{f.nick}</p>
                <p className="text-[10px] text-muted-foreground">
                  #{f.pubId.slice(-4)} · {online ? (inThisChannel ? '本频道在线' : '其他频道在线') : `添加于 ${timeAgo(f.addedAt)}`}
                </p>
              </div>
              {online && inThisChannel && (
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8 shrink-0 rounded-lg text-primary hover:bg-primary/10"
                  onClick={() => onOpenDM(f.pubId, f.nick)}
                  aria-label="发起私聊"
                  title="发起私聊"
                >
                  <MessageCircle className="h-4 w-4" />
                </Button>
              )}
              <Button
                size="icon"
                variant="ghost"
                className="h-8 w-8 shrink-0 rounded-lg text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                onClick={() => removeFriend(f.pubId)}
                aria-label="移除好友"
                title="移除好友"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          )
        })}
      </div>

      <p className="px-4 py-3 text-[10px] leading-relaxed text-muted-foreground border-t border-black/5 dark:border-white/10 pb-safe">
        好友列表仅保存在本设备浏览器中，不上传服务器；私聊仍需双方进入同一频道。
      </p>
    </div>
  )
}
