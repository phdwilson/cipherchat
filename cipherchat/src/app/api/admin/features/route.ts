// 管理员功能开关（语音/私聊/好友/头像/P2P 独立开关）+ TURN 中继配置
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { verifySuperKeyHash, isAdminInitialized } from '@/lib/server/admin'
import { jsonError, jsonOk, reqIp } from '@/lib/server/api'
import { rateLimit } from '@/lib/server/ratelimit'
import { getFeatureFlags, getTurnConfig } from '@/lib/server/config'

export const dynamic = 'force-dynamic'

// ============== GET：返回功能开关 + TURN 配置（含凭证，仅管理员可读） ==============
// 注意：本路由返回的 TURN 凭证对管理员可见（理所应当）；普通客户端通过 /api/config 拉取
export async function GET() {
  const flags = await getFeatureFlags()
  const turn = await getTurnConfig()
  // 管理员面板可看到当前是否已配置 TURN（但密钥从不出现在 GET 响应里）
  let adminTurnMeta: {
    enabled: boolean
    hasUrl: boolean
    hasUsername: boolean
    hasCredential: boolean
    secretMode: string
    serverCount: number
  } = {
    enabled: turn.enabled,
    hasUrl: turn.servers.length > 0,
    hasUsername: !!turn.username,
    hasCredential: !!turn.credential,
    secretMode: turn.secretMode,
    serverCount: turn.servers.length,
  }
  return jsonOk({ ...flags, turn: adminTurnMeta })
}

// ============== POST：更新功能开关 / TURN 配置 ==============
// 注意：本接口对 TURN 字段单独处理，需要 super key 鉴权
export async function POST(req: NextRequest) {
  const ip = reqIp(req)
  if (!rateLimit('admin-features:' + ip, 30, 3600_000)) {
    return jsonError('请求过于频繁', 429)
  }

  let body: {
    adminKeyHash?: string
    // 功能开关
    voiceEnabled?: boolean
    whisperEnabled?: boolean
    friendEnabled?: boolean
    avatarUploadEnabled?: boolean
    p2pEnabled?: boolean
    // TURN 配置（v1.3.1 新增）
    turnEnabled?: boolean
    turnUrls?: string
    turnUsername?: string
    turnCredential?: string
    turnSecretMode?: 'static' | 'time-limited'
  }
  try {
    body = await req.json()
  } catch {
    return jsonError('请求格式错误')
  }

  const h = (body.adminKeyHash || '').trim().toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(h)) return jsonError('数据格式错误')
  if (!(await isAdminInitialized())) return jsonError('管理员密钥尚未初始化', 403)
  if (!(await verifySuperKeyHash(h))) return jsonError('超级密钥错误', 403)

  // —— 处理功能开关 ——
  const updates: Record<string, boolean | string> = {}
  for (const [k, v] of Object.entries(body)) {
    if (k === 'adminKeyHash') continue
    if (typeof v === 'boolean' && ['voiceEnabled', 'whisperEnabled', 'friendEnabled', 'avatarUploadEnabled', 'p2pEnabled', 'turnEnabled', 'allowHiddenGeo', 'dmsEnabled'].includes(k)) {
      updates[k] = v
    }
  }

  // —— 处理 TURN 字符串字段 ——
  // turnUrls 允许空字符串（清空配置）；其他字段非空才更新
  if (typeof body.turnUrls === 'string') {
    // 规范化：去重 + 去空 + 只保留 turn:/turns: 开头
    const cleaned = body.turnUrls
      .split(/[\s,]+/m)
      .map((s) => s.trim())
      .filter((s) => s.startsWith('turn:') || s.startsWith('turns:'))
    updates.turnUrls = cleaned.join('\n')
  }
  if (typeof body.turnUsername === 'string' && body.turnUsername.length <= 128) {
    updates.turnUsername = body.turnUsername.trim()
  }
  if (typeof body.turnCredential === 'string' && body.turnCredential.length <= 256) {
    updates.turnCredential = body.turnCredential
  }
  if (typeof body.turnSecretMode === 'string' && ['static', 'time-limited'].includes(body.turnSecretMode)) {
    updates.turnSecretMode = body.turnSecretMode
  }

  if (Object.keys(updates).length > 0) {
    await db.adminConfig.updateMany({ data: updates })
  }

  return jsonOk({ ...await getFeatureFlags(), turn: (await getTurnConfig()).enabled })
}
