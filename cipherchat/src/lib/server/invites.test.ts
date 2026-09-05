// 密钥轮换 / 邀请令牌 服务端逻辑单元测试
// 通过 mock PrismaClient 验证：startRotation 幂等检查、finishRotation 返回值、
// createInviteToken → redeemInvite 完整流程（含过期/次数上限/损坏数据）
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---- mock db（拦截 ../db 的 PrismaClient）----
const store = {
  serverSecret: [] as Array<{ id: string; inviteKey: string }>,
  inviteToken: [] as Array<Record<string, unknown>>,
  chatRotation: [] as Array<Record<string, any>>,
  chatSession: [] as Array<Record<string, unknown>>,
  chatMessage: [] as Array<Record<string, unknown>>,
  chatFile: [] as Array<Record<string, unknown>>,
}

vi.mock('../db', () => ({
  db: {
    $transaction: (ops: Promise<unknown>[]) => Promise.all(ops),
    serverSecret: {
      findFirst: async () => store.serverSecret[0] ?? null,
      // v1.7.0：getInviteKey 改用 findMany 收敛多行竞态产物，mock 同步补齐
      findMany: async () => store.serverSecret,
      deleteMany: async () => {
        // 保留第一行（与实现一致：只留最早一行），返回删除数
        const before = store.serverSecret.length
        if (store.serverSecret.length > 1) store.serverSecret.length = 1
        return { count: before - store.serverSecret.length }
      },
      create: async ({ data }: { data: { inviteKey: string } }) => {
        const row = { id: 'ss-1', ...data }
        store.serverSecret.push(row)
        return row
      },
    },
    inviteToken: {
      findUnique: async ({ where }: { where: { code: string } }) =>
        store.inviteToken.find((r) => r.code === where.code) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: 'it-' + store.inviteToken.length, uses: 0, ...data }
        store.inviteToken.push(row)
        return row
      },
      // v1.7.0：maxUses 原子扣减走条件 updateMany
      updateMany: async ({ where, data }: { where: { id: string; uses?: { lt: number } }; data: Record<string, unknown> }) => {
        const row = store.inviteToken.find((r) => r.id === where.id)
        if (!row) return { count: 0 }
        if (where.uses && typeof where.uses === 'object' && 'lt' in where.uses) {
          if (Number(row.uses ?? 0) >= (where.uses as { lt: number }).lt) return { count: 0 }
        }
        for (const [k, v] of Object.entries(data)) {
          if (v && typeof v === 'object' && 'increment' in (v as object)) {
            row[k] = ((row[k] as number) ?? 0) + (v as { increment: number }).increment
          } else {
            row[k] = v
          }
        }
        return { count: 1 }
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = store.inviteToken.find((r) => r.id === where.id)!
        // 支持 Prisma { increment: n } 字段更新语法
        for (const [k, v] of Object.entries(data)) {
          if (v && typeof v === 'object' && 'increment' in (v as object)) {
            ;(row as any)[k] = ((row as any)[k] ?? 0) + (v as { increment: number }).increment
          } else {
            ;(row as any)[k] = v
          }
        }
        return row
      },
      delete: async ({ where }: { where: { id: string } }) => {
        const idx = store.inviteToken.findIndex((r) => r.id === where.id)
        if (idx >= 0) store.inviteToken.splice(idx, 1)
        return { ok: true }
      },
      deleteMany: async ({ where }: { where: { expiresAt: { lt: Date } } }) => {
        const before = store.inviteToken.length
        store.inviteToken = store.inviteToken.filter(
          (r) => !((r.expiresAt as Date).getTime() < where.expiresAt.lt.getTime()),
        )
        return { count: before - store.inviteToken.length }
      },
    },
    chatSession: {
      findFirst: async ({ where }: { where: { channelKeyId: string } }) =>
        store.chatSession.find((r) => r.channelKeyId === where.channelKeyId) ?? null,
      deleteMany: async ({ where }: { where: { channelKeyId: string } }) => {
        const before = store.chatSession.length
        store.chatSession = store.chatSession.filter((r) => r.channelKeyId !== where.channelKeyId)
        return { count: before - store.chatSession.length }
      },
    },
    chatMessage: {
      findFirst: async ({ where }: { where: { channelKeyId: string } }) =>
        store.chatMessage.find((r) => r.channelKeyId === where.channelKeyId) ?? null,
      count: async ({ where }: { where: { channelKeyId: string } }) =>
        store.chatMessage.filter((r) => r.channelKeyId === where.channelKeyId).length,
    },
    chatFile: {
      findFirst: async () => null,
      count: async () => 0,
      findMany: async () => [],
      deleteMany: async () => ({ count: 0 }),
    },
    chatRotation: {
      findFirst: async ({ where }: { where: { oldKeyId: string; phase: object } }) =>
        store.chatRotation.find((r) => r.oldKeyId === where.oldKeyId && !['done', 'cancelled'].includes(r.phase)) ?? null,
      findUnique: async ({ where }: { where: { id: string } }) =>
        store.chatRotation.find((r) => r.id === where.id) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { msgDone: 0, fileDone: 0, fileTotal: 0, ...data }
        store.chatRotation.push(row)
        return row
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = store.chatRotation.find((r) => r.id === where.id)
        if (!row) throw new Error('not found')
        Object.assign(row, data)
        return row
      },
      updateMany: async ({ where, data }: { where: { id: string; phase: object }; data: Record<string, unknown> }) => {
        for (const r of store.chatRotation) {
          if (r.id === where.id && (where.phase as { in: string[] }).in.includes(r.phase)) Object.assign(r, data)
        }
        return { count: 1 }
      },
    },
  },
}))

