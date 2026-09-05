import { NextRequest } from 'next/server'
import { jsonError, jsonOk, reqIp } from '@/lib/server/api'
import { rateLimit } from '@/lib/server/ratelimit'
import { heartbeatClient, listOnlineClients } from '@/lib/server/client-bridge'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  if (!rateLimit('client-hb:' + reqIp(req), 60, 60_000)) {
    return jsonError('请求过于频繁', 429)
  }
  try {
    const body = await req.json()
    const clientId = String(body.clientId || '').trim()
    if (!clientId) return jsonError('clientId 无效')
    const rec = await heartbeatClient(clientId, body)
    if (!rec) return jsonError('客户端未注册', 404)
    const online = await listOnlineClients()
    return jsonOk({ lastSeen: rec.lastSeen, online: online.length })
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : '心跳失败', 500)
  }
}
