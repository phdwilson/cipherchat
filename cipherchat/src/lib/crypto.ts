'use client'
// 客户端端到端加密核心（WebCrypto AES-256-GCM + PBKDF2）
// 设计要点：
// 1. 服务器永远接触不到密码/密钥明文，只收到派生哈希与密文
// 2. 同一「频道ID+密码」在所有设备上派生出相同密钥 → 端到端可解密
// 3. 文件分块加密，AAD 绑定 fileId+index 防篡改/防乱序
// 4. 310,000 轮 PBKDF2 迭代抗暴力破解

const enc = new TextEncoder()
const dec = new TextDecoder()

// TS 5.7+ 的 lib.dom 将 BufferSource 收窄为「底层必须是 ArrayBuffer」，
// 统一用 te() 把 TextEncoder 的产物收窄为 ArrayBuffer 支撑的视图（零拷贝，仅类型层面）
type ABytes = Uint8Array<ArrayBuffer>
const te = (s: string): ABytes => enc.encode(s) as ABytes

export const PBKDF2_AUTH_ITERS = 120000
export const PBKDF2_KEY_ITERS = 310000

// ---------------- Base64 ----------------
export function bufToB64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let bin = ''
  const CH = 0x8000
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CH))
  }
  return btoa(bin)
}

export function b64ToBuf(b64: string): ABytes {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

// ---------------- 密钥派生 ----------------
async function pbkdf2(password: string, salt: string, iterations: number, bits = 256): Promise<ABytes> {
  const base = await crypto.subtle.importKey('raw', te(password), 'PBKDF2', false, ['deriveBits'])
  const bits8 = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: te(salt), iterations },
    base,
    bits
  )
  return new Uint8Array(bits8)
}

function toHex(bytes: ABytes): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')
}

export interface ChatKeys {
  aesKey: CryptoKey // AES-256-GCM
  authHash: string // 发送给服务器的认证哈希（服务器不可逆推密码）
}

export async function deriveChatKeys(channelId: string, password: string): Promise<ChatKeys> {
  const [auth, key] = await Promise.all([
    pbkdf2(password, 'cipherchat:auth:' + channelId, PBKDF2_AUTH_ITERS),
    pbkdf2(password, 'cipherchat:key:' + channelId, PBKDF2_KEY_ITERS),
  ])
  const aesKey = await crypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
  return { aesKey, authHash: toHex(auth) }
}

export interface DriveKeys {
  aesKey: CryptoKey
  keyHash: string
}

export async function deriveDriveKeys(driveId: string, secretKey: string): Promise<DriveKeys> {
  const [auth, key] = await Promise.all([
    pbkdf2(secretKey, 'cipherdrive:auth:' + driveId, PBKDF2_AUTH_ITERS),
    pbkdf2(secretKey, 'cipherdrive:key:' + driveId, PBKDF2_KEY_ITERS),
  ])
  const aesKey = await crypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
  return { aesKey, keyHash: toHex(auth) }
}

// 管理员超级密钥哈希（网盘创建授权；盐与聊天/网盘密钥均不同）
export async function deriveAdminKeyHash(superKey: string): Promise<string> {
  return toHex(await pbkdf2(superKey, 'cipherchat:admin', PBKDF2_AUTH_ITERS))
}

// 自毁探测哈希：在所有密码/密钥输入处附带，服务端命中自毁密钥即触发全局销毁
export async function deriveProbeHash(input: string): Promise<string> {
  return toHex(await pbkdf2(input, 'cipherchat:probe', PBKDF2_AUTH_ITERS))
}

// ---------------- JSON 信封加密（消息/昵称/元数据） ----------------
export interface SealedBox {
  iv: string
  data: string
}

export async function sealJSON(key: CryptoKey, obj: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, te(JSON.stringify(obj)))
  return JSON.stringify({ iv: bufToB64(iv), data: bufToB64(ct) } satisfies SealedBox)
}

