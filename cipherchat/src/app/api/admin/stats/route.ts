// 服务器统计（仅管理员，/stats 指令使用；不含任何消息内容）
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { verifySuperKeyHash, isAdminInitialized } from '@/lib/server/admin'
import { jsonError, jsonOk, reqIp } from '@/lib/server/api'
import { rateLimit } from '@/lib/server/ratelimit'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const ip = reqIp(req)
  if (!rateLimit('admin-stats:' + ip, 30, 3600_000)) {
    return jsonError('请求过于频繁，请稍后再试', 429)
  }

  let body: { adminKeyHash?: string }
  try {
    body = await req.json()
  } catch {
    return jsonError('请求格式错误')
  }

  const h = (body.adminKeyHash || '').trim().toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(h)) return jsonError('数据格式错误')
  if (!(await isAdminInitialized())) return jsonError('管理员密钥尚未初始化', 403)
  if (!(await verifySuperKeyHash(h))) return jsonError('超级密钥错误', 403)

  const [messages, chatFiles, chatBytesAgg, driveRepos, driveFiles, driveBytesAgg, chatSessions, driveSessions] =
    await Promise.all([
      db.chatMessage.count(),
      db.chatFile.count(),
      db.chatFile.aggregate({ _sum: { totalBytes: true } }),
      db.driveRepo.count(),
      db.driveFile.count(),
      db.driveFile.aggregate({ _sum: { totalBytes: true } }),
      db.chatSession.count(),
      db.driveSession.count(),
    ])

  return jsonOk({
    messages,
    chatFiles,
    chatBytes: Number(chatBytesAgg._sum.totalBytes || 0n),
    driveRepos,
    driveFiles,
    driveBytes: Number(driveBytesAgg._sum.totalBytes || 0n),
    sessions: chatSessions + driveSessions,
    uptimeSec: Math.round(process.uptime()),
  })
}
