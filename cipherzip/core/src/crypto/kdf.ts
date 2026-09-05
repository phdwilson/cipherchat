/**
 * 密钥派生（KDF）
 * - 密码：PBKDF2-SHA256（与 CipherChat 参数对齐，便于跨端互通）
 * - 密钥文件：读取任意文件的「指纹切片」+ 全文件哈希混合
 * - 混合模式：password ⊕ keyfile 双因子
 *
 * 密钥文件设计（天马行空但可落地）：
 * 用户可上传音乐/图片/任意文件作为密钥。我们不是简单 hash 全文件，
 * 而是：
 *  1. 取文件长度 L
 *  2. 在固定相对位置取样：offset = floor(L * φ) % max(1, L-4096)
 *     （φ = 黄金比例 0.618...，保证不同长度文件取样点分布稳定）
 *  3. 读取最多 64KiB 的「中段切片」
 *  4. 另取文件头 1KiB + 文件尾 1KiB
 *  5. SHA-256(head || mid || tail || lengthBE) 作为 keyfile 材料
 * 这样即使文件很大也只需读少量字节，且对内容局部改动敏感。
 */

import { createHash, pbkdf2 as pbkdf2Cb, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile, open, stat } from 'node:fs/promises'
import { promisify } from 'node:util'
import {
  PBKDF2_KEY_ITERS,
  PBKDF2_AUTH_ITERS,
  type KeyMaterial,
} from '@cipherzip/shared'

const pbkdf2 = promisify(pbkdf2Cb)

const PHI = (Math.sqrt(5) - 1) / 2 // ≈ 0.6180339887
const MID_MAX = 64 * 1024
const EDGE = 1024

export interface DerivedKeys {
  /** AES-256 内容加密密钥 */
  contentKey: Buffer
  /** 文件名加密密钥（与内容密钥分离） */
  nameKey: Buffer
  /** 可公开的认证哈希（不可逆推密钥，用于服务端登记） */
  authHash: string
  /** 随机盐（需写入归档头） */
  salt: Buffer
}

function toHex(buf: Buffer): string {
  return buf.toString('hex')
}

/**
 * 从任意文件提取稳定密钥材料（不需要读完整文件）。
 */
export async function extractKeyfileMaterial(filePath: string): Promise<Buffer> {
  const st = await stat(filePath)
  const L = st.size
  const lenBuf = Buffer.alloc(8)
  lenBuf.writeBigUInt64BE(BigInt(L))

  if (L === 0) {
    // 空文件：仍可派生，但极弱 —— 调用方应警告
    return createHash('sha256').update('cipherzip:empty-keyfile').update(lenBuf).digest()
  }

  const fh = await open(filePath, 'r')
  try {
    const headLen = Math.min(EDGE, L)
    const head = Buffer.alloc(headLen)
    await fh.read(head, 0, headLen, 0)

    const tailLen = Math.min(EDGE, L)
    const tail = Buffer.alloc(tailLen)
    await fh.read(tail, 0, tailLen, Math.max(0, L - tailLen))

    let mid = Buffer.alloc(0)
    if (L > EDGE * 2) {
      const midLen = Math.min(MID_MAX, L - EDGE * 2)
      const offset = Math.floor(L * PHI) % Math.max(1, L - midLen)
      mid = Buffer.alloc(midLen)
      await fh.read(mid, 0, midLen, offset)
    }

    return createHash('sha256')
      .update('cipherzip:keyfile:v1')
      .update(head)
      .update(mid)
      .update(tail)
      .update(lenBuf)
      .digest()
  } finally {
    await fh.close()
  }
}

async function materialToSecret(material: KeyMaterial): Promise<Buffer> {
  switch (material.type) {
    case 'password': {
      return Buffer.from(material.password, 'utf8')
    }
    case 'keyfile': {
      const kf = await extractKeyfileMaterial(material.path)
      if (material.password) {
        return createHash('sha256')
          .update(kf)
          .update(Buffer.from(material.password, 'utf8'))
          .digest()
      }
      return kf
    }
    case 'hybrid': {
      const kf = await extractKeyfileMaterial(material.keyfilePath)
      return createHash('sha256')
        .update(Buffer.from(material.password, 'utf8'))
        .update(kf)
        .digest()
    }
    case 'raw': {
      return Buffer.from(material.key)
    }
    default: {
      const _exhaustive: never = material
      throw new Error(`未知密钥类型: ${JSON.stringify(_exhaustive)}`)
    }
  }
}

/**
 * 主派生：产出 contentKey / nameKey / authHash
 * @param salt 若省略则随机生成（创建归档时）；打开归档时必须传入文件头中的盐
 */
export async function deriveKeys(
  material: KeyMaterial,
  salt?: Buffer,
  iters = PBKDF2_KEY_ITERS
): Promise<DerivedKeys> {
  const s = salt && salt.length >= 16 ? salt : randomBytes(32)
  const secret = await materialToSecret(material)

  // 一次派生 64 字节：前 32 内容密钥，后 32 文件名密钥
  const full = await pbkdf2(secret, Buffer.concat([Buffer.from('cipherzip:key:'), s]), iters, 64, 'sha256')
  const contentKey = full.subarray(0, 32)
  const nameKey = full.subarray(32, 64)

  const auth = await pbkdf2(
    secret,
    Buffer.concat([Buffer.from('cipherzip:auth:'), s]),
    PBKDF2_AUTH_ITERS,
    32,
    'sha256'
  )

  // 清理 secret
  secret.fill(0)

  return {
    contentKey: Buffer.from(contentKey),
    nameKey: Buffer.from(nameKey),
    authHash: toHex(auth),
    salt: s,
  }
}

/** 与 CipherChat 频道密钥互通：同一 channelId+password 可派生兼容密钥 */
export async function deriveCipherChatCompatible(
  channelId: string,
  password: string
): Promise<{ aesKey: Buffer; authHash: string }> {
  const auth = await pbkdf2(
    password,
    `cipherchat:auth:${channelId}`,
    PBKDF2_AUTH_ITERS,
    32,
    'sha256'
  )
  const key = await pbkdf2(
    password,
    `cipherchat:key:${channelId}`,
    PBKDF2_KEY_ITERS,
    32,
    'sha256'
  )
  return { aesKey: key, authHash: toHex(auth) }
}

export function safeEqualHex(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a, 'hex')
    const bb = Buffer.from(b, 'hex')
    if (ba.length !== bb.length) return false
    return timingSafeEqual(ba, bb)
  } catch {
    return false
  }
}

export async function sha256File(path: string): Promise<string> {
  const data = await readFile(path)
  return createHash('sha256').update(data).digest('hex')
}

export function sha256Buf(data: Buffer | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}
