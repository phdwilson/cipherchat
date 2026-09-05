/**
 * CipherChat 桥接客户端
 * 桌面端通过 HTTP 对接 CipherChat 网页后端（含新增 /api/client/*）。
 * 仅上传密文指纹 / 能力宣告，从不上传密码或明文。
 */

import {
  CIPHERCHAT_CLIENT_API,
  type ArchiveMeta,
} from '@cipherzip/shared'
import { deriveCipherChatCompatible } from '../crypto/kdf.js'

export interface BridgeConfig {
  baseUrl: string
  /** 桌面客户端标识 */
  clientId?: string
  userAgent?: string
}

export interface ClientCapabilities {
  version: string
  features: string[]
  p2pPort?: number
  meshWilling?: boolean
  nodeId?: string
}

export class CipherChatBridge {
  private base: string
  private clientId: string
  private token: string | null = null
  private ua: string

  constructor(cfg: BridgeConfig) {
    this.base = cfg.baseUrl.replace(/\/$/, '')
    this.clientId = cfg.clientId || `cz-${Date.now().toString(36)}`
    this.ua = cfg.userAgent || 'CipherZip/1.0'
  }

  private async req(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers || {})
    headers.set('user-agent', this.ua)
    headers.set('x-cipherzip-client', this.clientId)
    if (this.token) headers.set('x-session-token', this.token)
    if (init.body && !headers.has('content-type')) {
      headers.set('content-type', 'application/json')
    }
    return fetch(`${this.base}${path}`, { ...init, headers })
  }

  async health(): Promise<{ ok: boolean; data?: unknown }> {
    try {
      const r = await this.req(CIPHERCHAT_CLIENT_API.health)
      const data = await r.json().catch(() => ({}))
      return { ok: r.ok, data }
    } catch (e) {
      return { ok: false, data: { error: e instanceof Error ? e.message : String(e) } }
    }
  }

  async getConfig(): Promise<Record<string, unknown>> {
    const r = await this.req(CIPHERCHAT_CLIENT_API.config)
    if (!r.ok) throw new Error('获取 CipherChat 配置失败')
    return (await r.json()) as Record<string, unknown>
  }

  /** 注册桌面客户端能力 */
  async register(caps: ClientCapabilities): Promise<{ ok: boolean; clientToken?: string }> {
    const r = await this.req(CIPHERCHAT_CLIENT_API.clientRegister, {
      method: 'POST',
      body: JSON.stringify({ clientId: this.clientId, ...caps }),
    })
    const data = (await r.json().catch(() => ({}))) as { error?: string; clientToken?: string; ok?: boolean }
    if (!r.ok) throw new Error(data.error || '客户端注册失败')
    if (data.clientToken) this.token = data.clientToken
    return { ok: true, clientToken: data.clientToken }
  }

  async heartbeat(extra: Record<string, unknown> = {}): Promise<void> {
    await this.req(CIPHERCHAT_CLIENT_API.clientHeartbeat, {
      method: 'POST',
      body: JSON.stringify({ clientId: this.clientId, ts: Date.now(), ...extra }),
    })
  }

  /** 宣告归档密文指纹（无明文） */
  async announceArchive(info: {
    authHash: string
    size: number
    entryCount: number
    meta?: Partial<ArchiveMeta>
    fingerprint?: string
  }): Promise<void> {
    const r = await this.req(CIPHERCHAT_CLIENT_API.archiveAnnounce, {
      method: 'POST',
      body: JSON.stringify({ clientId: this.clientId, ...info }),
    })
    if (!r.ok) {
      const j = (await r.json().catch(() => ({}))) as { error?: string }
      throw new Error(j.error || '归档宣告失败')
    }
  }

  async lookupArchive(authHash: string): Promise<unknown> {
    const r = await this.req(`${CIPHERCHAT_CLIENT_API.archiveLookup}?authHash=${encodeURIComponent(authHash)}`)
    if (!r.ok) throw new Error('查询失败')
    return r.json()
  }

  /** 加入聊天频道（复用 CipherChat 会话协议） */
  async joinChannel(channelId: string, password: string): Promise<{ token: string; authHash: string }> {
    const keys = await deriveCipherChatCompatible(channelId, password)
    const r = await this.req(CIPHERCHAT_CLIENT_API.chatSession, {
      method: 'POST',
      body: JSON.stringify({
        channelId,
        authHash: keys.authHash,
        probeHash: '',
        pubId: this.clientId,
      }),
    })
    const data = (await r.json().catch(() => ({}))) as { error?: string; token?: string }
    if (!r.ok) throw new Error(data.error || '加入频道失败')
    this.token = data.token || null
    return { token: data.token || '', authHash: keys.authHash }
  }

  /** P2P 信令：发布 offer */
  async signalOffer(room: string, offer: unknown): Promise<void> {
    await this.req(CIPHERCHAT_CLIENT_API.signalOffer, {
      method: 'POST',
      body: JSON.stringify({ room, offer, clientId: this.clientId }),
    })
  }

  async signalAnswer(room: string, answer: unknown): Promise<void> {
    await this.req(CIPHERCHAT_CLIENT_API.signalAnswer, {
      method: 'POST',
      body: JSON.stringify({ room, answer, clientId: this.clientId }),
    })
  }

  async signalPoll(room: string): Promise<unknown> {
    const r = await this.req(`${CIPHERCHAT_CLIENT_API.signalPoll}?room=${encodeURIComponent(room)}&clientId=${encodeURIComponent(this.clientId)}`)
    return r.json()
  }
}
