// CipherChat WebSocket 中继服务
// 职责：实时消息转发 / 在线设备(含 IP 地区) / 正在输入 / 消息删除广播 / 网盘多端同步
// 安全约定：日志中绝不输出 token、消息密文内容；仅输出事件名与脱敏 ID
import { Server, Socket } from 'socket.io'
import { createServer } from 'http'
import { randomUUID } from 'crypto'

// 注意导入顺序：config 最先加载（其内部会读取项目根 .env）
import { SERVER_CONFIG } from '../../src/lib/server/config'
import { db, dbReady } from '../../src/lib/db'
import { verifyChatSession, verifyDriveSession } from '../../src/lib/server/session'
import { parseUA } from '../../src/lib/server/ua'
import { resolveGeo, clientIpFromHeaders } from '../../src/lib/server/geo'
import { deleteFileDir } from '../../src/lib/server/filestore'
import { rateLimit } from '../../src/lib/server/ratelimit'
// v1.6.0：角色检查改为顶层静态导入（原先每条消息都动态 import 一次，属于热路径浪费）
import { canSend, canClearChannel, canDeleteMessage, roleOf, setMemberRole } from '../../src/lib/server/roles'
// v1.7.0：管理员功能开关在 relay 侧强制执行（此前只存不查，关了也能用）
import { getFeatureFlags } from '../../src/lib/server/config'
// v1.7.0：过期未完成上传清理
import { cleanupStaleUploads } from '../../src/lib/server/filestore'
// v1.7.1：数据库自举（一键部署等全新环境缺 DATABASE_URL/缺表时自动补齐）
import { ensureDatabase, ensureSchema, resolveDatabaseUrl } from '../../src/lib/server/db-bootstrap'

const httpServer = createServer((req, res) => {
  // 简单健康检查端点（不含任何敏感信息）
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, svc: 'relay' }))
    return
  }
  res.writeHead(404)
  res.end()
})

const io = new Server(httpServer, {
  path: '/',
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 30000,
  pingInterval: 25000,
  maxHttpBufferSize: 256 * 1024, // 消息信封上限 256KB
})

// ---------------- 在线设备登记 ----------------
interface PresenceEntry {
  sessionKey: string // 会话 ID（Map 键，同设备重连不会误删他人）
  pubId: string // 稳定设备标识（对外展示与消息归属）
  socketId: string
  ua: ReturnType<typeof parseUA>
  ip: string
  region: string
  flagEmoji?: string
  networkType: 'lan' | 'wan' | 'unknown'
  deviceInfoEnc: string
  nickEnc?: string
  avatarEnc?: string // 加密的自定义头像（base64 data URL，限 96KB）
  moodEnc?: string // v1.7.0 加密心情状态（随 presence 广播，服务端不可读）
  joinedAt: number
  geoDisclosure: 'full' | 'region' | 'hidden' // IP 披露级别（v1.4.3）：full=完整 / region=仅地区 / hidden=不披露
}

// 按披露级别裁剪 presence 条目对外暴露的字段
function presentEntry(e: PresenceEntry) {
  return {
    deviceId: e.pubId,
    ua: { deviceType: e.ua.deviceType, label: e.ua.label, os: e.ua.os, browser: e.ua.browser },
    ip: e.geoDisclosure === 'full' ? e.ip : '', // region/hidden 不下发完整 IP
    region: e.geoDisclosure === 'hidden' ? '隐私模式' : (e.region || '定位中…'),
    flagEmoji: e.geoDisclosure === 'hidden' ? undefined : e.flagEmoji, // hidden 连国旗也不给
    networkType: e.geoDisclosure === 'hidden' ? 'unknown' as const : e.networkType,
    deviceInfoEnc: e.deviceInfoEnc,
    nickEnc: e.nickEnc,
    avatarEnc: e.avatarEnc,
    moodEnc: e.moodEnc,
    joinedAt: e.joinedAt,
    online: true,
    lastSeen: undefined as string | undefined,
    geoDisclosure: e.geoDisclosure,
  }
}

const chatPresence = new Map<string, Map<string, PresenceEntry>>() // channelKeyId -> sessionKey -> entry
const MAX_MESSAGE_PER_10S = 30
const PRESENCE_WINDOW_MS = 24 * 3600 * 1000 // 近 24h 活跃设备仍展示（离线状态）

function socketIp(sock: Socket): string {
  const h = sock.handshake.headers as Record<string, string | string[] | undefined>
  // v1.7.0：TRUST_PROXY=off 时回退到 TCP 对端地址，防伪造 XFF 绕过限流
  const ip = clientIpFromHeaders(h, sock.handshake.address || '')
  if (ip) return ip
  return 'unknown'
}

function broadcastPresence(channelKeyId: string) {
  const room = chatPresence.get(channelKeyId)
  const list = room ? Array.from(room.values()).map(presentEntry) : []
  io.to('ch:' + channelKeyId).emit('chat:presence', { devices: list })
}

// v1.6.0：在频道 presence 中按稳定设备标识 pubId 找到其在线 socket，用于信令单播
function findChatSocketId(channelKeyId: string, pubId: string): string | null {
  const room = chatPresence.get(channelKeyId)
  if (!room) return null
  for (const e of room.values()) {
    if (e.pubId === pubId) return e.socketId
  }
  return null
}

// 合并数据库中近 24h 活跃的离线设备（含加密设备详情），一起广播
async function broadcastFullPresence(channelKeyId: string) {
  const online = chatPresence.get(channelKeyId)
  const onlineList: ReturnType<typeof presentEntry>[] = online
    ? Array.from(online.values()).map(presentEntry)
    : []

  const onlineSessionIds = new Set(online ? Array.from(online.keys()) : [])
  const onlinePubIds = new Set(onlineList.map((d) => d.deviceId))
  try {
    const since = new Date(Date.now() - PRESENCE_WINDOW_MS)
    const recent = await db.chatSession.findMany({
      where: { channelKeyId, lastSeenAt: { gte: since } },
      orderBy: { lastSeenAt: 'desc' },
      take: 50,
    })
    for (const s of recent) {
      if (onlineSessionIds.has(s.id) || onlinePubIds.has(s.pubId)) continue
      const ua = parseUA(s.deviceLabel ? `${s.deviceLabel} Mozilla/5.0` : '')
      // v1.6.0：离线设备同样遵守该会话加入时选择的 IP 披露级别
      // （此前离线条目无视 region/hidden 直接下发完整 IP，属于隐私泄漏）
      const disclosure: 'full' | 'region' | 'hidden' =
        s.geoDisclosure === 'region' ? 'region' : s.geoDisclosure === 'hidden' ? 'hidden' : 'full'
      onlineList.push({
        deviceId: s.pubId || s.id,
        ua: { deviceType: ua.deviceType, label: s.deviceLabel || '未知设备', os: ua.os, browser: ua.browser },
        ip: disclosure === 'full' ? s.ip : '',
        region: '离线设备',
        flagEmoji: undefined,
        networkType: 'unknown',
        deviceInfoEnc: s.deviceInfoEnc || '',
        nickEnc: undefined,
        avatarEnc: undefined,
        moodEnc: undefined,
        joinedAt: s.lastSeenAt.getTime(),
        online: false,
        lastSeen: s.lastSeenAt.toISOString(),
        geoDisclosure: disclosure,
      })
    }
  } catch { /* ignore */ }

  io.to('ch:' + channelKeyId).emit('chat:presence', { devices: onlineList })
}

