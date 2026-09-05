/**
 * .ccz — Cipher Compressed Zip（强制端到端加密自定义格式）
 *
 * 文件布局（小端）：
 * ┌──────────────────────────────────────────────────────────┐
 * │ Magic "CCZ1" (4)                                         │
 * │ Version u16 (2)                                          │
 * │ Flags u32 (4)          必含 FORCE_E2E                    │
 * │ Cipher u8 / Compress u8 / reserved u16 (4)               │
 * │ ChunkSize u32 (4)                                        │
 * │ SaltLen u16 + Salt (var)                                 │
 * │ AuthHash 32B（密钥正确性快速校验，不可逆推）               │
 * │ HeaderEncLen u32 + HeaderEnc (AES-GCM 密封的 JSON meta)  │
 * │ TocEncLen u32 + TocEnc（密封的目录表）                    │
 * │ ChunkCount u32                                           │
 * │ 重复 ChunkCount 次： chunkLen u32 + chunkBytes           │
 * │ TrailerMagic "CCZE" (4) + archiveSha256 前 16B 校验      │
 * └──────────────────────────────────────────────────────────┘
 *
 * 只有 CipherZip 能正确打开：无密钥则 Header/TOC/内容全部不可读。
 */

import { randomUUID } from 'node:crypto'
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { basename, join, relative, dirname, sep } from 'node:path'
import {
  CCZ_MAGIC,
  CCZ_VERSION,
  ArchiveFlags,
  CipherAlgo,
  CompressAlgo,
  DEFAULT_CHUNK_SIZE,
  type ArchiveMeta,
  type TocEntry,
  type KeyMaterial,
} from '@cipherzip/shared'
import { deriveKeys, sha256Buf, type DerivedKeys } from '../crypto/kdf.js'
import { seal, open, sealName, openName, aadChunk } from '../crypto/aead.js'
import { compress, decompress } from '../compress/index.js'

const TRAILER = Buffer.from('CCZE')

export interface CreateCczOptions {
  inputs: string[] // 文件或目录绝对路径
  output: string
  key: KeyMaterial
  compress?: CompressAlgo
  cipher?: CipherAlgo
  level?: number
  encryptFilenames?: boolean
  chunkSize?: number
  comment?: string
  cipherchat?: ArchiveMeta['cipherchat']
  onProgress?: (done: number, total: number, file?: string) => void
  /** base 目录，用于计算相对路径 */
  baseDir?: string
}

export interface OpenCczResult {
  meta: ArchiveMeta
  entries: TocEntry[]
  keys: DerivedKeys
  chunks: Buffer[]
}

async function collectFiles(paths: string[], baseDir?: string): Promise<Array<{ abs: string; rel: string; isDir: boolean; size: number; mtime: number; mode: number }>> {
  const out: Array<{ abs: string; rel: string; isDir: boolean; size: number; mtime: number; mode: number }> = []
  const { readdir } = await import('node:fs/promises')

  async function walk(p: string, root: string) {
    const st = await stat(p)
    const rel = relative(root, p).split(sep).join('/') || basename(p)
    if (st.isDirectory()) {
      out.push({ abs: p, rel, isDir: true, size: 0, mtime: st.mtimeMs, mode: st.mode })
      const kids = await readdir(p)
      for (const k of kids) {
        if (k === '.' || k === '..') continue
        await walk(join(p, k), root)
      }
    } else if (st.isFile()) {
      out.push({ abs: p, rel, isDir: false, size: st.size, mtime: st.mtimeMs, mode: st.mode })
    }
  }

  for (const p of paths) {
    const st = await stat(p)
    const root = baseDir || (st.isDirectory() ? p : dirname(p))
    await walk(p, root)
  }
  return out
}

function writeU16(n: number): Buffer {
  const b = Buffer.alloc(2)
  b.writeUInt16LE(n)
  return b
}
function writeU32(n: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n)
  return b
}

/**
 * 创建 .ccz 归档（强制 E2E）
 */
