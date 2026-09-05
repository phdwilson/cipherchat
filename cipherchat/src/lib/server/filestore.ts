// 密文分块文件存储（chat / drive 两种命名空间）
// 目录结构：data/{ns}/{fileId}/000000.bin, 000001.bin ...
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { mkdir, readdir, rename, rm, stat, writeFile } from 'fs/promises'
import { join, resolve } from 'path'
import { Readable } from 'stream'
import { SERVER_CONFIG } from './config'

export type FileNamespace = 'chat' | 'drive'

function nsRoot(ns: FileNamespace) {
  const root = resolve(process.cwd(), SERVER_CONFIG.dataDir, ns)
  if (!existsSync(root)) mkdirSync(root, { recursive: true })
  return root
}

export function fileDir(ns: FileNamespace, fileId: string) {
  return join(nsRoot(ns), fileId)
}

export function chunkPath(ns: FileNamespace, fileId: string, index: number) {
  return join(fileDir(ns, fileId), String(index).padStart(6, '0') + '.bin')
}

export function chunkExists(ns: FileNamespace, fileId: string, index: number) {
  return existsSync(chunkPath(ns, fileId, index))
}

export function writeChunk(ns: FileNamespace, fileId: string, index: number, data: Buffer) {
  const dir = fileDir(ns, fileId)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const p = chunkPath(ns, fileId, index)
  const tmp = p + '.tmp'
  writeFileSync(tmp, data)
  renameSync(tmp, p) // 原子落盘，避免半块文件
}

// v1.7.0：异步版 writeChunk —— 4MiB 分块的同步写会卡住 Node 事件循环，
// 并发上传/下载时所有用户都会被阻塞；改用 fs/promises 后仅在本地磁盘队列排队
export async function writeChunkAsync(ns: FileNamespace, fileId: string, index: number, data: Buffer): Promise<void> {
  const dir = fileDir(ns, fileId)
  await mkdir(dir, { recursive: true })
  const p = chunkPath(ns, fileId, index)
  const tmp = p + '.tmp'
  await writeFile(tmp, data)
  await rename(tmp, p) // 同目录 rename 仍为原子操作
}

export function readChunk(ns: FileNamespace, fileId: string, index: number): Buffer | null {
  const p = chunkPath(ns, fileId, index)
  if (!existsSync(p)) return null
  try {
    return readFileSync(p)
  } catch {
    return null
  }
}

// 密钥轮换：把整个文件目录原子改名换绑到新 fileId（密文内容不变，
// 但 AAD 绑定旧 fileId —— 轮换时由客户端逐块重加密后上传新文件；此函数用于客户端
// 提交 fileMap 后服务端直接搬移磁盘数据，避免大文件双份存储）
export function moveFileDir(ns: FileNamespace, fromId: string, toId: string): boolean {
  const src = fileDir(ns, fromId)
  const dst = fileDir(ns, toId)
  try {
    if (!existsSync(src)) return false
    // Windows 下 rename 到「已存在的目录」会报 EEXIST/EPERM；目标只允许是空目录
    if (existsSync(dst)) {
      const entries = readdirSync(dst)
      if (entries.length > 0) return false
      rmSync(dst, { recursive: true, force: true })
    }
    renameSync(src, dst)
    return true
  } catch {
    return false
  }
}

export function deleteFileDir(ns: FileNamespace, fileId: string) {
  // v1.8.0 安全护栏：空/过短的 fileId 会把 join(root, '') 解析成命名空间根目录，
  // 直接 rmSync 会误删整个 data/chat 或 data/drive —— 必须拒绝
  if (!fileId || !/^[0-9a-zA-Z][0-9a-zA-Z-]{7,63}$/.test(fileId)) {
    console.warn('[filestore] deleteFileDir 拒绝了非法 fileId:', JSON.stringify(fileId))
    return
  }
  const dir = fileDir(ns, fileId)
  // 双保险：解析结果必须仍是「根目录的子目录」，不能等于根目录本身
  const root = nsRoot(ns)
  if (dir === root || !dir.startsWith(root)) return
  try {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  } catch {
    // ignore
  }
}

export function countChunks(ns: FileNamespace, fileId: string): number {
  const dir = fileDir(ns, fileId)
  if (!existsSync(dir)) return 0
  let n = 0
  while (existsSync(join(dir, String(n).padStart(6, '0') + '.bin'))) n++
  return n
}

