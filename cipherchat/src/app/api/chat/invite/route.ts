// 创建邀请令牌（二维码/链接分享）
// 免密钥模式（includePassword=true）时频道密码由服务器主密钥二次加密后存库，
// 链接中只有短码，绝不出现密码明文
import { NextRequest } from 'next/server'
import { jsonError, jsonOk } from '@/lib/server/api'
import { rateLimit } from '@/lib/server/ratelimit'
import { verifyChatSession } from '@/lib/server/session'
import { createInviteToken, cleanupInvites, type InvitePayload } from '@/lib/server/invites'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const token = req.headers.get('x-session-token')
  const session = token ? await verifyChatSession(token) : null
  if (!session) return jsonError('会话无效或已过期', 401)

  let body: { channelId?: string; password?: string; ttlMs?: number; maxUses?: number; role?: string }
  try {
    body = await req.json()
  } catch {
    return jsonError('请求格式错误')
  }

  const channelId = (body.channelId || '').trim()
  const password = typeof body.password === 'string' ? body.password : ''
  if (!channelId || channelId.length > 64) return jsonError('频道 ID 不合法')
  // 密码仅作为加密载荷暂存于服务端主密钥之下；长度限制防止滥用
  if (password && password.length > 256) return jsonError('密码过长')

  // v1.5.0 邀请角色：owner 可邀 admin/member/observer；member 可邀 member/observer
  const inviteRole = ['admin', 'member', 'observer'].includes(body.role || '') ? body.role! : 'member'

  if (!rateLimit('invite:' + session.pubId, 10, 60_000)) {
    return jsonError('邀请创建过于频繁，请稍后再试', 429)
  }
  const { canInviteRole } = await import('@/lib/server/roles')
  if (!(await canInviteRole(session.channelKeyId, session.pubId, inviteRole as 'admin' | 'member' | 'observer'))) {
    return jsonError(`权限不足：你的角色不能创建「${inviteRole}」邀请`, 403)
  }

  const payload: InvitePayload = { channelId, ...(password ? { password } : {}) }
  const { code, expiresAt } = await createInviteToken({
    payload,
    createdBy: session.pubId,
    role: inviteRole,
    ttlMs: Math.min(Math.max(Number(body.ttlMs) || 24 * 3600_000, 60_000), 7 * 24 * 3600_000),
    maxUses: Math.min(Math.max(Number(body.maxUses) || 0, 0), 1000),
  })
  cleanupInvites().catch(() => {})

  return jsonOk({ code, role: inviteRole, expiresAt: expiresAt.toISOString() })
}