export async function openJSON<T = unknown>(key: CryptoKey, sealed: string): Promise<T | null> {
  try {
    const box: SealedBox = JSON.parse(sealed)
    const iv = b64ToBuf(box.iv)
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, b64ToBuf(box.data))
    return JSON.parse(dec.decode(pt)) as T
  } catch (e) {
    // 关键路径（解密失败意味着密钥不匹配或数据损坏）—— 记录警告便于排查，
    // 但仍返回 null 保持调用方兼容（调用方按「无法解密」处理）
    console.warn('[crypto] openJSON 解密失败:', e instanceof Error ? e.message : e)
    return null
  }
}

// ---------------- 文件分块加密 ----------------
// 密文格式：12B IV || ciphertext(+16B GCM tag)
// AAD 绑定 fileId:index，防止分块被调换/重排

async function aadOf(fileId: string, index: number): Promise<ABytes> {
  return te(`f:${fileId}:${index}`)
}

export async function encryptChunk(key: CryptoKey, fileId: string, index: number, plain: ArrayBuffer): Promise<ABytes> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: await aadOf(fileId, index) },
    key,
    plain
  )
  const out = new Uint8Array(12 + ct.byteLength)
  out.set(iv, 0)
  out.set(new Uint8Array(ct), 12)
  return out
}

export async function decryptChunk(key: CryptoKey, fileId: string, index: number, wire: ArrayBuffer): Promise<ABytes> {
  const bytes = new Uint8Array(wire)
  const iv = bytes.subarray(0, 12)
  const ct = bytes.subarray(12)
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: await aadOf(fileId, index) },
    key,
    ct
  )
  return new Uint8Array(pt)
}

// ---------------- 加密上传 / 解密下载 ----------------
export interface UploadHandle {
  abort: () => void
}

export interface UploadResult {
  fileId: string
  totalChunks: number
  cipherBytes: number
}

// v1.5.0 断点续传状态（调用方持久化到 localStorage/IndexedDB）
export interface UploadResumeState {
  fileId: string
  doneIndexes: number[]
}

