// 聊天文件上传 - 初始化
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { verifyChatSession } from '@/lib/server/session'
import { jsonError, jsonOk, sessionToken } from '@/lib/server/api'
import { SERVER_CONFIG } from '@/lib/server/config'
import { rateLimit } from '@/lib/server/ratelimit'

export const dynamic = 'force-dynamic'

// v1.7.0 修复磁盘填充绕过：此前 MAX_CHUNKS=40000 固定值 × 4MiB 分块 = 理论 160GB，
// 而 totalBytes 只校验 1GiB —— 攻击者声明 1GiB 但传 40000 块即可占用 160GB 磁盘。
// 现在分块上限由「单文件字节上限 ÷ 分块大小」推导，两者恒一致。
const MAX_CHUNKS = Math.ceil(SERVER_CONFIG.maxChatFileBytes / SERVER_CONFIG.chunkSize) + 1

export async function POST(req: NextRequest) {
  const token = sessionToken(req)
  const session = token ? await verifyChatSession(token) : null
  if (!session) return jsonError('会话无效或已过期', 401)

  if (!rateLimit('chat-upload-init:' + session.id, 30, 60_000)) {
    return jsonError('上传请求过于频繁，请稍后再试', 429)
  }

  let body: { totalChunks?: number; totalBytes?: number; viewOnce?: boolean }
  try {
    body = await req.json()
  } catch {
    return jsonError('请求格式错误')
  }

  const totalChunks = Number(body.totalChunks)
  const totalBytes = Number(body.totalBytes)

  if (!Number.isInteger(totalChunks) || totalChunks < 1 || totalChunks > MAX_CHUNKS) {
    return jsonError('分块数量不合法')
  }
  if (!Number.isFinite(totalBytes) || totalBytes <= 0 || totalBytes > SERVER_CONFIG.maxChatFileBytes + 1024) {
    return jsonError(`文件大小超过聊天文件上限（${(SERVER_CONFIG.maxChatFileBytes / 1024 / 1024 / 1024).toFixed(0)}GB）`)
  }
  // v1.7.0：交叉校验「分块数 × 分块上限」不得显著超过声明的大小（+28B/块 IV+Tag 余量），
  // 防止声明小文件、实际写入海量分块
  const cipherUpper = totalChunks * (SERVER_CONFIG.chunkSize + 28)
  if (cipherUpper > SERVER_CONFIG.maxChatFileBytes + totalChunks * 28 + SERVER_CONFIG.chunkSize) {
    return jsonError('分块数与声明大小不一致')
  }
  const viewOnce = body.viewOnce === true

  const file = await db.chatFile.create({
    data: {
      channelKeyId: session.channelKeyId,
      totalChunks,
      totalBytes: BigInt(Math.round(totalBytes)),
      ...(viewOnce ? { viewOnce: true } : {}),
    },
  })

  return jsonOk({ fileId: file.id })
}
