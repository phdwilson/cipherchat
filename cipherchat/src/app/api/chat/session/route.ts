// 建立聊天会话：客户端提交 channelId + authHash（密码派生哈希，服务器永不知晓密码明文）
// probeHash：任何密码输入处附带的"自毁探测哈希"，命中自毁密钥即触发全局销毁
import { NextRequest } from 'next/server'
import { createChatSession, cleanupExpiredSessions } from '@/lib/server/session'
import { jsonError, jsonOk, reqDeviceLabel, reqIp } from '@/lib/server/api'
import { rateLimit } from '@/lib/server/ratelimit'
import { matchesDestroyProbe, executeGlobalWipe } from '@/lib/server/admin'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const ip = reqIp(req)
  if (!rateLimit('chat-session:' + ip, 30, 60_000)) {
    return jsonError('请求过于频繁，请稍后再试', 429)
  }

  let body: { channelId?: string; authHash?: string; probeHash?: string; pubId?: string; deviceInfoEnc?: string; geoDisclosure?: string }
  try {
    body = await req.json()
  } catch {
    return jsonError('请求格式错误')
  }

  const channelId = (body.channelId || '').trim()
  const authHash = (body.authHash || '').trim().toLowerCase()
  const pubId = (body.pubId || '').trim()
  const deviceInfoEnc = (body.deviceInfoEnc || '').slice(0, 4096)
  // IP 披露级别由用户在加入表单选择；「不披露(hidden)」是否可用由服务端按管理员开关强制裁决
  const geoDisclosure = ['full', 'region', 'hidden'].includes(body.geoDisclosure || '')
    ? (body.geoDisclosure as 'full' | 'region' | 'hidden') : 'full'

  if (!channelId || channelId.length > 64) return jsonError('频道 ID 长度需为 1-64 个字符')
  // 允许任意语言文字（含中文）、数字、下划线与短横线
  if (!/^[\p{L}\p{N}_-]+$/u.test(channelId)) return jsonError('频道 ID 仅支持文字、数字、下划线和短横线')
  if (!/^[a-f0-9]{64}$/.test(authHash)) return jsonError('认证数据格式错误')
  if (!/^[a-zA-Z0-9-]{8,64}$/.test(pubId)) return jsonError('设备标识格式错误')

  // ★ 自毁探测：密码命中自毁密钥 → 销毁全部聊天与网盘数据后直接返回
  if (await matchesDestroyProbe(body.probeHash)) {
    await executeGlobalWipe()
    return jsonOk({ destroyed: true })
  }

  // 偶尔清理过期会话与僵尸上传
  if (Math.random() < 0.1) cleanupExpiredSessions().catch(() => {})

  // v1.7.1 兜底：数据库未初始化（一键部署环境）时先自举，避免 web/relay 两侧库状态不一致
  const { ensureDatabase } = await import('@/lib/server/db-bootstrap')
  await ensureDatabase()

  const { token, session } = await createChatSession({
    channelId,
    authHash,
    pubId,
    deviceLabel: reqDeviceLabel(req),
    deviceInfoEnc,
    ip,
    geoDisclosure,
  })

  return jsonOk({
    token, // 仅此一次返回给客户端，之后通过请求头携带
    deviceId: session.pubId, // 稳定设备标识（持久 UUID，重进频道后历史消息归属依然正确）
    channelKeyId: session.channelKeyId,
  })
}
