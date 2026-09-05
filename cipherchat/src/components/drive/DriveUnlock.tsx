'use client'

import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { toast } from 'sonner'
import {
  HardDrive, KeyRound, Loader2, ArrowRight, Copy, Check, ShieldAlert, Wand2,
  ShieldCheck, Bomb, Crown,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useDriveStore } from '@/store/drive'
import { deriveAdminKeyHash, deriveProbeHash, passwordStrength } from '@/lib/crypto'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

type AdminStatus = 'loading' | 'uninit' | 'ready'

function StrengthBar({ value }: { value: string }) {
  const s = passwordStrength(value)
  const colors = ['bg-zinc-300', 'bg-red-400', 'bg-amber-400', 'bg-lime-500', 'bg-violet-500']
  if (!value) return null
  return (
    <div className="flex items-center gap-2 pt-1">
      <div className="flex-1 flex gap-1">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className={`h-1 flex-1 rounded-full transition-colors ${i < s.score ? colors[s.score] : 'bg-zinc-200 dark:bg-zinc-700'}`} />
        ))}
      </div>
      <span className="text-[11px] text-muted-foreground w-12 text-right">{s.label}</span>
    </div>
  )
}

// ======================= 首次初始化：设置 超级密钥 + 自毁密钥 =======================
function AdminInitCard({ onDone }: { onDone: () => void }) {
  const [superKey, setSuperKey] = useState('')
  const [superKey2, setSuperKey2] = useState('')
  const [destroyKey, setDestroyKey] = useState('')
  const [destroyKey2, setDestroyKey2] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    setErr(null)
    if (superKey.length < 8) return setErr('超级密钥至少 8 位（建议 12 位以上混合字符）')
    if (superKey !== superKey2) return setErr('两次输入的超级密钥不一致')
    if (destroyKey.length < 8) return setErr('自毁密钥至少 8 位')
    if (destroyKey !== destroyKey2) return setErr('两次输入的自毁密钥不一致')
    if (superKey === destroyKey) return setErr('超级密钥与自毁密钥不能相同')
    setBusy(true)
    try {
      const superKeyHash = await deriveAdminKeyHash(superKey)
      const destroyKeyHash = await deriveProbeHash(destroyKey) // 存储格式与探测哈希同源
      const res = await fetch('/api/admin/init', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ superKeyHash, destroyKeyHash }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j.error || '初始化失败')
      }
      toast.success('管理员密钥初始化成功，请妥善保管两把密钥')
      onDone()
    } catch (e) {
      setErr(e instanceof Error ? e.message : '初始化失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 24, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.45, ease: [0.2, 0.8, 0.25, 1] }}
      className="w-full rounded-[28px] glass p-7 sm:p-8 shadow-xl"
    >
      <div className="text-center">
        <span className="inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-amber-400 to-orange-500 text-white shadow-lg shadow-amber-500/30">
          <Crown className="h-7 w-7" />
        </span>
        <h2 className="mt-4 text-xl font-semibold">首次使用 · 初始化管理员密钥</h2>
        <p className="mt-1.5 text-sm text-muted-foreground">
          网盘功能需要管理员授权才能创建新仓库，请先设定两把密钥
        </p>
      </div>

      <div className="mt-6 space-y-4">
        <div className="rounded-2xl border border-violet-500/25 bg-violet-500/[0.06] p-3.5 space-y-3.5">
          <div>
            <p className="text-[12px] font-semibold text-violet-700 dark:text-violet-300 flex items-center gap-1.5">
              <ShieldCheck className="h-3.5 w-3.5" /> ① 管理员超级密钥（创建网盘时使用）
            </p>
            <div className="mt-2 space-y-2">
              <Input
                type="password" value={superKey} onChange={(e) => setSuperKey(e.target.value)}
                placeholder="设定超级密钥（至少 8 位）" autoComplete="new-password"
                className="h-10 rounded-xl text-[14px]"
              />
              <StrengthBar value={superKey} />
              <Input
                type="password" value={superKey2} onChange={(e) => setSuperKey2(e.target.value)}
                placeholder="再输入一次确认" autoComplete="new-password"
                className="h-10 rounded-xl text-[14px]"
              />
            </div>
          </div>
        </div>

        <div className="rounded-2xl border border-red-500/25 bg-red-500/[0.05] p-3.5">
          <p className="text-[12px] font-semibold text-red-600 dark:text-red-400 flex items-center gap-1.5">
            <Bomb className="h-3.5 w-3.5" /> ② 自毁密钥（紧急销毁全部数据，慎设）
          </p>
          <div className="mt-2 space-y-2">
            <Input
              type="password" value={destroyKey} onChange={(e) => setDestroyKey(e.target.value)}
              placeholder="设定自毁密钥（至少 8 位）" autoComplete="new-password"
              className="h-10 rounded-xl text-[14px]"
            />
            <StrengthBar value={destroyKey} />
            <Input
              type="password" value={destroyKey2} onChange={(e) => setDestroyKey2(e.target.value)}
              placeholder="再输入一次确认" autoComplete="new-password"
              className="h-10 rounded-xl text-[14px]"
            />
          </div>
          <p className="mt-2 text-[11.5px] leading-relaxed text-red-600/80 dark:text-red-400/80">
            在任何密码框输入这把密钥，都会立即销毁服务器上全部聊天记录、文件与网盘数据（不可恢复、无需确认）。请仅在需要紧急销毁时使用。
          </p>
        </div>
      </div>

      {err && (
        <div className="mt-4 rounded-xl bg-red-500/10 text-red-600 dark:text-red-400 text-[13px] px-3.5 py-2.5">{err}</div>
      )}

      <Button
        onClick={submit}
        disabled={busy}
        className="mt-5 w-full h-12 rounded-xl text-[15px] font-semibold bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 text-white shadow-lg shadow-amber-500/25 transition-all active:scale-[0.98]"
      >
        {busy ? (
          <><Loader2 className="h-4 w-4 animate-spin" /> 密钥派生中…</>
        ) : (
          <>完成初始化 <ArrowRight className="h-4 w-4" /></>
        )}
      </Button>

      <div className="mt-3 flex items-start gap-2 rounded-xl bg-amber-500/10 text-amber-700 dark:text-amber-300 px-3.5 py-2.5 text-[12px]">
        <ShieldAlert className="h-4 w-4 shrink-0 mt-0.5" />
        <span>两把密钥服务器只存哈希、无法找回。部署后请第一时间完成本初始化，防止他人抢先设置。</span>
      </div>
    </motion.div>
  )
}

