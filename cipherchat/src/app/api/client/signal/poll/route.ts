import { NextRequest } from 'next/server'
import { jsonError, reqIp } from '@/lib/server/api'
import { rateLimit } from '@/lib/server/ratelimit'
import { pollSignal } from '@/lib/server/client-bridge'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  if (!rateLimit('sig-poll:' + reqIp(req), 120, 60_000)) return jsonError('请求过于频繁', 429)
  const room = req.nextUrl.searchParams.get('room') || ''
  const clientId = req.nextUrl.searchParams.get('clientId') || ''
  if (!room || !clientId) return jsonError('参数不完整')
  const data = await pollSignal(room, clientId)
  return Response.json({ ok: true, ...data })
}
