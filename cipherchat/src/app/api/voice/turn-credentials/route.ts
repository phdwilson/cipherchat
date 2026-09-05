// TURN 凭证签发接口（static 长期凭证 / time-limited 短期凭证统一入口）
// v1.7.0 变更：
//  - 公开 /api/config 不再下发任何 TURN 凭证，凭证只从本端点获取
//  - 本端点保持独立限流（30/分/IP）；已登录聊天会话优先按会话维度限流
//  - time-limited 模式按 RFC 5389 §2.2 签发 1 小时短期凭证（coturn use-auth-secret）
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { jsonError, jsonOk, reqIp, sessionToken } from '@/lib/server/api'
import { rateLimit } from '@/lib/server/ratelimit'
import { getTurnConfig, generateTimedTurnCredentials } from '@/lib/server/config'
import { verifyChatSession } from '@/lib/server/session'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const ip = reqIp(req)
  // 已登录会话用会话 ID 限流（NAT 后多设备共享 IP 不互相挤占）；未登录按 IP 限流
  const token = sessionToken(req)
  const session = token ? await verifyChatSession(token) : null
  const bucket = session ? 'turn-creds:s:' + session.id : 'turn-creds:' + ip
  if (!rateLimit(bucket, 30, 60_000)) {
    return jsonError('请求过于频繁', 429)
  }
  const cfg = await getTurnConfig()
  if (!cfg.enabled) {
    return jsonError('TURN 未启用')
  }
  if (cfg.secretMode !== 'time-limited') {
    // static 模式：返回已配置的长期凭证（WebRTC ICE 凭证本质上必须对浏览器可见，
    // 防滥用靠限流 + 独立端点收敛暴露面；如需彻底解决请切换 time-limited 模式）
    return jsonOk({
      username: cfg.username || '',
      credential: cfg.credential || '',
      servers: cfg.servers,
      stunServers: cfg.stunServers,
      expiresAt: 0,
    })
  }
  // time-limited：从数据库取 HMAC 共享密钥并签发
  const row = await db.adminConfig.findFirst()
  if (!row || !row.turnCredential) {
    return jsonError('短期凭证密钥未配置')
  }
  // 凭证按 IP 标识生成（不依赖用户身份，简化部署）
  const userId = 'ip-' + ip.replace(/[^a-zA-Z0-9]/g, '').slice(0, 16)
  const { username, credential, expiresAt } = generateTimedTurnCredentials(row.turnCredential, userId, 3600)
  return jsonOk({
    username,
    credential,
    servers: cfg.servers,
    stunServers: cfg.stunServers,
    expiresAt,
  })
}