async function attachGeo(channelKeyId: string, entry: PresenceEntry) {
  // hidden 模式不做任何地理查询，IP 也不出本进程
  if (entry.geoDisclosure === 'hidden') return
  try {
    const geo = await resolveGeo(entry.ip)
    entry.region = geo.region
    entry.flagEmoji = geo.flagEmoji
    entry.networkType = geo.networkType
    const room = chatPresence.get(channelKeyId)
    if (room && room.get(entry.sessionKey) === entry) broadcastFullPresence(channelKeyId)
  } catch (e) {
    console.warn('[relay] attachGeo 失败:', e instanceof Error ? e.message : e)
  }
}

// ---------------- 消息 ----------------
async function persistAndRelayMessage(sock: Socket, payload: string, fileId: string | null, replyToId: string | null, clientId: string | null, burnAfterSec: number | null = null) {
  const info = sock.data.chat as { channelKeyId: string; pubId: string } | undefined
  if (!info) return { error: '尚未加入频道' }

  // v1.5.0 权限：observer 只读，不可发送消息/文件
  // v1.7.0 fail-closed：角色检查异常时拒绝发送（此前按允许处理，DB 故障窗口内
  // 被吊销成员可继续发消息）
  try {
    if (!(await canSend(info.channelKeyId, info.pubId))) {
      return { error: '你是旁听角色，无法发送消息' }
    }
  } catch (e) {
    console.warn('[relay] 角色检查失败（按拒绝处理）:', e instanceof Error ? e.message : e)
    return { error: '发送校验失败，请重试' }
  }

  if (typeof payload !== 'string' || payload.length === 0 || payload.length > 128 * 1024) {
    return { error: '消息内容不合法' }
  }
  if (fileId !== null && !/^[0-9a-fA-F-]{36}$/.test(fileId)) return { error: '文件引用不合法' }
  if (replyToId !== null && !/^[0-9a-fA-F-]{36}$/.test(replyToId)) return { error: '回复引用不合法' }
  if (clientId !== null && (typeof clientId !== 'string' || clientId.length > 64)) clientId = null

  if (!rateLimit('msg:' + info.pubId, MAX_MESSAGE_PER_10S, 10_000)) {
    return { error: '发送太快啦，休息一下吧' }
  }

  // 校验 file 归属（若携带）
  if (fileId) {
    const f = await db.chatFile.findUnique({ where: { id: fileId } })
    if (!f || f.channelKeyId !== info.channelKeyId || !f.ready) return { error: '文件尚未就绪' }
  }

  // v1.5.0 阅后即焚：burnAfterSec ∈ [300, 86400]，从现在起倒计时
  let burnAt: Date | null = null
  if (typeof burnAfterSec === 'number' && burnAfterSec >= 300 && burnAfterSec <= 86_400) {
    burnAt = new Date(Date.now() + burnAfterSec * 1000)
  }

  const row = await db.chatMessage.create({
    data: {
      channelKeyId: info.channelKeyId,
      senderId: info.pubId,
      payload,
      fileId,
      replyToId,
      ...(burnAt ? { burnAt } : {}),
    },
  })

  io.to('ch:' + info.channelKeyId).emit('chat:message', {
    id: row.id,
    senderId: row.senderId,
    payload: row.payload,
    fileId: row.fileId,
    replyToId: row.replyToId,
    clientId,
    readAt: row.readAt ? row.readAt.toISOString() : null,
    burnAt: row.burnAt ? row.burnAt.toISOString() : null, // v1.5.0 下发焚毁时间
    createdAt: row.createdAt.toISOString(),
  })

  // 可选的频道容量裁剪
  const cap = SERVER_CONFIG.maxMessagesPerChannel
  if (cap > 0 && Math.random() < 0.05) {
    const count = await db.chatMessage.count({ where: { channelKeyId: info.channelKeyId } })
    if (count > cap) {
      const oldest = await db.chatMessage.findMany({
        where: { channelKeyId: info.channelKeyId },
        orderBy: { createdAt: 'asc' },
        take: count - cap,
      })
      const fileIds = oldest.map((m) => m.fileId).filter(Boolean) as string[]
      await db.chatMessage.deleteMany({ where: { id: { in: oldest.map((m) => m.id) } } })
      for (const fid of fileIds) {
        await db.chatFile.deleteMany({ where: { id: fid } }).catch(() => {})
        deleteFileDir('chat', fid)
      }
    }
  }

  return { ok: true, id: row.id }
}

async function deleteMessages(sock: Socket, ids: string[] | null, all: boolean) {
  const info = sock.data.chat as { channelKeyId: string; pubId: string } | undefined
  if (!info) return { error: '尚未加入频道' }
  if (!all && (!Array.isArray(ids) || ids.length === 0)) return { error: '未选择消息' }
  if (!all && ids!.length > 500) return { error: '单次最多删除 500 条' }

  // v1.5.0 权限体系：
  //  - 清空频道仅 owner
  //  - 删除他人消息需要 admin+；删除自己的消息任何角色均可
  if (all) {
    if (!(await canClearChannel(info.channelKeyId, info.pubId))) {
      return { error: '仅频道创建者可以清空全部记录' }
    }
  } else {
    // v1.7.0：单次 findMany 批量校验归属，替代逐条 findUnique（500 条 = 500 次查询 → 1 次）
    const targets = await db.chatMessage.findMany({
      where: { id: { in: ids! }, channelKeyId: info.channelKeyId },
      select: { id: true, senderId: true },
    })
    for (const msg of targets) {
      if (!(await canDeleteMessage(info.channelKeyId, info.pubId, msg.senderId))) {
        return { error: '权限不足：删除他人消息需要管理员角色' }
      }
    }
  }

  if (all) {
    // v1.7.0：只取 fileId 不加载 payload 密文（此前 findMany 无 select 会把整个频道
    // 的密文全部拉进内存，大频道清空时 GB 级内存峰值）
    const msgs = await db.chatMessage.findMany({
      where: { channelKeyId: info.channelKeyId },
      select: { id: true, fileId: true },
    })
    const fileIds = Array.from(new Set(msgs.map((m) => m.fileId).filter(Boolean) as string[]))
    await db.chatMessage.deleteMany({ where: { channelKeyId: info.channelKeyId } })
    const files = await db.chatFile.findMany({ where: { channelKeyId: info.channelKeyId }, select: { id: true } })
    for (const f of files) {
      deleteFileDir('chat', f.id)
      await db.chatFile.delete({ where: { id: f.id } }).catch(() => {})
    }
    io.to('ch:' + info.channelKeyId).emit('chat:deleted', { all: true })
    return { ok: true, deleted: msgs.length, files: fileIds.length }
  }

  const msgs = await db.chatMessage.findMany({
    where: { id: { in: ids ?? undefined }, channelKeyId: info.channelKeyId },
  })
  const fileIds = Array.from(new Set(msgs.map((m) => m.fileId).filter(Boolean) as string[]))
  await db.chatMessage.deleteMany({ where: { id: { in: msgs.map((m) => m.id) } } })
  for (const fid of fileIds) {
    await db.chatFile.deleteMany({ where: { id: fid } }).catch(() => {})
    deleteFileDir('chat', fid)
  }
  io.to('ch:' + info.channelKeyId).emit('chat:deleted', { ids: msgs.map((m) => m.id) })
  return { ok: true, deleted: msgs.length }
}

