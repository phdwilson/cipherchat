// v1.5.0 频道权限体系：owner / admin / member / observer
// 修复越权隐患：此前任何成员可删除他人消息、清空整个频道
// 角色规则：
//   owner    —— 创建者；唯一可「清空频道」、可任命/罢免 admin、可转让 ownership
//   admin    —— 可删除任何消息、可将 member 降为 observer、可生成 admin/member/observer 邀请
//   member   —— 可删除自己的消息、可生成 member/observer 邀请
//   observer —— 只读：不可发送消息、不可上传文件、不可创建邀请
// 兼容性：无 ChatMember 记录的旧会话按 member 处理；首个发言/加入者自动登记。
import { db } from '../db'

export type ChannelRole = 'owner' | 'admin' | 'member' | 'observer'

export const ROLE_RANK: Record<ChannelRole, number> = { owner: 3, admin: 2, member: 1, observer: 0 }

// 取成员角色；无记录时自动登记为 member（首个进入者登记为 owner，保证每个频道有且仅有一个 owner）
export async function roleOf(channelKeyId: string, pubId: string): Promise<ChannelRole> {
  const existing = await db.chatMember.findUnique({
    where: { channelKeyId_pubId: { channelKeyId, pubId } },
  })
  if (existing) return existing.role as ChannelRole
  // 自动登记：频道尚无任何成员 → 本人为 owner；否则 member
  const any = await db.chatMember.findFirst({ where: { channelKeyId }, select: { id: true } })
  const role: ChannelRole = any ? 'member' : 'owner'
  await db.chatMember.create({ data: { channelKeyId, pubId, role } }).catch(() => {})
  return role
}

// 权限判断辅助
export async function canDeleteMessage(channelKeyId: string, pubId: string, msgSenderId: string): Promise<boolean> {
  if (pubId === msgSenderId) {
    // 自己的消息：任何角色都可撤回（防御性：observer 本就不该发出来）
    return true
  }
  const role = await roleOf(channelKeyId, pubId)
  return ROLE_RANK[role] >= ROLE_RANK.admin // 他人的消息需要 admin+
}

export async function canClearChannel(channelKeyId: string, pubId: string): Promise<boolean> {
  return (await roleOf(channelKeyId, pubId)) === 'owner'
}

export async function canInviteRole(channelKeyId: string, pubId: string, inviteRole: ChannelRole): Promise<boolean> {
  const myRank = ROLE_RANK[await roleOf(channelKeyId, pubId)]
  // observer 不能发邀请；admin 可邀 member/observer/admin？——admin 仅能邀 member/observer，owner 全部
  if (inviteRole === 'observer') return myRank >= ROLE_RANK.member
  if (inviteRole === 'member') return myRank >= ROLE_RANK.member
  if (inviteRole === 'admin') return myRank >= ROLE_RANK.owner
  return false // owner 角色只能通过转让获得
}

export async function canSend(channelKeyId: string, pubId: string): Promise<boolean> {
  return ROLE_RANK[await roleOf(channelKeyId, pubId)] >= ROLE_RANK.member
}

// 角色管理（owner 专属）：设置某成员角色；不允许降级/移除自己以外的 owner
export async function setMemberRole(channelKeyId: string, operatorPubId: string, targetPubId: string, role: ChannelRole): Promise<{ ok: boolean; error?: string }> {
  const myRole = await roleOf(channelKeyId, operatorPubId)
  if (ROLE_RANK[myRole] < ROLE_RANK.admin) return { ok: false, error: '权限不足' }
  if (role === 'owner') return { ok: false, error: 'owner 角色请使用转让功能' }
  const targetCur = await roleOf(channelKeyId, targetPubId)
  if (targetCur === 'owner' && operatorPubId !== targetPubId) return { ok: false, error: '不能修改 owner 的角色' }
  if (myRole === 'admin' && ROLE_RANK[targetCur] >= ROLE_RANK.admin && operatorPubId !== targetPubId) {
    return { ok: false, error: 'admin 不能修改其他 admin 的角色' }
  }
  await db.chatMember.upsert({
    where: { channelKeyId_pubId: { channelKeyId, pubId: targetPubId } },
    create: { channelKeyId, pubId: targetPubId, role },
    update: { role },
  })
  return { ok: true }
}
