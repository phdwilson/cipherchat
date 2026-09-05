// 服务端统一配置（仅相对导入，供 Next.js 与 ws 中继服务共用）
import { createHmac } from 'crypto'
import { resolve } from 'path'
import { loadEnvFile } from './env'
import { getProjectRoot } from './db-bootstrap'

loadEnvFile()

export const SERVER_CONFIG = {
  appName: '密讯 CipherChat',
  // WebSocket 中继服务端口（生产环境可通过 WS_PORT 覆盖）
  wsPort: Number(process.env.WS_PORT || 3003),
  // 分块大小（字节）：明文分块 4MiB
  chunkSize: 4 * 1024 * 1024,
  // 单个聊天文件上限（默认 1GiB）
  maxChatFileBytes: Number(process.env.MAX_CHAT_FILE_BYTES || 1024 * 1024 * 1024),
  // 网盘单文件上限（默认 5GiB）
  maxDriveFileBytes: Number(process.env.MAX_DRIVE_FILE_BYTES || 5 * 1024 * 1024 * 1024),
  // 网盘仓库默认配额（默认 20GiB）
  driveQuotaBytes: Number(process.env.DRIVE_QUOTA_BYTES || 20 * 1024 * 1024 * 1024),
  // 会话有效期（毫秒），默认 7 天
  sessionTtlMs: Number(process.env.SESSION_TTL_MS || 7 * 24 * 3600 * 1000),
  // 聊天历史每页条数
  historyPageSize: 100,
  // 聊天记录保留上限（每频道最多条数，0 = 不限制）
  maxMessagesPerChannel: Number(process.env.MAX_MESSAGES_PER_CHANNEL || 0),
  // 数据目录（密文分块文件存放处）
  // v1.8.1 修复：相对路径统一解析为「项目根/data」的绝对路径。
  // 背景：DATA_DIR=data 时旧实现依赖各进程 CWD —— web（standalone）chdir 到 .next/standalone，
  // relay 的 CWD 是项目根 → web 写入 .next/standalone/data，relay 却在 <根>/data 执行
  // 删除/清理（消息删除删不掉真密文、闪照假焚毁、定时清理永不命中）→ 隐私泄露 + 功能失效。
  // 绝对化后 filestore/selfcheck 的 resolve(cwd, dataDir) 与 CWD 无关，两进程必然同目录。
  get dataDir() {
    const raw = process.env.DATA_DIR || 'data'
    return raw.startsWith('/') ? raw : resolve(getProjectRoot(), raw)
  },
}

// ============== TURN 中继配置 ==============
// 暴露给客户端的 ICE 服务器数组（不含明文密钥的版本：若 turnSecretMode=time-limited，
// 由 /api/voice/turn-credentials 端点动态签发短期凭证）
export interface TurnPublicConfig {
  enabled: boolean
  // 已配置 TURN 服务器（不含凭证），客户端可见
  servers: string[]
  // 凭证模式：static=长期凭证 time-limited=短期凭证（客户端需轮询获取）
  secretMode: 'static' | 'time-limited'
  // 仅 static 模式下返回用户名与密码；time-limited 模式留空
  username?: string
  credential?: string
  // P2P STUN 公共服务器（兜底用，所有客户端都用）
  stunServers: string[]
}

const DEFAULT_STUN: string[] = [
  'stun:stun.l.google.com:19302',
  'stun:stun1.google.com:19302',
  'stun:stun.cloudflare.com:3478',
]

