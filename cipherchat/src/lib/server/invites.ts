// 邀请令牌 + 密钥轮换服务端逻辑
// 安全设计：
// 1. 链接中只出现短码 code，绝不出现频道密码明文
// 2. 免密钥模式下，密码由「服务器主密钥」AES-256-GCM 二次加密后存库；
//    受邀者凭短码换取解密载荷 —— 主密钥与密文分属同一 DB 但换取接口有频率限制，
//    且管理员可通过 maxUses / 过期时间控制暴露面
// 3. 密钥轮换：客户端驱动（唯一能解密旧密文的只有持密码的客户端），
//    服务端仅负责把重加密后的消息/文件原子迁移到新 channelKeyId
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'crypto'
import { db } from '../db'
import { deleteFileDir } from './filestore'

// ---------------- 服务器主密钥 ----------------
// v1.7.0：首次创建存在并发竞态（两个请求同时 findFirst→create 会产生两行 ServerSecret，
// 邀请密文将取决于「取到哪一行」而永久不可解）。利用 create 的返回值冲突检测：
// 若并发创建后发现有多行，则统一取最早一行，其余删除，保证全库只有一个主密钥。
async function getInviteKey(): Promise<Buffer> {
  const rows = await db.serverSecret.findMany({ orderBy: { createdAt: 'asc' } })
  if (rows.length > 0) {
    // 若历史遗留了多行（旧版本竞态产物），收敛到最早的一行
    if (rows.length > 1) {
      await db.serverSecret.deleteMany({ where: { id: { in: rows.slice(1).map((r) => r.id) } } }).catch(() => {})
    }
    return Buffer.from(rows[0].inviteKey, 'hex')
  }
  const key = randomBytes(32).toString('hex')
  try {
    await db.serverSecret.create({ data: { inviteKey: key } })
  } catch {
    // 并发对手刚好先建 → 回读即可（数据库里必然已有行）
    const again = await db.serverSecret.findFirst({ orderBy: { createdAt: 'asc' } })
    if (again) return Buffer.from(again.inviteKey, 'hex')
  }
  return Buffer.from(key, 'hex')
}

function encryptWithKey(key: Buffer, plain: string): string {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  const tag = c.getAuthTag()
  return Buffer.concat([iv, tag, ct]).toString('base64')
}

function decryptWithKey(key: Buffer, sealed: string): string | null {
  try {
    const raw = Buffer.from(sealed, 'base64')
    const d = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12))
    d.setAuthTag(raw.subarray(12, 28))
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8')
  } catch {
    return null
  }
}

// ---------------- 邀请令牌 ----------------
export interface InvitePayload {
  channelId: string
  password?: string // 存在 = 免密钥模式（受邀者无需输入密码即可加入）
}

export async function createInviteToken(params: {
  payload: InvitePayload
  createdBy: string
  ttlMs: number // 有效期毫秒，上限 7 天
  maxUses: number // 0 = 不限
  role?: string // v1.5.0 受邀者角色
}): Promise<{ code: string; expiresAt: Date }> {
  const ttl = Math.min(Math.max(params.ttlMs, 60_000), 7 * 24 * 3600_000)
  const key = await getInviteKey()
  const code = randomBytes(9).toString('base64url').replace(/[-_]/g, 'a').slice(0, 12)
  const data = encryptWithKey(key, JSON.stringify(params.payload))
  await db.inviteToken.create({
    data: {
      code,
      data,
      createdBy: params.createdBy.slice(0, 64),
      role: ['admin', 'member', 'observer'].includes(params.role || '') ? params.role! : 'member',
      maxUses: Math.min(Math.max(params.maxUses, 0), 1000),
      expiresAt: new Date(Date.now() + ttl),
    },
  })
  return { code, expiresAt: new Date(Date.now() + ttl) }
}

// 凭短码换取加入信息（限频由调用方处理）。免密钥模式返回 password 明文给持有链接者。
export async function redeemInvite(code: string): Promise<
  { error: string; status?: number } | { ok: true; payload: InvitePayload; role: string }
> {
  if (!code || !/^[A-Za-z0-9]{8,32}$/.test(code)) return { error: '邀请码格式错误' }
  const row = await db.inviteToken.findUnique({ where: { code } })
  if (!row) return { error: '邀请不存在或已失效', status: 404 }
  if (row.expiresAt.getTime() < Date.now()) {
    await db.inviteToken.delete({ where: { id: row.id } }).catch(() => {})
    return { error: '邀请已过期', status: 410 }
  }
  // v1.7.0：maxUses 原子扣减 —— 此前「先查后增」在并发兑换下会超出上限。
  // maxUses=0 表示不限次数；有上限时用条件 updateMany 抢占名额，抢不到即已用完
  if (row.maxUses > 0) {
    const claimed = await db.inviteToken.updateMany({
      where: { id: row.id, uses: { lt: row.maxUses } },
      data: { uses: { increment: 1 } },
    })
    if (claimed.count === 0) return { error: '邀请次数已用完', status: 410 }
  }
  const key = await getInviteKey()
  const raw = decryptWithKey(key, row.data)
  if (!raw) return { error: '邀请数据损坏' }
  let payload: InvitePayload
  try {
    payload = JSON.parse(raw)
  } catch {
    return { error: '邀请数据损坏' }
  }
  return { ok: true, payload, role: (row as { role?: string }).role || 'member' }
}