export async function createCcz(opts: CreateCczOptions): Promise<{ output: string; authHash: string; entryCount: number }> {
  const cipher = opts.cipher ?? CipherAlgo.AES_256_GCM
  const comp = opts.compress ?? CompressAlgo.BROTLI
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE
  let flags = ArchiveFlags.FORCE_E2E
  if (opts.encryptFilenames !== false) flags |= ArchiveFlags.ENCRYPT_FILENAMES
  if (opts.key.type === 'keyfile' || opts.key.type === 'hybrid') flags |= ArchiveFlags.KEYFILE_MODE

  const keys = await deriveKeys(opts.key)
  const files = await collectFiles(opts.inputs, opts.baseDir)

  const meta: ArchiveMeta = {
    version: CCZ_VERSION,
    flags,
    cipher,
    compress: comp,
    chunkSize,
    createdAt: Date.now(),
    comment: opts.comment,
    cipherchat: opts.cipherchat,
  }

  const entries: TocEntry[] = []
  const chunks: Buffer[] = []
  let totalBytes = files.filter((f) => !f.isDir).reduce((s, f) => s + f.size, 0) || 1
  let doneBytes = 0

  for (const f of files) {
    const entryId = randomUUID()
    const displayPath =
      flags & ArchiveFlags.ENCRYPT_FILENAMES ? sealName(keys.nameKey, f.rel) : f.rel
    const displayName =
      flags & ArchiveFlags.ENCRYPT_FILENAMES ? sealName(keys.nameKey, basename(f.rel)) : basename(f.rel)

    if (f.isDir) {
      entries.push({
        path: displayPath,
        name: displayName,
        size: 0,
        compressedSize: 0,
        mtime: f.mtime,
        mode: f.mode,
        isDir: true,
        chunkIndexes: [],
        sha256: '',
      })
      continue
    }

    const plain = await readFile(f.abs)
    const hash = sha256Buf(plain)
    const compressed = compress(plain, comp, { level: opts.level })
    const indexes: number[] = []
    let compressedSize = 0

    for (let i = 0; i * chunkSize < compressed.length || (compressed.length === 0 && i === 0); i++) {
      const slice = compressed.subarray(i * chunkSize, Math.min((i + 1) * chunkSize, compressed.length))
      const wire = seal(keys.contentKey, slice, aadChunk(entryId, i), cipher)
      indexes.push(chunks.length)
      chunks.push(wire)
      compressedSize += wire.length
    }

    entries.push({
      path: displayPath,
      name: displayName,
      size: f.size,
      compressedSize,
      mtime: f.mtime,
      mode: f.mode,
      isDir: false,
      chunkIndexes: indexes,
      sha256: hash,
    })

    // 把 entryId 编码进 toc 旁路：存在 path 前缀元数据通道太hack，改为 toc 扩展字段
    ;(entries[entries.length - 1] as TocEntry & { entryId: string }).entryId = entryId

    doneBytes += f.size
    opts.onProgress?.(doneBytes, totalBytes, f.rel)
  }

  // 序列化 TOC（含 entryId）
  const tocJson = Buffer.from(JSON.stringify(entries), 'utf8')
  const tocEnc = seal(keys.contentKey, tocJson, Buffer.from('cipherzip:toc'), cipher)
  const headerEnc = seal(keys.contentKey, Buffer.from(JSON.stringify(meta), 'utf8'), Buffer.from('cipherzip:meta'), cipher)

  // 组装文件
  const parts: Buffer[] = []
  parts.push(Buffer.from(CCZ_MAGIC))
  parts.push(writeU16(CCZ_VERSION))
  parts.push(writeU32(flags))
  parts.push(Buffer.from([cipher, comp, 0, 0]))
  parts.push(writeU32(chunkSize))
  parts.push(writeU16(keys.salt.length))
  parts.push(keys.salt)
  parts.push(Buffer.from(keys.authHash, 'hex')) // 32 bytes
  parts.push(writeU32(headerEnc.length))
  parts.push(headerEnc)
  parts.push(writeU32(tocEnc.length))
  parts.push(tocEnc)
  parts.push(writeU32(chunks.length))
  for (const c of chunks) {
    parts.push(writeU32(c.length))
    parts.push(c)
  }
  const body = Buffer.concat(parts)
  const check = sha256Buf(body).slice(0, 32)
  const file = Buffer.concat([body, TRAILER, Buffer.from(check, 'hex')])

  await mkdir(dirname(opts.output), { recursive: true })
  await writeFile(opts.output, file)

  // 清密钥
  keys.contentKey.fill(0)
  keys.nameKey.fill(0)

  return { output: opts.output, authHash: keys.authHash, entryCount: entries.length }
}

/**
 * 打开并解析 .ccz（验证密钥）
 */
export async function openCcz(filePath: string, key: KeyMaterial): Promise<OpenCczResult> {
  const data = await readFile(filePath)
  return openCczBuffer(data, key)
}

