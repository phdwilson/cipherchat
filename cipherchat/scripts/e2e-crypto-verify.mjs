// E2E 加密协议完整性验证脚本（模拟一个独立客户端，仅用公开 API + 相同密码）
// 验证：密钥派生一致性 / 历史消息解密 / 文件密文下载后逐块解密还原
import { webcrypto as crypto } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const BASE = 'http://localhost:3000'
const CHANNEL = 'e2e-test-room'
const PASSWORD = 'TestPass2024!secure'

const enc = new TextEncoder()
const dec = new TextDecoder()

function toHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')
}

function b64ToBuf(b64) {
  const bin = Buffer.from(b64, 'base64')
  return new Uint8Array(bin)
}

async function pbkdf2(password, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations }, base, 256))
}

async function openJSON(key, sealed) {
  const box = JSON.parse(sealed)
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBuf(box.iv) }, key, b64ToBuf(box.data))
  return JSON.parse(dec.decode(pt))
}

async function decryptChunk(key, fileId, index, wire) {
  const bytes = new Uint8Array(wire)
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytes.subarray(0, 12), additionalData: enc.encode(`f:${fileId}:${index}`) },
    key,
    bytes.subarray(12)
  )
  return new Uint8Array(pt)
}

// ---- 主流程 ----
const authHash = toHex(await pbkdf2(PASSWORD, 'cipherchat:auth:' + CHANNEL, 120000))
const keyBits = await pbkdf2(PASSWORD, 'cipherchat:key:' + CHANNEL, 310000)
const aesKey = await crypto.subtle.importKey('raw', keyBits, { name: 'AES-GCM' }, false, ['decrypt'])

console.log('[1] 密钥派生完成 authHash =', authHash.slice(0, 16) + '…')

const sres = await fetch(`${BASE}/api/chat/session`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ channelId: CHANNEL, authHash }),
})
if (!sres.ok) throw new Error('session 创建失败: ' + sres.status)
const { token } = await sres.json()
console.log('[2] 第三个客户端会话建立成功')

const hres = await fetch(`${BASE}/api/chat/history?limit=100`, { headers: { 'x-session-token': token } })
const { messages } = await hres.json()
console.log(`[3] 拉取到 ${messages.length} 条历史消息`)

let fileId = null
for (const m of messages) {
  const env = await openJSON(aesKey, m.payload)
  console.log(`    • [${env.nick}] ${env.kind === 'text' ? `"${env.text}"` : `文件: ${env.file.name} (${env.file.size}B)`}`)
  if (env.kind === 'file') fileId = env.file
}

if (!fileId) throw new Error('历史中未找到文件消息')
console.log(`[4] 找到文件消息: ${fileId.name}，开始下载密文并解密…`)

const fres = await fetch(`${BASE}/api/chat/file/${fileId.fileId}`, { headers: { 'x-session-token': token } })
if (!fres.ok) throw new Error('文件下载失败: ' + fres.status)
const wire = new Uint8Array(await fres.arrayBuffer())
console.log(`    密文长度: ${wire.length} bytes`)

// 按块解密（与服务端写入块对齐）
const CHUNK = 4 * 1024 * 1024
const parts = []
let off = 0
let idx = 0
while (off < wire.length) {
  const blockLen = Math.min(CHUNK + 28, wire.length - off)
  parts.push(await decryptChunk(aesKey, fileId.fileId, idx, wire.subarray(off, off + blockLen)))
  off += blockLen
  idx++
}
const plain = Buffer.concat(parts)
const expected = Buffer.from(await readFile('/tmp/test-doc.txt'))
console.log(`[5] 解密还原 ${plain.length} bytes`)

if (plain.equals(expected)) {
  console.log('[✓] 文件解密结果与原始文件逐字节一致 — 端到端加密完整回路验证通过！')
} else {
  throw new Error('解密结果与原文件不一致！')
}

// 验证错误密码无法解密（负向测试）
const badBits = await pbkdf2('wrong-password', 'cipherchat:key:' + CHANNEL, 310000)
const badKey = await crypto.subtle.importKey('raw', badBits, { name: 'AES-GCM' }, false, ['decrypt'])
let failed = false
try {
  await openJSON(badKey, messages[0].payload)
} catch {
  failed = true
}
console.log(failed ? '[✓] 错误密码无法解密任何内容（安全验证通过）' : '[✗] 警告：错误密码竟然解密成功！')
