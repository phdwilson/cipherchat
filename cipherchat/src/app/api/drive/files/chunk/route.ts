// 网盘文件上传 - 分块写入（原始密文二进制）
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { verifyDriveSession } from '@/lib/server/session'
import { jsonError, jsonOk, sessionToken } from '@/lib/server/api'
import { writeChunkAsync } from '@/lib/server/filestore'
import { SERVER_CONFIG } from '@/lib/server/config'
import { rateLimit } from '@/lib/server/ratelimit'

export const dynamic = 'force-dynamic'

const MAX_CHUNK_BODY = SERVER_CONFIG.chunkSize + 1024

export async function POST(req: NextRequest) {
  const token = sessionToken(req)
  const session = token ? await verifyDriveSession(token) : null
  if (!session) return jsonError('会话无效或已过期，请重新解锁', 401)
  // v1.7.0：网盘分块写入限流（此前完全无限制，可被用来打满磁盘 IO）
  if (!rateLimit('drive-chunkup:' + session.id, 120, 60_000)) {
    return jsonError('上传过于频繁，请稍后再试', 429)
  }

  const url = new URL(req.url)
  const fileId = url.searchParams.get('fileId') || ''
  const index = Number(url.searchParams.get('index'))

  if (!/^[0-9a-fA-F-]{36}$/.test(fileId)) return jsonError('文件 ID 不合法')
  if (!Number.isInteger(index) || index < 0 || index >= 100000) return jsonError('分块序号不合法')

  const file = await db.driveFile.findUnique({ where: { id: fileId } })
  if (!file || file.repoId !== session.repoId) return jsonError('文件不存在', 404)
  if (file.ready) return jsonError('文件已完结，拒绝重复写入')
  if (index >= file.totalChunks) return jsonError('分块序号超出范围')

  let buf: Buffer
  try {
    buf = Buffer.from(await req.arrayBuffer())
  } catch {
    return jsonError('读取数据失败')
  }
  if (buf.length === 0 || buf.length > MAX_CHUNK_BODY) {
    return jsonError(`分块大小不合法（最大 ${(MAX_CHUNK_BODY / 1024 / 1024).toFixed(1)}MB）`)
  }

  try {
    // v1.7.0：异步写盘，不再阻塞事件循环
    await writeChunkAsync('drive', fileId, index, buf)
  } catch {
    return jsonError('写入失败，请重试', 500)
  }

  return jsonOk({ received: index })
}
