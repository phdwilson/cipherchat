// HTTPS 证书状态查询（实时 TLS 探测 + 配置元信息）
import { NextRequest } from 'next/server'
import { verifySuperKeyHash, isAdminInitialized } from '@/lib/server/admin'
import { readHttpsMeta, readHttpsPending, probeCert } from '@/lib/server/admin-https'
import { jsonError, jsonOk, reqIp } from '@/lib/server/api'
import { rateLimit } from '@/lib/server/ratelimit'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const ip = reqIp(req)
  if (!rateLimit('admin-https-info:' + ip, 60, 3600_000)) {
    return jsonError('请求过于频繁，请稍后再试', 429)
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

  const meta = readHttpsMeta()
  const pending = readHttpsPending()
  const gatewayPort = Number(process.env.GATEWAY_PORT || 2053)

  // 无论是否配置，都做一次实时探测（未配置/HTTP 模式时会返回 available:false）
  const probe = await probeCert(meta?.domain || '', gatewayPort)

  return jsonOk({
    configured: !!meta,
    meta,
    pending,
    probe,
    gatewayPort,
  })
}
