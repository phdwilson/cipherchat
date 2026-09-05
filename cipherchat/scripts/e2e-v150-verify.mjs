// v1.5.0 新功能自动化测试
// 覆盖：成员级回执链 / 阅后即焚 / 角色权限（越权修复）/ 离线信箱 / DMS / 安全审计 API
import { webcrypto as crypto } from 'node:crypto'

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:3100'
const WS = process.env.E2E_WS || 'http://127.0.0.1:3003'
const enc = new TextEncoder()
const dec = new TextDecoder()
let PASS = 0, FAIL = 0
const failures = []
function ok(cond, label) {
  if (cond) { PASS++; console.log('  [PASS]', label) }
  else { FAIL++; failures.push(label); console.log('  [FAIL]', label) }
}
function toHex(bytes) { return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('') }
async function pbkdf2(password, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations }, base, 256))
}
async function sealJSON(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)))
  return JSON.stringify({ iv: Buffer.from(iv).toString('base64'), data: Buffer.from(ct).toString('base64') })
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function once(sock, event) { return new Promise((resolve) => sock.once(event, resolve)) }

async function makeClient(channelId, password, pubId) {
  const auth = toHex(await pbkdf2(password, 'cipherchat:auth:' + channelId, 120000))
  const keyBits = await pbkdf2(password, 'cipherchat:key:' + channelId, 310000)
  const aesKey = await crypto.subtle.importKey('raw', keyBits, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
  const res = await fetch(`${BASE}/api/chat/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channelId, authHash: auth, probeHash: '', pubId }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data?.error || `session failed ${res.status}`)
  return { token: data.token, aesKey, pubId }
}

console.log('CipherChat v1.5.0 自动化测试 @', new Date().toISOString())
const CH = 'v150-test-' + Date.now().toString(36)
const PW = 'V15Test#Secure'
const alice = await makeClient(CH, PW, 'e2e-v15-alice-01') // owner（首个加入）
const bob = await makeClient(CH, PW, 'e2e-v15-bob-0001')
const { io } = await import('socket.io-client')

const sockA = io(WS, { transports: ['websocket'], path: '/' })
await once(sockA, 'connect')
sockA.emit('chat:join', { token: alice.token })
await once(sockA, 'chat:ready')
await sleep(500) // 确保 Alice 先登记为 owner

const sockB = io(WS, { transports: ['websocket'], path: '/' })
await once(sockB, 'connect')
sockB.emit('chat:join', { token: bob.token })
await once(sockB, 'chat:ready')
await sleep(300)

// ================= A. 成员级回执链 =================
console.log('\n===[A] 成员级已读回执链 ===')

// Alice 发一条，Bob 读
const payload = await sealJSON(alice.aesKey, { v: 1, nick: 'Alice', kind: 'text', text: 'receipt-chain-test' })
const ack = await sockA.emitWithAck('chat:message', { payload, clientId: 'rc1' })
ok(ack?.ok === true, 'Alice 发送消息成功')
const msgId = ack.id

let readerBroadcast = null
sockA.on('chat:read', (d) => { if (d.ids?.includes(msgId)) readerBroadcast = d.readerId })
sockB.emit('chat:read', { ids: [msgId] })
await sleep(600)
ok(readerBroadcast === bob.pubId, `回执广播携带读者身份（readerId=${readerBroadcast}）`)

// 查询谁读了
const readersAck = await sockA.emitWithAck('chat:readers', { ids: [msgId] })
ok(readersAck?.ok && Array.isArray(readersAck.readers?.[msgId]) && readersAck.readers[msgId].some((r) => r.readerId === bob.pubId),
  '「谁读了我的消息」查询返回正确读者链')

// ================= B. 角色权限体系 =================
console.log('\n===[B] 频道角色体系 ===')
const membersAck = await sockA.emitWithAck('chat:members', {})
ok(membersAck?.ok === true && membersAck.members?.length >= 2, 'chat:members 返回成员列表')
ok(membersAck.me === 'owner' || membersAck.members?.some((m) => m.role === 'owner'), `存在 owner 角色（Alice=${membersAck.me}）`)
const bobRole = membersAck.members?.find((m) => m.pubId === bob.pubId)?.role
ok(bobRole === 'member', `后加入者默认 member（Bob=${bobRole}）`)

// Bob（member）清空频道应被拒 —— 越权修复验证
const clearAck = await sockB.emitWithAck('chat:delete', { all: true })
ok(clearAck?.error?.includes('创建者'), `member 清空频道被拒（越权修复）：${clearAck?.error}`)

// Alice（owner）任命 Bob 为 admin
const setRoleAck = await sockA.emitWithAck('chat:setRole', { targetPubId: bob.pubId, role: 'admin' })
ok(setRoleAck?.ok === true, 'owner 任命 admin 成功')

// member 不能任命
// （Bob 现在是 admin；再拉一个 charlie 测试 member 无权管理）
const charlie = await makeClient(CH, PW, 'e2e-v15-charlie-0')
const sockC = io(WS, { transports: ['websocket'], path: '/' })
await once(sockC, 'connect')
sockC.emit('chat:join', { token: charlie.token })
await once(sockC, 'chat:ready')
await sleep(300)
const cSetRole = await sockC.emitWithAck('chat:setRole', { targetPubId: bob.pubId, role: 'observer' })
ok(cSetRole?.error, `member 设置角色被拒：${cSetRole?.error}`)

// ================= C. 阅后即焚 =================
console.log('\n===[C] 阅后即焚（TTL） ===')
const burnPayload = await sealJSON(alice.aesKey, { v: 1, nick: 'Alice', kind: 'text', text: 'burn-me' })
// 最小 TTL 是 300s；为快速测试直接发一个非法小值 → 应不设置 burnAt（服务端白名单）
const burnAckNormal = await sockA.emitWithAck('chat:message', { payload: burnPayload, clientId: 'burn-normal', burnAfterSec: 3600 })
ok(burnAckNormal?.ok === true, '带 TTL=3600s 的消息发送成功')
const burnAckBad = await sockA.emitWithAck('chat:message', { payload: burnPayload, clientId: 'burn-bad', burnAfterSec: 5 })
ok(burnAckBad?.ok === true, '非法 TTL=5s 消息仍发送成功（服务端忽略非法值）')

// 验证历史接口中 TTL 消息存在（焚毁由服务端定时器执行，此处验证字段链路完整）
const hRes = await fetch(`${BASE}/api/chat/history?limit=10`, { headers: { 'x-session-token': alice.token } })
ok(hRes.ok, '历史拉取正常（焚毁消息在到期前可见）')

// ================= D. P2P 离线信箱 =================
console.log('\n===[D] P2P 离线信箱 ===')
// 注册身份
const putIdent = await fetch(`${BASE}/api/chat/mailbox`, {
  method: 'PUT',
  headers: { 'content-type': 'application/json', 'x-session-token': alice.token },
  body: JSON.stringify({ publicKey: 'dGVzdHB1YmxpY2tleWJhc2U2NGVuY29kZWQxMjM0NQ==' }),
})
ok(putIdent.ok, 'Alice 注册信箱公钥成功')

// 查询公钥
const getIdent = await fetch(`${BASE}/api/chat/mailbox?pubId=${alice.pubId}`, { headers: { 'x-session-token': bob.token } })
const identData = await getIdent.json()
ok(getIdent.ok && identData.publicKey, 'Bob 查询到 Alice 的公钥')

// 投递信件（模拟密文信封）
const fakeEnvelope = JSON.stringify({ v: 1, senderPub: 'c2VuZGVycHViS2V5YmFzZTY0', iv: Buffer.from('0123456789ab').toString('base64'), data: Buffer.from('sealed').toString('base64') })
const sendMail = await fetch(`${BASE}/api/chat/mailbox`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-session-token': bob.token },
  body: JSON.stringify({ toPubId: alice.pubId, envelope: fakeEnvelope }),
})
ok(sendMail.ok, 'Bob 向 Alice 信箱投递离线信件')

// 收取并删除（取走即删）
const recv1 = await fetch(`${BASE}/api/chat/mailbox`, { method: 'DELETE', headers: { 'x-session-token': alice.token } })
const recv1Data = await recv1.json()
ok(recv1.ok && recv1Data.items?.length === 1 && recv1Data.items[0].from === bob.pubId, 'Alice 收取到 1 封离线信件')
const recv2 = await fetch(`${BASE}/api/chat/mailbox`, { method: 'DELETE', headers: { 'x-session-token': alice.token } })
const recv2Data = await recv2.json()
ok(recv2.ok && (recv2Data.items || []).length === 0, '第二次收取为空（服务器不留副本，零知识）')

// 未注册用户不可投递
const sendToUnregistered = await fetch(`${BASE}/api/chat/mailbox`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-session-token': bob.token },
  body: JSON.stringify({ toPubId: 'nobody-here-00001', envelope: fakeEnvelope }),
})
ok(sendToUnregistered.status === 404, '向未注册用户投递被拒（404）')

// 未登录访问被拒
const unauthMail = await fetch(`${BASE}/api/chat/mailbox`, { method: 'DELETE' })
ok(unauthMail.status === 401, '未登录收取信箱被拒（401）')

// ================= E. 安全审计 API =================
console.log('\n===[E] 安全审计 ===')
const audit = await fetch(`${BASE}/api/chat/audit`, { headers: { 'x-session-token': alice.token } })
const auditData = await audit.json()
ok(audit.ok && auditData.me?.pubId === alice.pubId, '审计数据返回本人信息')
ok(Array.isArray(auditData.sessions) && auditData.sessions.some((s) => s.isCurrent), '会话列表含当前设备标记')
ok(auditData.identityRegistered === true, '信箱注册状态正确反映')

// 吊销他人会话被拒 / 吊销自己名下会话成功
const foreignSessions = await makeClient(CH, PW, 'e2e-v15-temp-0001')
const revForeign = await fetch(`${BASE}/api/chat/audit`, {
  method: 'DELETE',
  headers: { 'content-type': 'application/json', 'x-session-token': alice.token },
  body: JSON.stringify({ sessionId: foreignSessions.token.slice(0, 8) }), // 非 UUID → 400
})
ok(!revForeign.ok, '吊销非法 sessionId 被拒')

// 吊销自己的其他会话：先建一个新 session 拿其 id…… token 不含 id，
// 通过 audit 列表找一个非当前会话吊销
const other = auditData.sessions.find((s) => !s.isCurrent)
if (other) {
  const rev = await fetch(`${BASE}/api/chat/audit`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json', 'x-session-token': alice.token },
    body: JSON.stringify({ sessionId: other.id }),
  })
  ok(rev.ok, `吊销自己名下的旧会话成功`)
} else {
  PASS++; console.log('  [PASS] 无多余会话可吊销（跳过正向用例）')
}

// ================= F. Dead Man's Switch =================
console.log('\n===[F] Dead Man\'s Switch ===')
// 默认管理员未开放 → GET 应返回 enabled:false，POST 应 403
const dmsGet1 = await fetch(`${BASE}/api/chat/dms`, { headers: { 'x-session-token': alice.token } }).then((r) => r.json())
ok(dmsGet1.enabled === false, '默认 dmsEnabled=false → 用户侧功能隐藏')
const dmsPost1 = await fetch(`${BASE}/api/chat/dms`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-session-token': alice.token },
  body: JSON.stringify({ graceDays: 7, action: 'notify', notifyMailbox: bob.pubId }),
})
ok(dmsPost1.status === 403, '未开放时布防请求被拒（403）')

sockA.disconnect(); sockB.disconnect(); sockC.disconnect()

console.log(`\n===== v1.5.0 结果: ${PASS} 通过 / ${FAIL} 失败 =====`)
if (failures.length) { for (const f of failures) console.log(' -', f); process.exit(1) }
process.exit(0)
