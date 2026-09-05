'use client'
// v1.8.0 管理员一键自检面板：真实世界测试 + 失败原因 + 一键修复 + 傻瓜化教程
// 设计目标：管理员不需要懂技术 —— 点一下，看红绿灯，红灯点「一键修复」，照教程兜底。
import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { toast } from 'sonner'
import {
  Loader2, CheckCircle2, AlertTriangle, XCircle, ChevronDown, Wrench, RefreshCw,
  Activity, FileDown, TerminalSquare, RotateCw,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { explainError, errorToastDescription } from '@/lib/errors'

type CheckStatus = 'ok' | 'warn' | 'fail'

interface CheckFix {
  label: string
  action: string
  guide: string[]
}

interface CheckResult {
  id: string
  name: string
  category: string
  status: CheckStatus
  ms: number
  summary: string
  detail?: string
  metrics?: Record<string, string | number>
  fix?: CheckFix
}

interface SelfCheckReport {
  generatedAt: string
  durationMs: number
  summary: { ok: number; warn: number; fail: number }
  results: CheckResult[]
}

const STATUS_META: Record<CheckStatus, { icon: React.ReactNode; cls: string; label: string }> = {
  ok: { icon: <CheckCircle2 className="h-4 w-4" />, cls: 'text-emerald-600 dark:text-emerald-400', label: '正常' },
  warn: { icon: <AlertTriangle className="h-4 w-4" />, cls: 'text-amber-500', label: '注意' },
  fail: { icon: <XCircle className="h-4 w-4" />, cls: 'text-red-500', label: '故障' },
}

export function SelfCheckPanel({ adminKeyHash, onFixed }: { adminKeyHash: string; onFixed?: () => void }) {
  const [report, setReport] = useState<SelfCheckReport | null>(null)
  const [running, setRunning] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [fixing, setFixing] = useState<string | null>(null)

  const runCheck = async (checks?: string[]) => {
    if (running) return
    setRunning(true)
    setExpanded(null)
    try {
      const res = await fetch('/api/admin/selfcheck', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ adminKeyHash, ...(checks ? { checks } : {}) }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data?.error || `自检请求失败（HTTP ${res.status}）`)
      }
      setReport(data as SelfCheckReport)
      const { ok, warn, fail } = (data as SelfCheckReport).summary
      if (fail > 0) toast.error(`自检完成：${fail} 项故障需要处理`, { description: `另有 ${warn} 项注意、${ok} 项正常。请按红灯项的「一键修复」处理。` })
      else if (warn > 0) toast.warning(`自检完成：${warn} 项建议关注`, { description: `${ok} 项全部正常，无故障。` })
      else toast.success(`自检完成：${ok} 项全部正常 ✓`, { description: `耗时 ${(data as SelfCheckReport).durationMs / 1000 < 1 ? '<1' : Math.round((data as SelfCheckReport).durationMs / 1000)} 秒` })
    } catch (e) {
      const ex = explainError(e, '一键自检')
      toast.error(ex.title, { description: errorToastDescription(ex) })
    } finally {
      setRunning(false)
    }
  }

  const applyFix = async (r: CheckResult) => {
    if (!r.fix || fixing) return
    setFixing(r.id)
    try {
      const res = await fetch('/api/admin/maintenance', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ adminKeyHash, action: r.fix.action }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error || `修复动作失败（HTTP ${res.status}）`)
      toast.success(r.fix.label + ' 已执行', { description: data?.message || '完成' })
      // 修复后自动复查这一项
      await runCheck([r.id])
      onFixed?.()
    } catch (e) {
      const ex = explainError(e, '一键修复')
      toast.error(ex.title, { description: errorToastDescription(ex) })
    } finally {
      setFixing(null)
    }
  }

  const exportReport = () => {
    if (!report) return
    try {
      const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `cipherchat-selfcheck-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`
      a.click()
      URL.revokeObjectURL(url)
      toast.success('自检报告已导出')
    } catch {
      toast.error('报告导出失败')
    }
  }

  // 按分类分组
  const groups = report
    ? Object.entries(report.results.reduce<Record<string, CheckResult[]>>((acc, r) => {
        ;(acc[r.category] ||= []).push(r)
        return acc
      }, {}))
    : []

  const allPass = report && report.summary.fail === 0 && report.summary.warn === 0

  return (
    <div className="space-y-4">
      {/* 主操作区 */}
      <div className="glass rounded-2xl border p-5">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <h2 className="text-sm font-bold flex items-center gap-1.5">
              <Activity className="h-4 w-4 text-primary" /> 一键自检
            </h2>
            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground max-w-lg">
              真实世界测试：不是读状态，而是<b>真的</b>走一遍 网盘建仓→分块上传→完结→下载→逐字节比对→清理，
              并核查数据库/磁盘/中继/TURN/证书/备份 共 12 项。发现故障会给出原因、一键修复动作和分步教程。
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {report && (
              <Button variant="outline" size="sm" className="rounded-xl gap-1.5" onClick={exportReport}>
                <FileDown className="h-4 w-4" /> 导出报告
              </Button>
            )}
            <Button
              size="sm"
              className="rounded-xl gap-1.5 grad-primary shadow-lg shadow-violet-500/25"
              onClick={() => void runCheck()}
              disabled={running}
            >
              {running ? <Loader2 className="h-4 w-4 animate-spin" /> : report ? <RotateCw className="h-4 w-4" /> : <Activity className="h-4 w-4" />}
              {running ? '检测中…（含真实磁盘与网络 IO）' : report ? '重新自检' : '一键自检'}
            </Button>
          </div>
        </div>

        {/* 汇总 */}
        {report && (
          <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
            <span className={cn('rounded-full px-2.5 py-1 font-medium', allPass ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' : 'bg-red-500/10 text-red-600 dark:text-red-400')}>
              {report.summary.fail > 0 ? `${report.summary.fail} 项故障` : allPass ? '全部正常 ✓' : '无故障'}
            </span>
            {report.summary.warn > 0 && <span className="rounded-full px-2.5 py-1 font-medium bg-amber-500/15 text-amber-600 dark:text-amber-400">{report.summary.warn} 项注意</span>}
            <span className="rounded-full px-2.5 py-1 font-medium bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">{report.summary.ok} 项正常</span>
            <span className="text-muted-foreground">· 耗时 {(report.durationMs / 1000).toFixed(1)}s · {new Date(report.generatedAt).toLocaleString('zh-CN')}</span>
          </div>
        )}
      </div>

      {/* 结果列表 */}
      {groups.map(([category, items]) => (
        <div key={category} className="glass rounded-2xl border p-5">
          <h3 className="mb-3 text-xs font-bold uppercase tracking-wide text-muted-foreground">{category}</h3>
          <div className="space-y-2">
            {items.map((r) => {
              const meta = STATUS_META[r.status]
              const open = expanded === r.id
              const hasFixInfo = !!(r.fix || r.detail || r.metrics)
              return (
                <div key={r.id} className={cn('rounded-xl border transition-colors', r.status === 'fail' ? 'border-red-500/40 bg-red-500/[0.04]' : r.status === 'warn' ? 'border-amber-500/30 bg-amber-500/[0.03]' : 'bg-muted/30')}>
                  <button
                    className="w-full flex items-center gap-3 px-3.5 py-3 text-left"
                    onClick={() => setExpanded(hasFixInfo ? (open ? null : r.id) : null)}
                  >
                    <span className={cn('shrink-0', meta.cls)}>{meta.icon}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[13px] font-semibold">{r.name}</span>
                        <span className={cn('text-[10px] rounded-full px-1.5 py-0.5 font-medium', meta.cls)}>{meta.label}</span>
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground leading-relaxed">{r.summary}</p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {r.fix?.action && (
                        <Button
                          size="sm"
                          variant={r.status === 'fail' ? 'destructive' : 'outline'}
                          className="rounded-lg gap-1 h-8 text-xs"
                          disabled={fixing === r.id}
                          onClick={(e) => { e.stopPropagation(); void applyFix(r) }}
                        >
                          {fixing === r.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wrench className="h-3.5 w-3.5" />}
                          {fixing === r.id ? '修复中…' : r.fix.label}
                        </Button>
                      )}
                      {hasFixInfo && <ChevronDown className={cn('h-4 w-4 text-muted-foreground transition-transform', open && 'rotate-180')} />}
                    </div>
                  </button>

                  <AnimatePresence>
                    {open && hasFixInfo && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.18 }}
                        className="overflow-hidden"
                      >
                        <div className="px-3.5 pb-3.5 pt-1 space-y-3 border-t border-border/40">
                          {r.metrics && (
                            <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5 pt-2">
                              {Object.entries(r.metrics).map(([k, v]) => (
                                <div key={k} className="rounded-lg bg-muted/50 px-2.5 py-1.5">
                                  <p className="text-[10px] text-muted-foreground">{k}</p>
                                  <p className="text-[11px] font-mono truncate" title={String(v)}>{String(v)}</p>
                                </div>
                              ))}
                            </div>
                          )}
                          {r.detail && (
                            <pre className="whitespace-pre-wrap text-[11px] leading-relaxed text-muted-foreground bg-muted/40 rounded-lg p-2.5 font-mono">{r.detail}</pre>
                          )}
                          {r.fix && (
                            <div className="rounded-lg bg-primary/[0.05] border border-primary/20 p-3">
                              <p className="text-xs font-semibold flex items-center gap-1.5 mb-1.5">
                                <Wrench className="h-3.5 w-3.5 text-primary" /> 修复方式
                              </p>
                              <ol className="list-decimal list-inside space-y-1 text-[11px] leading-relaxed text-muted-foreground">
                                {r.fix.guide.map((g, i) => <li key={i}>{g}</li>)}
                              </ol>
                            </div>
                          )}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              )
            })}
          </div>
        </div>
      ))}

      {/* 空状态提示 */}
      {!report && !running && (
        <div className="glass rounded-2xl border p-8 text-center">
          <Activity className="h-10 w-10 mx-auto text-primary/50 mb-3" />
          <p className="text-sm font-medium">尚未运行过自检</p>
          <p className="mt-1 text-xs text-muted-foreground">点击上方「一键自检」，约 5~15 秒完成全部真实世界测试</p>
        </div>
      )}

      {/* CLI 提示 */}
      <div className="glass rounded-2xl border p-4 flex items-start gap-3">
        <TerminalSquare className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
        <div className="text-xs text-muted-foreground leading-relaxed">
          <p className="font-medium text-foreground">终端党 / 无法进后台时</p>
          <p className="mt-0.5">SSH 到服务器执行：<code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">bun scripts/doctor.mjs --key 超级密钥</code></p>
          <p>支持一键修复全部问题（<code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">--fix-all</code>）、单项重算（<code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">--recalc</code>）等，输出同样带原因与教程。</p>
        </div>
      </div>
    </div>
  )
}
