'use client'
// 分享进入页：从二维码/邀请链接打开后先到本页
// 免密钥模式：凭短码向服务器换取频道 ID + 密码（密码由服务端主密钥解密），一键进入
// 常规模式：只预填频道 ID，受邀者输入密码解锁进入 —— 密钥仍不经过链接
import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { toast } from 'sonner'
import { KeyRound, Eye, EyeOff, Loader2, ArrowRight, ShieldCheck, ShieldAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useChatStore } from '@/store/chat'
import { randomNick } from '@/lib/crypto'

export function extractInviteCode(): string | null {
  if (typeof window === 'undefined') return null
  const m = window.location.hash.match(/#\/?invite=([A-Za-z0-9]+)/)
  return m ? m[1] : null
}

export function InviteJoin({ onBack }: { onBack: () => void }) {
  const code = extractInviteCode()
  const join = useChatStore((s) => s.join)
  const joining = useChatStore((s) => s.joining)
  const [checking, setChecking] = useState(true)
  const [channelId, setChannelId] = useState('')
  const [password, setPassword] = useState<string | null>(null) // null = 需要用户输入
  const [pwInput, setPwInput] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [nickname, setNickname] = useState('')
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    try {
      const last = localStorage.getItem('cipherchat:last')
      if (last) {
        const n = JSON.parse(last).nickname
        if (n) setNickname(n)
      }
    } catch { /* ignore */ }
    if (!code) {
      // 没有 code 时按常规模式处理（仅频道 ID 从 query 拿）
      const ch = new URLSearchParams(window.location.hash.replace(/^#\??/, '')).get('ch') || ''
      setChannelId(ch)
      setPassword('')
      setChecking(false)
      return
    }
    ;(async () => {
      try {
        const res = await fetch('/api/chat/invite/redeem', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data?.error || '邀请无效或已过期')
        setChannelId(data.channelId)
        setPassword(data.password || '')
        if (!data.password) setPassword(null)
      } catch (e) {
        setErr(e instanceof Error ? e.message : '邀请无效')
        setPassword(null)
        setChannelId('') // 无法解析频道 → 显示手动表单
      } finally {
        setChecking(false)
      }
    })()
  }, [code])

  const doJoin = async () => {
    const pw = password ?? pwInput
    if (!channelId) return setErr('缺少频道信息')
    if (!pw && pwInput === '') return setErr('请输入频道密码')
    setErr(null)
    try {
      await join(channelId, pw || pwInput, nickname.trim() || randomNick())
    } catch (e) {
      setErr(e instanceof Error ? e.message : '加入失败')
    }
  }

  if (useChatStore((s) => s.joined)) return null

  if (checking) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 py-24 text-muted-foreground">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <p className="text-sm">正在验证邀请…</p>
      </div>
    )
  }

  const keyless = password !== null

  return (
    <div className="mx-auto w-full max-w-md px-4 py-8" style={{ minHeight: 'calc(100dvh - 6rem)' }}>
      <motion.div initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} className="glass w-full rounded-3xl border p-6 shadow-xl sm:p-8">
        <div className="mb-6 flex items-center gap-4">
          <div className={`grid h-14 w-14 shrink-0 place-items-center rounded-2xl text-white shadow-lg ${keyless ? 'grad-primary shadow-violet-500/30' : 'bg-zinc-500 shadow-zinc-500/20'}`}>
            {keyless ? <ShieldCheck className="h-7 w-7" /> : <ShieldAlert className="h-7 w-7" />}
          </div>
          <div>
            <h1 className="text-xl font-bold">{keyless ? '邀请你加入加密频道' : '需要密码的加密频道'}</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {keyless ? '发起人已授权免密钥加入 · 点击下方按钮即可进入' : '为保护消息安全，请输入频道密码后进入'}
            </p>
          </div>
        </div>

        <div className="space-y-4">
          <div className="rounded-xl bg-muted/60 px-3.5 py-2.5 text-sm">
            <span className="text-xs text-muted-foreground">频道</span>
            <p className="font-mono font-semibold">{channelId || '（未知）'}</p>
          </div>

          {!keyless && (
            <div className="space-y-1.5">
              <Label htmlFor="inv-pw" className="text-sm font-semibold">频道密码</Label>
              <div className="relative">
                <KeyRound className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="inv-pw"
                  type={showPw ? 'text' : 'password'}
                  value={pwInput}
                  onChange={(e) => setPwInput(e.target.value)}
                  placeholder="向发起人索取密码"
                  className="h-12 rounded-xl pl-10 pr-11"
                  autoComplete="off"
                />
                <button type="button" onClick={() => setShowPw((v) => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 p-1.5 text-muted-foreground hover:text-foreground" aria-label={showPw ? '隐藏密码' : '显示密码'}>
                  {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="inv-nick" className="text-sm font-semibold">我的昵称（可选）</Label>
            <Input id="inv-nick" value={nickname} onChange={(e) => setNickname(e.target.value.slice(0, 24))} placeholder="留空则随机昵称" className="h-11 rounded-xl" />
          </div>

          {err && <div className="rounded-xl bg-red-500/10 px-3.5 py-2.5 text-[13px] text-red-600 dark:text-red-400">{err}</div>}

          <Button onClick={doJoin} disabled={joining} className="h-12 w-full rounded-xl grad-primary text-base font-semibold shadow-lg shadow-violet-500/25">
            {joining ? <Loader2 className="mr-2 h-5 w-5 animate-spin" /> : <ArrowRight className="mr-1.5 h-4 w-4" />}
            {joining ? '正在派生密钥…' : keyless ? '一键加入频道' : '解锁并进入'}
          </Button>

          <button onClick={onBack} className="mx-auto block text-xs text-muted-foreground transition-colors hover:text-foreground">
            ← 返回首页
          </button>
        </div>
      </motion.div>
    </div>
  )
}
