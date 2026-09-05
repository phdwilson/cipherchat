'use client'
// v1.5.0 安全审计 + 离线信箱 + DMS 客户端辅助

export interface AuditData {
  me: { pubId: string; currentSessionId: string }
  sessions: Array<{
    id: string; device: string; ip: string; disclosure?: string
    createdAt: string; lastSeenAt: string; expiresAt: string; isCurrent: boolean
  }>
  invites: Array<{ code: string; role: string; uses: number; maxUses: number; expiresAt: string }>
  roles: Array<{ channelKeyId: string; role: string; joinedAt: string }>
  identityRegistered: boolean
  dmsEnabled: boolean
  dms: { graceDays: number; action: string; lastCheckIn: string } | null
}

async function authHeaders(token: string) {
  return { 'content-type': 'application/json', 'x-session-token': token }
}

export async function fetchAudit(token: string): Promise<AuditData> {
  const res = await fetch('/api/chat/audit', { headers: { 'x-session-token': token } })
  const d = await res.json()
  if (!res.ok) throw new Error(d?.error || '获取审计数据失败')
  return d as AuditData
}

export async function revokeSession(token: string, sessionId: string): Promise<void> {
  const res = await fetch('/api/chat/audit', {
    method: 'DELETE',
    headers: await authHeaders(token),
    body: JSON.stringify({ sessionId }),
  })
  const d = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(d?.error || '吊销失败')
}

// ---------------- X25519 设备身份（离线信箱） ----------------
// 密钥对一次性生成并持久化到 localStorage；公钥注册到服务器供他人加密离线信件，
// 私钥永不上传 —— 服务器仅存公钥，零知识。
function b64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}
function unb64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
const te = new TextEncoder()

// 生成或恢复本机信箱身份
export async function ensureMailboxIdentity(): Promise<{ publicKeyB64: string }> {
  try {
    const saved = localStorage.getItem('cipherchat:mailbox-ident')
    if (saved) return JSON.parse(saved)
  } catch { /* ignore */ }
  const pair = await crypto.subtle.generateKey({ name: 'X25519' } as AlgorithmIdentifier, true, ['deriveKey']) as CryptoKeyPair
  const privRaw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.privateKey))
  const pubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
  const out = { publicKeyB64: b64(pubRaw), _privHint: b64(privRaw.slice(0, 8)) + '…' }
  localStorage.setItem('cipherchat:mailbox-ident', JSON.stringify(out))
  // 私钥本体单独存储（同源隔离已足够；不随任何请求上传）
  localStorage.setItem('cipherchat:mailbox-priv', b64(privRaw))
  return out
}

export async function getMailboxPrivateKeyAsync(): Promise<CryptoKey> {
  let rawB64 = ''
  try { rawB64 = localStorage.getItem('cipherchat:mailbox-priv') || '' } catch { /* ignore */ }
  if (!rawB64) throw new Error('本机尚未生成信箱身份')
  return crypto.subtle.importKey('raw', unb64(rawB64), { name: 'X25519' } as AlgorithmIdentifier, false, ['deriveKey'])
}

// 注册公钥到服务器
export async function registerMailboxIdentity(token: string): Promise<string> {
  const ident = await ensureMailboxIdentity()
  const res = await fetch('/api/chat/mailbox', {
    method: 'PUT',
    headers: await authHeaders(token),
    body: JSON.stringify({ publicKey: ident.publicKeyB64 }),
  })
  if (!res.ok) {
    const d = await res.json().catch(() => ({}))
    throw new Error(d?.error || '注册身份失败')
  }
  return ident.publicKeyB64
}

// 加密一封离线信件（ECDH(X25519) → AES-256-GCM）
export async function sealMailboxEnvelope(recipientPubKeyB64: string, plaintextObj: unknown, senderPriv: CryptoKey): Promise<string> {
  const recipientPub = await crypto.subtle.importKey('raw', unb64(recipientPubKeyB64), { name: 'X25519' } as AlgorithmIdentifier, false, [])
  const aes = await crypto.subtle.deriveKey(
    { name: 'X25519', public: recipientPub }, senderPriv,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt'],
  )
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    aes,
    te.encode(JSON.stringify(plaintextObj)) as Uint8Array<ArrayBuffer>,
  )
  return JSON.stringify({ v: 1, iv: b64(iv), data: b64(ct) })
}