// ---------------- 自毁纪元轮询 ----------------
// Next.js 端执行全局自毁后 AdminConfig.wipeEpoch +1；
// 中继服务轮询到变化即向所有在线客户端广播 global:wipe（清屏重置）
let lastWipeEpoch: number | null = null
const WIPE_POLL_MS = 3000
// v1.7.1：种子查询挪到数据库自举之后（此前模块加载即首查，全新环境下日志必现 prisma:error 噪音）

setInterval(async () => {
  try {
    const cfg = await db.adminConfig.findFirst({ select: { wipeEpoch: true } })
    const epoch = cfg?.wipeEpoch ?? 0
    if (lastWipeEpoch !== null && epoch !== lastWipeEpoch) {
      chatPresence.clear()
      // v1.7.0：全局自毁同时清空语音房间状态（此前 wiped 频道仍在广播语音参会者并持有内存）
      voiceState.clear()
      voiceLobbyState.clear()
      io.emit('global:wipe', { epoch })
      console.log(`[relay] global wipe detected (epoch ${epoch}) — all data destroyed, clients notified`)
    }
    lastWipeEpoch = epoch
  } catch {
    /* ignore */
  }
}, WIPE_POLL_MS)

// ---------------- v1.5.0 阅后即焚清理 ----------------
// 每 60s 扫描 burnAt 到期的消息并删除（连带文件密文），广播删除事件
const BURN_SWEEP_MS = 60_000
setInterval(async () => {
  try {
    const due = await db.chatMessage.findMany({
      where: { burnAt: { lte: new Date() } },
      select: { id: true, fileId: true, channelKeyId: true },
      take: 200,
    })
    if (due.length === 0) return
    for (const m of due) {
      if (m.fileId) {
        await db.chatFile.deleteMany({ where: { id: m.fileId } }).catch(() => {})
        deleteFileDir('chat', m.fileId)
      }
    }
    await db.chatMessage.deleteMany({ where: { id: { in: due.map((m) => m.id) } } })
    // 按频道分组广播焚毁事件
    const byChannel = new Map<string, string[]>()
    for (const m of due) {
      const arr = byChannel.get(m.channelKeyId) || []
      arr.push(m.id)
      byChannel.set(m.channelKeyId, arr)
    }
    for (const [channelKeyId, ids] of byChannel) {
      io.to('ch:' + channelKeyId).emit('chat:burned', { ids }) // 客户端本地移除并显示「已焚毁」占位
    }
    console.log(`[relay] 焚毁 ${due.length} 条到期消息`)
  } catch (e) {
    console.warn('[relay] 焚毁扫描异常:', e instanceof Error ? e.message : e)
  }
}, BURN_SWEEP_MS)

// ---------------- v1.5.0 Dead Man's Switch 检查 ----------------
// 每 10 分钟检查一次：超过宽限期的 DMS 触发动作（notify → 投递信箱 / wipe → 全局自毁）
// 仅管理员后台 dmsEnabled=true 时注册的 DMS 才生效
import { executeGlobalWipe } from '../../src/lib/server/admin'
const DMS_CHECK_MS = 600_000
async function checkDeadMansSwitches() {
  try {
    const cfg = await db.adminConfig.findFirst({ select: { dmsEnabled: true } })
    if (!cfg?.dmsEnabled) return
    const switches = await db.deadMansSwitch.findMany()
    const now = Date.now()
    for (const s of switches) {
      const deadline = s.lastCheckIn.getTime() + s.graceDays * 86_400_000
      if (now < deadline) continue
      if (s.action === 'wipe') {
        console.warn(`[relay] DMS 触发（${s.pubId.slice(0, 8)} 超过 ${s.graceDays} 天无活动）→ 全局自毁`)
        await executeGlobalWipe()
        await db.deadMansSwitch.delete({ where: { id: s.id } }).catch(() => {})
        return // wipe 后表已清空，直接返回
      } else {
        // notify：向指定信箱投递提醒信封（内容为固定提示 JSON，由收件人密钥加密不在本层处理 ——
        // 信箱信封本身是服务端不可读的；这里投递一个明文元数据标记，收件客户端识别后展示）
        await db.mailboxItem.create({
          data: {
            recipientPubId: s.notifyMailbox || s.pubId,
            senderPubId: 'system:dms',
            envelope: JSON.stringify({ type: 'dms-triggered', pubId: s.pubId.slice(0, 8), graceDays: s.graceDays }),
          },
        }).catch(() => {})
        await db.deadMansSwitch.delete({ where: { id: s.id } }).catch(() => {})
        console.log(`[relay] DMS notify 已投递（${s.pubId.slice(0, 8)}）`)
      }
    }
  } catch (e) {
    console.warn('[relay] DMS 检查异常:', e instanceof Error ? e.message : e)
  }
}
setInterval(checkDeadMansSwitches, DMS_CHECK_MS)

// DMS 心跳：任何会话活动都会刷新 lastCheckIn（挂在 chat:message 上太重，
// 改为低频轮询所有在线 presence 的会话）
setInterval(async () => {
  try {
    const cfg = await db.adminConfig.findFirst({ select: { dmsEnabled: true } })
    if (!cfg?.dmsEnabled) return
    const sessionKeys = new Set<string>()
    for (const room of chatPresence.values()) {
      for (const key of room.keys()) sessionKeys.add(key)
    }
    if (sessionKeys.size === 0) return
    await db.chatSession.updateMany({ where: { id: { in: [...sessionKeys] } }, data: { lastSeenAt: new Date() } })
  } catch { /* ignore */ }
}, DMS_CHECK_MS)

// ---------------- v1.5.0 密钥轮换完成通知 ----------------
// web 进程完成轮换后标记 notifyPending；relay 轮询到即向旧频道房间广播，
// 在线成员收到提示「频道密钥已更换，请通过新邀请链接重新加入」
const ROTATION_NOTIFY_MS = 8000
setInterval(async () => {
  try {
    const pending = await db.chatRotation.findMany({
      where: { notifyPending: true, phase: 'done' },
      select: { id: true, oldKeyId: true, createdBy: true },
      take: 20,
    })
    for (const r of pending) {
      io.to('ch:' + r.oldKeyId).emit('chat:rotated', {
        byPubId: r.createdBy.slice(0, 8),
        at: new Date().toISOString(),
      })
      await db.chatRotation.update({ where: { id: r.id }, data: { notifyPending: false } }).catch(() => {})
      console.log(`[relay] 已广播轮换通知（旧频道 ${r.oldKeyId.slice(0, 8)}…）`)
    }
  } catch (e) {
    console.warn('[relay] 轮换通知轮询异常:', e instanceof Error ? e.message : e)
  }
}, ROTATION_NOTIFY_MS)

// ---------------- 语音频道状态 ----------------
// 每频道记录谁在语音、是否静音；信令（SDP/ICE）用频道密钥加密后经本服务定向中继
const voiceState = new Map<string, Map<string, { sessionKey: string; pubId: string; muted: boolean; socketId: string }>>()

function broadcastVoiceState(channelKeyId: string) {
  const room = voiceState.get(channelKeyId)
  const list = room ? Array.from(room.values()).map((e) => ({
    pubId: e.pubId,
    muted: e.muted,
  })) : []
  io.to('ch:' + channelKeyId).emit('voice:participants', { participants: list })
}

