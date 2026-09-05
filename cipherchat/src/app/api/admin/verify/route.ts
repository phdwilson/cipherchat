// 管理员超级密钥验证（/admin 指令使用）
import { NextRequest } from 'next/server'
import { verifySuperKeyHash, isAdminInitialized } from '@/lib/server/admin'
import { jsonError, jsonOk, reqIp } from '@/lib/server/api'
import { rateLimit } from '@/lib/server/ratelimit'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const ip = reqIp(req)
  if (!rateLimit('admin-verify:' + ip, 10, 3600_000)) {
    return jsonError('尝试过于频繁，请稍后再试', 429)
  }

  let body: { adminKeyHash?: string }
  try {
    body = await req.json()
  } catch {
    return jsonError('请求格式错误')
  }

  const h = (body.adminKeyHash || '').trim().toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(h)) return jsonError('数据格式错误')

  if (!(await isAdminInitialized())) return jsonError('管理员密钥尚未初始化', 403)
  if (!(await verifySuperKeyHash(h))) return jsonError('超级密钥错误', 403)

  return jsonOk()
}
