// CipherZip 桌面客户端注册
import { NextRequest } from 'next/server'
import { jsonError, jsonOk, reqIp } from '@/lib/server/api'
import { rateLimit } from '@/lib/server/ratelimit'
import { registerClient } from '@/lib/server/client-bridge'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  if (!rateLimit('client-reg:' + reqIp(req), 30, 60_000)) {
    return jsonError('请求过于频繁，请稍后再试', 429)
  }
  try {
    const body = await req.json()
    const clientId = String(body.clientId || '').trim()
    if (!clientId || clientId.length > 128) return jsonError('clientId 无效')
    const rec = await registerClient({
      clientId,
      version: body.version,
      features: Array.isArray(body.features) ? body.features.map(String) : [],
      p2pPort: typeof body.p2pPort === 'number' ? body.p2pPort : undefined,
      meshWilling: !!body.meshWilling,
      nodeId: body.nodeId ? String(body.nodeId) : undefined,
    })
    return jsonOk({
      clientId: rec.clientId,
      clientToken: rec.clientToken,
      features: rec.features,
    })
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : '注册失败', 500)
  }
}