// ---------------- 语音开黑大厅（Discord lobby） ----------------
// lobbyId -> sessionKey -> entry；大厅是临时房间，不持久化
// voiceLobbyState 的 Map 键采用 `${mode}:${lobbyId}` 复合键，确保同一 lobbyId
// 在 'relay' 与 'p2p' 两种模式下是两个互不可见的独立频道（保障隐私）
interface LobbyEntry {
  sessionKey: string
  pubId: string
  muted: boolean
  pttActive: boolean
  socketId: string
}
const voiceLobbyState = new Map<string, Map<string, LobbyEntry>>()

// 传输模式允许值白名单
const LOBBY_MODES = new Set(['relay', 'p2p'])
function sanitizeMode(m: unknown): 'relay' | 'p2p' {
  return m === 'relay' || m === 'p2p' ? m : 'p2p'
}

// 复合键 + socket.io room 命名：lobby:{mode}:{lobbyId}
function lobbyKey(mode: string, lobbyId: string) { return mode + ':' + lobbyId }
function lobbyRoom(mode: string, lobbyId: string) { return 'lobby:' + mode + ':' + lobbyId }

function broadcastLobbyState(mode: string, lobbyId: string) {
  const key = lobbyKey(mode, lobbyId)
  const room = voiceLobbyState.get(key)
  const list = room ? Array.from(room.values()).map((e) => ({
    pubId: e.pubId,
    muted: e.muted,
  })) : []
  io.to(lobbyRoom(mode, lobbyId)).emit('voice:lobby:participants', { lobbyId, mode, participants: list })
}

// 检查 lobby 是否允许加入（空 lobby 允许，已存在 lobby 时任何人可加入）
function lobbyExists(mode: string, lobbyId: string): boolean {
  const r = voiceLobbyState.get(lobbyKey(mode, lobbyId))
  return !!r && r.size > 0
}

