/**
 * 内置小型 P2P 服务器 / 客户端
 * - TCP JSON 行协议（每行一个 JSON 消息）
 * - 端到端：握手后用 ECDH 派生会话密钥，后续 payload 均为 AES-GCM 密封
 * - 支持：chat 文本、file 分块传输、ping、mesh 宣告
 */

import { createServer, connect, type Server, type Socket } from 'node:net'
import { createHash, randomBytes } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { seal, open } from '../crypto/aead.js'
import {
  encodeShareCode,
  encodeShareQr,
  decodeShareCode,
  decodeShareQr,
  generateP2PIdentity,
  deriveSessionKey,
  randomNick,
} from './sharecode.js'
import type { SharePayload } from '@cipherzip/shared'

export type P2PMessage =
  | { type: 'hello'; nick: string; pub: string; caps: string[] }
  | { type: 'hello-ok'; nick: string; pub: string }
  | { type: 'chat'; text: string; ts: number }
  | { type: 'file-meta'; name: string; size: number; sha256: string; id: string }
  | { type: 'file-chunk'; id: string; index: number; total: number; data: string }
  | { type: 'file-done'; id: string }
  | { type: 'mesh-announce'; nodeId: string; free: number }
  | { type: 'ping'; t: number }
  | { type: 'pong'; t: number }
  | { type: 'error'; message: string }

export interface P2PPeer {
  id: string
  nick: string
  socket: Socket
  sessionKey?: Buffer
  remotePub?: string
}

export interface P2PEvents {
  onChat?: (peer: P2PPeer, text: string) => void
  onFileReceived?: (peer: P2PPeer, path: string) => void
  onPeer?: (peer: P2PPeer, joined: boolean) => void
  onLog?: (msg: string) => void
}

export class P2PNode {
  private server: Server | null = null
  private identity = generateP2PIdentity()
  private peers = new Map<string, P2PPeer>()
  private nick: string
  private caps: string[]
  private downloadDir: string
  private port = 0
  private host = '0.0.0.0'
  private events: P2PEvents
  private fileBuffers = new Map<string, { name: string; chunks: Buffer[]; total: number; peer: P2PPeer }>()

  constructor(opts: { nick?: string; caps?: string[]; downloadDir?: string; events?: P2PEvents } = {}) {
    this.nick = opts.nick || randomNick()
    this.caps = opts.caps || ['chat', 'file']
    this.downloadDir = opts.downloadDir || join(process.cwd(), 'cipherzip-inbox')
    this.events = opts.events || {}
  }

  get publicKey() {
    return this.identity.publicKey
  }

  get listenPort() {
    return this.port
  }

  async start(port = 0, host = '0.0.0.0'): Promise<number> {
    this.host = host
    await mkdir(this.downloadDir, { recursive: true })
    return new Promise((resolve, reject) => {
      this.server = createServer((socket) => this.accept(socket))
      this.server.on('error', reject)
      this.server.listen(port, host, () => {
        const addr = this.server!.address()
        this.port = typeof addr === 'object' && addr ? addr.port : port
        this.events.onLog?.(`P2P 节点已监听 ${host}:${this.port}`)
        resolve(this.port)
      })
    })
  }

