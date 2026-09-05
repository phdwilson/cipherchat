'use client'
// WebRTC 语音管理器
// 架构：mesh 拓扑（每人与其他人各建一条 RTCPeerConnection）
// 信令：socket.io voice:signal 事件，payload 用频道密钥 sealJSON 加密
// 音频：WebRTC SRTP 自带加密，P2P 直传不经过服务器；中继模式下经 TURN 转发
//
// 三种使用场景：
// 1. 频道语音（多人 mesh）：join(socket, channelKey, myPubId) + voice:join/voice:signal
// 2. 语音开黑大厅（Discord 风格 lobby）：joinLobby(socket, lobbyId, myPubId) + voice:lobby:* 信令（lobbyId 用作种子派生签名密钥）
// 3. 私聊 1v1 通话：startCall / acceptCall / endCall，用 chat:whisper 通道传输 SDP/ICE
//
// ★ v1.3.1 修复：
// - ICE 服务器不再硬编码，由调用方在初始化前 fetch /api/config 拿到 turnConfig 后注入
// - pc.onconnectionstatechange 在 failed/disconnected 时回调 onError 而非静默关闭
// - 新增 onPeerStateChange(pubId, state) 让 UI 显示每对连接的质量（P2P / 中继 / 失败）
// - 新增 ICE gathering 超时检测（5s 内无候选则提示网络穿透困难）
//
// ★ v1.8.0 修复：
// - ICE 配置获取失败不再静默回退 —— toast 告知原因与修复方式
// - time-limited 短期 TURN 凭证自动 45 分钟轮换（过期后 ICE 会突然全断的隐患）

import type { Socket } from 'socket.io-client'
import { toast } from 'sonner'
import { sealJSON, openJSON, type SealedBox } from '@/lib/crypto'

// ============== ICE 服务器运行时配置 ==============
// 由 fetchIceServers() 从服务端拉取（管理员后台配置的 TURN + 默认 STUN）
export interface IceServerConfig {
  stunServers: string[]       // STUN 服务器列表
  turnServers: string[]       // TURN 服务器 URL 列表（不含凭证）
  turnEnabled: boolean        // 是否启用 TURN
  turnUsername?: string       // 长期凭证用户名（static 模式）
  turnCredential?: string     // 长期凭证密码（static 模式）
  turnSecretMode: 'static' | 'time-limited'  // static=长期凭证 time-limited=短期凭证（需轮询）
}

const DEFAULT_ICE: IceServerConfig = {
  stunServers: [
    'stun:stun.l.google.com:19302',
    'stun:stun1.google.com:19302',
    'stun:stun.cloudflare.com:3478',
  ],
  turnServers: [],
  turnEnabled: false,
  turnSecretMode: 'static',
}

// 内存缓存（首次获取后保留供后续 VoiceManager 实例使用；可手动 refresh）
let cachedIce: IceServerConfig | null = null
// v1.8.0：time-limited 模式下的短期凭证（45 分钟轮换，防 ICE 突然全断）
let turnCredExpiresAt = 0
let turnRefreshTimer: ReturnType<typeof setInterval> | null = null

export async function fetchIceServers(): Promise<IceServerConfig> {
  if (cachedIce) return cachedIce
  try {
    const r = await fetch('/api/config')
    const d = await r.json()
    if (d?.turn) {
      const base: IceServerConfig = {
        stunServers: Array.isArray(d.turn.stunServers) && d.turn.stunServers.length > 0
          ? d.turn.stunServers : DEFAULT_ICE.stunServers,
        turnServers: Array.isArray(d.turn.servers) ? d.turn.servers : [],
        turnEnabled: !!d.turn.enabled,
        turnUsername: d.turn.username,
        turnCredential: d.turn.credential,
        turnSecretMode: d.turn.secretMode === 'time-limited' ? 'time-limited' : 'static',
      }
      // v1.7.0：公开 /api/config 不再下发凭证 —— 需要 TURN 时从专用端点签发
      //（time-limited 模式拿短期凭证；static 模式拿长期凭证）
      if (base.turnEnabled && (!base.turnUsername || !base.turnCredential)) {
        try {
          const cr = await fetch('/api/voice/turn-credentials')
          if (cr.ok) {
            const c = await cr.json()
            if (c?.username && c?.credential) {
              base.turnUsername = c.username
              base.turnCredential = c.credential
              // v1.8.0：短期凭证记录过期时间并启动 45 分钟轮换
              if (base.turnSecretMode === 'time-limited' && c.expiresAt) {
                turnCredExpiresAt = Number(c.expiresAt) * 1000
                scheduleTurnRefresh()
              }
            }
          } else {
            // v1.8.0：凭证签发失败不再静默 —— 明确告知影响（语音将退化为直连）
            toast.warning('TURN 凭证获取失败，语音将尝试直连', {
              description: `原因：${cr.status === 429 ? '请求过于频繁被限流' : cr.status === 403 ? 'TURN 未启用或密钥未配置' : '凭证服务返回 ' + cr.status}。\n处理：直连（P2P）在同网段仍可用；跨网络若无声，请联系管理员在后台「自检」页检查 TURN 配置。`,
              duration: 10000,
            })
          }
        } catch (err) {
          // v1.8.0：网络层失败同样告知
          toast.warning('TURN 凭证获取失败，语音将尝试直连', {
            description: `原因：${err instanceof Error ? err.message : '网络错误'}。\n处理：检查网络后重进语音；跨网络无声请联系管理员检查 TURN。`,
            duration: 10000,
          })
        }
      }
      cachedIce = base
    } else {
      cachedIce = DEFAULT_ICE
    }
  } catch (e) {
    // v1.8.0：配置拉取失败不再静默回退 —— 告知原因与影响（此前用户只会觉得"语音莫名连不上"）
    toast.warning('语音服务器配置获取失败，使用默认直连配置', {
      description: `原因：${e instanceof Error ? e.message : '网络错误'}（服务器不可达或网关异常）。\n处理：刷新页面重试；跨网络通话需要 TURN 中继，若持续失败请联系管理员运行「一键自检」。`,
      duration: 10000,
    })
    cachedIce = DEFAULT_ICE
  }
  return cachedIce
}

