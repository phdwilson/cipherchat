'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Monitor, Smartphone, Tablet, Bot, HelpCircle, Pencil, Check, X, Wifi, WifiOff, Users, Camera, Trash2 } from 'lucide-react'
import { useChatStore, type PresenceDevice, type DeviceInfo, getLocalAvatar, useFeatureFlags } from '@/store/chat'
import { timeAgo } from '@/lib/greetings'
import { openJSON } from '@/lib/crypto'
import { listAvatars, getOrInitDefaultAvatar, getDefaultAvatar, setDefaultAvatar } from '@/lib/avatar-library'
import { Avatar, hueOf } from './MessageBubble'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

function normalizeIp(ip: string): string {
  if (ip.startsWith('::ffff:')) return ip.slice(7)
  if (ip === '::1') return '127.0.0.1'
  return ip || '未知'
}

// 网络类型徽标：🏠 局域网 / 🌐 公网
function NetworkBadge({ type }: { type?: string }) {
  if (type === 'lan') {
    return (
      <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-600 dark:text-amber-400">
        🏠 局域网
      </span>
    )
  }
  if (type === 'wan') {
    return (
      <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-sky-600 dark:text-sky-400">
        🌐 公网
      </span>
    )
  }
  return null
}

function DeviceRow({
  d,
  isMe,
  deviceInfo,
  onNickname,
}: {
  d: PresenceDevice & { nickDec?: string; moodDec?: string }
  isMe: boolean
  deviceInfo: DeviceInfo | null
  onNickname?: (n: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  const online = d.online !== false
  const icon = d.ua?.deviceType === 'phone' ? <Smartphone className="h-3.5 w-3.5" /> : d.ua?.deviceType === 'tablet' ? <Tablet className="h-3.5 w-3.5" /> : d.ua?.deviceType === 'bot' ? <Bot className="h-3.5 w-3.5" /> : d.ua?.deviceType === 'desktop' ? <Monitor className="h-3.5 w-3.5" /> : <HelpCircle className="h-3.5 w-3.5" />
  const hue = hueOf(d.deviceId)

  const save = () => {
    const n = draft.trim()
    if (n && onNickname) onNickname(n.slice(0, 24))
    setEditing(false)
  }

  return (
    <div className={cn('rounded-2xl border p-3.5 transition-colors', online ? 'bg-card' : 'bg-muted/40 opacity-75')}>
      <div className="flex items-center gap-3">
        <div className="relative shrink-0">
          <Avatar deviceId={d.deviceId} nickname={d.nickDec || d.deviceId.slice(-1).toUpperCase()} size={40} />
          <span
            className={cn(
              'absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full border-2 border-card',
              online ? 'animate-live bg-emerald-500' : 'bg-zinc-400'
            )}
            aria-label={online ? '在线' : '离线'}
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {editing ? (
              <span className="flex min-w-0 flex-1 items-center gap-1">
                <input
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') save()
                    if (e.key === 'Escape') setEditing(false)
                  }}
                  maxLength={24}
                  className="min-w-0 flex-1 rounded-lg border bg-background px-2 py-1 text-sm outline-none focus:border-primary"
                  aria-label="新昵称"
                />
                <button onClick={save} className="rounded-lg p-1 text-violet-500 hover:bg-muted" aria-label="保存昵称">
                  <Check className="h-4 w-4" />
                </button>
                <button onClick={() => setEditing(false)} className="rounded-lg p-1 text-muted-foreground hover:bg-muted" aria-label="取消">
                  <X className="h-4 w-4" />
                </button>
              </span>
            ) : (
              <>
                <span className="truncate text-sm font-semibold">{d.nickDec || '未知成员'}</span>
                {/* v1.7.0 心情状态：随 presence 加密广播，仅本频道成员可读 */}
                {d.moodDec && <span className="shrink-0 rounded-full bg-muted px-1.5 py-0 text-[10px] text-muted-foreground">{d.moodDec}</span>}
                {isMe && (
                  <>
                    <span className="shrink-0 rounded-full border border-primary/40 bg-primary/10 px-1.5 py-0 text-[9px] font-bold text-primary">我</span>
                    <button
                      onClick={() => {
                        setDraft('')
                        setEditing(true)
                      }}
                      className="shrink-0 rounded-lg p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                      aria-label="修改昵称"
                    >
                      <Pencil className="h-3 w-3" />
                    </button>
                  </>
                )}
              </>
            )}
          </div>
          <p className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground">
            {online ? (
              <span className="inline-flex items-center gap-0.5 text-emerald-600 dark:text-emerald-400">
                <Wifi className="h-3 w-3" /> 在线
              </span>
            ) : (
              <span>{d.lastSeen ? `最后活跃 ${timeAgo(d.lastSeen)}` : '离线'}</span>
            )}
            <span>· 设备 #{d.deviceId.slice(-4).toUpperCase()}</span>
          </p>
        </div>
        <NetworkBadge type={d.networkType} />
      </div>

      <div className="mt-3 grid gap-1.5 text-xs">
        {/* 加密的设备详情（型号/系统/屏幕/触摸） */}
        <div className="flex items-center gap-2 rounded-lg bg-muted/60 px-2.5 py-1.5">
          <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md" style={{ background: `hsl(${hue} 65% 58% / 0.15)`, color: `hsl(${hue} 65% 45%)` }}>
            {icon}
          </span>
          <span className="truncate">
            {deviceInfo
              ? `${deviceInfo.model} · ${deviceInfo.os} · ${deviceInfo.browser} · ${deviceInfo.screen}${deviceInfo.touch ? ' · 触屏' : ''}`
              : '设备环境信息已加密'}
          </span>
        </div>
        {/* IP 与归属地（v1.4.3：按成员的披露级别裁剪 —— hidden 不显示 IP 与地区） */}
        <div className="flex items-center gap-2 rounded-lg bg-muted/60 px-2.5 py-1.5">
          <span className="text-xs shrink-0 opacity-80">{d.geoDisclosure === 'hidden' ? '🛡️' : '📍'}</span>
          <span className="truncate">
            {d.geoDisclosure === 'hidden' ? (
              <span className="text-muted-foreground">该成员选择了隐私模式（不披露 IP / 地区）</span>
            ) : (
              <>
                {d.ip ? <span className="font-mono">{normalizeIp(d.ip)}</span> : <span className="font-mono text-muted-foreground">仅地区</span>}
                <span className="mx-1.5 text-muted-foreground/50">|</span>
                <span className="inline-flex items-center gap-1">
                  {d.flagEmoji ? <span>{d.flagEmoji}</span> : null}
                  {d.region || '定位中…'}
                </span>
              </>
            )}
          </span>
        </div>
      </div>
    </div>
  )
}

