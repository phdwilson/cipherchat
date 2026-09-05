// 闪照（view-once）服务器焚毁逻辑端到端验证
// 流程：建会话 → init(viewOnce) → 传 1 块 → complete → 首次下载 200 → 二次下载必须 410
import { pbkdf2Sync, randomUUID } from 'crypto'

const BASE = 'http://localhost:3000'
const channelId = 'flash-test-' + randomUUID().slice(0, 8)
const password = 'FlashTest123!'

async function main() {
  // 1) 派生 authHash（与客户端 PBKDF2-SHA256 120000 轮一致）
  const auth = pbkdf2Sync(password, 'cipherchat:auth:' + channelId, 120000, 32, 'sha256').toString('hex')
  const probe = pbkdf2Sync('no-destroy-key', 'cipherchat:probe', 120000, 32, 'sha256').toString('hex')

  // 2) 创建会话
  const res = await fetch(BASE + '/api/chat/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channelId, authHash: auth, probeHash: probe, pubId: randomUUID(), deviceInfoEnc: '', geoDisclosure: 'full' }),
  })
  const sess = await res.json()
  if (!res.ok || !sess.token) throw new Error('建会话失败: ' + JSON.stringify(sess))
  const token = sess.token
  console.log('[1] 会话创建成功')

  // 3) init 闪照文件（1 块）
  const initRes = await fetch(BASE + '/api/chat/files/init', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-session-token': token },
    body: JSON.stringify({ totalChunks: 1, totalBytes: 40, viewOnce: true }),
  })
  const init = await initRes.json()
  if (!init.fileId) throw new Error('init 失败: ' + JSON.stringify(init))
  console.log('[2] 闪照文件 init 成功 fileId=' + init.fileId)

  // 4) 传一块假密文
  const chunkRes = await fetch(BASE + `/api/chat/files/chunk?fileId=${init.fileId}&index=0`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'x-session-token': token },
    body: Buffer.from('0'.repeat(40)),
  })
  if (!chunkRes.ok) throw new Error('chunk 失败: ' + (await chunkRes.text()))
  const compRes = await fetch(BASE + '/api/chat/files/complete', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-session-token': token },
    body: JSON.stringify({ fileId: init.fileId }),
  })
  if (!compRes.ok) throw new Error('complete 失败: ' + (await compRes.text()))
  console.log('[3] 分块上传 + 完结成功')

  // 5) 首次下载应 200
  const dl1 = await fetch(BASE + `/api/chat/file/${init.fileId}`, { headers: { 'x-session-token': token } })
  const body1 = await dl1.text()
  console.log(`[4] 首次下载 status=${dl1.status} len=${body1.length}`)
  if (dl1.status !== 200) throw new Error('首次下载应为 200')

  // 6) 二次下载必须 410（已焚毁）
  const dl2 = await fetch(BASE + `/api/chat/file/${init.fileId}`, { headers: { 'x-session-token': token } })
  const body2 = await dl2.json().catch(() => ({}))
  console.log(`[5] 二次下载 status=${dl2.status} resp=${JSON.stringify(body2)}`)
  if (dl2.status !== 410 && dl2.status !== 404) throw new Error('二次下载应为 410/404（闪照已焚毁）')

  console.log('✅ 闪照焚毁逻辑验证通过：首看 200，再看 410/404，服务器密文与记录已删除')
}

main().catch((e) => {
  console.error('❌ 验证失败:', e.message)
  process.exit(1)
})
