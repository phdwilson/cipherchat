// v1.8.0 管理员一键自检：真实世界模拟测试全部核心功能
// POST { adminKeyHash, checks?: string[] } → 完整自检报告（含失败原因与修复指引）
import { NextRequest } from 'next/server'
import { verifySuperKeyHash, isAdminInitialized } from '@/lib/server/admin'
import { jsonError, jsonOk, reqIp } from '@/lib/server/api'
import { rateLimit } from '@/lib/server/ratelimit'
import { runSelfCheck } from '@/lib/server/selfcheck'

export const dynamic = 'force-dynamic'
// 上传管线含真实磁盘 IO 与自调用 HTTP，耗时可达数秒；放宽执行时限
export const maxDuration = 60

export async function POST(req: NextRequest) {
  const ip = reqIp(req)
  // 自检包含真实 IO，限制频率防止滥用（10 分钟内最多 6 次）
  if (!rateLimit('admin-selfcheck:' + ip, 6, 600_000)) {
    return jsonError('自检过于频繁，请 10 分钟后再试', 429)
  }

  let body: { adminKeyHash?: string; checks?: string[] }
  try {
    body = await req.json()
  } catch {
    return jsonError('请求格式错误')
  }

  const h = (body.adminKeyHash || '').trim().toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(h)) return jsonError('数据格式错误')
  if (!(await isAdminInitialized())) return jsonError('管理员密钥尚未初始化', 403)
  if (!(await verifySuperKeyHash(h))) return jsonError('超级密钥错误', 403)

  const only = Array.isArray(body.checks) ? body.checks.filter((x) => typeof x === 'string') : undefined

  try {
    const report = await runSelfCheck({ origin: req.nextUrl.origin, adminKeyHash: h }, only)
    return jsonOk({ ...report, results: report.results })
  } catch (e) {
    return jsonError(`自检引擎异常：${e instanceof Error ? e.message : String(e)}`, 500)
  }
}
