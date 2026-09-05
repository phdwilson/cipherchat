// 中继健康探针：验证 relay 是否可连、chat:join 是否正常
// 用法：bun scripts/relay-probe.mjs [端口] [中继URL]
// 输出判定：
//   connect 失败          → 网关/中继不可达（XTransformPort 未被转发或 relay 未启动）
//   chat:error code=auth  → 中继健康（能读 DB 并校验会话；无效 token 被正确拒绝）
//   chat:error code=server → 中继进程活着，但数据库不可用（未初始化/连不上）——
//                            这正是「已连接 · 0 台设备在线 · 发送失败」的根源
import { io } from 'socket.io-client'

const arg = process.argv[2]
const url = arg && /^https?:\/\//.test(arg) ? arg : `http://127.0.0.1:${arg || '3003'}`
const wantsJson = process.argv.includes('--json')

const result = { url, connected: false, joinError: null, code: null, elapsedMs: null }

const socket = io(url, {
  transports: ['websocket', 'polling'],
  timeout: 8000,
  reconnection: false,
})

const done = (exitCode) => {
  if (wantsJson) console.log(JSON.stringify(result, null, 2))
  process.exit(exitCode)
}
const timer = setTimeout(() => {
  if (!result.connected) console.error('[probe] 连接超时：中继不可达')
  else console.error('[probe] 已连接但 chat:join 无响应')
  done(2)
}, 10_000)

socket.on('connect', () => {
  result.connected = true
  const t0 = Date.now()
  socket.emit('chat:join', { token: 'probe-invalid-token-000000000000000000000000' }, () => {})
  socket.on('chat:error', (d) => {
    result.elapsedMs = Date.now() - t0
    result.code = d?.code || 'unknown'
    result.joinError = d?.message || ''
    console.error(`[probe] connect=ok, chat:error code=${result.code} message="${result.joinError}"`)
    clearTimeout(timer)
    socket.disconnect()
    // auth = 健康（正确拒绝了无效会话）；server = 中继的数据库不可用
    done(result.code === 'auth' ? 0 : 1)
  })
  setTimeout(() => {
    // 8s 内没有 chat:error 也没有被踢——join 静默失败（更糟）
    if (result.code === null) {
      console.error('[probe] chat:join 后既无 ready 也无 error（静默失败）')
      clearTimeout(timer)
      socket.disconnect()
      done(3)
    }
  }, 8000)
})
socket.on('connect_error', (e) => {
  console.error('[probe] connect_error:', e?.message || e)
  clearTimeout(timer)
  done(2)
})
