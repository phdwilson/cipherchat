'use client'
// v1.5.0 安全审计页（/security）—— 用户侧透明化
// 展示：活跃会话（可吊销）/ 我的邀请 / 频道角色 / 离线信箱身份 / DMS 状态
import { useCallback, useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { toast } from 'sonner'
import {
  ShieldCheck, Loader2, ArrowLeft, MonitorSmartphone, LogOut, Link2, Skull,
  Mailbox, RefreshCw, EyeOff,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  fetchAudit, revokeSession, armDms, disarmDms, fetchDmsStatus,
  registerMailboxIdentity,
  type AuditData, type DmsStatus,
} from '@/lib/security'

function readToken(): string | null {
  try { return sessionStorage.getItem('cipherchat:audit-token') || null } catch { return null }
}

export default function SecurityPage() {
  const [token, setToken] = useState<string | null>(null)
  const [tokenInput, setTokenInput] = useState('')
  const [data, setData] = useState<AuditData | null>(null)
  const [dms, setDms] = useState<DmsStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // DMS 设置表单
  const [dmsDays, setDmsDays] = useState(7)
  const [dmsAction, setDmsAction] = useState<'notify' | 'wipe'>('notify')
  const [dmsTarget, setDmsTarget] = useState('')

  const load = useCallback(async (t: string) => {
    setLoading(true)
    setErr(null)
    try {
      const [a, d] = await Promise.all([fetchAudit(t), fetchDmsStatus(t).catch(() => null)])
      setData(a)
      setDms(d)
    } catch (e) {
      setErr(e instanceof Error ? e.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const t = readToken()
    if (t) { setToken(t); void load(t) }
  }, [load])

  const submitToken = () => {
    if (tokenInput.trim().length >= 32) {
      try { sessionStorage.setItem('cipherchat:audit-token', tokenInput.trim()) } catch { /* ignore */ }
      setToken(tokenInput.trim())
      void load(tokenInput.trim())
    } else {
      toast.error('请粘贴完整的会话令牌（64 位十六进制）')
    }
  }

  const doRevoke = async (sid: string) => {
    if (!token) return
    try {
      await revokeSession(token, sid)
      toast.success('会话已吊销')
      void load(token)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '吊销失败')
    }
  }

  const doRegisterIdentity = async () => {
    if (!token) return
    try {
      await registerMailboxIdentity(token)
      toast.success('离线信箱身份已注册')
      void load(token)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '注册失败')
    }
  }

  const doArmDms = async () => {
    if (!token) return
    try {
      await armDms(token, dmsDays, dmsAction, dmsAction === 'notify' ? dmsTarget : undefined)
      toast.success('死人开关已布防')
      void load(token)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '布防失败')
    }
  }

  const doDisarmDms = async () => {
    if (!token) return
    try {
      await disarmDms(token)
      toast.message('死人开关已撤防')
      void load(token)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '撤防失败')
    }
  }

  return (
    <div className="min-h-[100dvh]">
      <header className="glass sticky top-0 z-40 border-b px-4 sm:px-6 py-3">
        <div className="mx-auto max-w-3xl flex items-center gap-3">
          <Button variant="ghost" size="icon" className="h-9 w-9 rounded-xl" onClick={() => window.close()} aria-label="关闭">
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="flex items-center gap-2 text-lg font-bold"><ShieldCheck className="h-5 w-5 text-primary" /> 安全审计</h1>
            <p className="text-[11px] text-muted-foreground">你的隐私状态，完全透明 —— 数据仅本人可见</p>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 sm:px-6 py-6 space-y-5">
        {/* 未解锁：需要会话 token */}
        {!token && (
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="glass rounded-2xl border p-6">
            <h2 className="mb-1 font-bold">验证身份</h2>
            <p className="mb-4 text-xs leading-relaxed text-muted-foreground">
              粘贴你的会话令牌以查看审计数据。令牌可在聊天页控制台通过 <code>/token</code> 指令获取，
              仅保存在本标签页（sessionStorage），关闭即清除。
            </p>
            <div className="flex gap-2">
              <Input value={tokenInput} onChange={(e) => setTokenInput(e.target.value)} placeholder="粘贴会话令牌…" className="font-mono text-[11px]" type="password" />
              <Button onClick={submitToken} disabled={loading}>查看</Button>
            </div>
            {err && <p className="mt-3 rounded-xl bg-red-500/10 px-3 py-2 text-[12.5px] text-red-600">{err}</p>}
          </motion.div>
        )}

        {loading && !data && (
          <div className="flex items-center justify-center gap-2 py-16 text-muted-foreground">
            <Loader2 className="h-6 w-6 animate-spin" /> 加载中…
          </div>
        )}

        {data && (
          <>
            {/* 身份卡 */}
            <section className="glass rounded-2xl border p-5">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs text-muted-foreground">我的设备标识</p>
                  <p className="font-mono text-sm font-semibold select-text">{data.me.pubId}</p>
                </div>
                <Button variant="outline" size="sm" className="rounded-xl gap-1.5" onClick={() => token && void load(token)}>
                  <RefreshCw className="h-3.5 w-3.5" /> 刷新
                </Button>
              </div>
              <div className="mt-3 flex items-center gap-2 rounded-xl bg-muted/60 px-3 py-2 text-[12px]">
                <Mailbox className="h-4 w-4 shrink-0 text-primary" />
                {data.identityRegistered ? '离线信箱身份已注册（公钥已在服务器）' : (
                  <>
                    <span className="flex-1">离线信箱未启用 —— 注册后他人可给你留离线消息</span>
                    <Button size="sm" variant="outline" className="h-7 rounded-lg text-[11px]" onClick={doRegisterIdentity}>注册</Button>
                  </>
                )}
              </div>
            </section>

            {/* 活跃会话 */}
            <section className="glass rounded-2xl border p-5">
              <h2 className="mb-1 flex items-center gap-2 text-sm font-bold"><MonitorSmartphone className="h-4 w-4 text-primary" /> 活跃会话（{data.sessions.length}）</h2>
              <p className="mb-3 text-[11px] text-muted-foreground">所有正在使用你身份的登录。发现陌生设备？立即吊销。</p>
              <ul className="space-y-2">
                {data.sessions.map((s) => (
                  <li key={s.id} className="flex items-center gap-3 rounded-xl border bg-muted/40 px-3.5 py-2.5 text-[12.5px]">
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold">
                        {s.device}
                        {s.isCurrent && <span className="ml-2 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-600">当前设备</span>}
                      </p>
                      <p className="mt-0.5 text-[11px] text-muted-foreground">
                        IP：{s.ip} · 最近活动 {new Date(s.lastSeenAt).toLocaleString('zh-CN')}
                      </p>
                    </div>
                    {!s.isCurrent && (
                      <Button size="sm" variant="outline" className="h-8 shrink-0 rounded-xl gap-1 text-red-600 hover:bg-red-500/10" onClick={() => doRevoke(s.id)}>
                        <LogOut className="h-3.5 w-3.5" /> 吊销
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </section>

            {/* 我的邀请 */}
            <section className="glass rounded-2xl border p-5">
              <h2 className="mb-1 flex items-center gap-2 text-sm font-bold"><Link2 className="h-4 w-4 text-primary" /> 我创建的邀请（{data.invites.length}）</h2>
              <p className="mb-3 text-[11px] text-muted-foreground">过期后自动失效；次数用尽即作废。</p>
              {data.invites.length === 0 ? (
                <p className="py-3 text-center text-[12px] text-muted-foreground">暂无活跃邀请</p>
              ) : (
                <ul className="space-y-1.5">
                  {data.invites.map((i) => (
                    <li key={i.code} className="flex items-center gap-3 rounded-xl border bg-muted/40 px-3.5 py-2 text-[12px]">
                      <code className="font-mono font-semibold">{i.code}</code>
                      <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] text-primary">{i.role}</span>
                      <span className="text-muted-foreground">{i.maxUses > 0 ? `${i.uses}/${i.maxUses} 次` : '不限次'}</span>
                      <span className="ml-auto text-[10.5px] text-muted-foreground">{new Date(i.expiresAt).toLocaleString('zh-CN')} 到期</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* Dead Man's Switch（仅管理员开放时显示） */}
            {dms?.enabled && (
              <section className="glass rounded-2xl border p-5">
                <h2 className="mb-1 flex items-center gap-2 text-sm font-bold">
                  <Skull className="h-4 w-4 text-red-500" /> 死人开关（Dead Man&apos;s Switch）
                </h2>
                <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">
                  连续 N 天没有任何登录活动时自动执行：<b>notify</b> 向指定信箱投递提醒，或 <b>wipe</b> 触发全局自毁。
                  每次正常使用都会自动续期。请谨慎选择 wipe。
                </p>
                {dms.armed && (
                  <div className="mb-3 flex items-center gap-2 rounded-xl bg-red-500/10 px-3 py-2 text-[12px] text-red-600 dark:text-red-400">
                    <EyeOff className="h-4 w-4 shrink-0" />
                    已布防：{dms.armed.graceDays} 天无活动 → {dms.armed.action === 'wipe' ? '全局自毁' : '通知'}
                    （截止 {new Date(dms.armed.deadline).toLocaleDateString('zh-CN')}）
                    <Button size="sm" variant="outline" className="ml-auto h-7 rounded-lg text-[11px]" onClick={doDisarmDms}>撤防</Button>
                  </div>
                )}
                {!dms.armed && (
                  <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <Label className="text-xs font-semibold">宽限期（天）</Label>
                        <Input type="number" min={1} max={365} value={dmsDays} onChange={(e) => setDmsDays(Math.min(Math.max(Number(e.target.value) || 1, 1), 365))} className="h-9 rounded-xl" />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs font-semibold">触发动作</Label>
                        <div className="flex gap-1.5">
                          <button onClick={() => setDmsAction('notify')} className={`flex-1 rounded-xl border px-2 py-2 text-[11.5px] font-semibold ${dmsAction === 'notify' ? 'border-primary bg-primary/10 text-primary' : ''}`}>通知</button>
                          <button onClick={() => setDmsAction('wipe')} className={`flex-1 rounded-xl border px-2 py-2 text-[11.5px] font-semibold ${dmsAction === 'wipe' ? 'border-red-500 bg-red-500/10 text-red-500' : ''}`}>自毁</button>
                        </div>
                      </div>
                    </div>
                    {dmsAction === 'notify' && (
                      <div className="space-y-1.5">
                        <Label className="text-xs font-semibold">通知收件人（对方设备标识 pubId）</Label>
                        <Input value={dmsTarget} onChange={(e) => setDmsTarget(e.target.value)} placeholder="对方的设备 ID…" className="h-9 rounded-xl font-mono text-[11px]" />
                      </div>
                    )}
                    <Button onClick={doArmDms} className={`h-10 w-full rounded-xl font-semibold ${dmsAction === 'wipe' ? 'bg-red-600 hover:bg-red-700' : 'grad-primary'}`}>
                      布防死人开关
                    </Button>
                  </div>
                )}
              </section>
            )}
          </>
        )}
      </main>
    </div>
  )
}