export function dirSizeBytes(ns: FileNamespace, fileId: string): number {
  const dir = fileDir(ns, fileId)
  if (!existsSync(dir)) return 0
  let total = 0
  try {
    const files = readdirSync(dir) as string[]
    for (const f of files) {
      if (!f.endsWith('.bin')) continue
      try {
        total += statSync(join(dir, f)).size
      } catch { /* ignore */ }
    }
  } catch {
    return 0
  }
  return total
}

// 返回缺失分块的序号列表（下载前校验，避免缺块被静默跳过导致解密错位）
export function missingChunks(ns: FileNamespace, fileId: string, totalChunks: number): number[] {
  const dir = fileDir(ns, fileId)
  const missing: number[] = []
  for (let i = 0; i < totalChunks; i++) {
    if (!existsSync(join(dir, String(i).padStart(6, '0') + '.bin'))) missing.push(i)
  }
  return missing
}

// v1.7.0：异步版完整性校验（单次 readdir 替代逐块 stat，万级分块从万次系统调用降为 1 次）
export async function missingChunksAsync(ns: FileNamespace, fileId: string, totalChunks: number): Promise<number[]> {
  const dir = fileDir(ns, fileId)
  let present: Set<string>
  try {
    present = new Set(await readdir(dir))
  } catch {
    return Array.from({ length: totalChunks }, (_, i) => i)
  }
  const missing: number[] = []
  for (let i = 0; i < totalChunks; i++) {
    if (!present.has(String(i).padStart(6, '0') + '.bin')) missing.push(i)
  }
  return missing
}

// v1.7.0：异步版目录大小统计（单次 readdir + 批量 stat）
// v1.8.0 修复：旧实现 `total += (await stat(...)).size` 在 Bun 运行时存在丢失更新竞态
// （38 个分片并发 stat，读-改-写被拆开交错，最终只剩 1~2 块大小 —— 150MB 文件
// 被统计成 2~4MB 的根因）。改为先把每个 size 求值完，再用 reduce 求和，零竞态。
export async function dirSizeBytesAsync(ns: FileNamespace, fileId: string): Promise<number> {
  const dir = fileDir(ns, fileId)
  let files: string[]
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.bin'))
  } catch {
    return 0
  }
  // 注意：Promise.all 的映射函数内不读写共享变量，size 在协程内求值完成后
  // 才在 reduce 中累加 —— 与并发调度时机完全无关
  const sizes = await Promise.all(
    files.map((f) =>
      stat(join(dir, f))
        .then((s) => s.size)
        .catch(() => 0)
    )
  )
  return sizes.reduce((a, b) => a + b, 0)
}

// v1.8.0：全命名空间磁盘占用（递归统计，自检/重算用）
// 与 dirSizeBytesAsync 相同的零竞态模式；扫的是 ns 根下所有文件目录
export async function nsDiskUsageBytes(ns: FileNamespace): Promise<number> {
  const root = nsRoot(ns)
  let repoDirs
  try {
    repoDirs = await readdir(root, { withFileTypes: true })
  } catch {
    return 0
  }
  const sizes = await Promise.all(
    (repoDirs as Array<{ name: string; isDirectory: () => boolean }>)
      .filter((d) => d.isDirectory())
      .map((d) => dirSizeBytesAsync(ns, d.name))
  )
  return sizes.reduce((a, b) => a + b, 0)
}

// 将所有分块串联成 Web Response 流（下载用）
// 调用前必须先用 missingChunks 校验完整性 —— 缺块会让客户端按 AAD 解密时整块错位
export function streamFile(ns: FileNamespace, fileId: string, totalChunks: number): ReadableStream<Uint8Array> {
  const dir = fileDir(ns, fileId)
  const paths: string[] = []
  for (let i = 0; i < totalChunks; i++) {
    paths.push(join(dir, String(i).padStart(6, '0') + '.bin'))
  }
  const nodeStream = Readable.from(
    (async function* () {
      for (const p of paths) {
        for await (const chunk of createReadStream(p, { highWaterMark: 1024 * 1024 })) {
          yield chunk as Buffer
        }
      }
    })()
  )
  return Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>
}

// 清理未完成的上传（ready=false 且超过 24 小时）
export async function cleanupStaleUploads(getStale: () => Promise<{ ns: FileNamespace; fileId: string }[]>) {
  try {
    const stale = await getStale()
    for (const item of stale) deleteFileDir(item.ns, item.fileId)
  } catch {
    // ignore
  }
}