// ---------------- 连接处理 ----------------
io.on('connection', (sock) => {
  sock.data.chat = null
  sock.data.drive = null

  // ===== 聊天 =====
  sock.on('chat:join', async (data: { token?: string; nickEnc?: string; avatarEnc?: string; deviceInfoEnc?: string; moodEnc?: string }) => {
    try {
      if (sock.data.chat) return
      const token = typeof data?.token === 'string' ? data.token : ''
      const session = await verifyChatSession(token)
      if (!session) {
        sock.emit('chat:error', { code: 'auth', message: '会话无效或已过期，请重新进入' })
        return
      }
      const ip = socketIp(sock)
      const ua = parseUA(sock.handshake.headers['user-agent'])
      const nickEnc = typeof data?.nickEnc === 'string' && data.nickEnc.length < 4096 ? data.nickEnc : undefined
      const deviceInfoEnc = typeof data?.deviceInfoEnc === 'string' && data.deviceInfoEnc.length < 4096 ? data.deviceInfoEnc : ''
      const avatarEnc = typeof data?.avatarEnc === 'string' && data.avatarEnc.length < 96 * 1024 ? data.avatarEnc : undefined
      // v1.7.0：心情状态（可选）
      const moodEnc = typeof data?.moodEnc === 'string' && data.moodEnc.length < 2048 ? data.moodEnc : undefined

      sock.data.chat = { channelKeyId: session.channelKeyId, pubId: session.pubId, sessionKey: session.id }
      sock.join('ch:' + session.channelKeyId)

      if (!chatPresence.has(session.channelKeyId)) chatPresence.set(session.channelKeyId, new Map())
      // IP 披露级别由会话创建时决定（服务端已按管理员 allowHiddenGeo 裁决），presence 按此裁剪
      const disclosure: 'full' | 'region' | 'hidden' =
        session.geoDisclosure === 'region' ? 'region' : session.geoDisclosure === 'hidden' ? 'hidden' : 'full'
      const entry: PresenceEntry = {
        sessionKey: session.id,
        pubId: session.pubId,
        socketId: sock.id,
        ua,
        ip,
        region: disclosure === 'hidden' ? '隐私模式' : '定位中…',
        networkType: 'unknown',
        deviceInfoEnc,
        nickEnc,
        avatarEnc,
        moodEnc,
        joinedAt: Date.now(),
        geoDisclosure: disclosure,
      }
      chatPresence.get(session.channelKeyId)!.set(session.id, entry)

      // v1.5.0：成员登记（自动 owner/member），并向全频道广播我的角色
      try {
        const myRole = await roleOf(session.channelKeyId, session.pubId)
        io.to('ch:' + session.channelKeyId).emit('chat:roleChanged', {
          targetPubId: session.pubId,
          role: myRole,
          operatorPubId: 'system',
        })
      } catch (e) {
        console.warn('[relay] 成员登记失败:', e instanceof Error ? e.message : e)
      }

      broadcastFullPresence(session.channelKeyId)
      attachGeo(session.channelKeyId, entry)

      sock.emit('chat:ready', { deviceId: session.pubId, channelKeyId: session.channelKeyId })
    } catch (e) {
      // 关键路径：会话建立失败必须记录（可能是数据库异常），同时告知客户端
      // v1.7.1：数据库未初始化类异常 → 立即触发自举补齐，客户端收到 server 错误后会自动重试
      console.warn('[relay] chat:join 失败:', e instanceof Error ? e.message : e)
      if (e instanceof Error && /DATABASE_URL|does not exist|P2021|P1003|P1001/i.test(e.message + '\n' + String((e as { code?: string }).code || ''))) {
        void ensureDatabase().then((ok) => {
          if (ok) console.warn('[relay] chat:join 失败但数据库已自举完成，等待客户端自动重试')
        })
      }
      sock.emit('chat:error', { code: 'server', message: '加入频道失败，请重试' })
    }
  })

  sock.on('chat:message', async (data: { payload?: string; fileId?: string | null; replyToId?: string | null; clientId?: string | null; burnAfterSec?: number | null }, ack?: (r: unknown) => void) => {
    try {
      const burn = typeof data?.burnAfterSec === 'number' ? data.burnAfterSec : null
      const r = await persistAndRelayMessage(sock, data?.payload || '', data?.fileId ?? null, data?.replyToId ?? null, data?.clientId ?? null, burn)
      ack?.(r)
    } catch (e) {
      console.warn('[relay] chat:message 处理异常:', e instanceof Error ? e.message : e)
      ack?.({ error: '服务器开小差了' })
    }
  })

  // ===== 语音频道 =====
  sock.on('voice:join', async () => {
    const info = sock.data.chat as { channelKeyId: string; pubId: string; sessionKey: string } | undefined
    if (!info) return
    // v1.7.0：语音开关在服务端强制执行
    try {
      const flags = await getFeatureFlags()
      if (flags.voiceEnabled === false) return
    } catch { /* 查询失败按开启处理 */ }
    if (!voiceState.has(info.channelKeyId)) voiceState.set(info.channelKeyId, new Map())
    voiceState.get(info.channelKeyId)!.set(info.sessionKey, { sessionKey: info.sessionKey, pubId: info.pubId, muted: false, socketId: sock.id })
    sock.join('voice:' + info.channelKeyId)
    broadcastVoiceState(info.channelKeyId)
    console.log(`[relay] voice join: ${info.pubId.slice(0, 8)} in channel ${info.channelKeyId.slice(0, 8)}`)
  })

  sock.on('voice:leave', () => {
    const info = sock.data.chat as { channelKeyId: string; sessionKey: string } | undefined
    if (!info) return
    voiceState.get(info.channelKeyId)?.delete(info.sessionKey)
    sock.leave('voice:' + info.channelKeyId)
    broadcastVoiceState(info.channelKeyId)
  })

  sock.on('voice:mute', (data: { muted?: boolean }) => {
    const info = sock.data.chat as { channelKeyId: string; sessionKey: string } | undefined
    if (!info) return
    const entry = voiceState.get(info.channelKeyId)?.get(info.sessionKey)
    if (entry) { entry.muted = !!data?.muted; broadcastVoiceState(info.channelKeyId) }
  })

  // WebRTC 信令中继：定向投递给目标用户（信令本身由客户端用频道密钥加密）
  sock.on('voice:signal', (data: { toPubId?: string; payload?: string }, ack?: (r: unknown) => void) => {
    const info = sock.data.chat as { channelKeyId: string; pubId: string } | undefined
    if (!info || !data?.toPubId || typeof data.payload !== 'string') return
    if (data.payload.length > 64 * 1024) return // 信令上限 64KB
    // v1.6.0：原先向整个 voice 房间广播（人人都能收到不属于自己的加密信令），
    // 现在按 pubId 找到目标 socket 后单播，减少元数据扩散与流量
    const room = voiceState.get(info.channelKeyId)
    let targetSocketId: string | null = null
    if (room) {
      for (const entry of room.values()) {
        if (entry.pubId === data.toPubId) { targetSocketId = entry.socketId; break }
      }
    }
    if (!targetSocketId) { ack?.({ error: '目标不在线' }); return }
    io.to(targetSocketId).emit('voice:signal', {
      fromPubId: info.pubId,
      toPubId: data.toPubId,
      payload: data.payload,
    })
    ack?.({ ok: true })
  })

  // ===== 语音开黑大厅（Discord lobby） =====
  // 大厅是无密码临时语音房间；客户端用 lobbyId 派生签名密钥加密 SDP/ICE
  // 服务器不解析信令，只做定向投递
  // 传输模式 mode: 'relay' | 'p2p' — 同 lobbyId 不同 mode 是两个隔离频道
  sock.on('voice:lobby:join', (data: { lobbyId?: string; mode?: string }, ack?: (r: unknown) => void) => {
    const info = sock.data.chat as { channelKeyId: string; pubId: string; sessionKey: string } | undefined
    if (!info) { ack?.({ error: '尚未加入频道' }); return }
    const lobbyId = typeof data?.lobbyId === 'string' && /^[A-Za-z0-9_-]{2,32}$/.test(data.lobbyId) ? data.lobbyId : ''
    const mode = sanitizeMode(data?.mode)
    if (!lobbyId) { ack?.({ error: '大厅 ID 不合法' }); return }
    const key = lobbyKey(mode, lobbyId)
    if (!voiceLobbyState.has(key)) voiceLobbyState.set(key, new Map())
    voiceLobbyState.get(key)!.set(info.sessionKey, {
      sessionKey: info.sessionKey,
      pubId: info.pubId,
      muted: false,
      pttActive: false,
      socketId: sock.id,
    })
    sock.join(lobbyRoom(mode, lobbyId))
    broadcastLobbyState(mode, lobbyId)
    console.log(`[relay] voice lobby join: ${info.pubId.slice(0, 8)} in ${key}`)
    ack?.({ ok: true })
  })

  sock.on('voice:lobby:leave', (data: { lobbyId?: string; mode?: string }) => {
    const info = sock.data.chat as { sessionKey: string } | undefined
    if (!info) return
    const lobbyId = typeof data?.lobbyId === 'string' ? data.lobbyId : ''
    const mode = sanitizeMode(data?.mode)
    if (!lobbyId) return
    const key = lobbyKey(mode, lobbyId)
    const room = voiceLobbyState.get(key)
    if (!room) return
    room.delete(info.sessionKey)
    sock.leave(lobbyRoom(mode, lobbyId))
    if (room.size === 0) voiceLobbyState.delete(key)
    broadcastLobbyState(mode, lobbyId)
  })

  sock.on('voice:lobby:mute', (data: { lobbyId?: string; mode?: string; muted?: boolean }) => {
    const info = sock.data.chat as { sessionKey: string } | undefined
    if (!info) return
    const lobbyId = typeof data?.lobbyId === 'string' ? data.lobbyId : ''
    const mode = sanitizeMode(data?.mode)
    if (!lobbyId) return
    const entry = voiceLobbyState.get(lobbyKey(mode, lobbyId))?.get(info.sessionKey)
    if (entry) { entry.muted = !!data?.muted; broadcastLobbyState(mode, lobbyId) }
  })

  // PTT 状态广播：按下/松开按键时通知大厅其他人
  sock.on('voice:lobby:ptt', (data: { lobbyId?: string; mode?: string; active?: boolean }) => {
    const info = sock.data.chat as { pubId: string; sessionKey: string } | undefined
    if (!info) return
    const lobbyId = typeof data?.lobbyId === 'string' ? data.lobbyId : ''
    const mode = sanitizeMode(data?.mode)
    if (!lobbyId) return
    const entry = voiceLobbyState.get(lobbyKey(mode, lobbyId))?.get(info.sessionKey)
    if (!entry) return
    entry.pttActive = !!data?.active
    // 广播给同大厅（同 mode）其他成员
    sock.to(lobbyRoom(mode, lobbyId)).emit('voice:lobby:ptt', {
      lobbyId,
      mode,
      pubId: info.pubId,
      active: entry.pttActive,
    })
  })

  // 大厅信令中继：定向投递给同大厅（同 mode）目标用户
  sock.on('voice:lobby:signal', (data: { lobbyId?: string; mode?: string; toPubId?: string; payload?: string }, ack?: (r: unknown) => void) => {
    const info = sock.data.chat as { pubId: string } | undefined
    if (!info) return
    const lobbyId = typeof data?.lobbyId === 'string' ? data.lobbyId : ''
    const mode = sanitizeMode(data?.mode)
    const toPubId = typeof data?.toPubId === 'string' ? data.toPubId : ''
    const payload = typeof data?.payload === 'string' ? data.payload : ''
    if (!lobbyId || !toPubId || !payload || payload.length > 64 * 1024) return
    const room = voiceLobbyState.get(lobbyKey(mode, lobbyId))
    if (!room) return
    // v1.6.0：直接单播到目标 socket（原先全大厅广播）
    let targetSocketId: string | null = null
    for (const entry of room.values()) {
      if (entry.pubId === toPubId) { targetSocketId = entry.socketId; break }
    }
    if (!targetSocketId) return
    io.to(targetSocketId).emit('voice:lobby:signal', {
      lobbyId,
      mode,
      fromPubId: info.pubId,
      toPubId,
      payload,
    })
    ack?.({ ok: true })
  })

  // ===== 语音开黑大厅 · 文字聊天侧栏 =====
  // payload 为客户端用大厅密钥 sealJSON 加密的消息信封；服务器只转发不存储不解析
  sock.on('voice:lobby:text', (data: { lobbyId?: string; mode?: string; payload?: string }, ack?: (r: unknown) => void) => {
    const info = sock.data.chat as { pubId: string; sessionKey: string } | undefined
    if (!info) { ack?.({ error: '尚未加入频道' }); return }
    const lobbyId = typeof data?.lobbyId === 'string' && /^[A-Za-z0-9_-]{2,32}$/.test(data.lobbyId) ? data.lobbyId : ''
    const mode = sanitizeMode(data?.mode)
    const payload = typeof data?.payload === 'string' && data.payload.length > 0 && data.payload.length < 16 * 1024 ? data.payload : ''
    if (!lobbyId || !payload) { ack?.({ error: '参数不合法' }); return }
    // 只有在大厅内的 socket 才能发
    if (!voiceLobbyState.get(lobbyKey(mode, lobbyId))?.has(info.sessionKey)) { ack?.({ error: '不在该大厅内' }); return }
    io.to(lobbyRoom(mode, lobbyId)).emit('voice:lobby:text', {
      lobbyId,
      mode,
      fromPubId: info.pubId,
      payload,
    })
    ack?.({ ok: true })
  })

  // ===== 私聊 1v1 通话（DM call） =====
  // 通话信令本身也走 channelKeyId 加密；服务器只做端到端单播，不向全频道扩散
  // 事件：voice:call:invite / accept / reject / end / signal
  const forwardCallSignal = (
    ev: 'voice:call:invite' | 'voice:call:accept' | 'voice:call:reject' | 'voice:call:end' | 'voice:call:signal',
    sock: Socket,
    data: { toPubId?: string; payload?: string },
    maxBytes: number,
    ack?: (r: unknown) => void,
  ) => {
    const info = sock.data.chat as { channelKeyId: string; pubId: string } | undefined
    if (!info || !data?.toPubId || typeof data.payload !== 'string') return
    if (data.payload.length > maxBytes) return
    const target = findChatSocketId(info.channelKeyId, data.toPubId)
    if (!target) { ack?.({ error: '对方不在线' }); return }
    io.to(target).emit(ev, {
      fromPubId: info.pubId,
      toPubId: data.toPubId,
      payload: data.payload,
    })
    ack?.({ ok: true })
  }

  sock.on('voice:call:invite', (d, ack) => forwardCallSignal('voice:call:invite', sock, d, 16 * 1024, ack))
  sock.on('voice:call:accept', (d) => forwardCallSignal('voice:call:accept', sock, d, 16 * 1024))
  sock.on('voice:call:reject', (d) => forwardCallSignal('voice:call:reject', sock, d, 16 * 1024))
  sock.on('voice:call:end', (d) => forwardCallSignal('voice:call:end', sock, d, 16 * 1024))

  // 通话内 SDP/ICE 信令（加密后定向投递）
  sock.on('voice:call:signal', (d, ack) => forwardCallSignal('voice:call:signal', sock, d, 64 * 1024, ack))

  // ===== 私聊/Whisper =====
  // whisper: 定向投递给同频道目标用户，不广播、不存储（临时性）
  sock.on('chat:whisper', async (data: { payload?: string; toPubId?: string; clientId?: string | null }, ack?: (r: unknown) => void) => {
    const info = sock.data.chat as { channelKeyId: string; pubId: string } | undefined
    if (!info) { ack?.({ error: '尚未加入频道' }); return }
    // v1.7.0：whisper 开关在服务端强制执行（此前只存不查，关了也能用）
    try {
      const flags = await getFeatureFlags()
      if (flags.whisperEnabled === false) { ack?.({ error: '管理员已关闭私聊功能' }); return }
    } catch { /* 查询失败按开启处理 */ }
    const payload = typeof data?.payload === 'string' && data.payload.length > 0 && data.payload.length < 128 * 1024 ? data.payload : ''
    const toPubId = typeof data?.toPubId === 'string' ? data.toPubId : ''
    if (!payload || !toPubId) { ack?.({ error: '参数不合法' }); return }
    // v1.7.0 隐私修复：此前名义上是「定向投递」实际却 emit 给全频道房间，
    // 所有成员都能收到他人的私聊信封与 from/to 元数据；现在单播到目标 socket
    const target = findChatSocketId(info.channelKeyId, toPubId)
    if (!target) { ack?.({ error: '对方不在线' }); return }
    io.to(target).emit('chat:whisper', {
      fromPubId: info.pubId,
      toPubId,
      payload,
      clientId: data?.clientId || null,
    })
    // 同步回执给发送者（确认送达；客户端依赖 ack 渲染本地气泡）
    ack?.({ ok: true })
  })

  sock.on('chat:typing', (data: { on?: boolean }) => {
    const info = sock.data.chat as { channelKeyId: string; pubId: string } | undefined
    if (!info) return
    // v1.6.0：typing 会被放大广播给全频道，必须限流（防一个连接刷爆所有人的事件队列）
    if (!rateLimit('typing:' + info.pubId, 20, 10_000)) return
    sock.to('ch:' + info.channelKeyId).emit('chat:typing', { deviceId: info.pubId, on: !!data?.on })
  })

  // 已读回执：读者上报阅读到的消息 ID，服务端落库并广播给发送方
  // v1.5.0 升级：成员级回执链（每条消息 × 每个读者），支持「谁读了我发的消息」
  sock.on('chat:read', async (data: { ids?: string[] }) => {
    const info = sock.data.chat as { channelKeyId: string; pubId: string } | undefined
    if (!info) return
    if (!rateLimit('read:' + info.pubId, 60, 10_000)) return
    const ids = (Array.isArray(data?.ids) ? data.ids : [])
      .filter((x) => typeof x === 'string' && /^[0-9a-fA-F-]{36}$/.test(x))
      .slice(0, 200)
    if (ids.length === 0) return
    try {
      // 仅标记：属于本频道、非读者自己发送、且尚未标记过的消息
      const msgs = await db.chatMessage.findMany({
        where: { id: { in: ids }, channelKeyId: info.channelKeyId, senderId: { not: info.pubId } },
        select: { id: true, readAt: true, burnAt: true },
      })
      const toMark = msgs.filter((m) => !m.readAt).map((m) => m.id)
      if (toMark.length === 0) return
      await db.chatMessage.updateMany({ where: { id: { in: toMark } }, data: { readAt: new Date() } })
      // v1.5.0 成员级回执链；v1.6.0：原先逐条 await upsert（最多 200 次 SQLite 往返），
      // 合并为单个交互式事务一次提交
      await db.$transaction(
        toMark.map((id) =>
          db.chatReadReceipt.upsert({
            where: { messageId_readerId: { messageId: id, readerId: info.pubId } },
            create: { messageId: id, readerId: info.pubId },
            update: {},
          }),
        ),
      ).catch((e) => console.warn('[relay] 回执批量写入失败:', e instanceof Error ? e.message : e))
      io.to('ch:' + info.channelKeyId).emit('chat:read', {
        ids: toMark,
        readerId: info.pubId, // v1.5.0：携带读者身份，发送方可展示「谁读了」
      })
    } catch (e) {
      console.warn('[relay] chat:read 处理异常:', e instanceof Error ? e.message : e)
    }
  })

  // ===== v1.5.0 「谁读了我发的消息」查询 =====
  sock.on('chat:readers', async (data: { ids?: string[] }, ack?: (r: unknown) => void) => {
    const info = sock.data.chat as { channelKeyId: string } | undefined
    if (!info) { ack?.({ error: '尚未加入频道' }); return }
    const ids = (Array.isArray(data?.ids) ? data.ids : [])
      .filter((x) => typeof x === 'string' && /^[0-9a-fA-F-]{36}$/.test(x))
      .slice(0, 50)
    try {
      // v1.7.0 修复跨频道元数据泄露：此前只按 messageId 查回执，任何频道成员
      // 都可探到其他频道消息的读者列表与阅读时间；现在 join 回 ChatMessage
      // 并限定 channelKeyId，只能查到本频道消息的读者
      const receipts = await db.chatReadReceipt.findMany({
        where: { messageId: { in: ids }, message: { channelKeyId: info.channelKeyId } },
        select: { messageId: true, readerId: true, readAt: true },
      })
      const map: Record<string, Array<{ readerId: string; readAt: string }>> = {}
      for (const r of receipts) {
        ;(map[r.messageId] ||= []).push({ readerId: r.readerId, readAt: r.readAt.toISOString() })
      }
      ack?.({ ok: true, readers: map })
    } catch {
      ack?.({ error: '查询失败' })
    }
  })

  // ===== v1.6.0 表情回应（Reactions） =====
  // emoji 作为元数据明文存储（不含消息内容）；observer 不可回应；同一读者同消息同 emoji 唯一
  sock.on('chat:react', async (data: { messageId?: string; emoji?: string; action?: 'add' | 'remove' }, ack?: (r: unknown) => void) => {
    const info = sock.data.chat as { channelKeyId: string; pubId: string } | undefined
    if (!info) { ack?.({ error: '尚未加入频道' }); return }
    const messageId = typeof data?.messageId === 'string' ? data.messageId : ''
    const emoji = typeof data?.emoji === 'string' ? data.emoji.trim() : ''
    const action = data?.action === 'remove' ? 'remove' : 'add'
    if (!/^[0-9a-fA-F-]{36}$/.test(messageId) || !emoji || [...emoji].length > 8 || emoji.length > 48) {
      ack?.({ error: '参数不合法' }); return
    }
    if (!rateLimit('react:' + info.pubId, 60, 10_000)) { ack?.({ error: '操作太快了' }); return }
    try {
      if (!(await canSend(info.channelKeyId, info.pubId))) { ack?.({ error: '旁听角色无法回应' }); return }
      // 消息必须属于本频道（防止跨频道挂回应）
      const msg = await db.chatMessage.findUnique({
        where: { id: messageId },
        select: { id: true, channelKeyId: true },
      })
      if (!msg || msg.channelKeyId !== info.channelKeyId) { ack?.({ error: '消息不存在' }); return }
      if (action === 'add') {
        await db.chatReaction.upsert({
          where: { messageId_readerId_emoji: { messageId, readerId: info.pubId, emoji } },
          create: { messageId, channelKeyId: info.channelKeyId, readerId: info.pubId, emoji },
          update: {},
        })
      } else {
        await db.chatReaction.deleteMany({
          where: { messageId, readerId: info.pubId, emoji },
        })
      }
      io.to('ch:' + info.channelKeyId).emit('chat:react', {
        messageId,
        readerId: info.pubId,
        emoji,
        action,
        at: new Date().toISOString(),
      })
      ack?.({ ok: true })
    } catch (e) {
      console.warn('[relay] chat:react 异常:', e instanceof Error ? e.message : e)
      ack?.({ error: '操作失败' })
    }
  })

  // ===== v1.7.0 加密投票 =====
  // 选项文字在信封密文内端到端加密；服务器只存「谁对哪条消息投了第几项」。
  // 与 emoji 回应同级的元数据颗粒度；一人一票，可改票（upsert）。
  sock.on('chat:vote', async (data: { messageId?: string; optionIndex?: number }, ack?: (r: unknown) => void) => {
    const info = sock.data.chat as { channelKeyId: string; pubId: string } | undefined
    if (!info) { ack?.({ error: '尚未加入频道' }); return }
    const messageId = typeof data?.messageId === 'string' ? data.messageId : ''
    const optionIndex = Number(data?.optionIndex)
    if (!/^[0-9a-fA-F-]{36}$/.test(messageId) || !Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex > 19) {
      ack?.({ error: '参数不合法' }); return
    }
    if (!rateLimit('vote:' + info.pubId, 30, 10_000)) { ack?.({ error: '操作太快了' }); return }
    try {
      if (!(await canSend(info.channelKeyId, info.pubId))) { ack?.({ error: '旁听角色无法投票' }); return }
      const msg = await db.chatMessage.findUnique({
        where: { id: messageId },
        select: { id: true, channelKeyId: true },
      })
      if (!msg || msg.channelKeyId !== info.channelKeyId) { ack?.({ error: '消息不存在' }); return }
      await db.chatPollVote.upsert({
        where: { messageId_voterId: { messageId, voterId: info.pubId } },
        create: { messageId, channelKeyId: info.channelKeyId, voterId: info.pubId, optionIndex },
        update: { optionIndex },
      })
      io.to('ch:' + info.channelKeyId).emit('chat:vote', {
        messageId,
        voterId: info.pubId,
        optionIndex,
        at: new Date().toISOString(),
      })
      ack?.({ ok: true })
    } catch (e) {
      console.warn('[relay] chat:vote 异常:', e instanceof Error ? e.message : e)
      ack?.({ error: '投票失败' })
    }
  })

  // ===== v1.5.0 频道角色管理 =====
  // 查询我的角色与全成员列表（pubId + role；昵称由客户端用 presence 解密）
  sock.on('chat:members', async (_data: unknown, ack?: (r: unknown) => void) => {
    const info = sock.data.chat as { channelKeyId: string; pubId: string } | undefined
    if (!info) { ack?.({ error: '尚未加入频道' }); return }
    try {
      const members = await db.chatMember.findMany({
        where: { channelKeyId: info.channelKeyId },
        select: { pubId: true, role: true },
      })
      const me = members.find((m) => m.pubId === info.pubId)?.role || 'member'
      ack?.({ ok: true, me, members })
    } catch {
      ack?.({ error: '查询失败' })
    }
  })

  // 变更成员角色（owner/admin 操作）
  sock.on('chat:setRole', async (data: { targetPubId?: string; role?: string }, ack?: (r: unknown) => void) => {
    const info = sock.data.chat as { channelKeyId: string; pubId: string } | undefined
    if (!info) { ack?.({ error: '尚未加入频道' }); return }
    const role = data?.role
    if (!['admin', 'member', 'observer'].includes(role || '')) { ack?.({ error: '角色不合法' }); return }
    const targetPubId = typeof data.targetPubId === 'string' ? data.targetPubId : ''
    if (!targetPubId) { ack?.({ error: '参数不合法' }); return }
    try {
      const r = await setMemberRole(info.channelKeyId, info.pubId, targetPubId, role as 'admin' | 'member' | 'observer')
      if (!r.ok) { ack?.({ error: r.error }); return }
      // 广播给全频道（客户端更新成员面板角色标签）
      io.to('ch:' + info.channelKeyId).emit('chat:roleChanged', {
        targetPubId,
        role,
        operatorPubId: info.pubId,
      })
      ack?.({ ok: true })
    } catch {
      ack?.({ error: '操作失败' })
    }
  })

  // 昵称/头像实时更新：重新加密的昵称或头像广播给频道内所有人
  sock.on('chat:nick', (data: { nickEnc?: string; avatarEnc?: string | null; moodEnc?: string }) => {
    const info = sock.data.chat as { channelKeyId: string; sessionKey: string; pubId: string } | undefined
    if (!info) return
    // v1.7.0：补上限流 —— 此前每次 nick 更新都触发全频道 presence 查询+广播，
    // 单连接可无限制刷爆全频道事件队列与 SQLite
    if (!rateLimit('nick:' + info.pubId, 15, 10_000)) return
    const room = chatPresence.get(info.channelKeyId)
    const entry = room?.get(info.sessionKey)
    if (!entry || entry.socketId !== sock.id) return
    const nickEnc = typeof data?.nickEnc === 'string' && data.nickEnc.length < 4096 ? data.nickEnc : null
    if (nickEnc) entry.nickEnc = nickEnc
    // 头像可独立更新（清空时传 null）
    if (data && Object.prototype.hasOwnProperty.call(data, 'avatarEnc')) {
      const v = data.avatarEnc
      entry.avatarEnc = (typeof v === 'string' && v.length < 96 * 1024) ? v : undefined
    }
    // v1.7.0：心情状态随 presence 广播（加密信封，服务端不可读）
    if (data && Object.prototype.hasOwnProperty.call(data, 'moodEnc')) {
      const m = data.moodEnc
      entry.moodEnc = (typeof m === 'string' && m.length < 2048) ? m : undefined
    }
    broadcastFullPresence(info.channelKeyId)
  })

  sock.on('chat:delete', async (data: { ids?: string[]; all?: boolean }, ack?: (r: unknown) => void) => {
    try {
      const r = await deleteMessages(sock, data?.ids || null, !!data?.all)
      ack?.(r)
    } catch {
      ack?.({ error: '删除失败' })
    }
  })

  // ===== 网盘（多端同步） =====
  sock.on('drive:join', async (data: { token?: string }) => {
    try {
      if (sock.data.drive) return
      const session = await verifyDriveSession(typeof data?.token === 'string' ? data.token : '')
      if (!session) {
        sock.emit('drive:error', { code: 'auth', message: '会话无效或已过期' })
        return
      }
      sock.data.drive = { repoId: session.repoId }
      sock.join('dr:' + session.repoId)
      sock.emit('drive:ready', { repoId: session.repoId })
    } catch {
      sock.emit('drive:error', { code: 'server', message: '加入失败' })
    }
  })

  sock.on('drive:changed', () => {
    const info = sock.data.drive
    if (!info) return
    sock.to('dr:' + info.repoId).emit('drive:changed', {})
  })

  sock.on('disconnect', () => {
    const info = sock.data.chat as { channelKeyId: string; sessionKey: string; pubId: string } | undefined
    if (info) {
      // 清理频道 voice 状态
      const chVoice = voiceState.get(info.channelKeyId)
      if (chVoice) {
        chVoice.delete(info.sessionKey)
        if (chVoice.size === 0) voiceState.delete(info.channelKeyId)
        broadcastVoiceState(info.channelKeyId)
      }
      // 清理 lobby voice 状态（遍历所有 lobby 找该 sessionKey）
      for (const [key, room] of voiceLobbyState) {
        if (room.has(info.sessionKey)) {
          room.delete(info.sessionKey)
          if (room.size === 0) voiceLobbyState.delete(key)
          // 复合键格式为 `${mode}:${lobbyId}`，重新解析后广播
          const sep = key.indexOf(':')
          const mode = sep > 0 ? key.slice(0, sep) : 'p2p'
          const lobbyId = sep > 0 ? key.slice(sep + 1) : key
          broadcastLobbyState(mode, lobbyId)
        }
      }
      // 清理聊天 presence
      const room = chatPresence.get(info.channelKeyId)
      if (room) {
        const entry = room.get(info.sessionKey)
        if (entry && entry.socketId === sock.id) {
          room.delete(info.sessionKey)
          // 会话最后活跃时间落库，供「近 24h 活跃设备」展示
          db.chatSession.update({ where: { id: info.sessionKey }, data: { lastSeenAt: new Date() } }).catch(() => {})
        }
        if (room.size === 0) chatPresence.delete(info.channelKeyId)
      }
      broadcastFullPresence(info.channelKeyId)
    }
  })

  sock.on('error', () => { /* 静默处理，避免把错误细节打进日志 */ })
})