  async stop() {
    for (const p of this.peers.values()) p.socket.destroy()
    this.peers.clear()
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) || resolve())
  }

  /** 生成分享码（需提供对外可达 host） */
  makeShare(publicHost: string, ttlMs = 24 * 3600_000): { code: string; qr: string; payload: SharePayload } {
    const payload: SharePayload = {
      v: 1,
      host: publicHost,
      port: this.port,
      pub: this.identity.publicKey,
      caps: this.caps,
      exp: Date.now() + ttlMs,
      nick: this.nick,
    }
    return { code: encodeShareCode(payload), qr: encodeShareQr(payload), payload }
  }

  /** 通过分享码或二维码 JSON 连接对方 */
  async connectShare(codeOrQr: string): Promise<P2PPeer> {
    let host: string
    let port: number
    let peerPub: string | undefined
    const trimmed = codeOrQr.trim()
    if (trimmed.startsWith('{')) {
      const p = decodeShareQr(trimmed)
      host = p.host
      port = p.port
      peerPub = p.pub
    } else {
      const p = decodeShareCode(trimmed)
      host = p.host
      port = p.port
    }
    return this.connect(host, port, peerPub)
  }

  async connect(host: string, port: number, _peerPub?: string): Promise<P2PPeer> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host, port }, () => {
        const peer = this.wireSocket(socket, true)
        // 主动方先发 hello
        this.sendRaw(peer, {
          type: 'hello',
          nick: this.nick,
          pub: this.identity.publicKey,
          caps: this.caps,
        })
        const onHelloOk = (msg: P2PMessage) => {
          if (msg.type === 'hello-ok') {
            peer.nick = msg.nick
            peer.remotePub = msg.pub
            peer.sessionKey = deriveSessionKey(this.identity.privateKey, msg.pub, 'cipherzip-p2p-v1')
            this.events.onPeer?.(peer, true)
            resolve(peer)
          }
        }
        ;(peer as P2PPeer & { _once?: (m: P2PMessage) => void })._once = onHelloOk
      })
      socket.on('error', reject)
    })
  }

  sendChat(peer: P2PPeer, text: string) {
    this.sendSecure(peer, { type: 'chat', text, ts: Date.now() })
  }

  async sendFile(peer: P2PPeer, filePath: string, onProgress?: (i: number, n: number) => void) {
    const data = await readFile(filePath)
    const id = randomBytes(8).toString('hex')
    const sha256 = createHash('sha256').update(data).digest('hex')
    const name = basename(filePath)
    const chunkSize = 64 * 1024
    const total = Math.max(1, Math.ceil(data.length / chunkSize))
    this.sendSecure(peer, { type: 'file-meta', name, size: data.length, sha256, id })
    for (let i = 0; i < total; i++) {
      const slice = data.subarray(i * chunkSize, Math.min((i + 1) * chunkSize, data.length))
      this.sendSecure(peer, {
        type: 'file-chunk',
        id,
        index: i,
        total,
        data: slice.toString('base64'),
      })
      onProgress?.(i + 1, total)
    }
    this.sendSecure(peer, { type: 'file-done', id })
  }

  private accept(socket: Socket) {
    const peer = this.wireSocket(socket, false)
    this.events.onLog?.(`新连接 ${socket.remoteAddress}`)
  }

  private wireSocket(socket: Socket, _outbound: boolean): P2PPeer {
    const id = randomBytes(8).toString('hex')
    const peer: P2PPeer = { id, nick: '未知', socket }
    this.peers.set(id, peer)
    let buf = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      buf += chunk
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + 1)
        if (!line.trim()) continue
        try {
          this.onLine(peer, line)
        } catch (e) {
          this.events.onLog?.(`协议错误: ${e instanceof Error ? e.message : e}`)
        }
      }
    })
    socket.on('close', () => {
      this.peers.delete(id)
      this.events.onPeer?.(peer, false)
    })
    return peer
  }

  private onLine(peer: P2PPeer, line: string) {
    let msg: P2PMessage
    // 加密帧：{"e":"<base64>"}
    const raw = JSON.parse(line) as P2PMessage | { e: string }
    if ('e' in raw && typeof (raw as { e: string }).e === 'string') {
      if (!peer.sessionKey) throw new Error('尚未完成握手')
      const plain = open(peer.sessionKey, Buffer.from((raw as { e: string }).e, 'base64'))
      msg = JSON.parse(plain.toString('utf8')) as P2PMessage
    } else {
      msg = raw as P2PMessage
    }

    const once = (peer as P2PPeer & { _once?: (m: P2PMessage) => void })._once
    if (once) {
      once(msg)
      delete (peer as P2PPeer & { _once?: unknown })._once
    }

    switch (msg.type) {
      case 'hello': {
        peer.nick = msg.nick
        peer.remotePub = msg.pub
        peer.sessionKey = deriveSessionKey(this.identity.privateKey, msg.pub, 'cipherzip-p2p-v1')
        this.sendRaw(peer, { type: 'hello-ok', nick: this.nick, pub: this.identity.publicKey })
        this.events.onPeer?.(peer, true)
        break
      }
      case 'chat':
        this.events.onChat?.(peer, msg.text)
        break
      case 'file-meta': {
        this.fileBuffers.set(msg.id, { name: msg.name, chunks: [], total: 0, peer })
        break
      }
      case 'file-chunk': {
        const fb = this.fileBuffers.get(msg.id)
        if (!fb) break
        fb.total = msg.total
        fb.chunks[msg.index] = Buffer.from(msg.data, 'base64')
        break
      }
      case 'file-done': {
        const fb = this.fileBuffers.get(msg.id)
        if (!fb) break
        const data = Buffer.concat(fb.chunks.filter(Boolean))
        const dest = join(this.downloadDir, fb.name)
        writeFile(dest, data).then(() => {
          this.events.onFileReceived?.(peer, dest)
          this.fileBuffers.delete(msg.id)
        })
        break
      }
      case 'ping':
        this.sendSecure(peer, { type: 'pong', t: msg.t })
        break
      default:
        break
    }
  }

  private sendRaw(peer: P2PPeer, msg: P2PMessage) {
    peer.socket.write(JSON.stringify(msg) + '\n')
  }

  private sendSecure(peer: P2PPeer, msg: P2PMessage) {
    if (!peer.sessionKey) {
      this.sendRaw(peer, msg)
      return
    }
    const wire = seal(peer.sessionKey, Buffer.from(JSON.stringify(msg), 'utf8'))
    peer.socket.write(JSON.stringify({ e: wire.toString('base64') }) + '\n')
  }

  listPeers(): Array<{ id: string; nick: string }> {
    return [...this.peers.values()].map((p) => ({ id: p.id, nick: p.nick }))
  }
}