// v1.8.0：短期 TURN 凭证自动轮换 —— 在过期前 15 分钟拉新凭证并刷新缓存
// 不刷新的话：凭证过期后所有新建 ICE 候选全部 401，语音"突然全断且不知原因"
function scheduleTurnRefresh() {
  if (turnRefreshTimer) clearInterval(turnRefreshTimer)
  if (!turnCredExpiresAt) return
  turnRefreshTimer = setInterval(() => {
    void (async () => {
      const remainMs = turnCredExpiresAt - Date.now()
      if (remainMs > 15 * 60_000) return // 距过期还早，不动
      try {
        const cr = await fetch('/api/voice/turn-credentials')
        if (!cr.ok) return
        const c = await cr.json()
        if (c?.username && c?.credential && cachedIce) {
          cachedIce.turnUsername = c.username
          cachedIce.turnCredential = c.credential
          turnCredExpiresAt = Number(c.expiresAt) * 1000 || (Date.now() + 45 * 60_000)
        }
      } catch { /* 轮换失败保留旧凭证；下一次 tick 再试 */ }
    })()
  }, 5 * 60_000)
  // 页面卸载时清理
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', () => {
      if (turnRefreshTimer) clearInterval(turnRefreshTimer)
    }, { once: true })
  }
}

// 强制刷新（管理员后台改了 TURN 配置后客户端可主动刷新）
export function refreshIceServersCache() {
  cachedIce = null
  turnCredExpiresAt = 0
  if (turnRefreshTimer) { clearInterval(turnRefreshTimer); turnRefreshTimer = null }
}

// ============== 内部工具：构造 ICE 服务器数组 ==============
function buildIceServers(cfg: IceServerConfig, opts: { forceRelay: boolean }): RTCIceServer[] {
  const list: RTCIceServer[] = cfg.stunServers.map((u) => ({ urls: u }))
  if (cfg.turnEnabled && cfg.turnServers.length > 0 && cfg.turnUsername && cfg.turnCredential) {
    for (const u of cfg.turnServers) {
      list.push({
        urls: u,
        username: cfg.turnUsername,
        credential: cfg.turnCredential,
      })
    }
  }
  return list
}

// ============== 连接质量状态 ==============
// 与 RTCIceConnectionState / RTCPeerConnectionState 对齐但简化为 UI 友好版本
export type PeerConnState =
  | 'new'           // 刚创建
  | 'connecting'    // ICE 协商中
  | 'p2p'           // 已连接，走 host / srflx（P2P 直连）
  | 'relay'         // 已连接，走 TURN 中继
  | 'failed'        // 失败（无法穿透或对方不响应）
  | 'disconnected'  // 临时断开（可能恢复）
  | 'closed'        // 已关闭

export type LobbyMode = 'relay' | 'p2p'

interface VoiceParticipant { pubId: string; muted: boolean; speaking?: boolean }

export type VoiceMode = 'channel' | 'lobby' | 'dm'

export class VoiceManager {
  private socket: Socket | null = null
  private channelKey: CryptoKey | null = null // 频道密钥（用于 channel/dm 模式信令加密）
  private myPubId = ''
  private mode: VoiceMode = 'channel'
  private lobbyId = ''
  private lobbyMode: LobbyMode = 'p2p' // 大厅传输模式：relay/p2p。相同 lobbyId+不同 lobbyMode 是两个独立频道
  private callPeerPubId = '' // DM 通话目标
  private iceCfg: IceServerConfig = DEFAULT_ICE

  private localStream: MediaStream | null = null
  private screenStream: MediaStream | null = null
  private peers = new Map<string, RTCPeerConnection>()
  private peerStates = new Map<string, PeerConnState>()
  private remoteStreams = new Map<string, MediaStream>()
  private participants: VoiceParticipant[] = []
  private audioContext: AudioContext | null = null
  private analysers = new Map<string, AnalyserNode>()
  private speakingTimers = new Map<string, ReturnType<typeof setTimeout>>()
  // ICE gathering 超时计时器
  private gatheringTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private gatheringWarned = new Set<string>()

