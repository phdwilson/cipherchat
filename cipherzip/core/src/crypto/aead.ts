/**
 * AEAD 加解密封装
 * 默认 AES-256-GCM；可选 ChaCha20-Poly1305
 * 密文线格式：12B nonce || ciphertext || 16B tag（Node 的 createCipheriv 已附加 tag）
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  type CipherGCM,
  type DecipherGCM,
} from 'node:crypto'
import { CipherAlgo } from '@cipherzip/shared'

const NONCE_LEN = 12
const TAG_LEN = 16

function algoName(algo: CipherAlgo): 'aes-256-gcm' | 'chacha20-poly1305' {
  switch (algo) {
    case CipherAlgo.CHACHA20_POLY1305:
      return 'chacha20-poly1305'
    case CipherAlgo.AES_256_GCM:
    default:
      return 'aes-256-gcm'
  }
}

/**
 * 加密一块明文。
 * @param aad 附加认证数据（绑定 fileId/index，防调换）
 */
export function seal(
  key: Buffer,
  plain: Buffer | Uint8Array,
  aad?: Buffer | Uint8Array,
  algo: CipherAlgo = CipherAlgo.AES_256_GCM
): Buffer {
  const nonce = randomBytes(NONCE_LEN)
  const name = algoName(algo)
  const cipher = createCipheriv(name, key, nonce) as CipherGCM
  if (aad && aad.length) cipher.setAAD(Buffer.from(aad))
  const ct = Buffer.concat([cipher.update(Buffer.from(plain)), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([nonce, ct, tag])
}

export function open(
  key: Buffer,
  wire: Buffer | Uint8Array,
  aad?: Buffer | Uint8Array,
  algo: CipherAlgo = CipherAlgo.AES_256_GCM
): Buffer {
  const buf = Buffer.from(wire)
  if (buf.length < NONCE_LEN + TAG_LEN) {
    throw new Error('密文过短，无法解密')
  }
  const nonce = buf.subarray(0, NONCE_LEN)
  const tag = buf.subarray(buf.length - TAG_LEN)
  const ct = buf.subarray(NONCE_LEN, buf.length - TAG_LEN)
  const name = algoName(algo)
  const decipher = createDecipheriv(name, key, nonce) as DecipherGCM
  if (aad && aad.length) decipher.setAAD(Buffer.from(aad))
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()])
}

/** 文件名专用：确定性不足（仍用随机 nonce），输出 base64url */
export function sealName(nameKey: Buffer, name: string): string {
  const wire = seal(nameKey, Buffer.from(name, 'utf8'), Buffer.from('cipherzip:name'))
  return wire.toString('base64url')
}

export function openName(nameKey: Buffer, sealed: string): string {
  const wire = Buffer.from(sealed, 'base64url')
  return open(nameKey, wire, Buffer.from('cipherzip:name')).toString('utf8')
}

export function aadChunk(entryId: string, index: number): Buffer {
  return Buffer.from(`ccz:${entryId}:${index}`, 'utf8')
}
