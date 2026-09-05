// 凭邀请短码换取加入信息
// 免密钥模式返回 channelId + password（由服务端主密钥解密）；
// 常规模式只返回 channelId，受邀者仍需输入密码
import { NextRequest } from 'next/server'
import { jsonError, jsonOk, reqIp } from '@/lib/server/api'
import { rateLimit } from '@/lib/server/ratelimit'
import { redeemInvite } from '@/lib/server/invites'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  if (!rateLimit('redeem:' + reqIp(req), 20, 60_000)) {
    return jsonError('请求过于频繁，请稍后再试', 429)
  }
  let body: { code?: string }
  try {
    body = await req.json()
  } catch {
    return jsonError('请求格式错误')
  }
  const r = await redeemInvite((body.code || '').trim())
  if ('error' in r) return jsonError(r.error, r.status || 400)
  return jsonOk({
    channelId: r.payload.channelId,
    password: r.payload.password || null, // null = 需要受邀者自行输入密码
    role: r.role, // v1.5.0 受邀角色
  })
}
