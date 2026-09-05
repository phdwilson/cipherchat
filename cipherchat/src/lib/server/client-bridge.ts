/**
 * CipherZip 桌面客户端桥接存储（v1.9+）
 * - 仅保存客户端能力宣告、归档密文指纹、P2P 信令
 * - 永不接收/存储密码或明文内容
 * - 使用 DATA_DIR 下 JSON 文件，模块化、可替换为 DB
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { SERVER_CONFIG } from './config'

export interface ClientRecord {
  clientId: string
  clientToken: string
  version: string
  features: string[]
  p2pPort?: number
  meshWilling?: boolean
  nodeId?: string
  lastSeen: number
  createdAt: number
}

export interface ArchiveAnnounce {
  clientId: string
  authHash: string
  size: number
  entryCount: number
  fingerprint?: string
  meta?: Record<string, unknown>
  createdAt: number
}

export interface SignalBox {
  room: string
  offers: Array<{ clientId: string; offer: unknown; ts: number }>
  answers: Array<{ clientId: string; answer: unknown; ts: number }>
}

function rootDir() {
  return join(SERVER_CONFIG.dataDir, 'client-bridge')
}

async function ensure() {
  await mkdir(rootDir(), { recursive: true })
}

async function readJson<T>(name: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(join(rootDir(), name), 'utf8')
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

async function writeJson(name: string, data: unknown) {
  await ensure()
  await writeFile(join(rootDir(), name), JSON.stringify(data, null, 2), 'utf8')
}

export async function registerClient(input: {
  clientId: string
  version?: string
  features?: string[]
  p2pPort?: number
  meshWilling?: boolean
  nodeId?: string
}): Promise<ClientRecord> {
  await ensure()
  const clients = await readJson<Record<string, ClientRecord>>('clients.json', {})
  const existing = clients[input.clientId]
  const rec: ClientRecord = {
    clientId: input.clientId,
    clientToken: existing?.clientToken || randomBytes(24).toString('hex'),
    version: input.version || '1.0.0',
    features: input.features || [],
    p2pPort: input.p2pPort,
    meshWilling: input.meshWilling,
    nodeId: input.nodeId,
    lastSeen: Date.now(),
    createdAt: existing?.createdAt || Date.now(),
  }
  clients[input.clientId] = rec
  await writeJson('clients.json', clients)
  return rec
}

export async function heartbeatClient(clientId: string, extra: Record<string, unknown> = {}) {
  const clients = await readJson<Record<string, ClientRecord>>('clients.json', {})
  const rec = clients[clientId]
  if (!rec) return null
  rec.lastSeen = Date.now()
  if (typeof extra.p2pPort === 'number') rec.p2pPort = extra.p2pPort as number
  if (typeof extra.meshWilling === 'boolean') rec.meshWilling = extra.meshWilling as boolean
  clients[clientId] = rec
  await writeJson('clients.json', clients)
  return rec
}

export async function announceArchive(a: Omit<ArchiveAnnounce, 'createdAt'>) {
  if (!/^[0-9a-f]{64}$/i.test(a.authHash)) throw new Error('authHash 格式无效')
  const list = await readJson<ArchiveAnnounce[]>('archives.json', [])
  const row: ArchiveAnnounce = { ...a, createdAt: Date.now() }
  // 同 authHash 覆盖
  const idx = list.findIndex((x) => x.authHash === a.authHash)
  if (idx >= 0) list[idx] = row
  else list.push(row)
  // 限制 10k 条
  while (list.length > 10_000) list.shift()
  await writeJson('archives.json', list)
  return row
}

export async function lookupArchive(authHash: string) {
  const list = await readJson<ArchiveAnnounce[]>('archives.json', [])
  return list.filter((x) => x.authHash === authHash)
}

export async function listOnlineClients(maxAgeMs = 5 * 60_000) {
  const clients = await readJson<Record<string, ClientRecord>>('clients.json', {})
  const now = Date.now()
  return Object.values(clients).filter((c) => now - c.lastSeen <= maxAgeMs)
}

export async function putSignalOffer(room: string, clientId: string, offer: unknown) {
  const all = await readJson<Record<string, SignalBox>>('signals.json', {})
  const box = all[room] || { room, offers: [], answers: [] }
  box.offers.push({ clientId, offer, ts: Date.now() })
  // 保留最近 20 条
  box.offers = box.offers.slice(-20)
  all[room] = box
  await writeJson('signals.json', all)
}

export async function putSignalAnswer(room: string, clientId: string, answer: unknown) {
  const all = await readJson<Record<string, SignalBox>>('signals.json', {})
  const box = all[room] || { room, offers: [], answers: [] }
  box.answers.push({ clientId, answer, ts: Date.now() })
  box.answers = box.answers.slice(-20)
  all[room] = box
  await writeJson('signals.json', all)
}

export async function pollSignal(room: string, clientId: string) {
  const all = await readJson<Record<string, SignalBox>>('signals.json', {})
  const box = all[room] || { room, offers: [], answers: [] }
  return {
    offers: box.offers.filter((o) => o.clientId !== clientId),
    answers: box.answers.filter((a) => a.clientId !== clientId),
  }
}