export async function uploadEncryptedFile(opts: {
  file: File
  key: CryptoKey
  chunkSize: number
  initUrl: string
  chunkUrl: (fileId: string, index: number) => string
  completeUrl: string
  token: string
  meta?: Record<string, unknown> // 附加加密元数据（网盘用）
  initExtra?: Record<string, unknown> // v1.7.0：随 init 请求发送的明文标记（如闪照 viewOnce=true，不涉内容）
  onProgress?: (sentBytes: number, totalBytes: number) => void
  signal?: AbortSignal
  concurrency?: number
  resumeState?: UploadResumeState // v1.5.0 断点续传：传入已完成块清单，跳过这些块
  onResumeState?: (s: UploadResumeState) => void // v1.5.0 每完成一块回报状态（调用方持久化）
  throttleBps?: number // v1.5.0 限速（字节/秒）；不传则不限速
  pauseRef?: { paused: boolean } // v1.5.0 暂停开关：外部置 true 即暂停上传循环
}): Promise<UploadResult> {
  const { file, key, chunkSize, token } = opts
  const plainSize = file.size
  const totalChunks = Math.max(1, Math.ceil(plainSize / chunkSize))
  // 预估密文大小（每块 +28B：IV 12 + Tag 16）
  const cipherEstimate = plainSize + totalChunks * 28

  const doneSet = new Set<number>(opts.resumeState?.doneIndexes || [])

  let fileId = opts.resumeState?.fileId || ''
  if (!fileId) {
    const initBody: Record<string, unknown> = { totalChunks, totalBytes: cipherEstimate, ...(opts.initExtra || {}) }
    if (opts.meta) initBody.meta = await sealJSON(key, opts.meta)

    const initRes = await fetch(opts.initUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-token': token },
      body: JSON.stringify(initBody),
      signal: opts.signal,
    })
    if (!initRes.ok) {
      const j = await initRes.json().catch(() => ({ error: '上传初始化失败' }))
      throw new Error(j.error || '上传初始化失败')
    }
    fileId = (await initRes.json()).fileId
  }

  let sentBytes = [...doneSet].length * chunkSize
  let nextIndex = 0
  const workers: Promise<void>[] = []
  const n = Math.max(1, Math.min(opts.concurrency ?? 2, 4))

  // v1.5.0 限速：简单令牌桶 —— 每发一块按块大小等待配额
  const bps = opts.throttleBps ?? 0
  let throttleQuota = bps || Infinity
  let lastRefill = Date.now()
  const acquireQuota = async (bytes: number) => {
    if (!bps) return
    while (true) {
      const now = Date.now()
      throttleQuota += ((now - lastRefill) / 1000) * bps
      lastRefill = now
      if (throttleQuota >= bytes) { throttleQuota -= bytes; return }
      await new Promise((r) => setTimeout(r, Math.min(200, Math.ceil((bytes - throttleQuota) / bps * 1000))))
    }
  }
  const waitIfPaused = async () => {
    while (opts.pauseRef?.paused) await new Promise((r) => setTimeout(r, 300))
  }

  const runWorker = async () => {
    while (nextIndex < totalChunks) {
      if (opts.signal?.aborted) throw new DOMException('aborted', 'AbortError')
      // v1.8.1 竞态修复：领取分块序号必须与循环条件检查在同一同步块内完成（中间不得有 await）。
      // 旧实现把 await waitIfPaused() 夹在检查与领取之间 —— 并发 worker 同时通过检查后
      // 先后领取，后领取者拿到 totalChunks 本身（越界），服务端以「分块序号超出范围」拒绝，
      // 整个上传失败。≤1 块的小文件（≤4MiB，即最常见的图片/小文件）100% 触发。
      const index = nextIndex++
      await waitIfPaused()
      if (doneSet.has(index)) continue // v1.5.0 断点续传：跳过已完成块
      const slice = file.slice(index * chunkSize, Math.min((index + 1) * chunkSize, plainSize))
      const cipher = await encryptChunk(key, fileId!, index, await slice.arrayBuffer())
      await acquireQuota(cipher.length)
      const res = await fetch(opts.chunkUrl(fileId!, index), {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', 'x-session-token': token },
        body: cipher,
        signal: opts.signal,
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({ error: '分块上传失败' }))
        throw new Error(j.error || `分块 ${index} 上传失败`)
      }
      sentBytes += slice.size
      doneSet.add(index)
      // v1.5.0 回报断点续传状态
      opts.onResumeState?.({ fileId: fileId!, doneIndexes: [...doneSet] })
      opts.onProgress?.(Math.min(sentBytes, plainSize), plainSize)
    }
  }
  for (let i = 0; i < n; i++) workers.push(runWorker())
  await Promise.all(workers)

  const completeRes = await fetch(opts.completeUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-session-token': token },
    body: JSON.stringify({ fileId }),
    signal: opts.signal,
  })
  if (!completeRes.ok) {
    const j = await completeRes.json().catch(() => ({ error: '上传完结失败' }))
    throw new Error(j.error || '上传完结失败')
  }

  return { fileId, totalChunks, cipherBytes: cipherEstimate }
}

export interface DecryptFetchers {
  url: string // 密文流地址
  token: string
}