// 我的资料卡：默认随机头像库（30 个手绘 SVG，零网络），上传作为可选开关项
function MyProfileCard() {
  const deviceId = useChatStore((s) => s.deviceId)
  const nickname = useChatStore((s) => s.nickname)
  const setAvatar = useChatStore((s) => s.setAvatar)
  const flags = useFeatureFlags()
  const [customB64, setCustomB64] = useState<string | null>(null)
  const [defaultAvatar, setDefaultAvatarState] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setCustomB64(getLocalAvatar())
    if (deviceId) setDefaultAvatarState(getOrInitDefaultAvatar(deviceId))
  }, [deviceId])

  const onPick = () => fileRef.current?.click()

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    if (!f.type.startsWith('image/')) { toast.error('请选择图片文件'); return }
    if (f.size > 5 * 1024 * 1024) { toast.error('图片过大（>5MB）'); return }
    setBusy(true)
    try {
      const b64 = await resizeToDataUrl(f, 256, 0.85)
      setCustomB64(b64)
      await setAvatar(b64)
      toast.success('自定义头像已更新')
    } catch (err) {
      toast.error('图片处理失败')
    } finally {
      setBusy(false)
    }
  }

  const onRemove = async () => {
    setBusy(true)
    try {
      setCustomB64(null)
      await setAvatar(null)
      toast.success('已恢复默认头像')
    } finally { setBusy(false) }
  }

  const pickFromLibrary = (dataUrl: string) => {
    setDefaultAvatar(dataUrl)
    setDefaultAvatarState(dataUrl)
    setPickerOpen(false)
    // 默认头像改变后，需要广播给其他成员：用频道密钥加密后通过 chat:nick 广播
    // 这里通过 setAvatar(null) 来清除自定义头像，触发默认头像展示
    // 但默认头像保存在 localStorage，需要随频道一起广播
    void broadcastDefaultAvatar(dataUrl)
    toast.success('已选用默认头像')
  }

  // 把默认头像作为"自定义"头像广播给同频道（其他成员没有本地这个 default）
  const broadcastDefaultAvatar = async (dataUrl: string) => {
    await setAvatar(dataUrl)
  }

  const currentAvatar = customB64 || defaultAvatar
  const hue = hueOf(deviceId)

  return (
    <div className="rounded-2xl border bg-primary/5 p-3.5 space-y-3">
      <div className="flex items-center gap-3">
        <div className="relative shrink-0">
          {currentAvatar ? (
            <span className="block h-10 w-10 overflow-hidden rounded-xl">
              <img src={currentAvatar} alt="我的头像" className="h-full w-full object-cover" />
            </span>
          ) : (
            <span
              className="grid h-10 w-10 place-items-center rounded-xl text-sm font-bold text-white shadow-sm"
              style={{ background: `linear-gradient(135deg, hsl(${hue} 65% 58%), hsl(${(hue + 45) % 360} 70% 48%))` }}
            >
              {nickname.slice(0, 1) || '?'}
            </span>
          )}
          <button
            onClick={() => setPickerOpen((v) => !v)}
            disabled={busy}
            className="absolute -bottom-1 -right-1 grid h-5 w-5 place-items-center rounded-full border-2 border-card bg-primary text-white shadow-sm disabled:opacity-50"
            aria-label="选择头像"
            title="选择头像"
          >
            <Camera className="h-3 w-3" />
          </button>
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onFile} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{nickname || '我'}</p>
          <p className="text-[11px] text-muted-foreground">{customB64 ? '自定义头像（已加密广播）' : '默认头像库'}</p>
        </div>
        {customB64 && (
          <Button size="icon" variant="ghost" className="h-8 w-8 shrink-0 rounded-lg text-muted-foreground hover:bg-destructive/10 hover:text-destructive" onClick={onRemove} disabled={busy} aria-label="移除自定义头像" title="恢复默认头像">
            <Trash2 className="h-4 w-4" />
          </Button>
        )}
      </div>

      {/* 头像库选择网格（默认展开/折叠切换） */}
      {pickerOpen && (
        <div className="rounded-xl border bg-card/60 p-2 space-y-2">
          <p className="px-1 text-[11px] text-muted-foreground">默认头像库（30 个手绘头像，按设备稳定分配；可手动挑选）</p>
          <div className="grid grid-cols-6 gap-1.5">
            {listAvatars().map((a, i) => (
              <button
                key={i}
                onClick={() => pickFromLibrary(a)}
                className={cn(
                  'overflow-hidden rounded-lg ring-2 transition',
                  defaultAvatar === a ? 'ring-primary' : 'ring-transparent hover:ring-primary/30',
                )}
                title={`头像 ${i + 1}`}
              >
                <img src={a} alt="" className="h-9 w-9 object-cover" draggable={false} />
              </button>
            ))}
          </div>
          {flags.avatarUploadEnabled && (
            <Button
              variant="outline"
              size="sm"
              className="w-full h-8 rounded-lg gap-1.5 text-[12px]"
              onClick={onPick}
              disabled={busy}
            >
              <Camera className="h-3.5 w-3.5" />
              上传自定义头像（≤5MB，自动裁剪 256×256）
            </Button>
          )}
          {!flags.avatarUploadEnabled && (
            <p className="px-1 text-[10.5px] text-muted-foreground/80">管理员已关闭自定义头像上传，仅可使用默认头像库</p>
          )}
        </div>
      )}
    </div>
  )
}

