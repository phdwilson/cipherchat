// 密钥轮换：客户端驱动的全量内容迁移
// 流程：
//  1. POST start —— 持旧会话 token + 新 authHash 创建轮换任务（服务端校验新频道未占用）
//  2. POST migrate —— 客户端分批提交「用新密钥重加密后的消息密文」，
//     服务端在事务内把每条消息改写 payload 并迁移 channelKeyId / readAt 保留
//  3. POST files —— 客户端逐块下载旧密文→解密→用新密钥重加密→上传到新 fileId，
//     提交映射后服务端把消息的 fileId 换绑并删除旧文件
//  4. POST finish —— 吊销旧频道全部会话，标记完成；所有成员用新密码重新进入即可无缝续聊
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { jsonError, jsonOk } from '@/lib/server/api'
import { rateLimit } from '@/lib/server/ratelimit'
import { verifyChatSession } from '@/lib/server/session'
import { canClearChannel } from '@/lib/server/roles'
import { startRotation, getRotation, finishRotation, cancelRotation, markRotationFailed, keyIdOf } from '@/lib/server/invites'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const token = req.headers.get('x-session-token')
  const session = token ? await verifyChatSession(token) : null
  if (!session) return jsonError('会话无效或已过期', 401)
  if (!rateLimit('rotate:' + session.pubId, 5, 60_000)) {
    return jsonError('操作过于频繁，请稍后再试', 429)
  }

  let body: {
    action?: string
    channelId?: string
    newAuthHash?: string
    rotationId?: string
    messages?: Array<{ id: string; payload: string }>
    fileMap?: Array<{ oldFileId: string; newFileId: string }>
  }
  try {
    body = await req.json()
  } catch {
    return jsonError('请求格式错误')
  }

  // ---------- 开始轮换 ----------
  if (body.action === 'start') {
    // v1.7.0 权限门：轮换会吊销全频道会话并强制所有人重进，此前任何角色（含旁听）
    // 都能发起 —— 现在仅频道创建者（owner）可发起
    if (!(await canClearChannel(session.channelKeyId, session.pubId))) {
      return jsonError('仅频道创建者可以发起密钥轮换', 403)
    }
    const channelId = (body.channelId || '').trim()
    const newAuthHash = (body.newAuthHash || '').trim().toLowerCase()
    if (!channelId || channelId.length > 64) return jsonError('频道 ID 不合法')
    if (!/^[a-f0-9]{64}$/.test(newAuthHash)) return jsonError('新密码认证数据格式错误')
    const r = await startRotation({
      oldKeyId: session.channelKeyId,
      newKeyId: keyIdOf(channelId, newAuthHash),
      createdBy: session.pubId,
    })
    if ('error' in r) return jsonError(r.error, 409)
    return jsonOk({ rotationId: r.id })
  }

  // ---------- 批量迁移消息（重加密后的密文） ----------
  if (body.action === 'migrate') {
    const rot = body.rotationId ? await db.chatRotation.findUnique({ where: { id: body.rotationId } }) : null
    // pending（刚创建）或 messages（迁移中）均可提交；进入首批后状态转为 messages
    if (!rot || !['pending', 'messages'].includes(rot.phase) || rot.oldKeyId !== session.channelKeyId) {
      return jsonError('轮换任务不存在或状态不符', 409)
    }
    if (rot.phase === 'pending') {
      await db.chatRotation.update({ where: { id: rot.id }, data: { phase: 'messages' } })
      rot.phase = 'messages'
    }
    if (rot.expiresAt.getTime() < Date.now()) return jsonError('轮换任务已过期', 410)
    const msgs = Array.isArray(body.messages) ? body.messages.slice(0, 200) : []
    try {
      // v1.6.0：原先每条消息单独一个 $transaction（200 条 = 200 次 SQLite 往返），
      // 这里先做参数校验，再合并成单个事务一次性提交
      const valid = msgs.filter(
        (m): m is { id: string; payload: string } =>
          !!m &&
          /^[0-9a-fA-F-]{36}$/.test(m.id) &&
          typeof m.payload === 'string' &&
          !!m.payload &&
          m.payload.length <= 128 * 1024,
      )
      if (valid.length > 0) {
        try {
          await db.$transaction(
            valid.map((m) =>
              db.chatMessage.update({
                where: { id: m.id },
                data: { payload: m.payload, channelKeyId: rot.newKeyId },
              }),
            ),
          )
        } catch (e) {
          // 单事务失败（如并发迁移竞态）→ 退化为逐条提交，能迁多少迁多少
          console.warn('[rotate] 批量事务失败，退化为逐条迁移:', e instanceof Error ? e.message : e)
          for (const m of valid) {
            await db.chatMessage
              .update({ where: { id: m.id }, data: { payload: m.payload, channelKeyId: rot.newKeyId } })
              .catch((e2) => console.warn('[rotate] 单条消息迁移失败:', e2 instanceof Error ? e2.message : e2))
          }
        }
      }
      const done = valid.length
      await db.chatRotation.update({
        where: { id: rot.id },
        data: { msgDone: { increment: done } },
      })
      const remaining = await db.chatMessage.count({ where: { channelKeyId: rot.oldKeyId } })
      return jsonOk({ migrated: done, remaining })
    } catch (e) {
      // 关键路径异常 → 标记轮换失败，客户端可取消回滚或重试
      await markRotationFailed(rot.id)
      console.warn('[rotate] migrate 阶段异常，已标记 failed:', e instanceof Error ? e.message : e)
      return jsonError('迁移过程出现异常，轮换已暂停（可重试或取消回滚）', 500)
    }
  }

  // ---------- 文件换绑 ----------
  if (body.action === 'files') {
    const rot = body.rotationId ? await db.chatRotation.findUnique({ where: { id: body.rotationId } }) : null
    if (!rot || (rot.phase !== 'files' && rot.phase !== 'messages') || rot.oldKeyId !== session.channelKeyId) {
      return jsonError('轮换任务不存在或状态不符', 409)
    }
    if (rot.expiresAt.getTime() < Date.now()) return jsonError('轮换任务已过期', 410)
    const map = Array.isArray(body.fileMap) ? body.fileMap.slice(0, 100) : []
    let swapped = 0
    try {
      for (const f of map) {
        if (!f || !/^[0-9a-fA-F-]{36}$/.test(f.oldFileId) || !/^[0-9a-fA-F-]{36}$/.test(f.newFileId)) continue
        try {
          // 校验新旧文件归属正确后再整体换绑：消息指向新文件，旧文件记录与磁盘块一并清理
          const nf = await db.chatFile.findUnique({ where: { id: f.newFileId } })
          const of_ = await db.chatFile.findUnique({ where: { id: f.oldFileId } })
          if (!nf || nf.channelKeyId !== rot.newKeyId || !of_ || of_.channelKeyId !== rot.oldKeyId) continue
          // v1.7.0：去掉重复的 updateMany（第二条是第一条的超集，保留更广的一条即可）
          await db.chatMessage.updateMany({ where: { fileId: f.oldFileId }, data: { fileId: f.newFileId } })
          await db.chatFile.delete({ where: { id: f.oldFileId } }).catch((e) => console.warn('[rotate] 删除旧文件记录失败:', e instanceof Error ? e.message : e))
          swapped++
        } catch (e) {
          console.warn('[rotate] 单个文件换绑失败:', e instanceof Error ? e.message : e)
        }
      }
    } catch (e) {
      await markRotationFailed(rot.id)
      console.warn('[rotate] files 阶段异常，已标记 failed:', e instanceof Error ? e.message : e)
      return jsonError('文件迁移出现异常，轮换已暂停（可重试或取消回滚）', 500)
    }
    await db.chatRotation.update({ where: { id: rot.id }, data: { phase: 'files', fileDone: { increment: swapped } } })
    const remaining = await db.chatMessage.count({ where: { channelKeyId: rot.oldKeyId } })
    return jsonOk({ swapped, remaining })
  }

  // ---------- 取消/回滚轮换 ----------
  if (body.action === 'cancel') {
    // BUG 修复（v1.4.3）：rotationId 缺失时按当前会话的频道回退查找进行中的任务，
    // 避免客户端未传 id 时永远 409
    let rot = body.rotationId ? await db.chatRotation.findUnique({ where: { id: body.rotationId } }) : null
    if (!rot) {
      rot = await db.chatRotation.findFirst({
        where: { oldKeyId: session.channelKeyId, phase: { in: ['failed', 'pending'] } },
        orderBy: { createdAt: 'desc' },
      })
    }
    if (!rot || rot.oldKeyId !== session.channelKeyId) return jsonError('轮换任务不存在或状态不符', 409)
    const r = await cancelRotation(rot.id)
    if (!r.success) {
      return jsonError(r.reason === 'not_cancellable' ? '当前状态不可取消（仅 failed/pending 可回滚）' : '轮换任务不存在', 409)
    }
    console.warn(`[rotate] 任务 ${rot.id} 已取消回滚，清理半成品文件 ${r.cleanedFiles} 个`)
    return jsonOk({ cancelled: true, cleanedFiles: r.cleanedFiles })
  }

  // ---------- 完成轮换 ----------
  if (body.action === 'finish') {
    // v1.7.0：完成会吊销旧频道全部会话，同样仅 owner 可执行
    if (!(await canClearChannel(session.channelKeyId, session.pubId))) {
      return jsonError('仅频道创建者可以完成密钥轮换', 403)
    }
    const rot = body.rotationId ? await db.chatRotation.findUnique({ where: { id: body.rotationId } }) : null
    if (!rot || rot.oldKeyId !== session.channelKeyId) return jsonError('轮换任务不存在或状态不符', 409)
    const result = await finishRotation(rot.id)
    if (!result.success) {
      const msg = result.reason === 'already_done' ? '该轮换任务已完成，请勿重复提交' : '轮换任务不可完成（可能已取消或失败）'
      return jsonError(msg, 409)
    }
    const remainingMsgs = await db.chatMessage.count({ where: { channelKeyId: rot.oldKeyId } })
    // v1.5.0：轮换完成 → 通知在线成员。web 与 relay 是两个进程，无法直接 emit；
    // 采用与 wipeEpoch 相同的轮询桥接：写一条 ChatRotation 记录的 notifyAt，
    // relay 轮询到未通知的 done 任务即向旧频道房间广播 chat:rotated
    await db.chatRotation.update({ where: { id: rot.id }, data: { notifyPending: true } }).catch((e) => {
      console.warn('[rotate] 标记通知失败:', e instanceof Error ? e.message : e)
    })
    return jsonOk({ ok: true, newKeyId: result.newKeyId, leftoverMessages: remainingMsgs })
  }

  // ---------- 查询进度 ----------
  if (body.action === 'status') {
    const st = body.rotationId ? await getRotation(body.rotationId) : null
    if (!st) return jsonError('轮换任务不存在', 404)
    return jsonOk(st)
  }

  return jsonError('未知操作')
}
