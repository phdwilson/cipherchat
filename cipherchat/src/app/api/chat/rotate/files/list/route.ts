// 轮换辅助：列出旧频道下全部文件（供客户端逐个重加密）
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { jsonError, jsonOk, sessionToken } from '@/lib/server/api'
import { verifyChatSession } from '@/lib/server/session'
import { rateLimit } from '@/lib/server/ratelimit'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const token = sessionToken(req)
  const session = token ? await verifyChatSession(token) : null
  if (!session) return jsonError('会话无效或已过期', 401)
  if (!rateLimit('rotlist:' + session.pubId, 10, 60_000)) {
    return jsonError('请求过于频繁，请稍后再试', 429)
  }
  const files = await db.chatFile.findMany({
    where: { channelKeyId: session.channelKeyId, ready: true },
    select: { id: true, totalChunks: true },
    take: 500,
  })
  return jsonOk({ files })
}
