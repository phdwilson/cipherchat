/**
 * 分享码系统
 * 将 {host, port, pub, caps, exp, nick} 编码为易记英文单词序列（或二维码 JSON）。
 *
 * 编码思路：
 * 1. 规范化 IPv4 为 32-bit；IPv6 取前 8 字节摘要
 * 2. 端口 16-bit
 * 3. 公钥 SHA-256 取前 10 字节
 * 4. 能力位 8-bit + 过期（小时粒度 16-bit）
 * 5. 整体 1+4+2+10+1+2 = 20 字节 → 用 2048 词表编为 16 个单词（带校验）
 *
 * 分享码本质是客户端内置词表「加密/编码」后的人类可读地址，
 * 不是服务器发放的 — 完全本地生成。
 */

import {
  createHash,
  createHmac,
  randomBytes,
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
} from 'node:crypto'
import type { SharePayload } from '@cipherzip/shared'
import { WORDLIST } from './wordlist.js'

const VERSION = 1

function ipv4ToBytes(host: string): Buffer | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return null
  const parts = m.slice(1).map(Number)
  if (parts.some((p) => p > 255)) return null
  return Buffer.from(parts)
}

function bytesToIpv4(b: Buffer): string {
  return `${b[0]}.${b[1]}.${b[2]}.${b[3]}`
}

function payloadToBytes(p: SharePayload): Buffer {
  const buf = Buffer.alloc(20)
  buf.writeUInt8(VERSION, 0)
  const ip = ipv4ToBytes(p.host)
  if (ip) ip.copy(buf, 1)
  else {
    // 非 IPv4：用 host 哈希填 4 字节，完整 host 放扩展（二维码模式更合适）
    createHash('sha256').update(p.host).digest().subarray(0, 4).copy(buf, 1)
  }
  buf.writeUInt16BE(p.port & 0xffff, 5)
  const pubHash = createHash('sha256').update(p.pub).digest().subarray(0, 10)
  pubHash.copy(buf, 7)
  let caps = 0
  if (p.caps.includes('chat')) caps |= 1
  if (p.caps.includes('file')) caps |= 2
  if (p.caps.includes('mesh')) caps |= 4
  buf.writeUInt8(caps, 17)
  const expHours = Math.max(0, Math.min(0xffff, Math.floor(p.exp / 3_600_000)))
  buf.writeUInt16BE(expHours & 0xffff, 18)
  return buf
}

/** 20 字节 → 16 个词（每词 11 bit，共 176 bit；前 160 bit 数据 + 16 bit CRC） */
function bytesToWords(data20: Buffer): string[] {
  const crc = createHash('sha256').update(data20).digest().readUInt16BE(0)
  const full = Buffer.concat([data20, Buffer.alloc(2)])
  full.writeUInt16BE(crc, 20)
  // 22 字节 = 176 bit → 16 * 11 bit
  let bits = 0n
  for (const b of full.subarray(0, 22)) bits = (bits << 8n) | BigInt(b)
  const words: string[] = []
  for (let i = 0; i < 16; i++) {
    const shift = BigInt((15 - i) * 11)
    const idx = Number((bits >> shift) & 0x7ffn)
    words.push(WORDLIST[idx % WORDLIST.length])
  }
  return words
}

function wordsToBytes(words: string[]): Buffer {
  if (words.length !== 16) throw new Error('分享码应为 16 个英文单词')
  let bits = 0n
  for (const w of words) {
    const idx = WORDLIST.indexOf(w.toLowerCase())
    if (idx < 0) throw new Error(`未知单词: ${w}`)
    bits = (bits << 11n) | BigInt(idx)
  }
  const full = Buffer.alloc(22)
  for (let i = 21; i >= 0; i--) {
    full[i] = Number(bits & 0xffn)
    bits >>= 8n
  }
  const data20 = full.subarray(0, 20)
  const crc = full.readUInt16BE(20)
  const expect = createHash('sha256').update(data20).digest().readUInt16BE(0)
  if (crc !== expect) throw new Error('分享码校验失败（可能输入有误）')
  return data20
}

export function encodeShareCode(payload: SharePayload): string {
  const words = bytesToWords(payloadToBytes(payload))
  return words.join('-')
}

export function decodeShareCode(code: string): Omit<SharePayload, 'pub' | 'nick'> & { pubHash: Buffer; hostHint: string } {
  const words = code.trim().toLowerCase().split(/[\s\-_.]+/).filter(Boolean)
  const data = wordsToBytes(words)
  const version = data.readUInt8(0)
  if (version !== VERSION) throw new Error(`不支持的分享码版本: ${version}`)
  const hostHint = bytesToIpv4(data.subarray(1, 5))
  const port = data.readUInt16BE(5)
  const pubHash = data.subarray(7, 17)
  const capsByte = data.readUInt8(17)
  const caps: string[] = []
  if (capsByte & 1) caps.push('chat')
  if (capsByte & 2) caps.push('file')
  if (capsByte & 4) caps.push('mesh')
  const exp = data.readUInt16BE(18) * 3_600_000
  return { v: 1, host: hostHint, hostHint, port, caps, exp, pubHash }
}

/** 完整 JSON 载荷（用于二维码，可含完整公钥与昵称） */
export function encodeShareQr(payload: SharePayload): string {
  return JSON.stringify({ ...payload, code: encodeShareCode(payload) })
}

export function decodeShareQr(text: string): SharePayload {
  const j = JSON.parse(text) as SharePayload
  if (j.v !== 1 || !j.host || !j.port || !j.pub) throw new Error('无效的分享二维码')
  return j
}

/** 生成 P2P 会话密钥对（X25519） */
export function generateP2PIdentity(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('x25519')
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  }
}

/** 用 HMAC 派生会话传输密钥 */
export function deriveSessionKey(privateKeyDerB64: string, peerPublicDerB64: string, salt: string): Buffer {
  // X25519 ECDH + HMAC-SHA256
  const priv = createPrivateKey({ key: Buffer.from(privateKeyDerB64, 'base64'), format: 'der', type: 'pkcs8' })
  const pub = createPublicKey({ key: Buffer.from(peerPublicDerB64, 'base64'), format: 'der', type: 'spki' })
  const shared = diffieHellman({ privateKey: priv, publicKey: pub })
  return createHmac('sha256', shared).update(salt).digest()
}

export function randomNick(): string {
  const adj = ['星尘', '夜风', '流云', '月影', '晨曦', '碧波', '青竹', '飞雪', '紫电', '寒烟']
  const noun = ['旅人', '行者', '信使', '访客', '游侠', '隐士', '观星者', '逐光者']
  return `${adj[Math.floor(Math.random() * adj.length)]}${noun[Math.floor(Math.random() * noun.length)]}`
}
