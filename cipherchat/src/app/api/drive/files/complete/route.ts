// 网盘文件上传 - 完结（校验完整性 + 计入已用空间）
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { verifyDriveSession } from '@/lib/server/session'
import { jsonError, jsonOk, sessionToken } from '@/lib/server/api'
import { countChunks, dirSizeBytesAsync, deleteFileDir } from '@/lib/server/filestore'
import { rateLimit } from '@/lib/server/ratelimit'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const token = sessionToken(req)
  const session = token ? await verifyDriveSession(token) : null
  if (!session) return jsonError('会话无效或已过期，请重新解锁', 401)
  if (!rateLimit('drive-complete:' + session.id, 30, 60_000)) {
    return jsonError('请求过于频繁，请稍后再试', 429)
  }

  let body: { fileId?: string }
  try {
    body = await req.json()
  } catch {
    return jsonError('请求格式错误')
  }
  const fileId = body.fileId || ''
  if (!/^[0-9a-fA-F-]{36}$/.test(fileId)) return jsonError('文件 ID 不合法')

  const file = await db.driveFile.findUnique({ where: { id: fileId } })
  if (!file || file.repoId !== session.repoId) return jsonError('文件不存在', 404)

  const actual = countChunks('drive', fileId)
  if (actual < file.totalChunks) {
    return jsonError(`分块不完整（${actual}/${file.totalChunks}），请重试上传`)
  }

  if (!file.ready) {
    // v1.7.0：异步统计密文实际大小（替代同步 statSync 循环）
    // v1.8.0：此值是计费/配额的唯一依据，必须真实落库
    const realSize = BigInt(await dirSizeBytesAsync('drive', fileId))
    try {
      await db.driveFile.update({ where: { id: fileId }, data: { ready: true, totalBytes: realSize } })
      // v1.7.0：原子累加已用空间；v1.8.0：不再静默吞错 —— 失败时返回明确原因与
      // 修复指引（否则配额永久漂移，用户毫无感知）
      await db.driveRepo.update({ where: { id: session.repoId }, data: { usedBytes: { increment: realSize } } })
    } catch (e) {
      // 文件本体已完整落盘，只回滚 ready 标记避免半完成状态；告知重试或管理员重算
      await db.driveFile.update({ where: { id: fileId }, data: { ready: false } }).catch(() => {})
      const reason = e instanceof Error ? e.message : String(e)
      return jsonError(
        `文件已保存，但占用统计写入失败（${reason}）。请稍后重试完结；若反复失败，请管理员在后台执行「重算网盘占用」修复统计`,
        500
      )
    }
  }

  return jsonOk({ fileId })
}