  // PTT 模式：按下键才广播音频；松开键静音
  private pttEnabled = false
  private pttActive = false
  // 自由讲话（VAD）：根据音量自动判断 speaking
  private vadEnabled = true

  onRemoteStream: ((pubId: string, stream: MediaStream | null) => void) | null = null
  onParticipantsChange: ((list: VoiceParticipant[]) => void) | null = null
  onSpeakingChange: ((pubId: string, speaking: boolean) => void) | null = null
  onMutedChange: ((muted: boolean) => void) | null = null
  onPttActiveChange: ((active: boolean) => void) | null = null
  onError: ((msg: string) => void) | null = null
  // ★ v1.3.1 新增：每对 peer 的连接质量状态变化回调
  onPeerStateChange: ((pubId: string, state: PeerConnState) => void) | null = null

  // DM 通话事件回调
  onCallIncoming: ((fromPubId: string) => void) | null = null
  onCallAccepted: ((peerPubId: string) => void) | null = null
  onCallRejected: ((peerPubId: string) => void) | null = null
  onCallEnded: ((peerPubId: string) => void) | null = null
  onCallError: ((msg: string) => void) | null = null

  private muted = false

  // ============== 0. 设置 ICE 配置 ==============
  // 必须在 join/joinLobby/startCall/acceptCall 之前调用
  async setIceConfig(cfg: IceServerConfig) {
    this.iceCfg = cfg
  }

  // ============== 1. 频道语音（多人 mesh） ==============
  async join(socket: Socket, channelKey: CryptoKey, myPubId: string) {
    this.socket = socket
    this.channelKey = channelKey
    this.myPubId = myPubId
    this.mode = 'channel'

    if (!await this.ensureMic()) return false
    this.setupMicAnalyser('_self')
    this.attachChannelHandlers()
    socket.emit('voice:join')
    return true
  }

  // ============== 2. 语音开黑大厅（Discord lobby） ==============
  async joinLobby(socket: Socket, lobbyKey: CryptoKey, myPubId: string, lobbyId: string, lobbyMode: LobbyMode = 'p2p') {
    this.socket = socket
    this.channelKey = lobbyKey
    this.myPubId = myPubId
    this.mode = 'lobby'
    this.lobbyId = lobbyId
    this.lobbyMode = lobbyMode

    if (!await this.ensureMic()) return false
    this.setupMicAnalyser('_self')
    this.attachLobbyHandlers()
    socket.emit('voice:lobby:join', { lobbyId, mode: lobbyMode })
    return true
  }

  // ============== 3. 私聊 1v1 通话 ==============
  async startCall(socket: Socket, channelKey: CryptoKey, myPubId: string, peerPubId: string): Promise<boolean> {
    this.socket = socket
    this.channelKey = channelKey
    this.myPubId = myPubId
    this.mode = 'dm'
    this.callPeerPubId = peerPubId

    if (!await this.ensureMic()) return false
    this.setupMicAnalyser('_self')
    this.attachDMCallHandlers()

    const payload = await sealJSON(channelKey, { type: 'invite' })
    socket.emit('voice:call:invite', { toPubId: peerPubId, payload })
    return true
  }

  async acceptCall(socket: Socket, channelKey: CryptoKey, myPubId: string, peerPubId: string): Promise<boolean> {
    this.socket = socket
    this.channelKey = channelKey
    this.myPubId = myPubId
    this.mode = 'dm'
    this.callPeerPubId = peerPubId

    if (!await this.ensureMic()) return false
    this.setupMicAnalyser('_self')
    this.attachDMCallHandlers()

    const payload = await sealJSON(channelKey, { type: 'accept' })
    socket.emit('voice:call:accept', { toPubId: peerPubId, payload })
    return true
  }

  endCall() {
    if (this.mode === 'dm' && this.channelKey && this.socket) {
      // v1.7.0：局部捕获 socket —— 挂断信令异步加密期间 this.socket 可能已被
      // leave() 置空，此前 ?.emit 静默吞掉结束信令，对方会一直挂在通话中
      const sock = this.socket
      const peer = this.callPeerPubId
      sealJSON(this.channelKey, { type: 'end' }).then((p) => {
        sock.emit('voice:call:end', { toPubId: peer, payload: p })
      }).catch(() => {})
    }
    this.teardownCall()
  }

  private teardownCall() {
    for (const pubId of [...this.peers.keys()]) this.closePeer(pubId)
    this.callPeerPubId = ''
    this.detachDMCallHandlers()
    this.stopLocalMic()
  }