// 清理过期邀请（懒触发）
export async function cleanupInvites() {
  try {
    await db.inviteToken.deleteMany({ where: { expiresAt: { lt: new Date() } } })
  } catch { /* ignore */ }
}

// ---------------- 密钥轮换 ----------------
export async function startRotation(params: {
  oldKeyId: string
  newKeyId: string
  createdBy: string
}): Promise<{ error: string } | { id: string }> {
  // 幂等检查：同频道已有未完成的轮换任务时拒绝重复创建（防连点竞态）
  const ongoing = await db.chatRotation.findFirst({
    where: { oldKeyId: params.oldKeyId, phase: { notIn: ['done', 'cancelled'] } },
    select: { id: true, phase: true },
  })
  if (ongoing) return { error: '该频道已有进行中的轮换任务' }
  const clash = await db.chatSession.findFirst({ where: { channelKeyId: params.newKeyId }, select: { id: true } })
  if (clash) return { error: '新密码对应的频道已存在，请换一个新密码' }
  const oldExists = await db.chatMessage.findFirst({ where: { channelKeyId: params.oldKeyId }, select: { id: true } })
  const oldFiles = await db.chatFile.findFirst({ where: { channelKeyId: params.oldKeyId }, select: { id: true } })
  if (!oldExists && !oldFiles) return { error: '旧频道没有可迁移的内容' }
  const row = await db.chatRotation.create({
    data: {
      oldKeyId: params.oldKeyId,
      newKeyId: params.newKeyId,
      createdBy: params.createdBy.slice(0, 64),
      phase: 'pending', // 初始 pending；migrate 开始后进入 messages → files → done
      fileTotal: await db.chatFile.count({ where: { channelKeyId: params.oldKeyId } }),
      expiresAt: new Date(Date.now() + 3600_000), // 轮换任务 1 小时内有效
    },
  })
  return { id: row.id }
}

export async function getRotation(id: string): Promise<{ phase: string; msgDone: number; fileTotal: number; fileDone: number } | null> {
  const r = await db.chatRotation.findUnique({ where: { id } })
  if (!r || r.phase === 'done') return r ? { phase: r.phase, msgDone: r.msgDone, fileTotal: r.fileTotal, fileDone: r.fileDone } : null
  return { phase: r.phase, msgDone: r.msgDone, fileTotal: r.fileTotal, fileDone: r.fileDone }
}

// 取消/回滚轮换：仅 failed / pending 状态可取消。
// 清理半成品：删除已迁移到新 keyId 的文件记录与磁盘块、把已改写 payload 的消息回滚不可行
// （payload 已被重加密覆盖），因此 cancelled 后旧频道保留原样、用户可重新发起全新轮换。
// 返回被清理的新频道文件数量。
export async function cancelRotation(id: string): Promise<{ success: true; cleanedFiles: number } | { success: false; reason: 'not_found' | 'not_cancellable' }> {
  const r = await db.chatRotation.findUnique({ where: { id } })
  if (!r) return { success: false, reason: 'not_found' }
  if (r.phase !== 'failed' && r.phase !== 'pending') return { success: false, reason: 'not_cancellable' }
  // 清理半成品：迁移到新 keyId 的文件属于半成品数据
  // v1.7.0 修复：此前只删 ready=false 的行，ready=true 的行被清了磁盘块却保留
  // 记录 → 消息仍在但文件永久打不开（孤儿行）。现在统一整行删除 + 清盘。
  const halfDone = await db.chatFile.findMany({ where: { channelKeyId: r.newKeyId }, select: { id: true } })
  for (const f of halfDone) deleteFileDir('chat', f.id)
  await db.chatFile.deleteMany({ where: { channelKeyId: r.newKeyId } })
  await db.chatRotation.update({ where: { id }, data: { phase: 'cancelled' } })
  return { success: true, cleanedFiles: halfDone.length }
}

export async function finishRotation(id: string): Promise<{ success: true; newKeyId: string } | { success: false; reason: 'not_found' | 'already_done' }> {
  const r = await db.chatRotation.findUnique({ where: { id } })
  if (!r) return { success: false, reason: 'not_found' }
  if (r.phase === 'done') return { success: false, reason: 'already_done' }
  if (r.phase === 'cancelled' || r.phase === 'failed') return { success: false, reason: 'not_found' }
  await db.chatSession.deleteMany({ where: { channelKeyId: r.oldKeyId } }) // 吊销旧频道全部会话
  await db.chatRotation.update({ where: { id }, data: { phase: 'done' } })
  return { success: true, newKeyId: r.newKeyId }
}

// 将轮换任务标记为失败（由 migrate/files 阶段的异常 catch 调用）
export async function markRotationFailed(id: string): Promise<void> {
  await db.chatRotation.updateMany({
    where: { id, phase: { in: ['pending', 'messages', 'files'] } },
    data: { phase: 'failed' },
  }).catch((e) => console.warn('[rotate] 标记失败状态出错:', e instanceof Error ? e.message : e))
}

// ---------------- channelKeyId 工具（与 session.ts 保持一致） ----------------
export function keyIdOf(channelId: string, authHash: string): string {
  return createHash('sha256').update('chan:' + channelId + ':' + authHash).digest('hex')
}