vi.mock('./filestore', () => ({ deleteFileDir: vi.fn() }))

import { startRotation, finishRotation, cancelRotation, markRotationFailed, createInviteToken, redeemInvite, keyIdOf } from './invites'

beforeEach(() => {
  store.serverSecret.length = 0
  store.inviteToken.length = 0
  store.chatRotation.length = 0
  store.chatSession.length = 0
  store.chatMessage.length = 0
})

describe('startRotation 幂等检查', () => {
  it('首次创建成功，phase 初始为 pending', async () => {
    store.chatMessage.push({ channelKeyId: 'old', id: 'm1' })
    const r = await startRotation({ oldKeyId: 'old', newKeyId: 'new', createdBy: 'u1' })
    expect(r).toHaveProperty('id')
    expect(store.chatRotation[0].phase).toBe('pending')
  })

  it('同频道已有未完成任务时拒绝重复创建', async () => {
    store.chatMessage.push({ channelKeyId: 'old', id: 'm1' })
    await startRotation({ oldKeyId: 'old', newKeyId: 'new-a', createdBy: 'u1' })
    const again = await startRotation({ oldKeyId: 'old', newKeyId: 'new-b', createdBy: 'u2' })
    expect(again).toEqual({ error: '该频道已有进行中的轮换任务' })
    expect(store.chatRotation.length).toBe(1)
  })

  it('已取消的任务不阻塞新轮换', async () => {
    store.chatMessage.push({ channelKeyId: 'old', id: 'm1' })
    const first = await startRotation({ oldKeyId: 'old', newKeyId: 'n1', createdBy: 'u1' })
    await cancelRotation((first as { id: string }).id)
    const second = await startRotation({ oldKeyId: 'old', newKeyId: 'n2', createdBy: 'u1' })
    expect(second).toHaveProperty('id')
  })

  it('新密码对应频道已有会话时拒绝（409 冲突）', async () => {
    store.chatMessage.push({ channelKeyId: 'old', id: 'm1' })
    store.chatSession.push({ channelKeyId: 'taken' })
    const r = await startRotation({ oldKeyId: 'old', newKeyId: 'taken', createdBy: 'u1' })
    expect(r).toHaveProperty('error')
  })
})

describe('finishRotation 返回值', () => {
  it('成功返回 { success: true, newKeyId } 并吊销旧会话', async () => {
    store.chatMessage.push({ channelKeyId: 'old', id: 'm1' })
    store.chatSession.push({ channelKeyId: 'old' }, { channelKeyId: 'other' })
    const started = await startRotation({ oldKeyId: 'old', newKeyId: 'new', createdBy: 'u1' })
    // 模拟进入 messages 阶段后完成
    Object.assign(store.chatRotation[0], { phase: 'messages' })
    const r = await finishRotation((started as { id: string }).id)
    expect(r).toEqual({ success: true, newKeyId: 'new' })
    expect(store.chatSession.some((s) => s.channelKeyId === 'old')).toBe(false)
    expect(store.chatSession.some((s) => s.channelKeyId === 'other')).toBe(true)
  })

  it('not_found：任务不存在', async () => {
    expect(await finishRotation('nope')).toEqual({ success: false, reason: 'not_found' })
  })

  it('already_done：重复 finish 拒绝', async () => {
    store.chatMessage.push({ channelKeyId: 'old', id: 'm1' })
    const started = await startRotation({ oldKeyId: 'old', newKeyId: 'new', createdBy: 'u1' })
    Object.assign(store.chatRotation[0], { phase: 'messages' })
    const id = (started as { id: string }).id
    await finishRotation(id)
    expect(await finishRotation(id)).toEqual({ success: false, reason: 'already_done' })
  })

  it('failed 状态不可直接 finish', async () => {
    store.chatMessage.push({ channelKeyId: 'old', id: 'm1' })
    const started = await startRotation({ oldKeyId: 'old', newKeyId: 'new', createdBy: 'u1' })
    const id = (started as { id: string }).id
    await markRotationFailed(id)
    expect(await finishRotation(id)).toEqual({ success: false, reason: 'not_found' })
  })
})

