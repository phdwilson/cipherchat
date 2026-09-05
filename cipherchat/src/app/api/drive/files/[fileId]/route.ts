// 网盘单个文件：下载（流式密文）/ 重命名（更新加密元数据）
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { verifyDriveSession } from '@/lib/server/session'
import { jsonError, jsonOk, sessionToken } from '@/lib/server/api'
import { streamFile, missingChunks, dirSizeBytes } from '@/lib/server/filestore'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest, ctx: { params: Promise<{ fileId: string }> }) {
  const token = sessionToken(req)
  const session = token ? await verifyDriveSession(token) : null
  if (!session) return jsonError('会话无效或已过期', 401)

  const { fileId } = await ctx.params
  if (!/^[0-9a-fA-F-]{36}$/.test(fileId)) return jsonError('文件 ID 不合法')

  const file = await db.driveFile.findUnique({ where: { id: fileId } })
  if (!file || file.repoId !== session.repoId || !file.ready) return jsonError('文件不存在', 404)

  // v1.6.0：缺块直接报错，避免产出解密必然失败的坏流
  const missing = missingChunks('drive', fileId, file.totalChunks)
  if (missing.length > 0) return jsonError('文件分块不完整（可能上传中断），无法下载', 409)

  return new Response(streamFile('drive', fileId, file.totalChunks), {
    headers: {
      'content-type': 'application/octet-stream',
      'cache-control': 'no-store',
      'content-length': String(dirSizeBytes('drive', fileId)),
    },
  })
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ fileId: string }> }) {
  const token = sessionToken(req)
  const session = token ? await verifyDriveSession(token) : null
  if (!session) return jsonError('会话无效或已过期', 401)

  const { fileId } = await ctx.params
  let body: { meta?: string }
  try {
    body = await req.json()
  } catch {
    return jsonError('请求格式错误')
  }
  const meta = body.meta || ''
  if (meta.length > 8192) return jsonError('元数据过大')

  const file = await db.driveFile.findUnique({ where: { id: fileId } })
  if (!file || file.repoId !== session.repoId) return jsonError('文件不存在', 404)

  await db.driveFile.update({ where: { id: fileId }, data: { meta } })
  return jsonOk()
}
