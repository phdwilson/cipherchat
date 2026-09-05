// 聊天文件上传 - 完结（校验分块完整性）
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { verifyChatSession } from '@/lib/server/session'
import { jsonError, jsonOk, sessionToken } from '@/lib/server/api'
import { countChunks } from '@/lib/server/filestore'
import { rateLimit } from '@/lib/server/ratelimit'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const token = sessionToken(req)
  const session = token ? await verifyChatSession(token) : null
  if (!session) return jsonError('会话无效或已过期', 401)
  if (!rateLimit('filedone:' + session.id, 30, 60_000)) {
    return jsonError('操作过于频繁，请稍后再试', 429)
  }

  let body: { fileId?: string }
  try {
    body = await req.json()
  } catch {
    return jsonError('请求格式错误')
  }
  const fileId = body.fileId || ''
  if (!/^[0-9a-fA-F-]{36}$/.test(fileId)) return jsonError('文件 ID 不合法')

  const file = await db.chatFile.findUnique({ where: { id: fileId } })
  if (!file || file.channelKeyId !== session.channelKeyId) return jsonError('文件不存在', 404)

  const actual = countChunks('chat', fileId)
  if (actual < file.totalChunks) {
    return jsonError(`分块不完整（${actual}/${file.totalChunks}），请重试上传`)
  }

  if (!file.ready) {
    await db.chatFile.update({ where: { id: fileId }, data: { ready: true } })
  }

  return jsonOk({ fileId })
}
