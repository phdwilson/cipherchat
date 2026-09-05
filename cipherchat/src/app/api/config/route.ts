// 公开运行时配置（不含任何敏感信息）
// v1.7.0 安全修复：TURN 静态长期凭证不再随公开配置下发 —— 此前任何人不登录
// 都能拿到可长期使用的 TURN 中继凭证（开放中继滥用 / 流量费被盗用）。
// 现在凭证仅由 /api/voice/turn-credentials 签发（带独立限流 + 会话优先），
// 本接口只下发「是否启用 / 服务器地址 / 凭证模式」。
import { NextRequest } from 'next/server'
import { getWebPublicConfig, getFeatureFlags, getTurnConfig, getGeoPrivacyFlag } from '@/lib/server/config'
import { rateLimit } from '@/lib/server/ratelimit'
import { reqIp } from '@/lib/server/api'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  if (!rateLimit('config:' + reqIp(req), 60, 60_000)) {
    return Response.json({ error: '请求过于频繁，请稍后再试' }, { status: 429 })
  }
  const [flags, turn, geo] = await Promise.all([getFeatureFlags(), getTurnConfig(), getGeoPrivacyFlag()])
  // 剥离凭证：turn.username / turn.credential 绝不进入公开配置
  const { username: _u, credential: _c, ...turnPublic } = turn
  return Response.json({ ...getWebPublicConfig(), ...flags, ...geo, turn: turnPublic })
}
