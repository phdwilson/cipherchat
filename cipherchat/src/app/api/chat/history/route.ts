// 拉取聊天历史（密文返回，客户端本地解密）
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { verifyChatSession } from '@/lib/server/session'
import { jsonError, jsonOk, sessionToken } from '@/lib/server/api'
import { SERVER_CONFIG } from '@/lib/server/config'
import { rateLimit } from '@/lib/server/ratelimit'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const token = sessionToken(req)
  const session = token ? await verifyChatSession(token) : null
  if (!session) return jsonError('会话无效或已过期，请重新进入频道', 401)
  if (!rateLimit('history:' + session.pubId, 30, 60_000)) {
    return jsonError('拉取过于频繁，请稍后再试', 429)
  }

  const url = new URL(req.url)
  // v1.7.0：参数严格校验 —— 此前 ?limit=abc 会产生 NaN 直接传给 Prisma 抹 500，
  // ?before=garbage 会产生 Invalid Date 抹 500
  const limitRaw = Number(url.searchParams.get('limit') || SERVER_CONFIG.historyPageSize)
  const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? Math.floor(limitRaw) : SERVER_CONFIG.historyPageSize, 1), 300)
  const beforeRaw = url.searchParams.get('before')
  let beforeMs: number | null = null
  if (beforeRaw) {
    const t = Date.parse(beforeRaw)
    if (!Number.isFinite(t)) return jsonError('before 参数需为合法时间戳')
    beforeMs = t
  }

  const messages = await db.chatMessage.findMany({
    where: {
      channelKeyId: session.channelKeyId,
      ...(beforeMs !== null ? { createdAt: { lt: new Date(beforeMs) } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: {
      reactions: { select: { readerId: true, emoji: true } },
      pollVotes: { select: { voterId: true, optionIndex: true } }, // v1.7.0 加密投票
    },
  })

  return jsonOk({
    messages: messages.reverse().map((m) => ({
      id: m.id,
      senderId: m.senderId,
      payload: m.payload,
      fileId: m.fileId || null,
      replyToId: m.replyToId || null,
      readAt: m.readAt ? m.readAt.toISOString() : null,
      burnAt: m.burnAt ? m.burnAt.toISOString() : null,
      createdAt: m.createdAt.toISOString(),
      // v1.6.0：历史消息携带表情回应
      reactions: m.reactions.map((r) => ({ readerId: r.readerId, emoji: r.emoji })),
      // v1.7.0：历史消息携带投票
      votes: m.pollVotes.map((v) => ({ voterId: v.voterId, optionIndex: v.optionIndex })),
    })),
    hasMore: messages.length === limit,
  })
}