// ---------------- v1.7.0 未完成上传定时清理 ----------------
// cleanupStaleUploads 原本从未被任何调用方触发（死代码），
// 中断的上传（ready=false 超过 24h）会永久留在磁盘与库里；现在每小时清理一次
const STALE_SWEEP_MS = 3600_000
setInterval(() => {
  void cleanupStaleUploads(async () => {
    const since = new Date(Date.now() - 24 * 3600 * 1000)
    const staleChat = await db.chatFile.findMany({
      where: { ready: false, createdAt: { lt: since } },
      select: { id: true },
      take: 200,
    })
    const staleDrive = await db.driveFile.findMany({
      where: { ready: false, createdAt: { lt: since } },
      select: { id: true },
      take: 200,
    })
    const items: { ns: 'chat' | 'drive'; fileId: string }[] = [
      ...staleChat.map((f) => ({ ns: 'chat' as const, fileId: f.id })),
      ...staleDrive.map((f) => ({ ns: 'drive' as const, fileId: f.id })),
    ]
    // 磁盘目录已清理后把孤儿行也删掉
    for (const it of items) {
      if (it.ns === 'chat') await db.chatFile.deleteMany({ where: { id: it.fileId, ready: false } }).catch(() => {})
      else await db.driveFile.deleteMany({ where: { id: it.fileId, ready: false } }).catch(() => {})
    }
    return items
  })
}, STALE_SWEEP_MS)

