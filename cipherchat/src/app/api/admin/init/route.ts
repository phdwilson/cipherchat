// 管理员密钥首次初始化：设置 超级密钥 + 自毁密钥（仅允许一次，之后 409）
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { isAdminInitialized } from '@/lib/server/admin'
import { jsonError, jsonOk, reqIp } from '@/lib/server/api'
import { rateLimit } from '@/lib/server/ratelimit'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const ip = reqIp(req)
  if (!rateLimit('admin-init:' + ip, 5, 3600_000)) {
    return jsonError('尝试过于频繁，请一小时后再试', 429)
  }

  // 已初始化则拒绝 —— 防止他人事后抢占重设
  if (await isAdminInitialized()) {
    return jsonError('管理员密钥已初始化，不可重复设置', 409)
  }

  let body: { superKeyHash?: string; destroyKeyHash?: string }
  try {
    body = await req.json()
  } catch {
    return jsonError('请求格式错误')
  }

  const superKeyHash = (body.superKeyHash || '').trim().toLowerCase()
  const destroyKeyHash = (body.destroyKeyHash || '').trim().toLowerCase()

  if (!/^[a-f0-9]{64}$/.test(superKeyHash)) return jsonError('超级密钥数据格式错误')
  if (!/^[a-f0-9]{64}$/.test(destroyKeyHash)) return jsonError('自毁密钥数据格式错误')
  if (superKeyHash === destroyKeyHash) return jsonError('超级密钥与自毁密钥不能相同')

  await db.adminConfig.create({ data: { superKeyHash, destroyKeyHash } })

  return jsonOk()
}
