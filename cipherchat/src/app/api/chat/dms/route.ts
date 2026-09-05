// v1.5.0 Dead Man's Switch 用户端点
// 注意：dmsEnabled=false（默认）时本接口对普通用户完全关闭 —— 开关对用户隐藏
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { jsonError, jsonOk, sessionToken } from '@/lib/server/api'
import { verifyChatSession } from '@/lib/server/session'
import { rateLimit } from '@/lib/server/ratelimit'

export const dynamic = 'force-dynamic'

async function dmsAllowed(): Promise<boolean> {
  const cfg = await db.adminConfig.findFirst({ select: { dmsEnabled: true } })
  return !!cfg?.dmsEnabled
}

// 查询我的 DMS 状态（含功能是否开放）
export async function GET(req: NextRequest) {
  const token = sessionToken(req)
  const session = token ? await verifyChatSession(token) : null
  if (!session) return jsonError('会话无效或已过期', 401)
  const enabled = await dmsAllowed()
  if (!enabled) return jsonOk({ enabled: false, armed: null }) // 功能未开放 → 前端隐藏开关
  const row = await db.deadMansSwitch.findUnique({ where: { pubId: session.pubId } })
  return jsonOk({
    enabled: true,
    armed: row ? {
      graceDays: row.graceDays,
      action: row.action,
      notifyMailbox: row.notifyMailbox || null,
      lastCheckIn: row.lastCheckIn.toISOString(),
      deadline: new Date(row.lastCheckIn.getTime() + row.graceDays * 86_400_000).toISOString(),
    } : null,
  })
}

// 设置/更新 DMS
export async function POST(req: NextRequest) {
  if (!(await dmsAllowed())) return jsonError('管理员未开放此功能', 403)
  const token = sessionToken(req)
  const session = token ? await verifyChatSession(token) : null
  if (!session) return jsonError('会话无效或已过期', 401)
  if (!rateLimit('dms:' + session.pubId, 10, 3600_000)) return jsonError('操作过于频繁', 429)

  let body: { graceDays?: number; action?: string; notifyMailbox?: string }
  try { body = await req.json() } catch { return jsonError('请求格式错误') }
  const graceDays = Math.round(Number(body.graceDays))
  if (!Number.isFinite(graceDays) || graceDays < 1 || graceDays > 365) return jsonError('宽限期需为 1-365 天')
  const action = body.action === 'wipe' ? 'wipe' : 'notify'
  let notifyMailbox = ''
  if (action === 'notify') {
    // wipe 动作影响全局，要求更慎重：notify 需要一个有效收件人
    notifyMailbox = (body.notifyMailbox || '').trim()
    if (!/^[a-zA-Z0-9-]{8,64}$/.test(notifyMailbox)) return jsonError('通知收件人不合法')
    const ident = await db.deviceIdentity.findUnique({ where: { pubId: notifyMailbox }, select: { pubId: true } })
    if (!ident) return jsonError('通知收件人未注册离线信箱', 404)
  }
  await db.deadMansSwitch.upsert({
    where: { pubId: session.pubId },
    create: { pubId: session.pubId, graceDays, action, notifyMailbox },
    update: { graceDays, action, notifyMailbox, lastCheckIn: new Date() },
  })
  return jsonOk({ ok: true })
}

// 撤防
export async function DELETE(req: NextRequest) {
  if (!(await dmsAllowed())) return jsonError('管理员未开放此功能', 403)
  const token = sessionToken(req)
  const session = token ? await verifyChatSession(token) : null
  if (!session) return jsonError('会话无效或已过期', 401)
  await db.deadMansSwitch.deleteMany({ where: { pubId: session.pubId } })
  return jsonOk({ ok: true })
}
