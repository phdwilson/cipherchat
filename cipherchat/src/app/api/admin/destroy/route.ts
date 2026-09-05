// 紧急自毁（/destroy 指令使用；与密码框触发同一销毁引擎）
// 可否认性：验证失败与未初始化返回同一错误文案，不泄露任何信息
import { NextRequest } from 'next/server'
import { matchesDestroyProbe, executeGlobalWipe, isAdminInitialized } from '@/lib/server/admin'
import { jsonError, jsonOk, reqIp } from '@/lib/server/api'
import { rateLimit } from '@/lib/server/ratelimit'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const ip = reqIp(req)
  if (!rateLimit('admin-destroy:' + ip, 10, 3600_000)) {
    return jsonError('尝试过于频繁，请稍后再试', 429)
  }

  let body: { probeHash?: string }
  try {
    body = await req.json()
  } catch {
    return jsonError('请求格式错误')
  }

  const h = (body.probeHash || '').trim().toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(h)) return jsonError('密钥无效', 403)
  if (!(await isAdminInitialized())) return jsonError('密钥无效', 403)
  if (!(await matchesDestroyProbe(h))) return jsonError('密钥无效', 403)

  await executeGlobalWipe()
  return jsonOk({ destroyed: true })
}
