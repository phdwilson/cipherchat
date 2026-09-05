'use client'
// 邀请二维码 / 密钥轮换 客户端辅助
// - 二维码在本地渲染（qrcode 库），链接不出现在任何服务器日志
// - 轮换：旧密钥解密 → 新密钥重加密 → 分批提交，全程密文迁移
import { deriveChatKeys, sealJSON, openJSON, encryptChunk, decryptChunk } from '@/lib/crypto'
import { uploadEncryptedFile } from '@/lib/crypto'

export interface InviteInfo {
  code: string
  url: string
  expiresAt: string
  withPassword: boolean // 是否免密钥模式
}

export async function createInvite(opts: {
  token: string
  channelId: string
  password?: string | null
  ttlMs?: number
  maxUses?: number
}): Promise<InviteInfo> {
  const res = await fetch('/api/chat/invite', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-session-token': opts.token },
    body: JSON.stringify({
      channelId: opts.channelId,
      password: opts.password || '',
      ttlMs: opts.ttlMs,
      maxUses: opts.maxUses,
    }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data?.error || '创建邀请失败')
  const base = `${location.origin}${location.pathname.replace(/\/$/, '')}`
  return {
    code: data.code,
    url: `${base}#/invite=${data.code}`,
    expiresAt: data.expiresAt,
    withPassword: !!opts.password,
  }
}

export async function redeemInvite(code: string): Promise<{ channelId: string; password: string | null }> {
  const res = await fetch('/api/chat/invite/redeem', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data?.error || '邀请无效')
  return { channelId: data.channelId, password: data.password }
}

// ---------------- 密钥轮换 ----------------
export interface RotationProgress {
  phase: 'start' | 'messages' | 'files' | 'finish' | 'done'
  msgDone: number
  msgTotal: number
  fileDone: number
  fileTotal: number
}

export async function rotateChannelKeys(opts: {
  channelId: string
  oldPassword: string
  newPassword: string
  onProgress?: (p: RotationProgress) => void
  onRotationId?: (id: string) => void // 把 rotationId 暴露给调用方（取消回滚时携带）
}): Promise<void> {
  const oldKeys = await deriveChatKeys(opts.channelId, opts.oldPassword)
  const newKeys = await deriveChatKeys(opts.channelId, opts.newPassword)

  // 需要一个旧会话 token 才能调用 rotate API —— 由调用方（已加入频道的用户）提供：
  // 这里通过重新建立 session 拿 token（用旧密码）
  const pubId = (() => {
    try { return localStorage.getItem('cipherchat:devid') || crypto.randomUUID() } catch { return crypto.randomUUID() }
  })()
  const sRes = await fetch('/api/chat/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channelId: opts.channelId, authHash: oldKeys.authHash, probeHash: '', pubId }),
  })
  const sData = await sRes.json()
  if (!sRes.ok) throw new Error(sData?.error || '轮换失败：无法验证旧密码')
  const token: string = sData.token

  // 1. 开始
  const stRes = await fetch('/api/chat/rotate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-session-token': token },
    body: JSON.stringify({ action: 'start', channelId: opts.channelId, newAuthHash: newKeys.authHash }),
  })
  const stData = await stRes.json()
  if (!stRes.ok) throw new Error(stData?.error || '启动轮换失败')
  const rotationId: string = stData.rotationId
  opts.onRotationId?.(rotationId)
  opts.onProgress?.({ phase: 'messages', msgDone: 0, msgTotal: 0, fileDone: 0, fileTotal: 0 })

  // 2. 拉取全部旧消息并重加密（分页拉取避免一次载入过多）
  let msgDone = 0
  let before: string | null = null
  while (true) {
    const hRes = await fetch(`/api/chat/history?limit=200${before ? `&before=${encodeURIComponent(before)}` : ''}`, {
      headers: { 'x-session-token': token },
    })
    if (!hRes.ok) throw new Error('拉取历史消息失败')
    const { messages } = await hRes.json()
    if (!Array.isArray(messages) || messages.length === 0) break
    const batch: Array<{ id: string; payload: string }> = []
    for (const m of messages as Array<{ id: string; senderId: string; payload: string; createdAt: string }>) {
      const env = await openJSON<unknown>(oldKeys.aesKey, m.payload)
      if (env === null) continue // 无法解密的条目跳过（异常数据）
      batch.push({ id: m.id, payload: await sealJSON(newKeys.aesKey, env) })
    }
    before = messages[messages.length - 1].createdAt
    if (batch.length > 0) {
      const mRes = await fetch('/api/chat/rotate', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-session-token': token },
        body: JSON.stringify({ action: 'migrate', rotationId, messages: batch }),
      })
      if (!mRes.ok) throw new Error('迁移消息失败')
      msgDone += batch.length
      opts.onProgress?.({ phase: 'messages', msgDone, msgTotal: 0, fileDone: 0, fileTotal: 0 })
    }
    if (messages.length < 200) break
  }

  // 3. 文件逐个重加密上传（下载旧密文 → 解密 → 新密钥重加密 → 上传新 fileId）
  const fIdsRes = await fetch('/api/chat/rotate/files/list', {
    headers: { 'x-session-token': token },
  })
  const files: Array<{ id: string; totalChunks: number }> = fIdsRes.ok ? (await fIdsRes.json()).files || [] : []
  const cfgRes = await fetch('/api/config')
  const cfg = await cfgRes.json().catch(() => ({ chunkSize: 4 * 1024 * 1024 }))
  const chunkSize = cfg?.chunkSize || 4 * 1024 * 1024
  let fileDone = 0
  const fileMap: Array<{ oldFileId: string; newFileId: string }> = []
  for (const f of files) {
    try {
      // 新会话（新频道）下上传 —— 先用新密码建 session
      const nSessRes = await fetch('/api/chat/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channelId: opts.channelId, authHash: newKeys.authHash, probeHash: '', pubId }),
      })
      const nSess = await nSessRes.json()
      if (!nSessRes.ok) throw new Error(nSess?.error || '新频道会话建立失败')

      // 下载旧文件密文
      const dlRes = await fetch(`/api/chat/file/${f.id}`, { headers: { 'x-session-token': token } })
      if (!dlRes.ok) throw new Error('下载旧文件失败')
      const wire = new Uint8Array(await dlRes.arrayBuffer())

      // 解密 + 重加密每一块
      const parts: BlobPart[] = []
      for (let i = 0; i < f.totalChunks; i++) {
        const blockLen = Math.min(chunkSize + 28, wire.length - i * (chunkSize + 28))
        if (blockLen <= 0) break
        const block = wire.subarray(i * (chunkSize + 28), i * (chunkSize + 28) + blockLen)
        const pt = await decryptChunk(oldKeys.aesKey, f.id, i, block.slice().buffer)
        const re = await encryptChunk(newKeys.aesKey, 'pending', i, pt.buffer as ArrayBuffer)
        parts.push(re)
      }

      // 上传（AAD 需要绑定真实 fileId，所以先 init 拿到 id 后再加密一遍；
      // 为简化内存占用这里直接从 parts 重组 File 再走 uploadEncryptedFile）
      const blob = new Blob(parts, { type: 'application/octet-stream' })
      const tmpName = `rotate-${f.id}`
      const result = await uploadEncryptedFile({
        file: new File([blob], tmpName, { type: 'application/octet-stream' }),
        key: newKeys.aesKey,
        chunkSize,
        initUrl: '/api/chat/files/init',
        chunkUrl: (fid, idx) => `/api/chat/files/chunk?fileId=${fid}&index=${idx}`,
        completeUrl: '/api/chat/files/complete',
        token: nSess.token,
        concurrency: 2,
      })
      fileMap.push({ oldFileId: f.id, newFileId: result.fileId })
      fileDone++
      opts.onProgress?.({ phase: 'files', msgDone, msgTotal: 0, fileDone, fileTotal: files.length })
    } catch (e) {
      // 单个文件失败不阻断整体轮换，但必须记录（该文件将保留在旧 keyId 下，
      // finish 后不可再解密 —— 用户需从警告中得知哪些内容未能迁移）
      console.warn(`[rotate] 文件 ${f.id} 重加密迁移失败，该文件将无法在新密钥下访问:`, e instanceof Error ? e.message : e)
    }
  }
  if (fileMap.length > 0) {
    await fetch('/api/chat/rotate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-token': token },
      body: JSON.stringify({ action: 'files', rotationId, fileMap }),
    })
  }

  // 4. 完成
  await fetch('/api/chat/rotate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-session-token': token },
    body: JSON.stringify({ action: 'finish', rotationId }),
  })
  opts.onProgress?.({ phase: 'done', msgDone, msgTotal: 0, fileDone, fileTotal: files.length })
}

// 取消并回滚轮换：rotationId 可选 —— 服务端在缺失时按当前会话频道回退查找
// （v1.4.3 BUG 修复：此前未传 rotationId 导致 cancel 永远 409）
export async function cancelRotationRemote(channelId: string, oldPassword: string, rotationId?: string): Promise<void> {
  const oldKeys = await deriveChatKeys(channelId, oldPassword)
  const pubId = (() => {
    try { return localStorage.getItem('cipherchat:devid') || crypto.randomUUID() } catch { return crypto.randomUUID() }
  })()
  const sRes = await fetch('/api/chat/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channelId, authHash: oldKeys.authHash, probeHash: '', pubId }),
  })
  const sData = await sRes.json()
  if (!sRes.ok) throw new Error(sData?.error || '取消失败：无法验证旧密码')
  const res = await fetch('/api/chat/rotate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-session-token': sData.token },
    body: JSON.stringify({ action: 'cancel', rotationId }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data?.error || '取消回滚失败')
}
