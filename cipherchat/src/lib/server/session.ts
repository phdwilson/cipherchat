// 会话令牌：签发随机 token（仅返回给客户端一次），数据库只存 SHA-256 哈希
// 任何日志中都不得输出 token 明文
import { createHash, randomBytes, timingSafeEqual } from 'crypto'
import { db } from '../db'
import { SERVER_CONFIG } from './config'

export type SessionKind = 'chat' | 'drive'

export function sha256hex(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

export function newToken(): string {
  return randomBytes(32).toString('hex')
}

export function hashToken(token: string): string {
  return sha256hex('token:' + token)
}

export function safeEqualHex(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
  } catch {
    return false
  }
}

export function channelKeyIdOf(channelId: string, authHash: string): string {
  return sha256hex('chan:' + channelId + ':' + authHash)
}

// ---------------- 聊天会话 ----------------

export interface ChatSessionInfo {
  id: string
  channelKeyId: string
  pubId: string // 稳定设备标识（消息归属判断用）
  deviceLabel: string
  ip: string
  geoDisclosure?: 'full' | 'region' | 'hidden'
}

export async function createChatSession(params: {
  channelId: string
  authHash: string
  pubId: string
  deviceLabel: string
  deviceInfoEnc?: string
  ip: string
  geoDisclosure?: 'full' | 'region' | 'hidden'
}): Promise<{ token: string; session: ChatSessionInfo }> {
  const token = newToken()
  const channelKeyId = channelKeyIdOf(params.channelId, params.authHash)
  const expiresAt = new Date(Date.now() + SERVER_CONFIG.sessionTtlMs)
  // IP 披露级别白名单校验；hidden 需要管理员允许（allowHiddenGeo）
  let disclosure = ['full', 'region', 'hidden'].includes(params.geoDisclosure || '') ? params.geoDisclosure! : 'full'
  if (disclosure === 'hidden') {
    try {
      const cfg = await db.adminConfig.findFirst({ select: { allowHiddenGeo: true } })
      if (!cfg?.allowHiddenGeo) disclosure = 'full' // 管理员未开放「不披露」→ 回退完整披露
    } catch (e) {
      console.warn('[session] 查询 allowHiddenGeo 失败，回退 full:', e instanceof Error ? e.message : e)
      disclosure = 'full'
    }
  }
  const row = await db.chatSession.create({
    data: {
      tokenHash: hashToken(token),
      channelKeyId,
      pubId: params.pubId,
      deviceLabel: params.deviceLabel,
      deviceInfoEnc: (params.deviceInfoEnc || '').slice(0, 4096),
      ip: params.ip,
      geoDisclosure: disclosure,
      expiresAt,
    },
  })
  return {
    token,
    session: {
      id: row.id,
      channelKeyId: row.channelKeyId,
      pubId: row.pubId,
      deviceLabel: row.deviceLabel,
      ip: row.ip,
      geoDisclosure: disclosure,
    },
  }
}

export async function verifyChatSession(token: string | null | undefined): Promise<ChatSessionInfo | null> {
  if (!token || token.length < 32) return null
  const row = await db.chatSession.findUnique({ where: { tokenHash: hashToken(token) } })
  if (!row) return null
  if (row.expiresAt.getTime() < Date.now()) {
    await db.chatSession.delete({ where: { id: row.id } }).catch(() => {})
    return null
  }
  // 偶尔刷新活跃时间（减少写放大）
  if (Date.now() - row.lastSeenAt.getTime() > 3600_000) {
    await db.chatSession.update({ where: { id: row.id }, data: { lastSeenAt: new Date() } }).catch(() => {})
  }
  return {
    id: row.id,
    channelKeyId: row.channelKeyId,
    pubId: row.pubId || row.id, // 兼容旧记录：无 pubId 时回退会话 ID
    deviceLabel: row.deviceLabel,
    ip: row.ip,
    geoDisclosure: (row as { geoDisclosure?: string }).geoDisclosure === 'region' ? 'region'
      : (row as { geoDisclosure?: string }).geoDisclosure === 'hidden' ? 'hidden' : 'full',
  }
}

// ---------------- 网盘会话 ----------------

export interface DriveSessionInfo {
  id: string
  repoId: string
  deviceLabel: string
  ip: string
}

export async function createDriveSession(params: {
  repoId: string
  deviceLabel: string
  ip: string
}): Promise<{ token: string; session: DriveSessionInfo }> {
  const token = newToken()
  const expiresAt = new Date(Date.now() + SERVER_CONFIG.sessionTtlMs)
  const row = await db.driveSession.create({
    data: {
      tokenHash: hashToken(token),
      repoId: params.repoId,
      deviceLabel: params.deviceLabel,
      ip: params.ip,
      expiresAt,
    },
  })
  return {
    token,
    session: { id: row.id, repoId: row.repoId, deviceLabel: row.deviceLabel, ip: row.ip },
  }
}

export async function verifyDriveSession(token: string | null | undefined): Promise<DriveSessionInfo | null> {
  if (!token || token.length < 32) return null
  const row = await db.driveSession.findUnique({ where: { tokenHash: hashToken(token) } })
  if (!row) return null
  if (row.expiresAt.getTime() < Date.now()) {
    await db.driveSession.delete({ where: { id: row.id } }).catch(() => {})
    return null
  }
  if (Date.now() - row.lastSeenAt.getTime() > 3600_000) {
    await db.driveSession.update({ where: { id: row.id }, data: { lastSeenAt: new Date() } }).catch(() => {})
  }
  return { id: row.id, repoId: row.repoId, deviceLabel: row.deviceLabel, ip: row.ip }
}

// 过期会话清理（懒执行，创建会话时偶尔触发）
export async function cleanupExpiredSessions() {
  const now = new Date()
  try {
    await db.chatSession.deleteMany({ where: { expiresAt: { lt: now } } })
    await db.driveSession.deleteMany({ where: { expiresAt: { lt: now } } })
  } catch {
    // ignore
  }
}