// 图片缩放为 256x256 数据 URL（保持纵横比裁剪居中，限制体积 ~10-30KB）
async function resizeToDataUrl(file: File, size: number, quality: number): Promise<string> {
  const bitmap = await createImageBitmap(file)
  const minSide = Math.min(bitmap.width, bitmap.height)
  const sx = (bitmap.width - minSide) / 2
  const sy = (bitmap.height - minSide) / 2
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas 2d 不可用')
  ctx.drawImage(bitmap, sx, sy, minSide, minSide, 0, 0, size, size)
  bitmap.close()
  return canvas.toDataURL('image/jpeg', quality)
}

export function usePresenceDetails() {
  const presence = useChatStore((s) => s.presence)
  const channelKey = useChatStore((s) => s.channelKey)
  const [nicks, setNicks] = useState<Record<string, string>>({})
  const [infos, setInfos] = useState<Record<string, DeviceInfo>>({})
  const [moods, setMoods] = useState<Record<string, string>>({})

  useEffect(() => {
    let alive = true
    const run = async () => {
      if (!channelKey) return
      // v1.7.0：并行解密 + 按密文缓存 —— 此前 for 循环串行 await，每个 presence
      // 事件都重解全部成员的昵称/设备详情（N 次 WebCrypto 往返）
      const [nextNicks, nextInfos, nextMoods] = await Promise.all([
        Promise.all(
          presence.map(async (p) => {
            if (!p.nickEnc) return null
            const v = await openJSON<{ nick: string }>(channelKey, p.nickEnc)
            return v?.nick ? ([p.deviceId, v.nick] as const) : null
          })
        ),
        Promise.all(
          presence.map(async (p) => {
            if (!p.deviceInfoEnc) return null
            const v = await openJSON<DeviceInfo>(channelKey, p.deviceInfoEnc)
            return v?.model ? ([p.deviceId, v] as const) : null
          })
        ),
        Promise.all(
          presence.map(async (p) => {
            if (!p.moodEnc) return null
            const v = await openJSON<{ mood: string }>(channelKey, p.moodEnc)
            return v?.mood ? ([p.deviceId, v.mood] as const) : null
          })
        ),
      ])
      if (alive) {
        setNicks(Object.fromEntries(nextNicks.filter(Boolean) as Array<readonly [string, string]>))
        setInfos(Object.fromEntries(nextInfos.filter(Boolean) as Array<readonly [string, DeviceInfo]>))
        setMoods(Object.fromEntries(nextMoods.filter(Boolean) as Array<readonly [string, string]>))
      }
    }
    run()
    return () => {
      alive = false
    }
  }, [presence, channelKey])

  return { nicks, infos, moods }
}

