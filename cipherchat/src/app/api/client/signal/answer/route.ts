import { NextRequest } from 'next/server'
import { jsonError, jsonOk, reqIp } from '@/lib/server/api'
import { rateLimit } from '@/lib/server/ratelimit'
import { putSignalAnswer } from '@/lib/server/client-bridge'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  if (!rateLimit('sig-ans:' + reqIp(req), 60, 60_000)) return jsonError('请求过于频繁', 429)
  try {
    const body = await req.json()
    const room = String(body.room || '').slice(0, 128)
    const clientId = String(body.clientId || '').slice(0, 128)
    if (!room || !clientId || body.answer == null) return jsonError('参数不完整')
    await putSignalAnswer(room, clientId, body.answer)
    return jsonOk()
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : '失败', 500)
  }
}
