'use client'

import { useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { toast } from 'sonner'
import { Hash, KeyRound, Eye, EyeOff, Loader2, ShieldCheck, ArrowRight, Wand2, MessagesSquare, Dice5, ShieldAlert, Radio, Zap, ScanLine } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useChatStore, type RuntimeConfig } from '@/store/chat'
import { passwordStrength, randomNick } from '@/lib/crypto'
import { generateChannelId, randomExamples, isSecureContextOk } from '@/lib/channel-id'
import { cn } from '@/lib/utils'
import { explainError } from '@/lib/errors'
import { QrScanDialog } from './QrScanDialog'

// ———— 随机频道 ID 生成逻辑已抽离至 @/lib/channel-id ————

function lastChatInfo(): { channelId: string; nickname: string } {
  try {
    const last = localStorage.getItem('cipherchat:last')
    if (last) {
      const { channelId: c, nickname: n } = JSON.parse(last)
      return { channelId: c || '', nickname: n || randomNick() }
    }
  } catch { /* ignore */ }
  return { channelId: '', nickname: randomNick() }
}

export function ChatJoin({ onBack }: { onBack: () => void }) {
  const { join, joining, config } = useChatStore()
  const [channelId, setChannelId] = useState(() => lastChatInfo().channelId)
  const [password, setPassword] = useState('')
  const [nickname, setNickname] = useState(() => lastChatInfo().nickname)
  const [showPw, setShowPw] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // v1.4.3：连接模式在加入前选定（与语音大厅一致）—— 相同频道 ID 不同模式互不可见
  const [mode, setMode] = useState<'relay' | 'p2p'>(() => {
    try { return localStorage.getItem('cipherchat:chat-mode') === 'relay' ? 'relay' : 'p2p' } catch { return 'p2p' }
  })
  // v1.4.3：IP 披露级别（full=完整 / region=仅地区 / hidden=不披露）
  const [geoDisclosure, setGeoDisclosure] = useState<'full' | 'region' | 'hidden'>('full')
  const allowHiddenGeo = (config as RuntimeConfig & { allowHiddenGeo?: boolean })?.allowHiddenGeo !== false
  // 示例 chips：每次挂载重新随机（含中文），不再固定
  const examples = useMemo(() => randomExamples(), [])
  const secureOk = useMemo(() => isSecureContextOk(), [])

  const strength = useMemo(() => passwordStrength(password), [password])
  const strengthColors = ['bg-zinc-300', 'bg-red-400', 'bg-amber-400', 'bg-lime-500', 'bg-emerald-500']

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault()
    const cid = channelId.trim()
    if (!cid) return setErr('请输入频道 ID')
    if (!password) return setErr('请输入密码')
    if (!secureOk) {
      setErr('当前连接不是安全上下文（HTTPS）：浏览器已禁用加密功能（WebCrypto）。请通过 HTTPS 域名访问，或在服务器上运行 deploy/https.sh 配置证书。')
      return
    }
    setErr(null)
    try { localStorage.setItem('cipherchat:chat-mode', mode) } catch { /* ignore */ }
    try {
      await join(cid, password, nickname, mode, geoDisclosure)
    } catch (e2) {
      // v1.8.0：不再裸抛英文原始错误 —— 统一翻译为「原因 + 处理方式」
      const ex = explainError(e2, '加入频道')
      setErr(`${ex.title}｜${ex.reason}｜处理：${ex.fix}`)
    }
  }

  const regenId = () => {
    setChannelId(generateChannelId())
    setErr(null)
  }

  // v1.4.3：扫码加入 —— 识别邀请二维码后自动兑换并填充频道信息
  const [qrOpen, setQrOpen] = useState(false)
  const [redeeming, setRedeeming] = useState(false)
  const onQrCode = (code: string) => {
    setQrOpen(false)
    void (async () => {
      try {
        setErr(null)
        setRedeeming(true)
        const res = await fetch('/api/chat/invite/redeem', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data?.error || '邀请无效或已过期')
        setChannelId(data.channelId || '')
        if (data.password) {
          // 免密钥模式：直接进入
          try { localStorage.setItem('cipherchat:chat-mode', mode) } catch { /* ignore */ }
          await join(data.channelId, data.password, nickname.trim() || randomNick(), mode, geoDisclosure)
        } else {
          toast.message('邀请已识别，请输入频道密码后进入')
        }
      } catch (e) {
        // v1.8.0：扫码/兑换失败同样带原因与修复方式
        const ex = explainError(e, '邀请兑换')
        setErr(`${ex.title}｜${ex.reason}｜处理：${ex.fix}`)
      } finally {
        setRedeeming(false)
      }
    })()
  }

  return (
    <div className="w-full max-w-md mx-auto px-4 flex items-center justify-center py-8" style={{ minHeight: 'calc(100dvh - 6rem)' }}>
      <motion.div
        initial={{ opacity: 0, y: 18 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="glass w-full rounded-3xl border p-6 shadow-xl sm:p-8"
      >
        {/* 标题区（图标 + 文案） */}
        <div className="mb-6 flex items-center gap-4">
          <div className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl grad-primary text-white shadow-lg shadow-violet-500/30">
            <MessagesSquare className="h-7 w-7" />
          </div>
          <div>
            <h1 className="text-xl font-bold">进入加密频道</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">频道 ID + 密码，相同的组合进入同一房间</p>
          </div>
        </div>

        <form onSubmit={submit} className="space-y-4">
          {/* 非安全上下文警告（HTTP 访问时 WebCrypto 不可用） */}
          {!secureOk && (
            <div className="flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-3.5 py-2.5 text-[12.5px] leading-relaxed text-red-600 dark:text-red-400">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                当前通过 <b>非 HTTPS</b> 访问，浏览器已禁用加密 API（WebCrypto），无法进入频道。
                请为站点配置 HTTPS（服务器上运行 <code className="rounded bg-black/10 px-1">sudo bash deploy/https.sh</code>），或使用 localhost 访问。
              </span>
            </div>
          )}

          {/* 频道 ID */}
          <div className="space-y-1.5">
            <Label htmlFor="channel" className="text-sm font-semibold">频道 ID</Label>
            <div className="relative">
              <Hash className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="channel"
                value={channelId}
                onChange={(e) => setChannelId(e.target.value.replace(/[^\p{L}\p{N}_-]/gu, '').slice(0, 64))}
                placeholder="任意名称，支持中文，如 starlight-corridor"
                className="h-12 rounded-xl pl-10 pr-12 text-base"
                autoComplete="off"
                disabled={joining}
              />
              {/* 随机生成（防重复） */}
              <button
                type="button"
                onClick={regenId}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-primary"
                aria-label="随机生成频道 ID"
                title="随机生成一个不重复的频道 ID"
              >
                <Dice5 className="h-4 w-4" />
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-1.5 pt-1">
              {examples.map((ex) => (
                <button
                  key={ex}
                  type="button"
                  className="rounded-full border bg-muted/50 px-2.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
                  onClick={() => setChannelId(ex)}
                >
                  {ex}
                </button>
              ))}
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/5 px-2.5 py-0.5 text-[11px] text-primary transition-colors hover:bg-primary/10"
                onClick={regenId}
              >
                <Dice5 className="h-3 w-3" /> 随机生成
              </button>
              {/* v1.4.3：扫码加入邀请 */}
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/5 px-2.5 py-0.5 text-[11px] text-primary transition-colors hover:bg-primary/10"
                onClick={() => setQrOpen(true)}
              >
                <ScanLine className="h-3 w-3" /> 扫码加入
              </button>
            </div>
          </div>

          {/* 密码 */}
          <div className="space-y-1.5">
            <Label htmlFor="password" className="text-sm font-semibold">
              频道密码 <span className="font-normal text-muted-foreground">（即 AES-256 加密密钥）</span>
            </Label>
            <div className="relative">
              <KeyRound className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="password"
                type={showPw ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="双方共享的密码，建议 12 位以上"
                className="h-12 rounded-xl pl-10 pr-11 text-base"
                autoComplete="new-password"
                disabled={joining}
              />
              <button
                type="button"
                onClick={() => setShowPw((v) => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-muted-foreground hover:text-foreground"
                aria-label={showPw ? '隐藏密码' : '显示密码'}
              >
                {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            {password.length > 0 && (
              <div className="flex items-center gap-2 pt-0.5">
                <div className="flex-1 flex gap-1">
                  {[0, 1, 2, 3].map((i) => (
                    <span
                      key={i}
                      className={`h-1 flex-1 rounded-full transition-colors ${i < strength.score ? strengthColors[strength.score] : 'bg-zinc-200 dark:bg-zinc-700'}`}
                    />
                  ))}
                </div>
                <span className="text-[11px] text-muted-foreground w-12 text-right">{strength.label}</span>
              </div>
            )}
          </div>

          {/* 昵称 */}
          <div className="space-y-1.5">
            <Label htmlFor="nick" className="text-sm font-semibold">
              我的昵称 <span className="font-normal text-muted-foreground">（加密传输）</span>
            </Label>
            <div className="flex gap-2">
              <Input
                id="nick"
                value={nickname}
                onChange={(e) => setNickname(e.target.value.slice(0, 24))}
                placeholder="给自己起个名字"
                className="h-11 rounded-xl text-base"
                disabled={joining}
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="h-11 w-11 rounded-xl shrink-0"
                onClick={() => setNickname(randomNick())}
                title="随机昵称"
              >
                <Wand2 className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {/* 连接模式（v1.4.3）：加入前必须选定，同频道 ID 不同模式互不可见 */}
          <div className="space-y-1.5">
            <Label className="text-sm font-semibold flex items-center gap-1.5">
              <Radio className="h-3.5 w-3.5" /> 连接方式
            </Label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setMode('p2p')}
                disabled={joining}
                className={cn(
                  'flex flex-col items-start gap-0.5 rounded-xl border p-3 text-left transition-all',
                  mode === 'p2p' ? 'border-primary bg-primary/10 shadow-sm' : 'border-border bg-card hover:bg-muted/40',
                )}
              >
                <span className={cn('text-xs font-bold flex items-center gap-1', mode === 'p2p' ? 'text-primary' : 'text-foreground')}>
                  <Zap className="h-3.5 w-3.5" /> P2P 直连
                </span>
                <span className="text-[10px] text-muted-foreground leading-tight">文字经 WebRTC DataChannel 直传，服务器不留存</span>
              </button>
              <button
                type="button"
                onClick={() => setMode('relay')}
                disabled={joining}
                className={cn(
                  'flex flex-col items-start gap-0.5 rounded-xl border p-3 text-left transition-all',
                  mode === 'relay' ? 'border-primary bg-primary/10 shadow-sm' : 'border-border bg-card hover:bg-muted/40',
                )}
              >
                <span className={cn('text-xs font-bold flex items-center gap-1', mode === 'relay' ? 'text-primary' : 'text-foreground')}>
                  <Radio className="h-3.5 w-3.5" /> 服务器中继
                </span>
                <span className="text-[10px] text-muted-foreground leading-tight">密文经服务器转发并留存，弱网更稳、支持离线消息</span>
              </button>
            </div>
            {/* 模式差异说明 + 相互可见性提醒 */}
            {mode === 'p2p' ? (
              <p className="rounded-lg bg-amber-500/10 px-2.5 py-1.5 text-[10.5px] leading-relaxed text-amber-700 dark:text-amber-400">
                ⚠️ P2P 模式：双方同时在线才能收发，历史不落库（刷新即失）；NAT 穿透失败时可能连不上。
              </p>
            ) : (
              <p className="rounded-lg bg-sky-500/10 px-2.5 py-1.5 text-[10.5px] leading-relaxed text-sky-700 dark:text-sky-400">
                ℹ️ 中继模式：密文存于服务器（端到端加密仍生效），可离线留言、随时回看历史。
              </p>
            )}
            <p className="text-[10px] font-medium text-red-500 dark:text-red-400">
              ⚠️ 所有成员必须选择<b>相同的连接方式</b>才能互相看见 —— 同一频道 ID 在 P2P 与中继模式下是两个隔离的房间。
            </p>
          </div>

          {/* IP 披露级别（v1.4.3）：hidden 是否可用由管理员后台 allowHiddenGeo 决定 */}
          <div className="space-y-1.5">
            <Label className="text-sm font-semibold flex items-center gap-1.5">
              <EyeOff className="h-3.5 w-3.5" /> IP 信息披露
            </Label>
            <div className="grid grid-cols-3 gap-2">
              {([
                { v: 'full', label: '完整 IP', desc: '显示 IP 与地区' },
                { v: 'region', label: '仅地区', desc: '隐藏 IP 只看地区' },
                ...(allowHiddenGeo ? [{ v: 'hidden', label: '不披露', desc: '完全隐藏归属' }] : []),
              ] as { v: 'full' | 'region' | 'hidden'; label: string; desc: string }[]).map((o) => (
                <button
                  key={o.v}
                  type="button"
                  onClick={() => setGeoDisclosure(o.v)}
                  disabled={joining}
                  className={cn(
                    'flex flex-col items-start gap-0.5 rounded-xl border px-2.5 py-2 text-left transition-all',
                    geoDisclosure === o.v ? 'border-primary bg-primary/10 shadow-sm' : 'border-border bg-card hover:bg-muted/40',
                  )}
                >
                  <span className={cn('text-[11px] font-bold', geoDisclosure === o.v ? 'text-primary' : 'text-foreground')}>{o.label}</span>
                  <span className="text-[9.5px] leading-tight text-muted-foreground">{o.desc}</span>
                </button>
              ))}
            </div>
            {!allowHiddenGeo && (
              <p className="text-[10px] text-muted-foreground">「不披露」选项已由管理员关闭。</p>
            )}
          </div>

          {err && (
            <div className="rounded-xl bg-red-500/10 text-red-600 dark:text-red-400 text-[13px] px-3.5 py-2.5">
              {err}
            </div>
          )}

          <Button
            type="submit"
            disabled={joining || !channelId.trim() || !password}
            className="h-12 w-full rounded-xl grad-primary text-base font-semibold shadow-lg shadow-violet-500/25"
          >
            {joining ? (
              <>
                <Loader2 className="mr-2 h-5 w-5 animate-spin" /> 正在派生密钥（PBKDF2 310k 轮）…
              </>
            ) : (
              <>
                进入频道 <ArrowRight className="ml-1.5 h-4 w-4" />
              </>
            )}
          </Button>
        </form>

        {/* v1.4.3：扫码加入对话框 */}
        {qrOpen && <QrScanDialog onCode={onQrCode} onClose={() => setQrOpen(false)} />}
        {/* 兑换邀请中遮罩提示 */}
        {redeeming && (
          <div className="mt-3 flex items-center justify-center gap-2 text-[12px] text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> 正在验证邀请…
          </div>
        )}

        <div className="mt-6 rounded-xl bg-muted/50 p-4 text-xs leading-relaxed text-muted-foreground">
          <p className="mb-1 flex items-center gap-1.5 font-semibold text-foreground">
            <ShieldCheck className="h-3.5 w-3.5" /> 密码的工作方式
          </p>
          <p>
            密码在本机经 PBKDF2 派生两把密钥：一把留在设备上做 AES-256-GCM 加解密，另一把的哈希用于向服务器证明身份。
            服务器永远接触不到密码本身，也无法解密任何消息。
            {config ? ` 单文件上限 ${Math.round(config.maxChatFileBytes / 1024 / 1024 / 1024)}GB。` : ''}
            忘记密码即永远无法解密历史消息。
          </p>
        </div>

        <button onClick={onBack} className="mt-4 mx-auto block text-xs text-muted-foreground hover:text-foreground transition-colors">
          ← 返回首页
        </button>
      </motion.div>
    </div>
  )
}
