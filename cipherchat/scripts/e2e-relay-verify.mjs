// v1.7.1 端到端验证：两个「客户端」走真实协议完成 建会话 → 入频道 → 发消息 → 对方收到
// 用法：先启动 relay（bun mini-services/relay/index.ts），再 bun scripts/e2e-relay-verify.mjs [端口]
// 退出码 0 = 全部通过。覆盖 v1.7.1 的自举后正常链路 + 未入频道拒绝路径 + presence。
import { io } from 'socket.io-client'

const PORT = process.argv[2] || '3003'
const URL = `http://127.0.0.1:${PORT}`
const FAILS = []
const ok = (cond, name) => {
  console.log(`${cond ? '✅' : '❌'} ${name}`)
  if (!cond) FAILS.push(name)
}
const withTimeout = (p, ms, label) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(label + ' 超时')), ms))])

// ---- 用服务端库直接建会话（与 web /api/chat/session 同一函数）----
const { createChatSession } = await import('../src/lib/server/session.ts')
const authHash = 'a'.repeat(64) // 任意 64 hex（真实场景为客户端 PBKDF2 派生）
const mk = (pubId) =>
  createChatSession({
    channelId: 'e2e-relay-171',
    authHash,
    pubId,
    deviceLabel: 'e2e',
    deviceInfoEnc: '',
    ip: '127.0.0.1',
    geoDisclosure: 'full',
  })
const alice = await mk('e2e-alice-01')
const bob = await mk('e2e-bob-01')
ok(alice.token?.length > 30 && bob.token?.length > 30, 'createChatSession 签发 token')

// 入频连接：connect → chat:join → 等 chat:ready
const connect = (token) =>
  new Promise((resolve, reject) => {
    const s = io(URL, { transports: ['websocket', 'polling'], timeout: 8000, reconnection: false })
    const t = setTimeout(() => reject(new Error('chat:ready 超时')), 8000)
    s.on('chat:error', (d) => { clearTimeout(t); reject(new Error(`chat:error ${d?.code}: ${d?.message}`)) })
    s.on('chat:ready', () => { clearTimeout(t); resolve(s) })
    s.on('connect', () => s.emit('chat:join', { token, nickEnc: 'e2e', deviceInfoEnc: '' }))
    s.on('connect_error', (e) => { clearTimeout(t); reject(e) })
  })

// 不入频的裸连接（负向用例）
const connectRaw = () =>
  new Promise((resolve, reject) => {
    const s = io(URL, { transports: ['websocket', 'polling'], timeout: 8000, reconnection: false })
    s.on('connect', () => resolve(s))
    s.on('connect_error', (e) => reject(e))
    setTimeout(() => reject(new Error('裸连接超时')), 8000)
  })

// presence 采集：从连接起挂监听，避免错过早期广播
const latestPresence = []
const trackPresence = (s) => s.on('chat:presence', (d) => { if (d?.devices) latestPresence.push(d.devices) })

// ---- 1) 未入频道发送 → 必须被拒（裸连接，不发 chat:join）----
const sRaw = await connectRaw()
const rej = await withTimeout(
  new Promise((resolve) => sRaw.emit('chat:message', { payload: 'x', clientId: 'pre-join' }, (r) => resolve(r))),
  5000,
  '未入频道 ack',
)
ok(rej && rej.error === '尚未加入频道', `未入频道发送被拒（got: ${JSON.stringify(rej)}）`)
sRaw.disconnect()

// ---- 2) 双方入频道，alice 发消息 → ack ok + bob 实时收到广播 ----
const sAlice = await connect(alice.token)
trackPresence(sAlice)
const sBob = await connect(bob.token)
trackPresence(sBob)

const gotByBob = new Promise((resolve) => sBob.on('chat:message', (m) => resolve(m)))
const ack = await withTimeout(
  new Promise((resolve) => sAlice.emit('chat:message', { payload: 'e2e-hello-171', clientId: 'c-1' }, (r) => resolve(r))),
  6000,
  'chat:message ack',
)
ok(ack?.ok === true && typeof ack.id === 'string', `发送 ack ok（got: ${JSON.stringify(ack)}）`)
const received = await withTimeout(gotByBob, 6000, 'bob 接收广播')
ok(received?.payload === 'e2e-hello-171' && received?.senderId === alice.session.pubId, 'bob 实时收到消息广播')

// ---- 3) presence：任一广播快照同时含双方 ----
await new Promise((r) => setTimeout(r, 1500))
const bothIn = latestPresence.some((devices) => {
  const ids = devices.map((d) => d.deviceId)
  return ids.includes(alice.session.pubId) && ids.includes(bob.session.pubId)
})
ok(bothIn, `presence 含双方在线设备（共收到 ${latestPresence.length} 次广播）`)

sAlice.disconnect()
sBob.disconnect()
console.log(FAILS.length === 0 ? '\n全部通过 ✅' : `\n失败 ${FAILS.length} 项 ❌`)
process.exit(FAILS.length === 0 ? 0 : 1)