export async function getTurnConfig(): Promise<TurnPublicConfig> {
  try {
    const { db } = await import('../db')
    const cfg = await db.adminConfig.findFirst()
    if (!cfg) {
      return { enabled: false, servers: [], secretMode: 'static', stunServers: DEFAULT_STUN }
    }
    const servers = (cfg.turnUrls || '')
      .split(/[\s,]+/m)
      .map((s) => s.trim())
      .filter((s) => s.startsWith('turn:') || s.startsWith('turns:'))
    const mode: 'static' | 'time-limited' = cfg.turnSecretMode === 'time-limited' ? 'time-limited' : 'static'
    const out: TurnPublicConfig = {
      enabled: !!cfg.turnEnabled && servers.length > 0,
      servers,
      secretMode: mode,
      stunServers: DEFAULT_STUN,
    }
    // 仅 static 模式且启用时返回凭证；time-limited 由专用端点签发
    if (out.enabled && mode === 'static' && cfg.turnUsername && cfg.turnCredential) {
      out.username = cfg.turnUsername
      out.credential = cfg.turnCredential
    }
    return out
  } catch {
    return { enabled: false, servers: [], secretMode: 'static', stunServers: DEFAULT_STUN }
  }
}

// 时间窗口短期凭证（time-limited credentials，按 RFC 5389 §2.2 / coturn use-auth-secret 算法）
// username = "<expiry-epoch>:<userid>"  →  expiry 取整 1 小时窗口
// password = HMAC-SHA1(secret, username) 的 base64
// 服务端 coturn 配置 use-auth-secret, static-auth-secret=<secret>，必须与 db 中 turnCredential 一致
export function generateTimedTurnCredentials(secret: string, userId: string = 'cipherchat', ttlSec = 3600): {
  username: string
  credential: string
  expiresAt: number
} {
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSec
  const username = `${expiresAt}:${userId}`
  const hmac = createHmac('sha1', secret).update(username).digest('base64')
  return { username, credential: hmac, expiresAt }
}

export function getWebPublicConfig() {
  return {
    appName: SERVER_CONFIG.appName,
    wsPort: SERVER_CONFIG.wsPort,
    chunkSize: SERVER_CONFIG.chunkSize,
    maxChatFileBytes: SERVER_CONFIG.maxChatFileBytes,
    maxDriveFileBytes: SERVER_CONFIG.maxDriveFileBytes,
    driveQuotaBytes: SERVER_CONFIG.driveQuotaBytes,
  }
}

// v1.4.3：allowHiddenGeo 是否允许普通用户「不披露 IP/地区」（管理员开关，公开只读）
export async function getGeoPrivacyFlag(): Promise<{ allowHiddenGeo: boolean; dmsEnabled: boolean }> {
  try {
    const { db } = await import('../db')
    const cfg = await db.adminConfig.findFirst({ select: { allowHiddenGeo: true, dmsEnabled: true } })
    return { allowHiddenGeo: cfg?.allowHiddenGeo !== false, dmsEnabled: !!cfg?.dmsEnabled }
  } catch (e) {
    console.warn('[config] 查询隐私开关失败:', e instanceof Error ? e.message : e)
    return { allowHiddenGeo: true, dmsEnabled: false }
  }
}

// 功能开关默认值（管理员未初始化时全部开启；dmsEnabled 默认隐藏）
export const DEFAULT_FEATURE_FLAGS = {
  voiceEnabled: true,
  whisperEnabled: true,
  friendEnabled: true,
  avatarUploadEnabled: true,
  p2pEnabled: true,
  allowHiddenGeo: true,
  dmsEnabled: false,
}

export async function getFeatureFlags() {
  try {
    const { db } = await import('../db')
    const cfg = await db.adminConfig.findFirst()
    if (!cfg) return DEFAULT_FEATURE_FLAGS
    return {
      voiceEnabled: cfg.voiceEnabled,
      whisperEnabled: cfg.whisperEnabled,
      friendEnabled: cfg.friendEnabled,
      avatarUploadEnabled: cfg.avatarUploadEnabled,
      p2pEnabled: cfg.p2pEnabled,
      // v1.6.0 修复：此前这两个开关未随 GET /api/admin/features 回显，面板刷新后永远显示默认值
      allowHiddenGeo: cfg.allowHiddenGeo !== false,
      dmsEnabled: !!cfg.dmsEnabled,
    }
  } catch {
    return DEFAULT_FEATURE_FLAGS
  }
}
