import { NextRequest } from 'next/server'
import { jsonError, reqIp } from '@/lib/server/api'
import { rateLimit } from '@/lib/server/ratelimit'
import { lookupArchive } from '@/lib/server/client-bridge'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  if (!rateLimit('arch-lk:' + reqIp(req), 60, 60_000)) {
    return jsonError('请求过于频繁', 429)
  }
  const authHash = req.nextUrl.searchParams.get('authHash') || ''
  if (!/^[0-9a-f]{64}$/i.test(authHash)) return jsonError('authHash 无效')
  const rows = await lookupArchive(authHash)
  // 不返回 clientId 以外的敏感定位信息过多 —— 仅元数据
  return Response.json({
    ok: true,
    items: rows.map((r) => ({
      authHash: r.authHash,
      size: r.size,
      entryCount: r.entryCount,
      fingerprint: r.fingerprint,
      createdAt: r.createdAt,
    })),
  })
}
