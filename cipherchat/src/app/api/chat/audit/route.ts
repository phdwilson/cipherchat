// v1.5.0 安全审计页数据（用户侧透明化）
// 返回：我的会话列表 / 我创建的活跃邀请 / 我的角色 / DMS 状态 —— 全部仅限本人可见
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { jsonOk, jsonError, sessionToken } from '@/lib/server/api'
import { verifyChatSession } from '@/lib/server/session'
import { rateLimit } from '@/lib/server/ratelimit'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const token = sessionToken(req)
  const session = token ? await verifyChatSession(token) : null
  if (!session) return jsonError('会话无效或已过期', 401)
  if (!rateLimit('audit:' + session.pubId, 20, 60_000)) return jsonError('请求过于频繁', 429)

  // 1. 本设备标识下的全部活跃会话（哪些地方在用我的身份）
  const sessions = await db.chatSession.findMany({
    where: { pubId: session.pubId, expiresAt: { gt: new Date() } },
    select: { id: true, deviceLabel: true, ip: true, geoDisclosure: true, createdAt: true, lastSeenAt: true, expiresAt: true },
    orderBy: { lastSeenAt: 'desc' },
    take: 50,
  })

  // 2. 我创建的未过期邀请
  const invites = await db.inviteToken.findMany({
    where: { createdBy: session.pubId, expiresAt: { gt: new Date() } },
    select: { code: true, role: true, uses: true, maxUses: true, expiresAt: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: 100,
  })

  // 3. 我在频道中的角色（所有频道）
  const memberships = await db.chatMember.findMany({
    where: { pubId: session.pubId },
    select: { channelKeyId: true, role: true, joinedAt: true },
    take: 100,
  })

  // 4. 身份注册状态 + DMS
  const ident = await db.deviceIdentity.findUnique({ where: { pubId: session.pubId }, select: { updatedAt: true } })
  const cfg = await db.adminConfig.findFirst({ select: { dmsEnabled: true } })
  const dms = cfg?.dmsEnabled
    ? await db.deadMansSwitch.findUnique({ where: { pubId: session.pubId }, select: { graceDays: true, action: true, lastCheckIn: true } })
    : null

  return jsonOk({
    me: { pubId: session.pubId, currentSessionId: session.id },
    sessions: sessions.map((s) => ({
      id: s.id,
      device: s.deviceLabel,
      ip: s.geoDisclosure === 'full' ? s.ip : '(已隐藏)',
      disclosure: s.geoDisclosure,
      createdAt: s.createdAt.toISOString(),
      lastSeenAt: s.lastSeenAt.toISOString(),
      expiresAt: s.expiresAt.toISOString(),
      isCurrent: s.id === session.id,
    })),
    invites: invites.map((i) => ({
      code: i.code,
      role: i.role,
      uses: i.uses,
      maxUses: i.maxUses,
      expiresAt: i.expiresAt.toISOString(),
    })),
    roles: memberships,
    identityRegistered: !!ident,
    dmsEnabled: !!cfg?.dmsEnabled,
    dms: dms ? { graceDays: dms.graceDays, action: dms.action, lastCheckIn: dms.lastCheckIn.toISOString() } : null,
  })
}

// 吊销指定会话（非当前）—— 安全审计页操作
export async function DELETE(req: NextRequest) {
  const token = sessionToken(req)
  const session = token ? await verifyChatSession(token) : null
  if (!session) return jsonError('会话无效或已过期', 401)
  if (!rateLimit('auditrev:' + session.pubId, 10, 60_000)) return jsonError('请求过于频繁', 429)
  let body: { sessionId?: string }
  try { body = await req.json() } catch { return jsonError('请求格式错误') }
  const sid = (body.sessionId || '').trim()
  if (!sid || !/^[0-9a-fA-F-]{36}$/.test(sid)) return jsonError('参数不合法')
  if (sid === session.id) return jsonError('不能吊销当前会话')
  // 只能吊销自己名下的会话
  const r = await db.chatSession.deleteMany({ where: { id: sid, pubId: session.pubId } })
  if (r.count === 0) return jsonError('会话不存在或不属于你', 404)
  return jsonOk({ revoked: r.count })
}