export function MembersSheet({ compact = false }: { compact?: boolean }) {
  const presence = useChatStore((s) => s.presence)
  const deviceId = useChatStore((s) => s.deviceId)
  const channelId = useChatStore((s) => s.channelId)
  const setNickname = useChatStore((s) => s.setNickname)
  const { nicks, infos, moods } = usePresenceDetails()

  const onlineCount = presence.filter((d) => d.online !== false).length

  const sorted = useMemo(
    () =>
      [...presence]
        .map((d) => ({ ...d, nickDec: nicks[d.deviceId] || '', moodDec: moods[d.deviceId] || '' }))
        .sort((a, b) => {
          // 在线优先 → 自己最前 → 加入时间
          const ao = a.online !== false ? 0 : 1
          const bo = b.online !== false ? 0 : 1
          if (ao !== bo) return ao - bo
          if (a.deviceId === deviceId) return -1
          if (b.deviceId === deviceId) return 1
          return a.joinedAt - b.joinedAt
        }),
    [presence, deviceId, nicks, moods]
  )

  return (
    <Sheet>
      <SheetTrigger asChild>
        {compact ? (
          <Button variant="ghost" size="icon" className="relative h-9 w-9 shrink-0 rounded-xl" aria-label="查看在线设备">
            <Users className="h-[18px] w-[18px]" />
            {onlineCount > 0 && (
              <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-primary px-1 text-[9px] font-bold text-primary-foreground">
                {onlineCount}
              </span>
            )}
          </Button>
        ) : (
          <Button variant="ghost" size="sm" className="rounded-full gap-1.5 h-9 px-3 text-[13px] text-muted-foreground hover:text-foreground">
            <Wifi className="h-3.5 w-3.5 text-primary" />
            <span className="inline-flex h-4.5 min-w-4 items-center justify-center rounded-full bg-primary/15 text-primary px-1.5 text-[11px] font-semibold">
              {onlineCount}
            </span>
            <span className="hidden sm:inline">台设备在线</span>
          </Button>
        )}
      </SheetTrigger>
      <SheetContent side="right" className="w-full sm:max-w-md p-0 flex flex-col">
        <SheetHeader className="px-5 pt-5 pb-3 border-b border-black/5 dark:border-white/10">
          <SheetTitle className="flex items-center gap-2 text-left text-base">
            <Users className="h-4 w-4 text-primary" /> 频道内设备
          </SheetTitle>
          <SheetDescription className="text-left text-xs">
            频道「{channelId}」· {onlineCount} 台在线 / {presence.length} 台近期活跃
          </SheetDescription>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto scroll-slim px-4 py-4 space-y-2.5">
          {deviceId && <MyProfileCard />}
          {sorted.map((d) => (
            <DeviceRow
              key={d.deviceId + d.joinedAt}
              d={d}
              isMe={d.deviceId === deviceId}
              deviceInfo={infos[d.deviceId] || null}
              onNickname={async (n) => {
                await setNickname(n)
                toast.success(`昵称已更新为「${n}」`)
              }}
            />
          ))}
          {sorted.length === 0 && (
            <p className="text-center text-sm text-muted-foreground py-10">暂无设备（连接中…）</p>
          )}
        </div>
        <p className="px-5 py-3 text-[11px] leading-relaxed text-muted-foreground border-t border-black/5 dark:border-white/10 pb-safe">
          设备详情（型号 / 屏幕 / 触摸 / 昵称 / 头像）由频道密钥加密，服务器无法读取；IP、归属地与网络类型由服务器从连接层识别，不可被客户端伪造。
        </p>
      </SheetContent>
    </Sheet>
  )
}