  // ============== 共用：麦克风初始化 ==============
  private async ensureMic(): Promise<boolean> {
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
      if (this.pttEnabled) {
        this.localStream.getAudioTracks().forEach((t) => (t.enabled = false))
      }
      return true
    } catch (e) {
      this.onError?.(e instanceof Error ? e.message : '麦克风权限被拒绝')
      return false
    }
  }

  private setupMicAnalyser(pubId: string) {
    if (!this.localStream) return
    try {
      this.audioContext = this.audioContext || new AudioContext()
      const source = this.audioContext.createMediaStreamSource(this.localStream)
      const analyser = this.audioContext.createAnalyser()
      analyser.fftSize = 256
      source.connect(analyser)
      this.analysers.set(pubId, analyser)
      if (this.vadEnabled) this.detectSpeaking(pubId)
    } catch { /* ignore */ }
  }

  private stopLocalMic() {
    this.localStream?.getTracks().forEach((t) => t.stop())
    this.localStream = null
    this.audioContext?.close()
    this.audioContext = null
    this.analysers.clear()
    this.speakingTimers.clear()
    for (const t of this.gatheringTimers.values()) clearTimeout(t)
    this.gatheringTimers.clear()
    this.gatheringWarned.clear()
    this.peerStates.clear()
    this.muted = false
    this.pttActive = false
  }

  // ============== 频道语音信令处理 ==============
  private attachChannelHandlers() {
    const socket = this.socket!
    socket.on('voice:participants', (d: { participants: VoiceParticipant[] }) => {
      this.participants = d.participants || []
      this.onParticipantsChange?.(this.participants)
      for (const p of this.participants) {
        if (p.pubId !== this.myPubId && !this.peers.has(p.pubId)) {
          this.initiateConnection(p.pubId)
        }
      }
      for (const pubId of [...this.peers.keys()]) {
        if (!this.participants.find((p) => p.pubId === pubId)) {
          this.closePeer(pubId)
        }
      }
    })
    socket.on('voice:signal', async (d: { fromPubId: string; toPubId: string; payload: string }) => {
      if (d.toPubId !== this.myPubId && d.fromPubId !== this.myPubId) return
      const peerPubId = d.fromPubId === this.myPubId ? d.toPubId : d.fromPubId
      if (!this.channelKey) return
      const signal = await openJSON<{ type: string; sdp?: string; candidate?: RTCIceCandidateInit }>(this.channelKey, d.payload)
      if (!signal) return
      await this.handleSignal(peerPubId, signal)
    })
  }

  private detachChannelHandlers() {
    this.socket?.off('voice:participants')
    this.socket?.off('voice:signal')
  }

  // ============== 大厅信令处理 ==============
  private attachLobbyHandlers() {
    const socket = this.socket!
    socket.on('voice:lobby:participants', (d: { lobbyId: string; mode: LobbyMode; participants: VoiceParticipant[] }) => {
      if (d.lobbyId !== this.lobbyId || d.mode !== this.lobbyMode) return
      this.participants = d.participants || []
      this.onParticipantsChange?.(this.participants)
      for (const p of this.participants) {
        if (p.pubId !== this.myPubId && !this.peers.has(p.pubId)) {
          this.initiateConnection(p.pubId)
        }
      }
      for (const pubId of [...this.peers.keys()]) {
        if (!this.participants.find((p) => p.pubId === pubId)) {
          this.closePeer(pubId)
        }
      }
    })
    socket.on('voice:lobby:signal', async (d: { lobbyId: string; mode: LobbyMode; fromPubId: string; toPubId: string; payload: string }) => {
      if (d.lobbyId !== this.lobbyId || d.mode !== this.lobbyMode) return
      if (d.toPubId !== this.myPubId && d.fromPubId !== this.myPubId) return
      const peerPubId = d.fromPubId === this.myPubId ? d.toPubId : d.fromPubId
      if (!this.channelKey) return
      const signal = await openJSON<{ type: string; sdp?: string; candidate?: RTCIceCandidateInit }>(this.channelKey, d.payload)
      if (!signal) return
      await this.handleSignal(peerPubId, signal)
    })
    socket.on('voice:lobby:ptt', (d: { lobbyId: string; mode: LobbyMode; pubId: string; active: boolean }) => {
      if (d.lobbyId !== this.lobbyId || d.mode !== this.lobbyMode) return
      this.onSpeakingChange?.(d.pubId, d.active)
    })
  }

  private detachLobbyHandlers() {
    this.socket?.off('voice:lobby:participants')
    this.socket?.off('voice:lobby:signal')
    this.socket?.off('voice:lobby:ptt')
  }

  // ============== DM 通话信令处理 ==============
  private attachDMCallHandlers() {
    const socket = this.socket!
    socket.on('voice:call:signal', async (d: { fromPubId: string; toPubId: string; payload: string }) => {
      if (d.toPubId !== this.myPubId && d.fromPubId !== this.myPubId) return
      const peerPubId = d.fromPubId === this.myPubId ? d.toPubId : d.fromPubId
      if (peerPubId !== this.callPeerPubId) return
      if (!this.channelKey) return
      const signal = await openJSON<{ type: string; sdp?: string; candidate?: RTCIceCandidateInit }>(this.channelKey, d.payload)
      if (!signal) return
      await this.handleSignal(peerPubId, signal)
    })
  }

  private detachDMCallHandlers() {
    this.socket?.off('voice:call:signal')
  }

  // ============== PTT 控制 ==============
  setPTTEnabled(on: boolean) {
    this.pttEnabled = on
    if (!this.localStream) return
    if (this.pttEnabled) {
      this.localStream.getAudioTracks().forEach((t) => (t.enabled = this.pttActive))
    } else {
      this.localStream.getAudioTracks().forEach((t) => (t.enabled = !this.muted))
    }
  }

  setVadEnabled(on: boolean) {
    this.vadEnabled = on
    if (on && this.localStream && !this.analysers.has('_self')) {
      this.setupMicAnalyser('_self')
    }
  }

  pttPress() {
    if (!this.pttEnabled || this.pttActive) return
    this.pttActive = true
    this.localStream?.getAudioTracks().forEach((t) => (t.enabled = true))
    this.onPttActiveChange?.(true)
    if (this.mode === 'lobby') {
      this.socket?.emit('voice:lobby:ptt', { lobbyId: this.lobbyId, mode: this.lobbyMode, active: true })
    }
  }

  pttRelease() {
    if (!this.pttEnabled || !this.pttActive) return
    this.pttActive = false
    this.localStream?.getAudioTracks().forEach((t) => (t.enabled = false))
    this.onPttActiveChange?.(false)
    if (this.mode === 'lobby') {
      this.socket?.emit('voice:lobby:ptt', { lobbyId: this.lobbyId, mode: this.lobbyMode, active: false })
    }
  }

  // ============== 静音切换 ==============
  toggleMute() {
    if (!this.localStream) return
    if (this.pttEnabled) {
      this.pttEnabled = false
      this.pttActive = false
    }
    this.muted = !this.muted
    this.localStream.getAudioTracks().forEach((t) => (t.enabled = !this.muted))
    this.onMutedChange?.(this.muted)
    if (this.mode === 'channel') {
      this.socket?.emit('voice:mute', { muted: this.muted })
    } else if (this.mode === 'lobby') {
      this.socket?.emit('voice:lobby:mute', { lobbyId: this.lobbyId, mode: this.lobbyMode, muted: this.muted })
    }
  }

  get isMuted() { return this.muted }
  get participantList() { return this.participants }
  get currentMode() { return this.mode }
  get pttMode() { return this.pttEnabled }
  get peerStateMap() { return new Map(this.peerStates) }

  // ============== WebRTC 建链 ==============
  private async initiateConnection(peerPubId: string) {
    if (this.myPubId > peerPubId) return
    const pc = this.createPeer(peerPubId)
    if (!pc) return
    try {
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      await this.sendSignal(peerPubId, { type: 'offer', sdp: offer.sdp })
    } catch (e) {
      this.reportPeerError(peerPubId, '发起通话连接失败')
    }
  }

  private createPeer(peerPubId: string): RTCPeerConnection | null {
    if (!this.localStream) return null
    // ★ v1.3.1：ICE 服务器从运行时配置构造
    //   - lobby+relay 模式：若 TURN 可用则 forceRelay；否则降级为 STUN
    //   - 其他模式：含 STUN+TURN 的全量 ICE（让浏览器自己选最优路径）
    const forceRelay = this.mode === 'lobby' && this.lobbyMode === 'relay' && this.iceCfg.turnEnabled
    const iceServers = buildIceServers(this.iceCfg, { forceRelay })
    const pcConfig: RTCConfiguration = {
      iceServers,
      ...(forceRelay ? { iceTransportPolicy: 'relay' as RTCIceTransportPolicy } : {}),
      iceCandidatePoolSize: 4,
    }
    const pc = new RTCPeerConnection(pcConfig)
    this.localStream.getTracks().forEach((t) => pc.addTrack(t, this.localStream!))
    pc.ontrack = (e) => {
      const stream = e.streams[0]
      this.remoteStreams.set(peerPubId, stream)
      this.onRemoteStream?.(peerPubId, stream)
      try {
        if (!this.audioContext) this.audioContext = new AudioContext()
        const src = this.audioContext.createMediaStreamSource(stream)
        const an = this.audioContext.createAnalyser()
        an.fftSize = 256
        src.connect(an)
        this.analysers.set(peerPubId, an)
        this.detectSpeaking(peerPubId)
      } catch { /* ignore */ }
    }
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.sendSignal(peerPubId, { type: 'candidate', candidate: e.candidate.toJSON() })
      }
    }
    // ★ ICE gathering 超时：5s 内无候选 → 提示网络穿透困难
    //   且只有一次（避免重复 toast）
    pc.onicegatheringstatechange = () => {
      const gs = pc.iceGatheringState
      if (gs === 'gathering' && !this.gatheringWarned.has(peerPubId)) {
        // 设置 5s 计时器：如果 5s 后仍处于 gathering，提示
        const t = setTimeout(() => {
          if (pc.iceGatheringState === 'gathering' && !this.gatheringWarned.has(peerPubId + '_warned')) {
            this.gatheringWarned.add(peerPubId + '_warned')
            this.reportPeerError(peerPubId, '网络穿透较慢：可能处于对称 NAT / CGNAT，建议管理员启用 TURN 中继')
          }
        }, 5000)
        this.gatheringTimers.set(peerPubId, t)
      } else if (gs === 'complete') {
        const t = this.gatheringTimers.get(peerPubId)
        if (t) { clearTimeout(t); this.gatheringTimers.delete(peerPubId) }
      }
    }
    // ★ 连接状态变化 → 回调到 UI
    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState
      let mapped: PeerConnState = 'connecting'
      if (s === 'new') mapped = 'new'
      else if (s === 'checking') mapped = 'connecting'
      else if (s === 'connected') {
        // 判定 P2P vs relay：扫描当前 selected candidate pair
        // 退化方式：从 stats 中查 selected candidate pair 的 local-candidate 类型
        // 简化：先 emit 'connected'，再异步查 stats 判断
        this.updatePeerState(peerPubId, 'connecting')
        pc.getStats(null).then((stats) => {
          let foundRelay = false
          let foundHost = false
          stats.forEach((report) => {
            // @ts-ignore id 包含 candidate-pair
            if (report.type === 'candidate-pair' && report.nominated) {
              const lid = report.localCandidateId || report.localCandidate?.id
              // 在 stats 中找对应的 local-candidate
              stats.forEach((r2) => {
                if (r2.id === lid && r2.type === 'local-candidate') {
                  const ct = r2.candidateType
                  if (ct === 'relay') foundRelay = true
                  else foundHost = true
                }
              })
            }
          })
          this.updatePeerState(peerPubId, foundRelay ? 'relay' : (foundHost ? 'p2p' : 'p2p'))
        }).catch(() => this.updatePeerState(peerPubId, 'p2p'))
        return
      } else if (s === 'disconnected') mapped = 'disconnected'
      else if (s === 'failed') {
        mapped = 'failed'
        this.reportPeerError(peerPubId, '与该设备的连接失败：可能 NAT 穿透受阻，建议管理员启用 TURN 中继')
      } else if (s === 'closed') mapped = 'closed'
      this.updatePeerState(peerPubId, mapped)
    }
    pc.onconnectionstatechange = () => {
      // 兜底：iceconnectionstatechange 未捕获的 failed/disconnected 状态
      const cs = pc.connectionState
      if (cs === 'failed') {
        this.updatePeerState(peerPubId, 'failed')
        this.reportPeerError(peerPubId, '与该设备的连接失败：可能 NAT 穿透受阻或对端离线')
      } else if (cs === 'disconnected') {
        this.updatePeerState(peerPubId, 'disconnected')
      }
    }
    this.peers.set(peerPubId, pc)
    this.updatePeerState(peerPubId, 'new')
    return pc
  }

  // 更新某 peer 的连接状态并通知 UI
  private updatePeerState(pubId: string, state: PeerConnState) {
    const prev = this.peerStates.get(pubId)
    if (prev === state) return
    this.peerStates.set(pubId, state)
    this.onPeerStateChange?.(pubId, state)
  }

  // 上报 peer 错误（toast + onError）
  private reportPeerError(peerPubId: string, msg: string) {
    const shortId = peerPubId.slice(-4)
    const full = `#${shortId} · ${msg}`
    this.onError?.(full)
    // DM 模式特殊：同时通知 call error
    if (this.mode === 'dm') {
      this.onCallError?.(msg)
    }
  }

  private async handleSignal(peerPubId: string, signal: { type: string; sdp?: string; candidate?: RTCIceCandidateInit }) {
    let pc = this.peers.get(peerPubId)
    if (!pc) {
      if (signal.type === 'offer') {
        const created = this.createPeer(peerPubId)
        if (!created) return
        pc = created
      } else {
        return
      }
    }
    try {
      if (signal.type === 'offer' && signal.sdp) {
        await pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp })
        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        await this.sendSignal(peerPubId, { type: 'answer', sdp: answer.sdp })
      } else if (signal.type === 'answer' && signal.sdp) {
        await pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp })
      } else if (signal.type === 'candidate' && signal.candidate) {
        try {
          await pc.addIceCandidate(signal.candidate)
        } catch { /* ignore late candidates */ }
      }
    } catch (e) {
      // 仅在 offer/answer 处理失败时上报（candidate 失败正常）
      if (signal.type !== 'candidate') {
        this.reportPeerError(peerPubId, '信令协商失败')
      }
    }
  }

  private async sendSignal(peerPubId: string, signal: unknown) {
    if (!this.socket || !this.channelKey) return
    const payload = await sealJSON(this.channelKey, signal)
    if (this.mode === 'channel') {
      this.socket.emit('voice:signal', { toPubId: peerPubId, payload })
    } else if (this.mode === 'lobby') {
      this.socket.emit('voice:lobby:signal', { lobbyId: this.lobbyId, mode: this.lobbyMode, toPubId: peerPubId, payload })
    } else if (this.mode === 'dm') {
      this.socket.emit('voice:call:signal', { toPubId: peerPubId, payload })
    }
  }

  // ============== 说话检测（VAD） ==============
  private detectSpeaking(pubId: string) {
    const analyser = this.analysers.get(pubId)
    if (!analyser) return
    const data = new Uint8Array(analyser.frequencyBinCount)
    const check = () => {
      if (!this.analysers.has(pubId)) return
      analyser.getByteFrequencyData(data)
      const avg = data.reduce((a, b) => a + b, 0) / data.length
      const isSelf = pubId === '_self'
      if (isSelf && this.pttEnabled) {
        requestAnimationFrame(check)
        return
      }
      const muted = isSelf ? this.muted : false
      const speaking = avg > 18 && !muted
      const prev = this.speakingTimers.has(pubId)
      if (speaking && !prev) {
        this.onSpeakingChange?.(isSelf ? this.myPubId : pubId, true)
        this.speakingTimers.set(pubId, setTimeout(() => {
          this.onSpeakingChange?.(isSelf ? this.myPubId : pubId, false)
          this.speakingTimers.delete(pubId)
        }, 800))
      }
      requestAnimationFrame(check)
    }
    check()
  }

  private closePeer(pubId: string) {
    const pc = this.peers.get(pubId)
    if (pc) {
      try { pc.close() } catch { /* ignore */ }
      this.peers.delete(pubId)
    }
    this.remoteStreams.delete(pubId)
    this.analysers.delete(pubId)
    const t = this.gatheringTimers.get(pubId)
    if (t) { clearTimeout(t); this.gatheringTimers.delete(pubId) }
    this.gatheringWarned.delete(pubId)
    this.gatheringWarned.delete(pubId + '_warned')
    this.peerStates.delete(pubId)
    this.onRemoteStream?.(pubId, null)
    this.onPeerStateChange?.(pubId, 'closed')
  }

  // ============== 屏幕共享（getDisplayMedia） ==============
  // 把屏幕轨加入所有现有 peer connection；返回 null 表示用户取消/不支持
  async startScreenShare(): Promise<boolean> {
    if (!this.localStream) return false
    try {
      const display = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 15, max: 30 } },
        audio: false,
      })
      const track = display.getVideoTracks()[0]
      if (!track) return false
      this.screenStream = display
      // 加入每条 peer connection（ renegotiate ）
      for (const [, pc] of this.peers) {
        this.addScreenTrack(pc, track)
      }
      track.onended = () => { void this.stopScreenShare() }
      // 通知 UI
      this.onScreenShareChange?.(true)
      return true
    } catch {
      return false
    }
  }

  private addScreenTrack(pc: RTCPeerConnection, track: MediaStreamTrack) {
    const sender = pc.getSenders().find((s) => s.track?.kind === 'video')
    if (sender) {
      void sender.replaceTrack(track)
    } else {
      pc.addTrack(track, this.screenStream!)
    }
    // 触发重新协商
    void (async () => {
      try {
        const offer = await pc.createOffer()
        await pc.setLocalDescription(offer)
        for (const [pubId, p] of this.peers) {
          if (p === pc) { await this.sendSignal(pubId, { type: 'offer', sdp: offer.sdp }); break }
        }
      } catch { /* ignore */ }
    })()
  }

  async stopScreenShare() {
    this.screenStream?.getTracks().forEach((t) => t.stop())
    this.screenStream = null
    for (const [pubId, pc] of this.peers) {
      const sender = pc.getSenders().find((s) => s.track?.kind === 'video')
      if (!sender) continue
      // v1.7.0：区分「replaceTrack 换上来的」（相机轨还在）与「addTrack 加上去的」
      //（停止后 track 成了死轨仍留在 sender 上，对端黑屏）—— 后者需 removeTrack 并重协商
      if (sender.track === null) {
        // replaceTrack(null) 的情形：无残留轨
        continue
      }
      if (sender.track.readyState === 'ended') {
        try {
          pc.removeTrack(sender)
          const offer = await pc.createOffer()
          await pc.setLocalDescription(offer)
          await this.sendSignal(pubId, { type: 'offer', sdp: offer.sdp })
        } catch { /* ignore */ }
      } else {
        await sender.replaceTrack(null).catch(() => {})
      }
    }
    this.onScreenShareChange?.(false)
  }

  get screenSharing(): boolean { return !!this.screenStream }

  // 远端屏幕流回调（pubId → MediaStream，video 轨）
  onScreenShareChange: ((sharing: boolean) => void) | null = null

  // ============== v1.5.0 实时变声（AudioWorklet pitch shift，全部本地） ==============
  private pitchCtx: AudioContext | null = null
  private pitchNode: AudioWorkletNode | null = null
  private pitchSource: MediaStreamAudioSourceNode | null = null
  private pitchDest: MediaStreamAudioDestinationNode | null = null
  voiceMaskOn = false

  // 开启变声：麦克风 → worklet(pitch) → 变声后的流替换给所有 peer connection
  async enableVoiceMask(ratio: number): Promise<boolean> {
    if (!this.localStream || this.voiceMaskOn) return false
    try {
      this.pitchCtx = new AudioContext()
      await this.pitchCtx.audioWorklet.addModule('/worklets/pitch-shift.js')
      this.pitchSource = this.pitchCtx.createMediaStreamSource(this.localStream)
      this.pitchNode = new AudioWorkletNode(this.pitchCtx, 'pitch-shift', {
        processorOptions: { ratio },
      })
      this.pitchDest = this.pitchCtx.createMediaStreamDestination()
      this.pitchSource.connect(this.pitchNode)
      this.pitchNode.connect(this.pitchDest)
      // 用变声后的音轨替换所有已发送的音频轨（对端无感知切换）
      const maskedTrack = this.pitchDest.stream.getAudioTracks()[0]
      for (const [, pc] of this.peers) {
        const sender = pc.getSenders().find((s) => s.track?.kind === 'audio')
        if (sender) await sender.replaceTrack(maskedTrack).catch(() => {})
      }
      // 记录原始轨，关闭时恢复
      this._originalTracks = this.localStream.getAudioTracks()
      this.voiceMaskOn = true
      return true
    } catch (e) {
      console.warn('[voice] 变声开启失败:', e instanceof Error ? e.message : e)
      await this.disableVoiceMask().catch(() => {})
      return false
    }
  }

  private _originalTracks: MediaStreamTrack[] = []

  // 调整变调比率（0.5 低沉 ~ 2.0 尖细）
  async setVoiceMaskRatio(ratio: number) {
    if (this.pitchNode) this.pitchNode.port.postMessage({ type: 'set-ratio', value: Math.min(2, Math.max(0.5, ratio)) })
  }

  // 关闭变声：恢复原始麦克风音轨
  async disableVoiceMask() {
    try { this.pitchSource?.disconnect() } catch { /* ignore */ }
    try { this.pitchNode?.disconnect() } catch { /* ignore */ }
    if (this.pitchCtx && this.pitchCtx.state !== 'closed') await this.pitchCtx.close().catch(() => {})
    this.pitchCtx = null; this.pitchNode = null; this.pitchSource = null; this.pitchDest = null
    if (this.voiceMaskOn) {
      for (const [, pc] of this.peers) {
        const sender = pc.getSenders().find((s) => s.track?.kind === 'audio')
        if (sender && this._originalTracks[0]) await sender.replaceTrack(this._originalTracks[0]).catch(() => {})
      }
    }
    this._originalTracks = []
    this.voiceMaskOn = false
  }

  // ============== 离开 ==============
  leave() {
    if (this.mode === 'channel') {
      this.socket?.emit('voice:leave')
      this.detachChannelHandlers()
    } else if (this.mode === 'lobby') {
      this.socket?.emit('voice:lobby:leave', { lobbyId: this.lobbyId, mode: this.lobbyMode })
      this.detachLobbyHandlers()
    } else if (this.mode === 'dm') {
      this.endCall()
    }
    this.screenStream?.getTracks().forEach((t) => t.stop())
    this.screenStream = null
    void this.disableVoiceMask().catch(() => {})
    this.socket = null
    this.channelKey = null
    for (const pubId of [...this.peers.keys()]) this.closePeer(pubId)
    this.stopLocalMic()
    this.participants = []
  }
}

