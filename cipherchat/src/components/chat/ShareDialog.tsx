'use client'
// 频道分享对话框：生成邀请链接 + 二维码（本地渲染，不出服务器）
// 两种模式：
//  1. 常规模式 —— 链接只含频道 ID，受邀者需自行输入密码
//  2. 免密钥模式 —— 密码由「服务器主密钥」二次加密后存库，
//     链接只含短码；扫码/点开即加入。分享者可设有效期与次数
import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { toast } from 'sonner'
import { Copy, QrCode, Loader2, ShieldCheck, ShieldAlert, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { createInvite, type InviteInfo } from '@/lib/share'

export function ShareDialog({
  channelId,
  password,
  token,
  onClose,
}: {
  channelId: string
  password: string // 当前用户持有的频道密码（免密钥模式下用于服务端二次加密）
  token: string
  onClose: () => void
}) {
  const [mode, setMode] = useState<'ask' | 'normal' | 'keyless'>('ask')
  const [busy, setBusy] = useState(false)
  const [invite, setInvite] = useState<InviteInfo | null>(null)
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [ttlHours, setTtlHours] = useState(24)
  const [maxUses, setMaxUses] = useState(0)

  const doCreate = async (withPassword: boolean) => {
    setBusy(true)
    try {
      const info = await createInvite({
        token,
        channelId,
        password: withPassword ? password : null,
        ttlMs: ttlHours * 3600_000,
        maxUses,
      })
      setInvite(info)
      setMode(withPassword ? 'keyless' : 'normal')
      setQrDataUrl(await QRCode.toDataURL(info.url, { width: 320, margin: 2 }))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '创建邀请失败')
    } finally {
      setBusy(false)
    }
  }

  const copyLink = async () => {
    if (!invite) return
    try {
      await navigator.clipboard.writeText(invite.url)
      toast.success('邀请链接已复制')
    } catch { /* ignore */ }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4 backdrop-blur-sm" role="dialog" aria-modal="true">
      <div className="glass w-full max-w-md rounded-2xl border p-5 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-lg font-bold"><QrCode className="h-5 w-5 text-primary" /> 分享频道</h2>
          <Button variant="ghost" size="icon" className="h-8 w-8 rounded-lg" onClick={onClose} aria-label="关闭">
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* 模式选择 */}
        {mode === 'ask' && (
          <div className="space-y-3">
            <p className="text-sm leading-relaxed text-muted-foreground">
              选择邀请方式：<b>{channelId}</b>
            </p>
            <button
              onClick={() => doCreate(true)}
              disabled={busy}
              className="w-full rounded-xl border border-primary/30 bg-primary/5 p-4 text-left transition hover:bg-primary/10 disabled:opacity-50"
            >
              <span className="flex items-center gap-2 font-semibold text-primary">
                <ShieldCheck className="h-4 w-4" /> 扫码直接加入（免密钥）
              </span>
              <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                对方扫码即可进入频道。密码不会出现在链接里 —— 由服务器主密钥 AES-256-GCM 二次加密后保管，链接仅含随机短码。
              </span>
            </button>
            <button
              onClick={() => doCreate(false)}
              disabled={busy}
              className="w-full rounded-xl border bg-card p-4 text-left transition hover:bg-muted/40 disabled:opacity-50"
            >
              <span className="flex items-center gap-2 font-semibold">
                <ShieldAlert className="h-4 w-4" /> 仅分享进入页面（需输入密码）
              </span>
              <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                邀请只包含频道 ID，对方打开后仍需输入密码才能解密消息。
              </span>
            </button>
            <div className="grid grid-cols-2 gap-3 pt-1">
              <div className="space-y-1.5">
                <Label htmlFor="ttl" className="text-xs">有效期（小时）</Label>
                <Input id="ttl" type="number" min={1} max={168} value={ttlHours} onChange={(e) => setTtlHours(Math.min(Math.max(Number(e.target.value) || 1, 1), 168))} className="h-9 rounded-xl" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="uses" className="text-xs">可用次数（0=不限）</Label>
                <Input id="uses" type="number" min={0} max={1000} value={maxUses} onChange={(e) => setMaxUses(Math.min(Math.max(Number(e.target.value) || 0, 0), 1000))} className="h-9 rounded-xl" />
              </div>
            </div>
          </div>
        )}

        {/* 创建中 */}
        {busy && (
          <div className="flex items-center justify-center gap-2 py-10 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" /> 正在生成邀请…
          </div>
        )}

        {/* 展示二维码 */}
        {!busy && invite && qrDataUrl && (
          <div className="space-y-4 text-center">
            {invite.withPassword && (
              <div className="rounded-xl bg-emerald-500/10 px-3 py-2 text-[12px] text-emerald-600 dark:text-emerald-400">
                免密钥邀请 · 密码已由服务器主密钥加密保管，链接不含任何机密明文
              </div>
            )}
            { }
            <img src={qrDataUrl} alt="频道邀请二维码" className="mx-auto rounded-xl border bg-white p-2" width={260} height={260} />
            <div className="break-all rounded-xl bg-muted/60 p-2.5 text-left text-[11px] font-mono leading-relaxed text-muted-foreground select-text">
              {invite.url}
            </div>
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1 rounded-xl" onClick={copyLink}>
                <Copy className="mr-1.5 h-4 w-4" /> 复制链接
              </Button>
              <Button variant="outline" className="rounded-xl" onClick={() => { setInvite(null); setQrDataUrl(null); setMode('ask') }}>
                重新生成
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">有效期至 {new Date(invite.expiresAt).toLocaleString('zh-CN')}</p>
          </div>
        )}
      </div>
    </div>
  )
}
