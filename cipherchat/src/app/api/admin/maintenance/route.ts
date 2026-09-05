// 维护操作：清理过期会话 / 吊销全部会话 / 立即备份
import { NextRequest } from 'next/server'
import { verifySuperKeyHash, isAdminInitialized } from '@/lib/server/admin'
import { maintenanceAction } from '@/lib/server/admin-https'
import { jsonError, jsonOk, reqIp } from '@/lib/server/api'
import { rateLimit } from '@/lib/server/ratelimit'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const ip = reqIp(req)
  if (!rateLimit('admin-maintenance:' + ip, 30, 3600_000)) {
    return jsonError('请求过于频繁，请稍后再试', 429)
  }

  let body: { adminKeyHash?: string; action?: string }
  try {
    body = await req.json()
  } catch {
    return jsonError('请求格式错误')
  }

  const h = (body.adminKeyHash || '').trim().toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(h)) return jsonError('数据格式错误')
  if (!(await isAdminInitialized())) return jsonError('管理员密钥尚未初始化', 403)
  if (!(await verifySuperKeyHash(h))) return jsonError('超级密钥错误', 403)

  const action = (body.action || '').trim()
  const r = await maintenanceAction(action)
  if (!r.ok) return jsonError(r.message)
  return jsonOk({ message: r.message, detail: r.detail })
}
