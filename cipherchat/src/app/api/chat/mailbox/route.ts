// v1.5.0 P2P 离线信箱：存/取/删
// 信封由发送方用收件人 X25519 公钥派生密钥加密（服务器不可读）；取走即删。
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { jsonError, jsonOk, sessionToken } from '@/lib/server/api'
import { verifyChatSession } from '@/lib/server/session'
import { rateLimit } from '@/lib/server/ratelimit'

export const dynamic = 'force-dynamic'

const MAX_ENVELOPE = 256 * 1024 // 单封信封上限 256KB
const MAX_MAILBOX_ITEMS = 200 // 每人信箱上限

// 注册/更新设备公钥（X25519，私钥永不出设备）
export async function PUT(req: NextRequest) {
  const token = sessionToken(req)
  const session = token ? await verifyChatSession(token) : null
  if (!session) return jsonError('会话无效或已过期', 401)
  if (!rateLimit('ident:' + session.pubId, 10, 60_000)) return jsonError('请求过于频繁', 429)
  let body: { publicKey?: string }
  try { body = await req.json() } catch { return jsonError('请求格式错误') }
  const pk = (body.publicKey || '').trim()
  if (!/^[A-Za-z0-9+/=]{40,88}$/.test(pk)) return jsonError('公钥格式不合法')
  await db.deviceIdentity.upsert({
    where: { pubId: session.pubId },
    create: { pubId: session.pubId, publicKey: pk },
    update: { publicKey: pk },
  })
  return jsonOk()
}

// 查询某用户的公钥（发信前需要）
export async function GET(req: NextRequest) {
  const token = sessionToken(req)
  const session = token ? await verifyChatSession(token) : null
  if (!session) return jsonError('会话无效或已过期', 401)
  const url = new URL(req.url)
  const targetPubId = url.searchParams.get('pubId') || ''
  if (!/^[a-zA-Z0-9-]{8,64}$/.test(targetPubId)) return jsonError('参数不合法')
  if (!rateLimit('identq:' + session.pubId, 60, 60_000)) return jsonError('请求过于频繁', 429)
  const row = await db.deviceIdentity.findUnique({ where: { pubId: targetPubId } })
  return jsonOk({ publicKey: row?.publicKey || null })
}

// 投递信件（发给离线用户）
export async function POST(req: NextRequest) {
  const token = sessionToken(req)
  const session = token ? await verifyChatSession(token) : null
  if (!session) return jsonError('会话无效或已过期', 401)
  if (!rateLimit('mailsend:' + session.pubId, 30, 60_000)) return jsonError('发送过于频繁', 429)
  let body: { toPubId?: string; envelope?: string }
  try { body = await req.json() } catch { return jsonError('请求格式错误') }
  const toPubId = (body.toPubId || '').trim()
  const envelope = body.envelope || ''
  if (!/^[a-zA-Z0-9-]{8,64}$/.test(toPubId)) return jsonError('收件人不合法')
  if (!envelope || envelope.length > MAX_ENVELOPE) return jsonError('信封大小不合法')
  // 收件人必须注册过身份（有公钥才能解）
  const ident = await db.deviceIdentity.findUnique({ where: { pubId: toPubId }, select: { pubId: true } })
  if (!ident) return jsonError('对方未注册离线信箱', 404)
  // 容量限制
  // v1.8.0：count-then-create 改为事务内原子操作（此前并发投递可双双通过计数检查，
  // 信箱轻微超容 200；SQLite 单写者 + 事务使检查与写入序列化）
  try {
    await db.$transaction(async (tx) => {
      const count = await tx.mailboxItem.count({ where: { recipientPubId: toPubId } })
      if (count >= MAX_MAILBOX_ITEMS) throw new Error('MAILBOX_FULL')
      await tx.mailboxItem.create({
        data: { recipientPubId: toPubId, senderPubId: session.pubId, envelope },
      })
    })
  } catch (e) {
    if (e instanceof Error && e.message === 'MAILBOX_FULL') return jsonError('对方信箱已满', 507)
    return jsonError('投递失败，请重试', 500)
  }
  return jsonOk()
}

// 收取并删除我的全部信件（取走即删 —— 服务器不留副本）
export async function DELETE(req: NextRequest) {
  const token = sessionToken(req)
  const session = token ? await verifyChatSession(token) : null
  if (!session) return jsonError('会话无效或已过期', 401)
  if (!rateLimit('mailrecv:' + session.pubId, 30, 60_000)) return jsonError('请求过于频繁', 429)
  const items = await db.mailboxItem.findMany({
    where: { recipientPubId: session.pubId },
    orderBy: { createdAt: 'asc' },
    take: 100,
  })
  await db.mailboxItem.deleteMany({ where: { id: { in: items.map((i) => i.id) } } })
  return jsonOk({
    items: items.map((i) => ({ from: i.senderPubId, envelope: i.envelope, at: i.createdAt.toISOString() })),
  })
}
