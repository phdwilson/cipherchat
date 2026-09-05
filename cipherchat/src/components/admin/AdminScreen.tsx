'use client'

// 管理员后台：超级密钥门禁 + 概览 / HTTPS 管理 / 维护 / 危险区
import { useCallback, useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { toast } from 'sonner'
import {
  Crown, Loader2, ArrowRight, LayoutDashboard, Globe, Wrench, Bomb, RefreshCw,
  HardDrive, MessageSquare, Users, Clock, AlertTriangle, Copy, Check,
  ShieldAlert, FileArchive, KeyRound, ToggleLeft, Mic, MessageCircle, UserRound, Image as ImageIcon, Network,
  Server, Zap, Radio, ShieldCheck, EyeOff, Skull, Activity,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { formatBytes, deriveAdminKeyHash, deriveProbeHash } from '@/lib/crypto'
import { isSecureContextOk } from '@/lib/channel-id'
import { SelfCheckPanel } from './SelfCheckPanel'

type Tab = 'overview' | 'selfcheck' | 'https' | 'voice' | 'maintain' | 'features' | 'danger'

interface Stats {
  messages: number
  chatFiles: number
  chatBytes: number
  driveRepos: number
  driveFiles: number
  driveBytes: number
  sessions: number
  uptimeSec: number
}

interface HttpsInfo {
  configured: boolean
  meta: { domain: string; mode: string; configuredAt: string } | null
  pending: { domain: string; mode: string; requestedAt: string } | null
  probe: {
    available: boolean
    subject?: string
    issuer?: string
    notAfter?: string
    daysLeft?: number
    error?: string
  }
  gatewayPort: number
}

interface DriveRepo {
  driveId: string
  usedBytes: number
  quotaBytes: number
  createdAt: string
  lastActiveAt: string
}

const MODE_LABEL: Record<string, string> = {
  'self-signed': '自签名证书',
  'acme-dns': '域名 + Cloudflare DNS 验证（自动续期）',
  'acme-http01': '域名 + HTTP-01 验证',
  custom: '自备证书',
  none: '未配置',
}

export function AdminScreen({ onBack }: { onBack: () => void }) {
  const [adminKey, setAdminKey] = useState('')
  const [adminKeyHash, setAdminKeyHash] = useState<string | null>(null)
  const [verifying, setVerifying] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('overview')

  const [stats, setStats] = useState<Stats | null>(null)
  const [drives, setDrives] = useState<DriveRepo[]>([])
  const [httpsInfo, setHttpsInfo] = useState<HttpsInfo | null>(null)
  const [loading, setLoading] = useState(false)

  // HTTPS 绑定表单
  const [bindDomain, setBindDomain] = useState('')
  const [bindMode, setBindMode] = useState<'self-signed' | 'acme-dns' | 'acme-http01' | 'custom'>('acme-dns')
  const [applyCommand, setApplyCommand] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  // 危险区
  const [destroyKey, setDestroyKey] = useState('')
  const [destroyArmed, setDestroyArmed] = useState(false)

  const secureOk = isSecureContextOk()

  const authedPost = useCallback(
    async (url: string, payload: Record<string, unknown> = {}) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ adminKeyHash, ...payload }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error || '请求失败')
      return data
    },
    [adminKeyHash]
  )

  const refreshAll = useCallback(async () => {
    if (!adminKeyHash) return
    setLoading(true)
    try {
      const [s, d, h] = await Promise.all([
        authedPost('/api/admin/stats'),
        authedPost('/api/admin/drives'),
        authedPost('/api/admin/https-info'),
      ])
      setStats(s)
      setDrives(d.drives || [])
      setHttpsInfo(h)
      if (h.meta?.domain) setBindDomain(h.meta.domain)
      if (h.meta?.mode && h.meta.mode !== 'none') setBindMode(h.meta.mode as 'self-signed')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [adminKeyHash, authedPost])

  useEffect(() => {
    if (adminKeyHash) void refreshAll()
  }, [adminKeyHash, refreshAll])

  const verify = async (e?: React.FormEvent) => {
    e?.preventDefault()
    if (!adminKey) return
    setVerifying(true)
    setErr(null)
    try {
      if (!secureOk) throw new Error('当前为非 HTTPS 访问，浏览器禁用加密 API，无法验证')
      const hash = await deriveAdminKeyHash(adminKey)
      const res = await fetch('/api/admin/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ adminKeyHash: hash }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j.error || '验证失败')
      }
      setAdminKeyHash(hash)
      toast.success('管理员身份已验证')
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : '验证失败')
    } finally {
      setVerifying(false)
    }
  }

  const doBind = async () => {
    try {
      const r = await authedPost('/api/admin/https-bind', { domain: bindDomain, mode: bindMode })
      setApplyCommand(r.applyCommand)
      toast.success('已保存待应用配置')
      await refreshAll()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '保存失败')
    }
  }

  const doMaintain = async (action: string, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return
    try {
      const r = await authedPost('/api/admin/maintenance', { action })
      toast.success(r.message)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '操作失败')
    }
  }

  const doDestroy = async () => {
    if (!destroyKey) return
    try {
      const probeHash = await deriveProbeHash(destroyKey)
      const res = await fetch('/api/admin/destroy', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ probeHash }),
      })
      const d = await res.json().catch(() => ({}))
      if (d?.destroyed) {
        window.location.href = '/'
      } else {
        toast.error('自毁密钥无效')
      }
    } catch {
      toast.error('请求失败')
    }
  }

  const copyCmd = async () => {
    if (!applyCommand) return
    try {
      await navigator.clipboard.writeText(applyCommand)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch { /* ignore */ }
  }

  // ———————— 门禁（未验证） ————————
  if (!adminKeyHash) {
    return (
      <div className="w-full max-w-md mx-auto px-4 flex items-center justify-center" style={{ minHeight: 'calc(100dvh - 10rem)' }}>
        <motion.div
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="glass w-full rounded-3xl border p-6 shadow-xl sm:p-8"
        >
          <div className="mb-6 flex items-center gap-4">
            <div className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl grad-primary text-white shadow-lg shadow-violet-500/30">
              <Crown className="h-7 w-7" />
            </div>
            <div>
              <h1 className="text-xl font-bold">管理员后台</h1>
              <p className="mt-0.5 text-sm text-muted-foreground">输入管理员超级密钥进入</p>
            </div>
          </div>

          <form onSubmit={verify} className="space-y-4">
            {!secureOk && (
              <div className="flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-3.5 py-2.5 text-[12.5px] leading-relaxed text-red-600 dark:text-red-400">
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
                <span>当前为非 HTTPS 访问，浏览器已禁用加密 API，无法验证。请先配置 HTTPS。</span>
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="adminKey" className="text-sm font-semibold flex items-center gap-1.5">
                <KeyRound className="h-3.5 w-3.5 text-primary" /> 超级密钥
              </Label>
              <Input
                id="adminKey"
                type="password"
                value={adminKey}
                onChange={(e) => setAdminKey(e.target.value)}
                placeholder="首次进入网盘页时设定的管理员超级密钥"
                className="h-12 rounded-xl text-base"
                autoComplete="current-password"
              />
            </div>
            {err && <div className="rounded-xl bg-red-500/10 text-red-600 dark:text-red-400 text-[13px] px-3.5 py-2.5">{err}</div>}
            <Button type="submit" disabled={verifying || !adminKey} className="h-12 w-full rounded-xl grad-primary text-base font-semibold shadow-lg shadow-violet-500/25">
              {verifying ? <><Loader2 className="mr-2 h-5 w-5 animate-spin" /> 验证中…</> : <>进入后台 <ArrowRight className="ml-1.5 h-4 w-4" /></>}
            </Button>
          </form>

          <button onClick={onBack} className="mt-5 mx-auto block text-xs text-muted-foreground hover:text-foreground transition-colors">← 返回首页</button>
        </motion.div>
      </div>
    )
  }

  // ———————— 已验证：后台面板 ————————
  const tabs: { key: Tab; label: string; icon: React.ReactNode }[] = [
    { key: 'overview', label: '概览', icon: <LayoutDashboard className="h-4 w-4" /> },
    { key: 'selfcheck', label: '自检', icon: <Activity className="h-4 w-4" /> },
    { key: 'https', label: 'HTTPS', icon: <Globe className="h-4 w-4" /> },
    { key: 'voice', label: '语音中继', icon: <Server className="h-4 w-4" /> },
    { key: 'maintain', label: '维护', icon: <Wrench className="h-4 w-4" /> },
    { key: 'features', label: '功能', icon: <ToggleLeft className="h-4 w-4" /> },
    { key: 'danger', label: '危险区', icon: <Bomb className="h-4 w-4" /> },
  ]

  // ———————— 栅格布局适配 6 项 ————————

  const h = httpsInfo
  const uptimeH = stats ? Math.floor(stats.uptimeSec / 3600) : 0
  const uptimeM = stats ? Math.floor((stats.uptimeSec % 3600) / 60) : 0

  return (
    <div className="w-full max-w-4xl mx-auto px-4 py-6">
      {/* 头部 */}
      <div className="mb-5 flex items-center gap-3">
        <Button variant="ghost" size="icon" className="h-9 w-9 rounded-xl shrink-0" onClick={onBack} aria-label="返回首页">
          <ArrowRight className="h-5 w-5 rotate-180" />
        </Button>
        <div className="grid h-11 w-11 place-items-center rounded-2xl grad-primary text-white shadow-lg shadow-violet-500/25 shrink-0">
          <Crown className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-bold">管理员后台</h1>
          <p className="text-xs text-muted-foreground">服务器统计 · HTTPS 证书管理 · 维护操作</p>
        </div>
        <Button variant="outline" size="sm" className="rounded-xl gap-1.5 shrink-0" onClick={() => void refreshAll()} disabled={loading}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} 刷新
        </Button>
      </div>

      {/* 页签 */}
      <div className="mb-5 grid grid-cols-4 sm:grid-cols-7 gap-1 rounded-2xl bg-black/[0.05] dark:bg-white/[0.06] p-1">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              'flex items-center justify-center gap-1.5 rounded-xl py-2 text-[13px] font-medium transition-all',
              tab === t.key ? 'bg-white dark:bg-zinc-800 text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {/* 概览 */}
      {tab === 'overview' && stats && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <StatCard icon={<MessageSquare className="h-4 w-4" />} label="聊天消息" value={String(stats.messages)} />
            <StatCard icon={<FileArchive className="h-4 w-4" />} label="聊天文件" value={`${stats.chatFiles} 个 · ${formatBytes(stats.chatBytes)}`} />
            <StatCard icon={<HardDrive className="h-4 w-4" />} label="网盘仓库" value={String(stats.driveRepos)} />
            <StatCard icon={<FileArchive className="h-4 w-4" />} label="网盘文件" value={`${stats.driveFiles} 个 · ${formatBytes(stats.driveBytes)}`} />
            <StatCard icon={<Users className="h-4 w-4" />} label="活跃会话" value={String(stats.sessions)} />
            <StatCard icon={<Clock className="h-4 w-4" />} label="运行时长" value={`${uptimeH} 小时 ${uptimeM} 分`} />
          </div>

          <div className="glass rounded-2xl border p-5">
            <h2 className="mb-3 text-sm font-bold flex items-center gap-1.5"><HardDrive className="h-4 w-4 text-primary" /> 网盘仓库列表</h2>
            {drives.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">暂无网盘仓库</p>
            ) : (
              <div className="space-y-2">
                {drives.map((d) => (
                  <div key={d.driveId} className="flex items-center gap-3 rounded-xl border bg-muted/40 px-3.5 py-2.5">
                    <span className="font-mono font-bold tracking-widest text-primary">{d.driveId}</span>
                    <div className="min-w-0 flex-1 text-xs text-muted-foreground">
                      <p>{formatBytes(d.usedBytes)} / {formatBytes(d.quotaBytes, 0)}</p>
                      <p>创建 {new Date(d.createdAt).toLocaleString('zh-CN')} · 活跃 {new Date(d.lastActiveAt).toLocaleString('zh-CN')}</p>
                    </div>
                    <div className="w-20 h-1.5 rounded-full bg-muted overflow-hidden shrink-0">
                      <div className="h-full grad-primary" style={{ width: `${Math.min(100, (d.usedBytes / d.quotaBytes) * 100)}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 一键自检 */}
      {tab === 'selfcheck' && (
        <SelfCheckPanel adminKeyHash={adminKeyHash!} onFixed={() => void refreshAll()} />
      )}

      {/* HTTPS 管理 */}
      {tab === 'https' && h && (
        <div className="space-y-4">
          {/* 当前状态 */}
          <div className="glass rounded-2xl border p-5">
            <h2 className="mb-3 text-sm font-bold flex items-center gap-1.5"><Globe className="h-4 w-4 text-primary" /> 当前证书状态（实时探测）</h2>
            {h.probe.available ? (
              <div className="space-y-2 text-sm">
                <Row label="协议" value={<span className="text-emerald-600 dark:text-emerald-400 font-medium">HTTPS ✓（网关 :{h.gatewayPort}）</span>} />
                <Row label="域名 / 模式" value={`${h.meta?.domain || h.probe.subject || '（未知）'} · ${MODE_LABEL[h.meta?.mode || 'none']}`} />
                <Row label="颁发者" value={h.probe.issuer || '-'} />
                <Row label="有效期至" value={h.probe.notAfter ? new Date(h.probe.notAfter).toLocaleString('zh-CN') : '-'} />
                <Row
                  label="剩余天数"
                  value={
                    <span className={cn('font-bold', (h.probe.daysLeft ?? 0) < 15 ? 'text-red-500' : (h.probe.daysLeft ?? 0) < 30 ? 'text-amber-500' : 'text-emerald-600 dark:text-emerald-400')}>
                      {h.probe.daysLeft} 天
                    </span>
                  }
                />
              </div>
            ) : (
              <div className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3.5 py-3 text-[13px] leading-relaxed text-amber-700 dark:text-amber-300">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  {h.probe.error || '网关未启用 TLS'}。当前站点以 HTTP 明文运行 —— 浏览器将禁用加密 API（WebCrypto），
                  <b>频道与网盘均无法使用，且通信可被中间人窃听</b>。请立即在下方绑定证书。
                </span>
              </div>
            )}
            {h.pending && (
              <div className="mt-3 rounded-xl border border-primary/25 bg-primary/5 px-3.5 py-2.5 text-xs">
                待应用配置：{h.pending.domain || '（自签）'} · {MODE_LABEL[h.pending.mode]}（{new Date(h.pending.requestedAt).toLocaleString('zh-CN')}）
              </div>
            )}
          </div>

          {/* 绑定/更换 */}
          <div className="glass rounded-2xl border p-5">
            <h2 className="mb-3 text-sm font-bold flex items-center gap-1.5"><Globe className="h-4 w-4 text-primary" /> 绑定 / 更换证书</h2>
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label className="text-[13px]">证书模式</Label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                  {(['acme-dns', 'self-signed'] as const).map((m) => (
                    <button
                      key={m}
                      onClick={() => setBindMode(m)}
                      className={cn(
                        'rounded-xl border px-3 py-2.5 text-left text-xs transition-colors',
                        bindMode === m ? 'border-primary/50 bg-primary/5' : 'hover:border-primary/30'
                      )}
                    >
                      <p className="font-semibold">{MODE_LABEL[m]}</p>
                      <p className="mt-0.5 leading-relaxed text-muted-foreground">{m === 'acme-dns' ? '需域名（A 记录指向本服务器）+ Cloudflare API Token，全自动签发续期，不占用 80/443' : '无需域名立即可用，浏览器首次访问需手动信任一次'}</p>
                    </button>
                  ))}
                </div>
              </div>
              {bindMode !== 'self-signed' && (
                <div className="space-y-1.5">
                  <Label htmlFor="bindDomain" className="text-[13px]">域名</Label>
                  <Input
                    id="bindDomain"
                    value={bindDomain}
                    onChange={(e) => setBindDomain(e.target.value)}
                    placeholder="例如 chat.example.com"
                    className="h-11 rounded-xl"
                  />
                </div>
              )}
              <Button onClick={doBind} className="w-full h-11 rounded-xl grad-primary text-white font-semibold">保存待应用配置</Button>
              {applyCommand && (
                <div className="rounded-xl border border-primary/25 bg-primary/5 p-3.5 space-y-2">
                  <p className="text-xs leading-relaxed text-muted-foreground">配置已保存。出于安全考虑（Web 进程不持有 root 权限），请在服务器终端执行以下命令完成证书签发并生效：</p>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 rounded-lg bg-black/80 dark:bg-black/60 px-3 py-2 text-xs text-emerald-400 font-mono overflow-x-auto">{applyCommand}</code>
                    <Button variant="outline" size="icon" className="h-9 w-9 rounded-lg shrink-0" onClick={copyCmd} aria-label="复制命令">
                      {copied ? <Check className="h-4 w-4 text-emerald-500" /> : <Copy className="h-4 w-4" />}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 维护 */}
      {tab === 'maintain' && (
        <div className="space-y-4">
          <div className="glass rounded-2xl border p-5 space-y-3">
            <h2 className="text-sm font-bold flex items-center gap-1.5"><Wrench className="h-4 w-4 text-primary" /> 常规维护</h2>
            <MaintainRow
              title="清理过期会话"
              desc="删除已过期的聊天/网盘会话记录（不影响在线用户与聊天记录）"
              onClick={() => void doMaintain('cleanup-sessions')}
            />
            <MaintainRow
              title="立即备份"
              desc="打包数据库 + 密文文件 + 配置到 /opt/cipherchat/backups/（建议定期下载到本地）"
              onClick={() => void doMaintain('backup')}
            />
          </div>
          <div className="glass rounded-2xl border p-5 space-y-3">
            <h2 className="text-sm font-bold flex items-center gap-1.5"><Activity className="h-4 w-4 text-primary" /> 一键修复（自检系统配套）</h2>
            <MaintainRow
              title="重算网盘占用"
              desc="以磁盘真实密文大小重写全部存储统计 —— 修复 v1.7.0 及之前版本「大文件占用被少记」的历史坏数据（如 150MB 显示 4MB），并清理磁盘已丢失的幽灵文件记录"
              onClick={() => void doMaintain('recalc-drive-usage')}
            />
            <MaintainRow
              title="清理孤儿文件"
              desc="删除磁盘上存在但数据库无记录的密文目录（上传中断/历史遗留），以及超 24 小时未完结的上传 —— 只释放空间，不影响正常文件"
              onClick={() => void doMaintain('cleanup-orphan-files')}
            />
            <MaintainRow
              title="整理数据库"
              desc="合并 WAL 日志并压缩数据库文件（在线安全执行，可回收空间、降低锁竞争）"
              onClick={() => void doMaintain('vacuum-db')}
            />
          </div>
          <div className="glass rounded-2xl border p-5 space-y-3">
            <h2 className="text-sm font-bold flex items-center gap-1.5"><Users className="h-4 w-4 text-primary" /> 会话管理</h2>
            <MaintainRow
              title="吊销全部会话"
              desc="强制所有设备重新验证（聊天与网盘的在线连接会被断开要求重新进入）"
              onClick={() => void doMaintain('revoke-sessions', '确定吊销全部会话吗？所有在线设备将被要求重新验证身份。')}
              danger
            />
          </div>
        </div>
      )}

      {/* 功能开关 */}
      {tab === 'features' && (
        <FeatureTogglePanel adminKeyHash={adminKeyHash} />
      )}

      {/* 语音中继 TURN */}
      {tab === 'voice' && (
        <VoiceRelayPanel adminKeyHash={adminKeyHash} />
      )}

      {/* 危险区 */}
      {tab === 'danger' && (
        <div className="glass rounded-2xl border border-red-500/30 p-5">
          <h2 className="mb-1 text-sm font-bold flex items-center gap-1.5 text-red-500"><Bomb className="h-4 w-4" /> 全局自毁</h2>
          <p className="mb-4 text-xs leading-relaxed text-muted-foreground">
            输入自毁密钥将<b className="text-red-500">立即且不可恢复地销毁服务器上全部聊天记录、文件与网盘数据</b>（含磁盘密文，吊销全部会话）。
            管理员配置会保留以防站点被重新抢占。此操作执行后无法撤销，请谨慎。
          </p>
          <div className="flex gap-2">
            <Input
              type="password"
              value={destroyKey}
              onChange={(e) => setDestroyKey(e.target.value)}
              placeholder="输入自毁密钥…"
              className="h-11 rounded-xl flex-1"
            />
            <Button
              variant="destructive"
              className="h-11 rounded-xl px-5 shrink-0"
              disabled={!destroyKey || !destroyArmed}
              onClick={() => void doDestroy()}
            >
              执行自毁
            </Button>
          </div>
          <label className="mt-3 flex items-center gap-2 text-xs text-muted-foreground select-none">
            <input type="checkbox" checked={destroyArmed} onChange={(e) => setDestroyArmed(e.target.checked)} className="accent-red-500" />
            我已知晓此操作不可恢复，将销毁所有数据
          </label>
        </div>
      )}
    </div>
  )
}

function StatCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="glass rounded-2xl border p-4">
      <span className="inline-grid h-8 w-8 place-items-center rounded-lg bg-primary/10 text-primary mb-2">{icon}</span>
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-sm font-bold truncate" title={value}>{value}</p>
    </div>
  )
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-black/5 dark:border-white/5 pb-1.5 last:border-0">
      <span className="text-xs text-muted-foreground shrink-0">{label}</span>
      <span className="text-xs text-right min-w-0 break-all">{value}</span>
    </div>
  )
}

function MaintainRow({ title, desc, onClick, danger }: { title: string; desc: string; onClick: () => void; danger?: boolean }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border bg-muted/40 px-3.5 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold">{title}</p>
        <p className="mt-0.5 text-[11.5px] leading-relaxed text-muted-foreground">{desc}</p>
      </div>
      <Button
        variant={danger ? 'destructive' : 'outline'}
        size="sm"
        className={cn('rounded-xl shrink-0', !danger && 'bg-card')}
        onClick={onClick}
      >
        执行
      </Button>
    </div>
  )
}

// ---------------- 功能开关子组件 ----------------
function FeatureTogglePanel({ adminKeyHash }: { adminKeyHash: string }) {
  const [flags, setFlags] = useState({
    voiceEnabled: true, whisperEnabled: true, friendEnabled: true,
    avatarUploadEnabled: true, p2pEnabled: true, allowHiddenGeo: true,
    dmsEnabled: false,
  })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await fetch('/api/admin/features')
      const d = await r.json()
      if (d?.ok && d.data) {
        setFlags({
          voiceEnabled: d.data.voiceEnabled !== false,
          whisperEnabled: d.data.whisperEnabled !== false,
          friendEnabled: d.data.friendEnabled !== false,
          avatarUploadEnabled: d.data.avatarUploadEnabled !== false,
          p2pEnabled: d.data.p2pEnabled !== false,
          allowHiddenGeo: d.data.allowHiddenGeo !== false,
          dmsEnabled: !!d.data.dmsEnabled,
        })
      }
    } catch { /* ignore */ }
    setLoading(false)
  }, [])

  useEffect(() => { void load() }, [load])

  const toggle = async (key: keyof typeof flags) => {
    if (!adminKeyHash) { toast.error('请先验证超级密钥'); return }
    const next = !flags[key]
    setFlags((f) => ({ ...f, [key]: next }))
    setSaving(key)
    try {
      const r = await fetch('/api/admin/features', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ adminKeyHash, [key]: next }),
      })
      const d = await r.json()
      if (d?.ok && d.data) {
        setFlags({
          voiceEnabled: d.data.voiceEnabled !== false,
          whisperEnabled: d.data.whisperEnabled !== false,
          friendEnabled: d.data.friendEnabled !== false,
          avatarUploadEnabled: d.data.avatarUploadEnabled !== false,
          p2pEnabled: d.data.p2pEnabled !== false,
          allowHiddenGeo: d.data.allowHiddenGeo !== false,
          dmsEnabled: !!d.data.dmsEnabled,
        })
      } else {
        toast.error(d?.error || '更新失败')
        setFlags((f) => ({ ...f, [key]: !next })) // 回滚
      }
    } catch {
      toast.error('网络错误')
      setFlags((f) => ({ ...f, [key]: !next }))
    } finally {
      setSaving(null)
    }
  }

  const items: { key: keyof typeof flags; label: string; desc: string; icon: React.ReactNode }[] = [
    { key: 'voiceEnabled', label: '语音频道', desc: 'Discord 风格的 P2P 语音开黑（WebRTC SRTP）', icon: <Mic className="h-4 w-4" /> },
    { key: 'whisperEnabled', label: '私聊功能', desc: '频道内点击他人头像发起端到端私聊（不留存）', icon: <MessageCircle className="h-4 w-4" /> },
    { key: 'friendEnabled', label: '好友系统', desc: '本地保存联系人列表、好友码导入/导出', icon: <UserRound className="h-4 w-4" /> },
    { key: 'avatarUploadEnabled', label: '自定义头像', desc: '允许用户上传头像（加密后随 presence 广播）', icon: <ImageIcon className="h-4 w-4" /> },
    { key: 'p2pEnabled', label: 'P2P 直连', desc: '文字消息尝试走 WebRTC DataChannel，绕过服务器存储', icon: <Network className="h-4 w-4" /> },
    { key: 'allowHiddenGeo', label: '允许隐藏 IP 归属（v1.4.3）', desc: '开放后普通用户加入频道时可选择「不披露任何 IP/地区」；关闭则该选项对用户不可见且服务端强制回退完整披露', icon: <EyeOff className="h-4 w-4" /> },
    { key: 'dmsEnabled', label: '死人开关（v1.5.0）', desc: '默认隐藏。开放后所有用户的「安全审计」页会出现 DMS 布防面板：连续 N 天无活动自动通知或触发全局自毁', icon: <Skull className="h-4 w-4" /> },
  ]

  if (loading) {
    return (
      <div className="glass rounded-2xl border p-8 flex items-center justify-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> 加载功能开关…
      </div>
    )
  }

  return (
    <div className="glass rounded-2xl border p-5 space-y-4">
      <div>
        <h2 className="mb-1 text-sm font-bold flex items-center gap-1.5">
          <ToggleLeft className="h-4 w-4 text-primary" /> 功能开关
        </h2>
        <p className="text-xs leading-relaxed text-muted-foreground">
          管理员可独立开启/关闭语音、私聊、好友、头像、P2P 五项功能。关闭后客户端对应入口自动隐藏。
          切换不影响已建立的会话与历史数据；客户端下次拉取配置（刷新或重新进入频道）后生效。
        </p>
      </div>
      <div className="space-y-2">
        {items.map((it) => (
          <div key={it.key} className="flex items-center gap-3 rounded-xl border bg-muted/40 px-3.5 py-3">
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
              {it.icon}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-semibold">{it.label}</p>
              <p className="mt-0.5 text-[11.5px] leading-relaxed text-muted-foreground">{it.desc}</p>
            </div>
            <button
              role="switch"
              aria-checked={flags[it.key]}
              disabled={saving === it.key}
              onClick={() => void toggle(it.key)}
              className={cn(
                'relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors disabled:opacity-50',
                flags[it.key] ? 'grad-primary' : 'bg-muted-foreground/25',
              )}
              title={flags[it.key] ? '已开启' : '已关闭'}
            >
              <span
                className={cn(
                  'inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform',
                  flags[it.key] ? 'translate-x-6' : 'translate-x-1',
                )}
              />
            </button>
          </div>
        ))}
      </div>
      <p className="text-[10.5px] leading-relaxed text-muted-foreground/80">
        注：所有功能开关默认全部开启；管理员未初始化时使用默认值。客户端每次拉取 /api/config 时同步最新状态。
      </p>
    </div>
  )
}

// ---------------- 语音中继 TURN 子组件 ----------------
function VoiceRelayPanel({ adminKeyHash }: { adminKeyHash: string }) {
  const [meta, setMeta] = useState<{
    enabled: boolean
    hasUrl: boolean
    hasUsername: boolean
    hasCredential: boolean
    secretMode: string
    serverCount: number
  } | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  // 表单字段
  const [turnEnabled, setTurnEnabled] = useState(false)
  const [turnUrls, setTurnUrls] = useState('')
  const [turnUsername, setTurnUsername] = useState('')
  const [turnCredential, setTurnCredential] = useState('')
  const [turnSecretMode, setTurnSecretMode] = useState<'static' | 'time-limited'>('static')

  // 一键安装脚本提示
  const [showInstallCmd, setShowInstallCmd] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await fetch('/api/admin/features')
      const d = await r.json()
      if (d?.ok && d.data?.turn) {
        const t = d.data.turn
        setMeta(t)
        setTurnEnabled(t.enabled)
        setTurnSecretMode(t.secretMode === 'time-limited' ? 'time-limited' : 'static')
        // 注意：GET 不返回明文凭证，仅显示是否已配置
      }
    } catch { /* ignore */ }
    setLoading(false)
  }, [])

  useEffect(() => { void load() }, [load])

  const save = async () => {
    if (!adminKeyHash) { toast.error('请先验证超级密钥'); return }
    setSaving(true)
    try {
      const body: Record<string, unknown> = { adminKeyHash, turnEnabled }
      // 仅在用户填了内容时才提交（避免覆盖已有凭证为空）
      if (turnUrls) body.turnUrls = turnUrls
      if (turnUsername) body.turnUsername = turnUsername
      if (turnCredential) body.turnCredential = turnCredential
      body.turnSecretMode = turnSecretMode
      const r = await fetch('/api/admin/features', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const d = await r.json()
      if (d?.ok) {
        toast.success('TURN 配置已保存')
        // 清空表单凭证字段（避免误以为已显示）
        setTurnUrls('')
        setTurnUsername('')
        setTurnCredential('')
        await load()
      } else {
        toast.error(d?.error || '保存失败')
      }
    } catch {
      toast.error('网络错误')
    } finally {
      setSaving(false)
    }
  }

  const installCmd = 'sudo bash /opt/cipherchat/deploy/turn-install.sh'

  const copyInstallCmd = async () => {
    try {
      await navigator.clipboard.writeText(installCmd)
      toast.success('安装命令已复制到剪贴板')
    } catch { /* ignore */ }
  }

  if (loading) {
    return (
      <div className="glass rounded-2xl border p-8 flex items-center justify-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> 加载语音中继配置…
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* 状态卡 */}
      <div className="glass rounded-2xl border p-5">
        <h2 className="mb-3 text-sm font-bold flex items-center gap-1.5">
          <Server className="h-4 w-4 text-primary" /> TURN 中继状态
        </h2>
        <div className="space-y-2 text-sm">
          <Row
            label="启用状态"
            value={
              <span className={cn('font-bold', meta?.enabled ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500')}>
                {meta?.enabled ? '已启用 ✓' : '未启用 ✗'}
              </span>
            }
          />
          <Row label="TURN 服务器" value={`${meta?.serverCount ?? 0} 个`} />
          <Row label="凭证模式" value={meta?.secretMode === 'time-limited' ? '短期凭证（HMAC-SHA1，1h 过期）' : '长期凭证（静态）'} />
          <Row label="用户名" value={meta?.hasUsername ? '已配置' : '未配置'} />
          <Row label="密码 / HMAC 密钥" value={meta?.hasCredential ? '已配置（不显示）' : '未配置'} />
        </div>
        {!meta?.enabled && (
          <div className="mt-3 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3.5 py-3 text-[13px] leading-relaxed text-amber-700 dark:text-amber-300">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              <b>未启用 TURN 时语音大概率失败：</b>STUN 只能穿透 cone NAT，对运营商 CGNAT / 对称 NAT / 公司防火墙无效。
              国内手机用户跨运营商通话几乎必然连不上，且失败时无任何提示。强烈建议运行下方「一键安装 coturn」脚本。
            </span>
          </div>
        )}
      </div>

      {/* 一键安装 coturn */}
      <div className="glass rounded-2xl border p-5">
        <h2 className="mb-2 text-sm font-bold flex items-center gap-1.5">
          <ShieldCheck className="h-4 w-4 text-emerald-500" /> 一键安装 coturn（自托管 TURN）
        </h2>
        <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
          与项目自托管理念一致 —— coturn 部署在本机，由 root 用户安装，自动生成凭证并写入本面板。
          音频不经过任何第三方服务器。安装约 1 分钟，端口需开放 <code className="bg-muted/60 px-1 rounded">3478/5349 UDP+TCP</code>。
        </p>
        <div className="flex items-center gap-2">
          <code className="flex-1 rounded-lg bg-black/80 dark:bg-black/60 px-3 py-2 text-xs text-emerald-400 font-mono overflow-x-auto">
            {installCmd}
          </code>
          <Button variant="outline" size="icon" className="h-9 w-9 rounded-lg shrink-0" onClick={copyInstallCmd} aria-label="复制命令">
            <Copy className="h-4 w-4" />
          </Button>
        </div>
        <button
          onClick={() => setShowInstallCmd((v) => !v)}
          className="mt-2 text-[11px] text-primary hover:underline"
        >
          {showInstallCmd ? '隐藏' : '查看'}手动安装步骤
        </button>
        {showInstallCmd && (
          <pre className="mt-2 rounded-lg bg-muted/60 p-3 text-[10.5px] leading-relaxed text-muted-foreground overflow-x-auto">
{`# 1. 在服务器终端执行（root）：
sudo bash /opt/cipherchat/deploy/turn-install.sh

# 2. 脚本会自动：
#    - apt install coturn
#    - 生成 32 字节随机静态凭证 + 长期用户名 cipherchat
#    - 写入 /etc/turnserver.conf（含 use-auth-secret 与 listening-port=3478）
#    - 启动 coturn systemd 服务
#    - 把凭证写入数据库 AdminConfig 表（turnEnabled=true）

# 3. 防火墙开放端口：
#    - 3478/UDP + 3478/TCP（必开）
#    - 5349/UDP + 5349/TCP（TLS over TCP，可选）
#    - 49152-65535/UDP（relay 端口范围，coturn 默认）

# 4. 回到此面板点击「刷新」即可看到状态变为已启用`}
          </pre>
        )}
      </div>

      {/* 手动配置表单 */}
      <div className="glass rounded-2xl border p-5">
        <h2 className="mb-3 text-sm font-bold flex items-center gap-1.5">
          <Server className="h-4 w-4 text-primary" /> 手动配置 TURN 服务器
        </h2>
        <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
          若已在外部部署 coturn / OpenRelay / Twilio NTS 等 TURN 服务，可直接在此填写。多个 URL 用换行或逗号分隔。
        </p>
        <div className="space-y-3">
          {/* 启用开关 */}
          <div className="flex items-center justify-between gap-3 rounded-xl border bg-muted/40 px-3.5 py-3">
            <div>
              <p className="text-[13px] font-semibold flex items-center gap-1.5">
                <Zap className="h-3.5 w-3.5 text-primary" /> 启用 TURN 中继
              </p>
              <p className="mt-0.5 text-[11.5px] leading-relaxed text-muted-foreground">关闭时仅 STUN，对称 NAT 下大概率失败</p>
            </div>
            <button
              role="switch"
              aria-checked={turnEnabled}
              disabled={saving}
              onClick={() => setTurnEnabled((v) => !v)}
              className={cn(
                'relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors disabled:opacity-50',
                turnEnabled ? 'grad-primary' : 'bg-muted-foreground/25',
              )}
              title={turnEnabled ? '已开启' : '已关闭'}
            >
              <span className={cn('inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform', turnEnabled ? 'translate-x-6' : 'translate-x-1')} />
            </button>
          </div>

          {/* 凭证模式 */}
          <div className="space-y-1.5">
            <Label className="text-[13px]">凭证模式</Label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
              <button
                type="button"
                onClick={() => setTurnSecretMode('static')}
                className={cn(
                  'rounded-xl border px-3 py-2.5 text-left text-xs transition-colors',
                  turnSecretMode === 'static' ? 'border-primary/50 bg-primary/5' : 'hover:border-primary/30',
                )}
              >
                <p className="font-semibold">长期凭证（静态）</p>
                <p className="mt-0.5 leading-relaxed text-muted-foreground">用户名 + 密码长期有效；coturn 配置 user:realm:password</p>
              </button>
              <button
                type="button"
                onClick={() => setTurnSecretMode('time-limited')}
                className={cn(
                  'rounded-xl border px-3 py-2.5 text-left text-xs transition-colors',
                  turnSecretMode === 'time-limited' ? 'border-primary/50 bg-primary/5' : 'hover:border-primary/30',
                )}
              >
                <p className="font-semibold">短期凭证（HMAC）</p>
                <p className="mt-0.5 leading-relaxed text-muted-foreground">1 小时过期，更安全；coturn 配置 use-auth-secret + static-auth-secret</p>
              </button>
            </div>
          </div>

          {/* TURN URL 列表 */}
          <div className="space-y-1.5">
            <Label htmlFor="turnUrls" className="text-[13px]">TURN 服务器 URL（多个用换行或逗号分隔）</Label>
            <textarea
              id="turnUrls"
              value={turnUrls}
              onChange={(e) => setTurnUrls(e.target.value)}
              placeholder={'turn:example.com:3478?transport=udp\nturn:example.com:3478?transport=tcp\nturns:example.com:5349'}
              className="w-full min-h-[80px] rounded-xl border bg-card px-3 py-2 text-xs font-mono resize-y"
              rows={3}
            />
            <p className="text-[10.5px] text-muted-foreground">
              留空保存则保留现有 URL 不变；填入新值会覆盖。当前已配置 {meta?.serverCount ?? 0} 个服务器。
            </p>
          </div>

          {/* 用户名 */}
          <div className="space-y-1.5">
            <Label htmlFor="turnUsername" className="text-[13px]">
              {turnSecretMode === 'static' ? '用户名（长期凭证）' : 'HMAC 共享密钥（Static Auth Secret）'}
            </Label>
            <Input
              id="turnUsername"
              type="text"
              value={turnUsername}
              onChange={(e) => setTurnUsername(e.target.value)}
              placeholder={meta?.hasUsername ? '已配置（不显示，留空保留）' : '例如 cipherchat'}
              className="h-11 rounded-xl font-mono"
            />
          </div>

          {/* 密码 / 密钥 */}
          <div className="space-y-1.5">
            <Label htmlFor="turnCredential" className="text-[13px]">
              {turnSecretMode === 'static' ? '密码（长期凭证）' : 'HMAC 密钥（与 coturn static-auth-secret 一致）'}
            </Label>
            <Input
              id="turnCredential"
              type="password"
              value={turnCredential}
              onChange={(e) => setTurnCredential(e.target.value)}
              placeholder={meta?.hasCredential ? '已配置（不显示，留空保留）' : '至少 16 位随机字符串'}
              className="h-11 rounded-xl font-mono"
            />
          </div>

          <Button onClick={save} disabled={saving} className="w-full h-11 rounded-xl grad-primary text-white font-semibold">
            {saving ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> 保存中…</> : '保存 TURN 配置'}
          </Button>
        </div>
      </div>

      {/* 客户端感知提示 */}
      <div className="glass rounded-2xl border p-5">
        <h2 className="mb-2 text-sm font-bold flex items-center gap-1.5">
          <Radio className="h-4 w-4 text-primary" /> 客户端感知
        </h2>
        <p className="text-xs leading-relaxed text-muted-foreground">
          保存后，客户端下次拉取 <code className="bg-muted/60 px-1 rounded">/api/config</code> 时同步生效；
          正在通话中的客户端需重新进入频道才能使用新 TURN。
          短期凭证模式下，客户端每小时轮询 <code className="bg-muted/60 px-1 rounded">/api/voice/turn-credentials</code> 自动刷新。
        </p>
      </div>
    </div>
  )
}
