'use client'
// 重新协商密钥（密钥轮换）：把频道密码换成新密码，全部消息与文件无缝迁移
// 原理：只有客户端能解密旧密文 —— 本地逐条解密 → 新密钥重加密 → 服务端换绑
import { useState } from 'react'
import { toast } from 'sonner'
import { KeyRound, Loader2, RefreshCcw, X, CheckCircle2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { passwordStrength } from '@/lib/crypto'
import { rotateChannelKeys, cancelRotationRemote } from '@/lib/share'

export function KeyRotationDialog({
  channelId,
  onClose,
  onDone,
}: {
  channelId: string
  onClose: () => void
  onDone: (newPassword: string) => void
}) {
  const [oldPw, setOldPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [newPw2, setNewPw2] = useState('')
  const [busy, setBusy] = useState(false)
  const [phase, setPhase] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [failed, setFailed] = useState(false) // 轮换失败 → 显示重试/取消回滚按钮
  const [rotationId, setRotationId] = useState<string | undefined>(undefined)
  const strength = passwordStrength(newPw)

  const submit = async () => {
    if (!oldPw || !newPw) return setErr('请填写旧密码与新密码')
    if (newPw !== newPw2) return setErr('两次输入的新密码不一致')
    if (newPw === oldPw) return setErr('新密码不能与旧密码相同')
    if (strength.score < 2) return setErr('新密码太弱，建议 12 位以上混合大小写/数字/符号')
    setErr(null)
    setBusy(true)
    try {
      await rotateChannelKeys({
        channelId,
        oldPassword: oldPw,
        newPassword: newPw,
        onRotationId: (id) => setRotationId(id), // 记录任务 ID（取消回滚时携带，修复 v1.4.3 BUG）
        onProgress: (p) => {
          if (p.phase === 'messages') setPhase(`正在迁移消息（已处理 ${p.msgDone} 条）…`)
          else if (p.phase === 'files') setPhase(`正在迁移文件（${p.fileDone}/${p.fileTotal}）…`)
          else if (p.phase === 'done') setPhase('完成！')
        },
      })
      toast.success('密钥已更换，所有内容已迁移到新密钥')
      onDone(newPw)
      onClose()
    } catch (e) {
      const msg = e instanceof Error ? e.message : '轮换失败'
      // 服务端返回「可恢复」失败（migrate/files 异常已标记 failed）时给出回滚选项
      setFailed(/异常|failed|暂停/.test(msg))
      setErr(msg)
    } finally {
      setBusy(false)
    }
  }

  // 取消并回滚：清理半成品数据，任务置为 cancelled，用户可重新发起
  // v1.4.3 BUG 修复：携带 rotationId；服务端在缺失时也会按频道回退查找兜底
  const cancelRollback = async () => {
    setBusy(true)
    try {
      await cancelRotationRemote(channelId, oldPw, rotationId)
      toast.message('轮换已取消，半成品数据已清理，可重新发起')
      setFailed(false)
      setErr(null)
      setPhase(null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : '取消失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4 backdrop-blur-sm" role="dialog" aria-modal="true">
      <div className="glass w-full max-w-md rounded-2xl border p-5 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-lg font-bold">
            <RefreshCcw className="h-5 w-5 text-primary" /> 重新协商频道密钥
          </h2>
          <Button variant="ghost" size="icon" className="h-8 w-8 rounded-lg" onClick={onClose} aria-label="关闭" disabled={busy}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        <p className="mb-4 rounded-xl bg-muted/60 p-3 text-xs leading-relaxed text-muted-foreground">
          将频道「{channelId}」的密码更换为新密码，<b>全部聊天消息与文件会自动解密并用新密钥重加密</b>，
          无缝迁移。完成后其他成员必须用新密码才能继续解密 —— 适合怀疑旧密码泄露时紧急换钥。
        </p>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-sm font-semibold">当前密码</Label>
            <Input type="password" value={oldPw} onChange={(e) => setOldPw(e.target.value)} className="h-10 rounded-xl" autoComplete="current-password" disabled={busy} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-sm font-semibold">新密码</Label>
            <Input type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} className="h-10 rounded-xl" autoComplete="new-password" disabled={busy} />
            {newPw && <span className={`text-[11px] ${strength.score >= 3 ? 'text-emerald-500' : 'text-amber-500'}`}>强度：{strength.label}</span>}
          </div>
          <div className="space-y-1.5">
            <Label className="text-sm font-semibold">确认新密码</Label>
            <Input type="password" value={newPw2} onChange={(e) => setNewPw2(e.target.value)} className="h-10 rounded-xl" autoComplete="new-password" disabled={busy} />
          </div>

          {err && <div className="rounded-xl bg-red-500/10 px-3 py-2 text-[13px] text-red-600 dark:text-red-400">{err}</div>}
          {busy && phase && (
            <div className="flex items-center gap-2 rounded-xl bg-primary/5 px-3 py-2 text-[13px] text-primary">
              <Loader2 className="h-4 w-4 animate-spin" /> {phase}
            </div>
          )}

          {/* 失败恢复：重试 / 取消回滚 */}
          {failed && !busy && (
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1 rounded-xl" onClick={submit}>
                <RefreshCcw className="mr-1.5 h-4 w-4" /> 重试
              </Button>
              <Button variant="outline" className="flex-1 rounded-xl text-red-600 hover:bg-red-500/10" onClick={cancelRollback}>
                <X className="mr-1.5 h-4 w-4" /> 取消并回滚
              </Button>
            </div>
          )}

          {!failed && (
            <Button onClick={submit} disabled={busy} className="h-11 w-full rounded-xl grad-primary font-semibold">
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <KeyRound className="mr-2 h-4 w-4" />}
              {busy ? '正在迁移…' : '开始更换并迁移'}
            </Button>
          )}
          {!busy && (
            <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
              <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
              迁移期间请保持页面打开。完成后你将自动以新密码重新进入频道。
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