// ============== 通话控制器：负责管理 socket 上的 voice:call:invite/accept/reject/end 全局事件 ==============
type CallSignalType = 'invite' | 'accept' | 'reject' | 'end'

interface CallSignalHandler {
  onIncoming: (fromPubId: string) => void
  onAccepted: (fromPubId: string) => void
  onRejected: (fromPubId: string) => void
  onEnded: (fromPubId: string) => void
}

let callSocket: Socket | null = null
let callHandler: CallSignalHandler | null = null

export function registerCallSocket(socket: Socket, channelKey: CryptoKey, myPubId: string, handler: CallSignalHandler) {
  if (callSocket === socket) {
    callHandler = handler
    return
  }
  if (callSocket) {
    unregisterCallSocket()
  }
  callSocket = socket
  callHandler = handler

  socket.on('voice:call:invite', async (d: { fromPubId: string; toPubId: string; payload: string }) => {
    if (d.toPubId !== myPubId) return
    const v = await openJSON<{ type: string }>(channelKey, d.payload)
    if (v?.type === 'invite') callHandler?.onIncoming(d.fromPubId)
  })
  socket.on('voice:call:accept', async (d: { fromPubId: string; toPubId: string; payload: string }) => {
    if (d.toPubId !== myPubId) return
    const v = await openJSON<{ type: string }>(channelKey, d.payload)
    if (v?.type === 'accept') callHandler?.onAccepted(d.fromPubId)
  })
  socket.on('voice:call:reject', async (d: { fromPubId: string; toPubId: string; payload: string }) => {
    if (d.toPubId !== myPubId) return
    const v = await openJSON<{ type: string }>(channelKey, d.payload)
    if (v?.type === 'reject') callHandler?.onRejected(d.fromPubId)
  })
  socket.on('voice:call:end', async (d: { fromPubId: string; toPubId: string; payload: string }) => {
    if (d.toPubId !== myPubId) return
    const v = await openJSON<{ type: string }>(channelKey, d.payload)
    if (v?.type === 'end') callHandler?.onEnded(d.fromPubId)
  })
}

export function unregisterCallSocket() {
  if (!callSocket) return
  callSocket.off('voice:call:invite')
  callSocket.off('voice:call:accept')
  callSocket.off('voice:call:reject')
  callSocket.off('voice:call:end')
  callSocket = null
  callHandler = null
}

export async function rejectCall(channelKey: CryptoKey, socket: Socket, myPubId: string, peerPubId: string) {
  const payload = await sealJSON(channelKey, { type: 'reject' })
  socket.emit('voice:call:reject', { toPubId: peerPubId, payload })
}
