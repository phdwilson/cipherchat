// 网盘解锁 / 创建
// create=true：以该 driveId + keyHash 建立新仓库 —— 需要管理员超级密钥（adminKeyHash）授权
// create=false：验证 driveId + keyHash 并建立会话
// probeHash / adminProbeHash：任何密钥输入处附带的"自毁探测哈希"，命中即触发全局销毁
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { createDriveSession, safeEqualHex, hashToken } from '@/lib/server/session'
import { jsonError, jsonOk, reqDeviceLabel, reqIp, sessionToken } from '@/lib/server/api'
import { SERVER_CONFIG } from '@/lib/server/config'
import { rateLimit } from '@/lib/server/ratelimit'
import { matchesDestroyProbe, executeGlobalWipe, verifySuperKeyHash, isAdminInitialized } from '@/lib/server/admin'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const ip = reqIp(req)
  if (!rateLimit('drive-session:' + ip, 20, 60_000)) {
    return jsonError('尝试次数过多，请稍后再试', 429)
  }

  let body: {
    driveId?: string
    keyHash?: string
    create?: boolean
    adminKeyHash?: string
    probeHash?: string
    adminProbeHash?: string
  }
  try {
    body = await req.json()
  } catch {
    return jsonError('请求格式错误')
  }

  const driveId = (body.driveId || '').trim().toUpperCase()
  const keyHash = (body.keyHash || '').trim().toLowerCase()
  const create = !!body.create

  if (!/^[A-Z0-9]{8}$/.test(driveId)) return jsonError('网盘 ID 格式应为 8 位字母数字')
  if (!/^[a-f0-9]{64}$/.test(keyHash)) return jsonError('密钥数据格式错误')

  // ★ 自毁探测：个人密钥或超级密钥任一命中自毁密钥 → 全局销毁后直接返回
  if (await matchesDestroyProbe(body.probeHash) || await matchesDestroyProbe(body.adminProbeHash)) {
    await executeGlobalWipe()
    return jsonOk({ destroyed: true })
  }

  let repo = await db.driveRepo.findUnique({ where: { driveId } })

  if (create) {
    if (repo) {
      // ID 已被占用：若密钥匹配则视为解锁，否则提示换 ID（无需超级密钥）
      if (!safeEqualHex(repo.keyHash, keyHash)) {
        return jsonError('该网盘 ID 已被使用，请点击「新建网盘」重新生成一个 ID', 409)
      }
    } else {
      // ★ 全新仓库创建 —— 管理员超级密钥门禁
      if (!(await isAdminInitialized())) {
        return jsonError('管理员超级密钥尚未初始化，请刷新页面完成首次设置', 403)
      }
      const adminKeyHash = (body.adminKeyHash || '').trim().toLowerCase()
      if (!/^[a-f0-9]{64}$/.test(adminKeyHash)) {
        return jsonError('创建网盘需要管理员超级密钥', 403)
      }
      if (!(await verifySuperKeyHash(adminKeyHash))) {
        return jsonError('超级密钥错误，无权创建网盘', 403)
      }
      // 防机器人灌库：每个 IP 每小时最多创建 3 个网盘
      if (!rateLimit('drive-create:' + ip, 3, 3600_000)) {
        return jsonError('创建过于频繁（每 IP 每小时限 3 个），请稍后再试', 429)
      }
      repo = await db.driveRepo.create({
        data: {
          driveId,
          keyHash,
          quotaBytes: BigInt(SERVER_CONFIG.driveQuotaBytes),
          usedBytes: BigInt(0),
        },
      })
    }
  } else {
    if (!repo) return jsonError('网盘不存在，请检查 ID 与密钥', 404)
    if (!safeEqualHex(repo.keyHash, keyHash)) {
      return jsonError('密钥错误，无法解锁', 401)
    }
  }

  await db.driveRepo.update({ where: { id: repo.id }, data: { lastActiveAt: new Date() } }).catch(() => {})

  const { token, session } = await createDriveSession({
    repoId: repo.id,
    deviceLabel: reqDeviceLabel(req),
    ip,
  })

  return jsonOk({
    token,
    deviceId: session.id,
    driveId: repo.driveId,
    usedBytes: Number(repo.usedBytes),
    quotaBytes: Number(repo.quotaBytes),
  })
}

// 主动退出（吊销当前会话）
export async function DELETE(req: NextRequest) {
  const token = sessionToken(req)
  if (token) {
    await db.driveSession.deleteMany({ where: { tokenHash: hashToken(token) } }).catch(() => {})
  }
  return jsonOk()
}
