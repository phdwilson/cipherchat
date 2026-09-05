import { NextRequest } from 'next/server'
import { jsonError, jsonOk, reqIp } from '@/lib/server/api'
import { rateLimit } from '@/lib/server/ratelimit'
import { announceArchive } from '@/lib/server/client-bridge'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  if (!rateLimit('arch-ann:' + reqIp(req), 30, 60_000)) {
    return jsonError('请求过于频繁', 429)
  }
  try {
    const body = await req.json()
    const authHash = String(body.authHash || '')
    const clientId = String(body.clientId || '')
    if (!authHash || !clientId) return jsonError('缺少 authHash 或 clientId')
    const row = await announceArchive({
      clientId,
      authHash,
      size: Number(body.size) || 0,
      entryCount: Number(body.entryCount) || 0,
      fingerprint: body.fingerprint ? String(body.fingerprint) : undefined,
      meta: body.meta && typeof body.meta === 'object' ? body.meta : undefined,
    })
    return jsonOk({ authHash: row.authHash, createdAt: row.createdAt })
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : '宣告失败', 400)
  }
}
