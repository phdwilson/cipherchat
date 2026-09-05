// 多分块大文件解密一致性验证
import { webcrypto as crypto } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'

const BASE = 'http://localhost:3000'
const CHANNEL = 'e2e-test-room'
const PASSWORD = 'TestPass2024!secure'
const enc = new TextEncoder()

const toHex = (bytes) => Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')
const b64ToBuf = (b64) => new Uint8Array(Buffer.from(b64, 'base64'))

async function pbkdf2(password, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations }, base, 256))
}

const authHash = toHex(await pbkdf2(PASSWORD, 'cipherchat:auth:' + CHANNEL, 120000))
const keyBits = await pbkdf2(PASSWORD, 'cipherchat:key:' + CHANNEL, 310000)
const aesKey = await crypto.subtle.importKey('raw', keyBits, { name: 'AES-GCM' }, false, ['decrypt'])

const sres = await fetch(`${BASE}/api/chat/session`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ channelId: CHANNEL, authHash }),
})
const { token } = await sres.json()

const hres = await fetch(`${BASE}/api/chat/history?limit=100`, { headers: { 'x-session-token': token } })
const { messages } = await hres.json()

let target = null
for (const m of messages) {
  const box = JSON.parse(m.payload)
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBuf(box.iv) }, aesKey, b64ToBuf(box.data))
    const env = JSON.parse(new TextDecoder().decode(pt))
    if (env.file && env.file.name === 'big-test-10mb.bin') target = env.file
  } catch { /* not ours */ }
}
if (!target) throw new Error('未找到大文件消息')

const fres = await fetch(`${BASE}/api/chat/file/${target.fileId}`, { headers: { 'x-session-token': token } })
const wire = new Uint8Array(await fres.arrayBuffer())

const CHUNK = 4 * 1024 * 1024
const parts = []
let off = 0, idx = 0
while (off < wire.length) {
  const blockLen = Math.min(CHUNK + 28, wire.length - off)
  const bytes = wire.subarray(off, off + blockLen)
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytes.subarray(0, 12), additionalData: enc.encode(`f:${target.fileId}:${idx}`) },
    aesKey,
    bytes.subarray(12)
  )
  parts.push(Buffer.from(pt))
  off += blockLen
  idx++
}
const plain = Buffer.concat(parts)
const md5 = (buf) => createHash('md5').update(buf).digest('hex')
const expected = await readFile('/tmp/big-test-10mb.bin')

console.log(`解密: ${plain.length} bytes / 原始: ${expected.length} bytes`)
console.log(`MD5 解密: ${md5(plain)}`)
console.log(`MD5 原始: ${md5(expected)}`)
console.log(md5(plain) === md5(expected) ? '[✓] 10MB 多分块文件解密完全一致！' : '[✗] 不一致！')