// 解密收到的信件
export async function openMailboxEnvelope<T = unknown>(envelopeStr: string, myPriv: CryptoKey, senderPublicKeyB64: string | null): Promise<T | null> {
  try {
    const env = JSON.parse(envelopeStr) as { iv: string; data: string; senderPub?: string }
    const senderPubB64: string | undefined = env.senderPub || senderPublicKeyB64 || undefined
    if (!senderPubB64) return null
    const senderPub = await crypto.subtle.importKey('raw', unb64(senderPubB64), { name: 'X25519' } as AlgorithmIdentifier, false, [])
    const aes = await crypto.subtle.deriveKey(
      { name: 'X25519', public: senderPub }, myPriv,
      { name: 'AES-GCM', length: 256 }, false, ['decrypt'],
    )
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(env.iv) }, aes, unb64(env.data),
    )
    return JSON.parse(new TextDecoder().decode(pt)) as T
  } catch {
    return null
  }
}

// 发送离线信件（自动查询对方公钥 + 加密 + 投递）
export async function sendOfflineLetter(token: string, toPubId: string, content: unknown): Promise<void> {
  const qRes = await fetch(`/api/chat/mailbox?pubId=${encodeURIComponent(toPubId)}`, { headers: { 'x-session-token': token } })
  const q = await qRes.json()
  if (!qRes.ok || !q.publicKey) throw new Error(q?.error || '对方未开启离线信箱')
  const myPriv = await getMailboxPrivateKeyAsync()
  const myIdent = await ensureMailboxIdentity()
  const envelope = await sealMailboxEnvelope(q.publicKey, { ...(content as object), senderPub: myIdent.publicKeyB64 }, myPriv)
  const res = await fetch('/api/chat/mailbox', {
    method: 'POST',
    headers: await authHeaders(token),
    body: JSON.stringify({ toPubId, envelope }),
  })
  const d = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(d?.error || '投递失败')
}

// 收取全部离线信件并本地解密
export async function fetchOfflineLetters(token: string): Promise<Array<{ from: string; at: string; content: unknown }>> {
  const res = await fetch('/api/chat/mailbox', {
    method: 'DELETE',
    headers: { 'x-session-token': token },
  })
  const d = await res.json()
  if (!res.ok) throw new Error(d?.error || '收取失败')
  const myPriv = await getMailboxPrivateKeyAsync()
  const out: Array<{ from: string; at: string; content: unknown }> = []
  for (const item of d.items || []) {
    // DMS 系统通知为明文标记
    if (item.from === 'system:dms') {
      out.push({ from: item.from, at: item.at, content: item.envelope })
      continue
    }
    const opened = await openMailboxEnvelope<Record<string, unknown>>(item.envelope, myPriv, null)
    if (opened) out.push({ from: item.from, at: item.at, content: opened })
  }
  return out
}

// ---------------- DMS 用户端 ----------------
export interface DmsStatus {
  enabled: boolean
  armed: { graceDays: number; action: string; notifyMailbox: string | null; lastCheckIn: string; deadline: string } | null
}
export async function fetchDmsStatus(token: string): Promise<DmsStatus> {
  const res = await fetch('/api/chat/dms', { headers: { 'x-session-token': token } })
  const d = await res.json()
  if (!res.ok) throw new Error(d?.error || '查询失败')
  return d as DmsStatus
}
export async function armDms(token: string, graceDays: number, action: 'wipe' | 'notify', notifyMailbox?: string): Promise<void> {
  const res = await fetch('/api/chat/dms', {
    method: 'POST',
    headers: await authHeaders(token),
    body: JSON.stringify({ graceDays, action, notifyMailbox }),
  })
  const d = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(d?.error || '设置失败')
}
export async function disarmDms(token: string): Promise<void> {
  const res = await fetch('/api/chat/dms', { method: 'DELETE', headers: { 'x-session-token': token } })
  const d = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(d?.error || '撤防失败')
}

// (预留标记已移至文件头)
