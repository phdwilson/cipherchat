// 网盘文件：列表 / 上传初始化 / 删除
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { verifyDriveSession } from '@/lib/server/session'
import { jsonError, jsonOk, sessionToken } from '@/lib/server/api'
import { deleteFileDir } from '@/lib/server/filestore'
import { SERVER_CONFIG } from '@/lib/server/config'
import { rateLimit } from '@/lib/server/ratelimit'

export const dynamic = 'force-dynamic'

// v1.7.0：分块数上限改为由单文件字节上限推导（此前固定 100000 × 4MiB = 400GB，
// 而 totalBytes 只校验 5GiB，存在磁盘填充绕过）
const MAX_CHUNKS = Math.ceil(SERVER_CONFIG.maxDriveFileBytes / SERVER_CONFIG.chunkSize) + 1

export async function GET(req: NextRequest) {
  const token = sessionToken(req)
  const session = token ? await verifyDriveSession(token) : null
  if (!session) return jsonError('会话无效或已过期，请重新解锁', 401)

  const repo = await db.driveRepo.findUnique({ where: { id: session.repoId } })
  if (!repo) return jsonError('网盘仓库不存在', 404)

  const files = await db.driveFile.findMany({
    where: { repoId: repo.id, ready: true },
    orderBy: { createdAt: 'desc' },
  })

  return jsonOk({
    files: files.map((f) => ({
      id: f.id,
      totalChunks: f.totalChunks,
      totalBytes: Number(f.totalBytes),
      meta: f.meta, // 加密元数据
      createdAt: f.createdAt.toISOString(),
    })),
    usedBytes: Number(repo.usedBytes),
    quotaBytes: Number(repo.quotaBytes),
  })
}

export async function POST(req: NextRequest) {
  const token = sessionToken(req)
  const session = token ? await verifyDriveSession(token) : null
  if (!session) return jsonError('会话无效或已过期，请重新解锁', 401)
  // v1.7.0：上传初始化限流（此前网盘初始化无任何频率限制）
  if (!rateLimit('drive-init:' + session.id, 30, 60_000)) {
    return jsonError('请求过于频繁，请稍后再试', 429)
  }

  let body: { totalChunks?: number; totalBytes?: number; meta?: string }
  try {
    body = await req.json()
  } catch {
    return jsonError('请求格式错误')
  }

  const totalChunks = Number(body.totalChunks)
  const totalBytes = Number(body.totalBytes)
  const meta = body.meta || ''

  // v1.7.0：分块数上限由单文件上限推导，并交叉校验一致性（防声明小文件实际写海量块）
  if (!Number.isInteger(totalChunks) || totalChunks < 1 || totalChunks > MAX_CHUNKS) return jsonError('分块数量不合法')
  if (!Number.isFinite(totalBytes) || totalBytes <= 0 || totalBytes > SERVER_CONFIG.maxDriveFileBytes + 1024) {
    return jsonError(`单文件上限为 ${(SERVER_CONFIG.maxDriveFileBytes / 1024 / 1024 / 1024).toFixed(0)}GB`)
  }
  const cipherUpper = totalChunks * (SERVER_CONFIG.chunkSize + 28)
  if (cipherUpper > SERVER_CONFIG.maxDriveFileBytes + totalChunks * 28 + SERVER_CONFIG.chunkSize) {
    return jsonError('分块数与声明大小不一致')
  }
  if (meta.length > 8192) return jsonError('元数据过大')

  const repo = await db.driveRepo.findUnique({ where: { id: session.repoId } })
  if (!repo) return jsonError('网盘仓库不存在', 404)

  if (Number(repo.usedBytes) + totalBytes > Number(repo.quotaBytes)) {
    return jsonError('网盘空间不足，请清理文件后重试', 413)
  }

  const file = await db.driveFile.create({
    data: {
      repoId: repo.id,
      totalChunks,
      totalBytes: BigInt(Math.round(totalBytes)),
      meta,
    },
  })

  return jsonOk({ fileId: file.id })
}

export async function DELETE(req: NextRequest) {
  const token = sessionToken(req)
  const session = token ? await verifyDriveSession(token) : null
  if (!session) return jsonError('会话无效或已过期', 401)

  let body: { ids?: string[]; all?: boolean }
  try {
    body = await req.json()
  } catch {
    return jsonError('请求格式错误')
  }

  if (body.all) {
    const files = await db.driveFile.findMany({ where: { repoId: session.repoId } })
    await db.driveFile.deleteMany({ where: { repoId: session.repoId } })
    for (const f of files) deleteFileDir('drive', f.id)
    await db.driveRepo.update({ where: { id: session.repoId }, data: { usedBytes: BigInt(0) } })
    return jsonOk({ deleted: files.length })
  }

  const ids = Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === 'string') : []
  if (ids.length === 0) return jsonError('未指定要删除的文件')

  const files = await db.driveFile.findMany({
    where: { id: { in: ids }, repoId: session.repoId },
  })
  let freed = 0n
  for (const f of files) {
    freed += f.totalBytes
    deleteFileDir('drive', f.id)
  }
  await db.driveFile.deleteMany({ where: { id: { in: files.map((f) => f.id) } } })
  // v1.7.0：原子扣减已用空间；v1.8.0：不再静默吞错，失败时明确告知（可由管理员重算修复）
  if (files.length > 0) {
    try {
      await db.driveRepo.update({ where: { id: session.repoId }, data: { usedBytes: { decrement: freed } } })
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      return jsonError(`文件已删除，但配额扣减失败（${reason}）。请管理员在后台执行「重算网盘占用」修正统计`, 500)
    }
  }

  return jsonOk({ deleted: files.length })
}