// ======================= 解锁 / 新建 =======================
export function DriveUnlock({ onBack }: { onBack: () => void }) {
  const { unlock, unlocking } = useDriveStore()
  const [adminStatus, setAdminStatus] = useState<AdminStatus>('loading')
  const [mode, setMode] = useState<'unlock' | 'create'>('unlock')
  const [driveId, setDriveId] = useState('')
  const [secretKey, setSecretKey] = useState('')
  const [adminKey, setAdminKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [createdId, setCreatedId] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    fetch('/api/admin/status')
      .then((r) => r.json())
      .then((d: { initialized?: boolean }) => setAdminStatus(d?.initialized ? 'ready' : 'uninit'))
      .catch(() => setAdminStatus('ready')) // 状态获取失败时按已初始化处理（服务端仍会拦截）
  }, [])

  useEffect(() => {
    try {
      const last = localStorage.getItem('cipherdrive:last')
      if (last) {
        const { driveId: d } = JSON.parse(last)
        if (d) setDriveId(d)
      }
    } catch { /* ignore */ }
  }, [])

  const submit = async () => {
    if (!secretKey) return
    setErr(null)
    try {
      if (mode === 'create') {
        if (!adminKey) {
          setErr('创建网盘需要管理员超级密钥')
          return
        }
        // 先向服务器申请随机 ID → 弹窗确认保存 → 再凭超级密钥正式建仓解锁
        const rid = await fetch('/api/drive/new-id', { method: 'POST' })
        if (!rid.ok) {
          const j = await rid.json().catch(() => ({}))
          throw new Error(j.error || '生成网盘 ID 失败')
        }
        const { driveId: newId } = await rid.json()
        setCreatedId(newId)
        return
      }
      await unlock(driveId, secretKey, false)
    } catch (e) {
      setErr(e instanceof Error ? e.message : '操作失败')
    }
  }

  const confirmCreated = async () => {
    if (!createdId || !secretKey) return
    const id = createdId
    setCreatedId(null)
    try {
      await unlock(id, secretKey, true, adminKey)
    } catch (e) {
      setErr(e instanceof Error ? e.message : '创建失败')
    }
  }

  const copyId = async () => {
    if (!createdId) return
    try {
      await navigator.clipboard.writeText(createdId)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch { /* ignore */ }
  }

  if (adminStatus === 'loading') {
    return (
      <div className="w-full max-w-md mx-auto px-4 flex items-center justify-center gap-3 py-24 text-muted-foreground" style={{ minHeight: 'calc(100vh - 10rem)' }}>
        <Loader2 className="h-5 w-5 animate-spin" /> 正在检查管理员配置…
      </div>
    )
  }

  return (
    <div className="w-full max-w-md mx-auto px-4 flex items-center justify-center" style={{ minHeight: 'calc(100vh - 10rem)' }}>
      {adminStatus === 'uninit' ? (
        <AdminInitCard onDone={() => setAdminStatus('ready')} />
      ) : (
        <motion.div
          initial={{ opacity: 0, y: 24, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.45, ease: [0.2, 0.8, 0.25, 1] }}
          className="w-full rounded-[28px] glass p-7 sm:p-8 shadow-xl"
        >
          <div className="text-center">
            <span className="inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-fuchsia-400 to-pink-500 text-white shadow-lg shadow-fuchsia-500/30">
              <HardDrive className="h-7 w-7" />
            </span>
            <h2 className="mt-4 text-xl font-semibold">隐私加密网盘</h2>
            <p className="mt-1.5 text-sm text-muted-foreground">
              个人密钥解锁专属仓库，文件名与内容全部加密存储
            </p>
          </div>

          {/* 模式切换 */}
          <div className="mt-6 grid grid-cols-2 gap-1 rounded-2xl bg-black/[0.05] dark:bg-white/[0.06] p-1">
            {(['unlock', 'create'] as const).map((m) => (
              <button
                key={m}
                onClick={() => { setMode(m); setErr(null) }}
                className={`rounded-xl py-2 text-[13px] font-medium transition-all ${
                  mode === m
                    ? 'bg-white dark:bg-zinc-800 text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {m === 'unlock' ? '解锁网盘' : '新建网盘'}
              </button>
            ))}
          </div>

          <div className="mt-5 space-y-4">
            {mode === 'unlock' && (
              <div className="space-y-1.5">
                <Label htmlFor="driveId" className="text-[13px] flex items-center gap-1.5">
                  <HardDrive className="h-3.5 w-3.5 text-fuchsia-500" /> 网盘 ID（8 位）
                </Label>
                <Input
                  id="driveId"
                  value={driveId}
                  onChange={(e) => setDriveId(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8))}
                  placeholder="例如 XK72M9QF"
                  autoComplete="off"
                  className="h-11 rounded-xl text-base font-mono tracking-widest"
                />
              </div>
            )}

            {mode === 'create' && (
              <div className="space-y-1.5">
                <Label htmlFor="adminKey" className="text-[13px] flex items-center gap-1.5">
                  <Crown className="h-3.5 w-3.5 text-amber-500" /> 管理员超级密钥
                </Label>
                <Input
                  id="adminKey"
                  type="password"
                  value={adminKey}
                  onChange={(e) => setAdminKey(e.target.value)}
                  placeholder="仅管理员可创建新网盘"
                  autoComplete="new-password"
                  className="h-11 rounded-xl text-base"
                />
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="driveKey" className="text-[13px] flex items-center gap-1.5">
                <KeyRound className="h-3.5 w-3.5 text-fuchsia-500" /> {mode === 'create' ? '设定个人密钥' : '个人密钥'}
              </Label>
              <div className="relative">
                <Input
                  id="driveKey"
                  type={showKey ? 'text' : 'password'}
                  value={secretKey}
                  onChange={(e) => setSecretKey(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && submit()}
                  placeholder="建议 16 位以上，一旦遗忘无法找回"
                  autoComplete="new-password"
                  className="h-11 rounded-xl text-base pr-14"
                />
                <button
                  type="button"
                  onClick={() => setShowKey((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground hover:text-foreground"
                >
                  {showKey ? '隐藏' : '显示'}
                </button>
              </div>
            </div>
          </div>

          {err && (
            <div className="mt-4 rounded-xl bg-red-500/10 text-red-600 dark:text-red-400 text-[13px] px-3.5 py-2.5">{err}</div>
          )}

          <Button
            onClick={submit}
            disabled={!secretKey || (mode === 'unlock' && driveId.length !== 8) || unlocking}
            className="mt-6 w-full h-12 rounded-xl text-[15px] font-semibold bg-gradient-to-r from-fuchsia-500 to-pink-500 hover:from-fuchsia-600 hover:to-pink-600 text-white shadow-lg shadow-fuchsia-500/25 transition-all active:scale-[0.98]"
          >
            {unlocking ? (
              <><Loader2 className="h-4 w-4 animate-spin" /> 密钥派生中…</>
            ) : mode === 'unlock' ? (
              <>解锁网盘 <ArrowRight className="h-4 w-4" /></>
            ) : (
              <><Wand2 className="h-4 w-4" /> 生成我的加密网盘</>
            )}
          </Button>

          <p className="mt-4 text-center text-[11px] leading-relaxed text-muted-foreground">
            密钥不同 = 完全独立的仓库 · 服务器无法读取任何文件
            <br />
            <button onClick={onBack} className="mt-2 text-xs hover:text-foreground transition-colors">← 返回首页</button>
          </p>
        </motion.div>
      )}

      {/* 新建成功弹窗 */}
      <Dialog open={!!createdId} onOpenChange={(o) => !o && setCreatedId(null)}>
        <DialogContent className="rounded-3xl max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-center">确认创建网盘</DialogTitle>
            <DialogDescription className="text-center pt-1">
              系统已分配以下 ID，确认后将验证超级密钥并创建仓库
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-2xl bg-gradient-to-br from-fuchsia-500/10 to-pink-500/10 border border-fuchsia-500/25 p-5 text-center">
            <p className="text-[11px] text-muted-foreground mb-2">你的网盘 ID</p>
            <p className="font-mono text-3xl font-bold tracking-[0.18em] text-gradient select-all">{createdId}</p>
            <Button
              onClick={copyId}
              variant="outline"
              size="sm"
              className="mt-3 rounded-full gap-1.5"
            >
              {copied ? <Check className="h-3.5 w-3.5 text-violet-500" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? '已复制' : '复制 ID'}
            </Button>
          </div>
          <div className="flex items-start gap-2 rounded-xl bg-amber-500/10 text-amber-700 dark:text-amber-300 px-3.5 py-2.5 text-[12px]">
            <ShieldAlert className="h-4 w-4 shrink-0 mt-0.5" />
            <span>ID 与密钥均无法找回：遗忘任何一个，数据将永远无法解密。建议现在就把它们抄写或存入密码管理器。</span>
          </div>
          <Button onClick={confirmCreated} className="rounded-xl bg-gradient-to-r from-fuchsia-500 to-pink-500 text-white">
            确认创建，进入网盘
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  )
}