// 解密下载：优先 File System Access API 流式写盘（大文件不占内存），回退 Blob
export async function downloadAndDecrypt(opts: {
  fetchers: DecryptFetchers
  key: CryptoKey
  fileId: string
  totalChunks: number
  fileName: string
  mime?: string
  chunkSize: number
  totalPlainBytes?: number
  onProgress?: (bytes: number, total: number) => void
  signal?: AbortSignal
}): Promise<Blob | null> {
  const res = await fetch(opts.fetchers.url, {
    headers: { 'x-session-token': opts.fetchers.token },
    signal: opts.signal,
  })
  if (!res.ok) {
    const j = await res.json().catch(() => ({ error: '下载失败' }))
    throw new Error(j.error || '下载失败')
  }
  if (!res.body) throw new Error('服务器未返回数据流')

  // 明文总大小未知时按密文流估算
  let received = 0
  const chunks: Uint8Array[] = []

  // 尝试 FSA（桌面 Chrome / Edge）
  const fsa = (window as unknown as { showSaveFilePicker?: (o: unknown) => Promise<FileSystemWritableFileStream> })
    .showSaveFilePicker
  if (typeof fsa === 'function') {
    try {
      const handle = await fsa({
        suggestedName: opts.fileName,
        types: opts.mime
          ? [{ description: opts.fileName, accept: { [opts.mime || 'application/octet-stream']: [] } }]
          : undefined,
      })
      const writable = await (handle as unknown as { createWritable: () => Promise<FileSystemWritableFileStream> }).createWritable()
      const reader = res.body.getReader()
      let buf = new Uint8Array(0)
      let chunkIndex = 0
      let written = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (opts.signal?.aborted) {
          await writable.close().catch(() => {})
          throw new DOMException('aborted', 'AbortError')
        }
        // 按 cipher 块长度切分：每块 = min(chunkSize+28, ...)；块边界由调用端保证与服务端一致
        const merged = new Uint8Array(buf.length + value.length)
        merged.set(buf, 0)
        merged.set(value, buf.length)
        buf = merged
        while (buf.length >= opts.chunkSize + 28 && chunkIndex < opts.totalChunks) {
          const block = buf.subarray(0, opts.chunkSize + 28)
          buf = buf.subarray(opts.chunkSize + 28)
          const pt = await decryptChunk(opts.key, opts.fileId, chunkIndex, block.slice().buffer)
          await writable.write(pt)
          written += pt.length
          chunkIndex++
          received += block.length
          opts.onProgress?.(written, opts.totalPlainBytes || 0)
        }
      }
      // 尾块（不足 chunkSize+28）
      if (buf.length > 0 && chunkIndex < opts.totalChunks) {
        const pt = await decryptChunk(opts.key, opts.fileId, chunkIndex, buf.slice().buffer)
        await writable.write(pt)
        written += pt.length
        chunkIndex++
        opts.onProgress?.(written, opts.totalPlainBytes || 0)
      }
      await writable.close()
      return null // 已保存到磁盘
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') throw e
      if (e instanceof DOMException && e.name === 'NotAllowedError') throw e
      // FSA 写盘失败回退 Blob 模式 —— 非致命但需记录（用户仍能拿到文件）
      console.warn('[crypto] FSA 流式写盘失败，回退 Blob 模式:', e instanceof Error ? e.message : e)
      // 其他错误（含用户取消 AbortError 之外）回退到 Blob 模式：重新请求
      const retry = await fetch(opts.fetchers.url, {
        headers: { 'x-session-token': opts.fetchers.token },
        signal: opts.signal,
      })
      if (!retry.ok || !retry.body) throw new Error('下载失败')
      return await blobDecrypt(retry, opts, 0)
    }
  }

  return await blobDecrypt(res, opts, 0)

  async function blobDecrypt(
    resp: Response,
    o: typeof opts,
    _pad: number
  ): Promise<Blob> {
    const ab = await resp.arrayBuffer()
    const wire = new Uint8Array(ab)
    const parts: BlobPart[] = []
    let off = 0
    for (let i = 0; i < o.totalChunks; i++) {
      const blockLen = Math.min(o.chunkSize + 28, wire.length - off)
      if (blockLen <= 0) break
      const block = wire.subarray(off, off + blockLen)
      const pt = await decryptChunk(o.key, o.fileId, i, block.slice().buffer)
      parts.push(pt)
      off += blockLen
      o.onProgress?.(off, wire.length)
    }
    return new Blob(parts, { type: o.mime || 'application/octet-stream' })
  }
}

// ---------------- 工具 ----------------
export function randomNick(): string {
  const adj = ['星尘', '夜风', '流云', '月影', '晨曦', '碧波', '青竹', '飞雪', '紫电', '寒烟', '落霞', '孤舟']
  const noun = ['旅人', '行者', '信使', '访客', '游侠', '隐士', '观星者', '逐光者']
  return `${adj[Math.floor(Math.random() * adj.length)]}${noun[Math.floor(Math.random() * noun.length)]}`
}

export function formatBytes(n: number, digits = 1): string {
  if (!Number.isFinite(n)) return '-'
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(digits)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(digits)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

export function passwordStrength(pw: string): { score: 0 | 1 | 2 | 3 | 4; label: string } {
  let s = 0
  if (pw.length >= 8) s++
  if (pw.length >= 14) s++
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw) || /\d/.test(pw) && /[a-zA-Z]/.test(pw)) s++
  if (/[^a-zA-Z0-9]/.test(pw) && pw.length >= 12) s++
  const labels = ['太短了', '较弱', '一般', '较强', '非常强']
  return { score: s as 0 | 1 | 2 | 3 | 4, label: labels[s] }
}