const PORT = SERVER_CONFIG.wsPort
// v1.7.0：等 PRAGMA（WAL/busy_timeout）生效后再对外提供服务，避免首查竞争
// v1.7.1：listen 前先完成数据库自举（DATABASE_URL 缺省推导 + 缺表自动 db push），
// 一键部署/裸机全新环境下不再出现「服务活着但一切查询报错」的假可用状态
void (async () => {
  const url = resolveDatabaseUrl()
  const ok = await ensureDatabase()
  if (!ok) {
    console.warn('[relay] 数据库自举失败，服务仍将启动但请求会报错（请检查磁盘权限或手动执行 prisma db push）')
  }
  // v1.7.1：自举完成后播种 wipe 纪元（避免全新环境下的首查报错噪音）
  try {
    const c = await db.adminConfig.findFirst({ select: { wipeEpoch: true } })
    lastWipeEpoch = c?.wipeEpoch ?? 0
  } catch { /* ignore */ }
  // 只输出数据库文件位置（不含凭据，SQLite 连接串即文件路径），便于部署排查
  console.log(`[relay] database = ${url.replace(/^file:/, '')} (ready=${ok})`)
  await dbReady()
  httpServer.listen(PORT, () => {
    console.log(`[relay] CipherChat relay service listening on :${PORT} (instance ${randomUUID().slice(0, 8)})`)
  })
})()

// 优雅退出：先停接收新连接 → 关闭所有 socket → 断开数据库连接后退出
let shuttingDown = false
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[relay] received ${sig}, shutting down`)
    io.close(() => {
      httpServer.close(() => {
        db.$disconnect().finally(() => process.exit(0))
      })
    })
    // 兜底：3s 后无论如何退出（systemd 会发 SIGKILL）
    setTimeout(() => process.exit(0), 3000).unref()
  })
}
