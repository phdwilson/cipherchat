// 管理员超级密钥 / 自毁密钥服务端逻辑（零知识：仅存 PBKDF2 哈希）
// 约定：
//   superKeyHash   = PBKDF2(超级密钥, "cipherchat:admin", 120k)  —— 网盘创建授权
//   destroyKeyHash = PBKDF2(自毁密钥, "cipherchat:probe", 120k)  —— 与任何密码输入处的探测哈希同源
// 客户端在所有密码输入处附带 probeHash = PBKDF2(输入, "cipherchat:probe", 120k)，
// 服务端命中 destroyKeyHash 即执行全局自毁（删除全部聊天/网盘记录与密文文件）。
import { db } from '../db'
import { safeEqualHex } from './session'
import { deleteFileDir } from './filestore'

export async function getAdminConfig() {
  return db.adminConfig.findFirst()
}

export async function isAdminInitialized(): Promise<boolean> {
  return (await getAdminConfig()) !== null
}

export async function verifySuperKeyHash(hash: string): Promise<boolean> {
  if (!/^[a-f0-9]{64}$/.test(hash)) return false
  const cfg = await getAdminConfig()
  return !!cfg && safeEqualHex(cfg.superKeyHash, hash)
}

// 探测哈希是否命中自毁密钥（恒定时间比较）
export async function matchesDestroyProbe(probeHash?: string | null): Promise<boolean> {
  if (!probeHash || !/^[a-f0-9]{64}$/.test(probeHash)) return false
  const cfg = await getAdminConfig()
  return !!cfg && safeEqualHex(cfg.destroyKeyHash, probeHash.trim().toLowerCase())
}

// 全局自毁：清空所有聊天/网盘数据（库表 + 磁盘密文），会话全吊销，纪元 +1 通知中继广播
// 管理员配置（超级密钥/自毁密钥）保留 —— 防止自毁后站点被陌生人重新初始化抢占
export async function executeGlobalWipe(): Promise<{ wipedMessages: number; wipedDrives: number }> {
  const chatFiles = await db.chatFile.findMany({ select: { id: true } })
  const driveFiles = await db.driveFile.findMany({ select: { id: true } })
  const msgCount = await db.chatMessage.count()
  const repoCount = await db.driveRepo.count()

  // 1) 磁盘密文分块
  for (const f of chatFiles) deleteFileDir('chat', f.id)
  for (const f of driveFiles) deleteFileDir('drive', f.id)

  // 2) 数据库（消息/文件/仓库/全部会话）
  // v1.6.0：补齐此前漏清的关系/元数据表 —— 成员关系、已读回执、离线信箱、DMS 布防、
  // 轮换任务、设备公钥与免密邀请（否则自毁后仍残留「谁在哪个频道」等元数据，
  // 免密邀请甚至能凭旧密码直接重建频道）
  await db.chatReaction.deleteMany({})
  await db.chatMessage.deleteMany({})
  await db.chatFile.deleteMany({})
  await db.driveFile.deleteMany({})
  await db.driveRepo.deleteMany({})
  await db.chatSession.deleteMany({})
  await db.driveSession.deleteMany({})
  await db.chatMember.deleteMany({})
  await db.chatReadReceipt.deleteMany({})
  await db.mailboxItem.deleteMany({})
  await db.deadMansSwitch.deleteMany({})
  await db.chatRotation.deleteMany({})
  await db.deviceIdentity.deleteMany({})
  await db.inviteToken.deleteMany({})

  // 3) 自毁纪元 +1（中继服务轮询到变化后向所有在线客户端广播 global:wipe）
  await db.adminConfig.updateMany({ data: { wipeEpoch: { increment: 1 } } })

  return { wipedMessages: msgCount, wipedDrives: repoCount }
}
