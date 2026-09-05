/**
 * @cipherzip/shared
 * 跨模块共享类型、常量与协议定义。
 * CipherZip 桌面端 / CLI / CipherChat 桥接均依赖此包，保证协议一致。
 */

/** 自定义强制加密压缩格式魔数与版本 */
export const CCZ_MAGIC = new Uint8Array([0x43, 0x43, 0x5a, 0x31]) // "CCZ1"
export const CCZ_VERSION = 1
export const CCZ_MIME = 'application/x-cipherzip'
export const CCZ_EXTENSION = '.ccz'

/** 与 CipherChat 对齐的 KDF 参数（可互操作派生） */
export const PBKDF2_AUTH_ITERS = 120_000
export const PBKDF2_KEY_ITERS = 310_000
export const ARGON2_TIME = 3
export const ARGON2_MEM_KIB = 64 * 1024
export const ARGON2_PARALLELISM = 4

/** 分块大小：与 CipherChat 默认 4MiB 对齐，便于网盘互传 */
export const DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024

/** 加密算法标识 */
export enum CipherAlgo {
  AES_256_GCM = 1,
  CHACHA20_POLY1305 = 2,
}

/** 压缩算法标识 */
export enum CompressAlgo {
  NONE = 0,
  DEFLATE = 1,
  GZIP = 2,
  BROTLI = 3,
  ZSTD = 4,
}

/** 归档功能标志位 */
export enum ArchiveFlags {
  NONE = 0,
  ENCRYPT_FILENAMES = 1 << 0,
  KEYFILE_MODE = 1 << 1,
  SOLID = 1 << 2,
  SPLIT = 1 << 3,
  SELF_DESTRUCT = 1 << 4,
  MESH_SHARD = 1 << 5,
  /** 强制端到端：.ccz 永远置位 */
  FORCE_E2E = 1 << 6,
}

/** 密钥材料来源 */
export type KeyMaterial =
  | { type: 'password'; password: string }
  | { type: 'keyfile'; path: string; password?: string }
  | { type: 'hybrid'; password: string; keyfilePath: string }
  | { type: 'raw'; key: Uint8Array }

/** 目录条目（TOC） */
export interface TocEntry {
  /** 相对路径（可能已加密混淆） */
  path: string
  /** 原始文件名（仅内存态，落盘时加密） */
  name: string
  size: number
  compressedSize: number
  mtime: number
  mode: number
  isDir: boolean
  /** 内容分块索引 */
  chunkIndexes: number[]
  sha256: string
  mime?: string
}

export interface ArchiveMeta {
  version: number
  flags: number
  cipher: CipherAlgo
  compress: CompressAlgo
  chunkSize: number
  createdAt: number
  comment?: string
  /** 创建者设备公开指纹（可选，用于 P2P 溯源） */
  creatorFingerprint?: string
  /** CipherChat 联动：可选频道/网盘绑定 */
  cipherchat?: {
    baseUrl?: string
    channelId?: string
    driveId?: string
  }
}

export interface SharePayload {
  /** 协议版本 */
  v: 1
  /** 对端可达地址 */
  host: string
  port: number
  /** 会话公钥（base64） */
  pub: string
  /** 能力位：chat / file / mesh */
  caps: string[]
  /** 过期时间 unix ms */
  exp: number
  /** 昵称 */
  nick?: string
}

export interface MeshNodeInfo {
  nodeId: string
  address: string
  port: number
  storageFree: number
  willing: boolean
  lastSeen: number
}

/** CipherChat 客户端桥接 API 路径约定 */
export const CIPHERCHAT_CLIENT_API = {
  health: '/api/health',
  config: '/api/config',
  /** 新增：桌面客户端注册 / 能力宣告 */
  clientRegister: '/api/client/register',
  clientHeartbeat: '/api/client/heartbeat',
  /** 新增：压缩包元数据登记（仅密文指纹，无明文） */
  archiveAnnounce: '/api/client/archive/announce',
  archiveLookup: '/api/client/archive/lookup',
  /** 新增：P2P 信令中继（可选） */
  signalOffer: '/api/client/signal/offer',
  signalAnswer: '/api/client/signal/answer',
  signalPoll: '/api/client/signal/poll',
  /** 网盘 / 聊天复用 */
  driveSession: '/api/drive/session',
  driveFiles: '/api/drive/files',
  chatSession: '/api/chat/session',
} as const

export const WORDLIST_ZH_HINT =
  '分享码由易记英文单词编码 IP/端口/公钥摘要，本地生成，服务器不可见。'

export function formatBytes(n: number, digits = 1): string {
  if (!Number.isFinite(n)) return '-'
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(digits)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(digits)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}