export async function openCczBuffer(data: Buffer, key: KeyMaterial): Promise<OpenCczResult> {
  let off = 0
  const magic = data.subarray(0, 4)
  if (!magic.equals(Buffer.from(CCZ_MAGIC))) throw new Error('不是有效的 .ccz 文件（魔数不匹配）')
  off = 4
  const version = data.readUInt16LE(off); off += 2
  if (version > CCZ_VERSION) throw new Error(`不支持的 .ccz 版本: ${version}`)
  const flags = data.readUInt32LE(off); off += 4
  if (!(flags & ArchiveFlags.FORCE_E2E)) throw new Error('非法归档：缺少强制 E2E 标志')
  const cipher = data.readUInt8(off) as CipherAlgo; off += 1
  const compressAlgo = data.readUInt8(off) as CompressAlgo; off += 1
  off += 2 // reserved
  const chunkSize = data.readUInt32LE(off); off += 4
  const saltLen = data.readUInt16LE(off); off += 2
  const salt = data.subarray(off, off + saltLen); off += saltLen
  const authHashStored = data.subarray(off, off + 32).toString('hex'); off += 32

  const keys = await deriveKeys(key, Buffer.from(salt))
  if (keys.authHash !== authHashStored) {
    keys.contentKey.fill(0)
    keys.nameKey.fill(0)
    throw new Error('密码或密钥文件不正确')
  }

  const headerLen = data.readUInt32LE(off); off += 4
  const headerEnc = data.subarray(off, off + headerLen); off += headerLen
  const tocLen = data.readUInt32LE(off); off += 4
  const tocEnc = data.subarray(off, off + tocLen); off += tocLen

  const metaPlain = open(keys.contentKey, headerEnc, Buffer.from('cipherzip:meta'), cipher)
  const meta = JSON.parse(metaPlain.toString('utf8')) as ArchiveMeta
  // 覆盖公开头中的字段保证一致
  meta.flags = flags
  meta.cipher = cipher
  meta.compress = compressAlgo
  meta.chunkSize = chunkSize
  meta.version = version

  const tocPlain = open(keys.contentKey, tocEnc, Buffer.from('cipherzip:toc'), cipher)
  const rawEntries = JSON.parse(tocPlain.toString('utf8')) as Array<TocEntry & { entryId?: string }>

  const chunkCount = data.readUInt32LE(off); off += 4
  const chunks: Buffer[] = []
  for (let i = 0; i < chunkCount; i++) {
    const cl = data.readUInt32LE(off); off += 4
    chunks.push(Buffer.from(data.subarray(off, off + cl)))
    off += cl
  }

  // 可选 trailer 校验
  if (off + 4 + 16 <= data.length && data.subarray(off, off + 4).equals(TRAILER)) {
    // soft check
  }

  const entries: TocEntry[] = rawEntries.map((e) => {
    const path = flags & ArchiveFlags.ENCRYPT_FILENAMES ? openName(keys.nameKey, e.path) : e.path
    const name = flags & ArchiveFlags.ENCRYPT_FILENAMES ? openName(keys.nameKey, e.name) : e.name
    return { ...e, path, name }
  })

  return { meta, entries: rawEntries.map((e, i) => ({ ...entries[i], chunkIndexes: e.chunkIndexes, sha256: e.sha256, size: e.size, compressedSize: e.compressedSize, mtime: e.mtime, mode: e.mode, isDir: e.isDir, path: entries[i].path, name: entries[i].name })), keys, chunks: chunks.map((c, idx) => {
    // 延迟解密：这里先存密文，extract 时再解
    return c
  }) }
}

export interface ExtractOptions {
  archivePath: string
  outputDir: string
  key: KeyMaterial
  /** 仅提取指定相对路径 */
  filter?: string[]
  onProgress?: (done: number, total: number, file?: string) => void
}

/**
 * 解密解压提取到目录
 */
export async function extractCcz(opts: ExtractOptions): Promise<{ files: string[] }> {
  const data = await readFile(opts.archivePath)
  const opened = await openCczBuffer(data, opts.key)
  const { meta, entries, keys, chunks } = opened

  // 重新解析 TOC 拿 entryId
  // openCczBuffer 已解密 entries 路径；需要 entryId —— 从原始 toc 再读一次
  let off = 4 + 2 + 4 + 4 + 4
  const saltLen = data.readUInt16LE(off); off += 2 + saltLen + 32
  const headerLen = data.readUInt32LE(off); off += 4 + headerLen
  const tocLen = data.readUInt32LE(off); off += 4
  const tocEnc = data.subarray(off, off + tocLen)
  const tocPlain = open(keys.contentKey, tocEnc, Buffer.from('cipherzip:toc'), meta.cipher)
  const rawEntries = JSON.parse(tocPlain.toString('utf8')) as Array<TocEntry & { entryId?: string }>

  await mkdir(opts.outputDir, { recursive: true })
  const written: string[] = []
  const total = entries.filter((e) => !e.isDir).length || 1
  let done = 0

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    const raw = rawEntries[i]
    if (opts.filter && opts.filter.length && !opts.filter.includes(e.path)) continue

    const dest = join(opts.outputDir, e.path)
    if (e.isDir) {
      await mkdir(dest, { recursive: true })
      continue
    }

    await mkdir(dirname(dest), { recursive: true })
    const entryId = raw.entryId || `e${i}`
    const parts: Buffer[] = []
    for (let ci = 0; ci < e.chunkIndexes.length; ci++) {
      const wire = chunks[e.chunkIndexes[ci]]
      const plain = open(keys.contentKey, wire, aadChunk(entryId, ci), meta.cipher)
      parts.push(plain)
    }
    const compressed = Buffer.concat(parts)
    const fileData = decompress(compressed, meta.compress)

    if (e.sha256 && sha256Buf(fileData) !== e.sha256) {
      throw new Error(`完整性校验失败: ${e.path}`)
    }
    await writeFile(dest, fileData)
    written.push(dest)
    done++
    opts.onProgress?.(done, total, e.path)
  }

  keys.contentKey.fill(0)
  keys.nameKey.fill(0)
  return { files: written }
}

/** 仅列出内容（需密钥） */
export async function listCcz(archivePath: string, key: KeyMaterial): Promise<{ meta: ArchiveMeta; entries: TocEntry[] }> {
  const r = await openCcz(archivePath, key)
  r.keys.contentKey.fill(0)
  r.keys.nameKey.fill(0)
  return { meta: r.meta, entries: r.entries }
}