describe('markRotationFailed / cancelRotation 回滚', () => {
  it('markRotationFailed 将进行中状态置为 failed', async () => {
    store.chatMessage.push({ channelKeyId: 'old', id: 'm1' })
    const started = await startRotation({ oldKeyId: 'old', newKeyId: 'new', createdBy: 'u1' })
    const id = (started as { id: string }).id
    Object.assign(store.chatRotation[0], { phase: 'files' })
    await markRotationFailed(id)
    expect(store.chatRotation[0].phase).toBe('failed')
  })

  it('cancelRotation 清理半成品并置为 cancelled；done 状态不可取消', async () => {
    store.chatMessage.push({ channelKeyId: 'old', id: 'm1' })
    const started = await startRotation({ oldKeyId: 'old', newKeyId: 'new', createdBy: 'u1' })
    const id = (started as { id: string }).id
    const ok = await cancelRotation(id)
    expect(ok.success).toBe(true)
    expect(store.chatRotation[0].phase).toBe('cancelled')
    expect(await cancelRotation(id)).toEqual({ success: false, reason: 'not_cancellable' })
  })
})

describe('createInviteToken → redeemInvite 流程', () => {
  it('创建后可兑换出原始载荷；uses 计数递增', async () => {
    const { code } = await createInviteToken({
      payload: { channelId: 'chan-x', password: 'pw-secret' },
      createdBy: 'u1',
      ttlMs: 3600_000,
      maxUses: 2,
    })
    const r = await redeemInvite(code)
    expect(r).toEqual({ ok: true, role: 'member', payload: { channelId: 'chan-x', password: 'pw-secret' } })
    expect(store.inviteToken[0].uses).toBe(1)
    await redeemInvite(code)
    // 第三次超出 maxUses=2
    const third = await redeemInvite(code)
    expect(third).toEqual({ error: '邀请次数已用完', status: 410 })
  })

  it('免密钥载荷在库中不以明文存在（主密钥二次加密）', async () => {
    await createInviteToken({
      payload: { channelId: 'chan-y', password: 'PLAINTEXT-PW' },
      createdBy: 'u1',
      ttlMs: 3600_000,
      maxUses: 0,
    })
    const raw = JSON.stringify(store.inviteToken[0].data)
    expect(raw).not.toContain('PLAINTEXT-PW') // 密文不含密码明文
  })

  it('格式错误的短码被拒', async () => {
    expect(await redeemInvite('bad code!')).toHaveProperty('error')
  })

  it('过期的邀请被拒（410）', async () => {
    const { code } = await createInviteToken({
      payload: { channelId: 'c' },
      createdBy: 'u1',
      ttlMs: 60_000, // 最小值
      maxUses: 0,
    })
    // 手动把过期时间拨到过去
    ;(store.inviteToken[0].expiresAt as Date).setTime(Date.now() - 1000)
    expect(await redeemInvite(code)).toEqual({ error: '邀请已过期', status: 410 })
  })

  it('不存在的短码返回 404', async () => {
    expect(await redeemInvite('ABCD12345678')).toEqual({ error: '邀请不存在或已失效', status: 404 })
  })

  it('同一主密钥可解密自己加密的令牌（跨令牌一致性）', async () => {
    const a = await createInviteToken({ payload: { channelId: 'c1' }, createdBy: 'u', ttlMs: 3600_000, maxUses: 0 })
    const b = await createInviteToken({ payload: { channelId: 'c2' }, createdBy: 'u', ttlMs: 3600_000, maxUses: 0 })
    expect(await redeemInvite(a.code)).toMatchObject({ ok: true })
    expect(await redeemInvite(b.code)).toMatchObject({ ok: true })
  })
})

describe('keyIdOf 与 session.ts 一致性', () => {
  it('相同输入产生稳定 keyId（sha256 hex）', () => {
    expect(keyIdOf('chan', 'aabb')).toBe(keyIdOf('chan', 'aabb'))
    expect(keyIdOf('chan', 'aabb')).toMatch(/^[a-f0-9]{64}$/)
    expect(keyIdOf('chan', 'aabb')).not.toBe(keyIdOf('chan', 'ccdd'))
  })
})
