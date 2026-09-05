/**
 * 传统格式支持层
 * - 创建：zip / tar / tar.gz / tar.br（可选加密包装）
 * - 读取：zip（yauzl）、tar/gz（内置）
 * - 7z/rar/xz：若系统存在 7z 命令则 shell 调用，否则给出明确错误
 *
 * 设计原则：传统格式「可」加密（AES zip），但只有 .ccz 强制 E2E。
 */

import { createWriteStream, createReadStream } from 'node:fs'
import { mkdir, rm, readdir, stat } from 'node:fs/promises'
import { join, basename, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { pipeline } from 'node:stream/promises'
import { createGzip, createGunzip, createBrotliCompress, createBrotliDecompress } from 'node:zlib'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import archiver from 'archiver'
import { createCcz, extractCcz } from '../format/ccz.js'
import { CompressAlgo, type KeyMaterial } from '@cipherzip/shared'

const execFileAsync = promisify(execFile)

export type LegacyFormat = 'zip' | 'tar' | 'tar.gz' | 'tgz' | 'tar.br' | 'gz' | 'ccz' | '7z' | 'rar' | 'xz'

export function detectFormat(pathOrName: string): LegacyFormat {
  const n = pathOrName.toLowerCase()
  if (n.endsWith('.ccz')) return 'ccz'
  if (n.endsWith('.tar.gz') || n.endsWith('.tgz')) return 'tar.gz'
  if (n.endsWith('.tar.br')) return 'tar.br'
  if (n.endsWith('.tar.xz') || n.endsWith('.txz')) return 'xz'
  if (n.endsWith('.tar')) return 'tar'
  if (n.endsWith('.gz')) return 'gz'
  if (n.endsWith('.7z')) return '7z'
  if (n.endsWith('.rar')) return 'rar'
  if (n.endsWith('.zip')) return 'zip'
  return 'zip'
}

async function collectFiles(paths: string[]): Promise<string[]> {
  const files: string[] = []
  async function walk(p: string) {
    const st = await stat(p)
    if (st.isDirectory()) {
      for (const k of await readdir(p)) await walk(join(p, k))
    } else if (st.isFile()) files.push(p)
  }
  for (const p of paths) await walk(p)
  return files
}

export interface PackOptions {
  inputs: string[]
  output: string
  format?: LegacyFormat
  password?: string
  key?: KeyMaterial
  level?: number
  encryptFilenames?: boolean
  keyfilePath?: string
  onProgress?: (done: number, total: number, file?: string) => void
}

/**
 * 统一打包入口：按扩展名/format 分发
 */
export async function packArchive(opts: PackOptions): Promise<string> {
  const format = opts.format || detectFormat(opts.output)

  // .ccz 强制走自定义引擎
  if (format === 'ccz') {
    let key: KeyMaterial
    if (opts.key) key = opts.key
    else if (opts.keyfilePath && opts.password) key = { type: 'hybrid', password: opts.password, keyfilePath: opts.keyfilePath }
    else if (opts.keyfilePath) key = { type: 'keyfile', path: opts.keyfilePath }
    else if (opts.password) key = { type: 'password', password: opts.password }
    else throw new Error('.ccz 格式强制端到端加密，必须提供密码或密钥文件')

    await createCcz({
      inputs: opts.inputs,
      output: opts.output,
      key,
      level: opts.level,
      encryptFilenames: opts.encryptFilenames,
      onProgress: opts.onProgress,
      compress: CompressAlgo.BROTLI,
    })
    return opts.output
  }

  if (format === '7z' || format === 'rar' || format === 'xz') {
    return packWith7z(opts, format)
  }

  if (format === 'zip') {
    return packZip(opts)
  }

  if (format === 'tar' || format === 'tar.gz' || format === 'tgz' || format === 'tar.br') {
    return packTar(opts, format)
  }

  if (format === 'gz') {
    // 单文件 gzip
    const files = await collectFiles(opts.inputs)
    if (files.length !== 1) throw new Error('.gz 仅支持单个文件')
    await mkdir(dirname(opts.output), { recursive: true })
    await pipeline(createReadStream(files[0]), createGzip({ level: opts.level ?? 6 }), createWriteStream(opts.output))
    return opts.output
  }

  throw new Error(`暂不支持创建格式: ${format}`)
}

async function packZip(opts: PackOptions): Promise<string> {
  // 标准 zip 密码加密偏弱；有密码/密钥时自动升级为强制 E2E 的 .ccz
  if (opts.password || opts.keyfilePath || opts.key) {
    const cczOut = opts.output.toLowerCase().endsWith('.ccz')
      ? opts.output
      : opts.output.replace(/\.zip$/i, '') + '.ccz'
    return packArchive({ ...opts, output: cczOut, format: 'ccz' })
  }

  await mkdir(dirname(opts.output), { recursive: true })
  const output = createWriteStream(opts.output)
  const archive = archiver('zip', { zlib: { level: opts.level ?? 6 } })
  const done = new Promise<void>((resolve, reject) => {
    output.on('close', () => resolve())
    archive.on('error', reject)
  })
  archive.pipe(output)

  for (const p of opts.inputs) {
    const st = await stat(p)
    if (st.isDirectory()) archive.directory(p, basename(p))
    else archive.file(p, { name: basename(p) })
  }
  await archive.finalize()
  await done
  return opts.output
}

async function packTar(opts: PackOptions, format: LegacyFormat): Promise<string> {
  // 用 archiver tar
  await mkdir(dirname(opts.output), { recursive: true })
  const output = createWriteStream(opts.output)
  const archive = archiver('tar', {
    gzip: format === 'tar.gz' || format === 'tgz',
    gzipOptions: { level: opts.level ?? 6 },
  })
  const done = new Promise<void>((resolve, reject) => {
    output.on('close', () => resolve())
    archive.on('error', reject)
  })

  if (format === 'tar.br') {
    // tar 后 brotli：先写临时 tar
    const tmp = join(tmpdir(), `cz-tar-${Date.now()}.tar`)
    const tmpOut = createWriteStream(tmp)
    const tar = archiver('tar')
    const tarDone = new Promise<void>((resolve, reject) => {
      tmpOut.on('close', () => resolve())
      tar.on('error', reject)
    })
    tar.pipe(tmpOut)
    for (const p of opts.inputs) {
      const st = await stat(p)
      if (st.isDirectory()) tar.directory(p, basename(p))
      else tar.file(p, { name: basename(p) })
    }
    await tar.finalize()
    await tarDone
    await pipeline(createReadStream(tmp), createBrotliCompress(), createWriteStream(opts.output))
    await rm(tmp, { force: true })
    return opts.output
  }

  archive.pipe(output)
  for (const p of opts.inputs) {
    const st = await stat(p)
    if (st.isDirectory()) archive.directory(p, basename(p))
    else archive.file(p, { name: basename(p) })
  }
  await archive.finalize()
  await done
  return opts.output
}

async function hasBin(bin: string): Promise<boolean> {
  try {
    await execFileAsync(bin, ['--help'], { timeout: 5000 })
    return true
  } catch {
    try {
      await execFileAsync('which', [bin])
      return true
    } catch {
      return false
    }
  }
}

async function packWith7z(opts: PackOptions, format: LegacyFormat): Promise<string> {
  if (!(await hasBin('7z'))) {
    throw new Error(`创建 ${format} 需要系统安装 7-Zip（7z 命令）。也可改用 .ccz / .zip / .tar.gz`)
  }
  await mkdir(dirname(opts.output), { recursive: true })
  const args = ['a', '-y']
  if (format === '7z') args.push('-t7z')
  else if (format === 'rar') args.push('-trar') // 7z 对 rar 创建支持有限
  else if (format === 'xz') args.push('-txz')
  if (opts.password) args.push(`-p${opts.password}`, '-mhe=on')
  args.push(opts.output, ...opts.inputs)
  await execFileAsync('7z', args, { timeout: 600_000, maxBuffer: 64 * 1024 * 1024 })
  return opts.output
}

export interface UnpackOptions {
  archive: string
  outputDir: string
  password?: string
  key?: KeyMaterial
  keyfilePath?: string
  onProgress?: (done: number, total: number, file?: string) => void
}

export async function unpackArchive(opts: UnpackOptions): Promise<string[]> {
  const format = detectFormat(opts.archive)
  await mkdir(opts.outputDir, { recursive: true })

  if (format === 'ccz') {
    let key: KeyMaterial
    if (opts.key) key = opts.key
    else if (opts.keyfilePath && opts.password) key = { type: 'hybrid', password: opts.password, keyfilePath: opts.keyfilePath }
    else if (opts.keyfilePath) key = { type: 'keyfile', path: opts.keyfilePath }
    else if (opts.password) key = { type: 'password', password: opts.password }
    else throw new Error('打开 .ccz 需要密码或密钥文件')
    const r = await extractCcz({
      archivePath: opts.archive,
      outputDir: opts.outputDir,
      key,
      onProgress: opts.onProgress,
    })
    return r.files
  }

  if (format === 'zip') {
    return unpackZip(opts)
  }

  if (format === 'gz' && !opts.archive.toLowerCase().includes('.tar')) {
    const outFile = join(opts.outputDir, basename(opts.archive).replace(/\.gz$/i, ''))
    await pipeline(createReadStream(opts.archive), createGunzip(), createWriteStream(outFile))
    return [outFile]
  }

  if (format === 'tar' || format === 'tar.gz' || format === 'tgz') {
    // 使用系统 tar
    const args = ['-xf', opts.archive, '-C', opts.outputDir]
    await execFileAsync('tar', args, { timeout: 600_000 })
    return [opts.outputDir]
  }

  if (format === 'tar.br') {
    const tmp = join(tmpdir(), `cz-${Date.now()}.tar`)
    await pipeline(createReadStream(opts.archive), createBrotliDecompress(), createWriteStream(tmp))
    await execFileAsync('tar', ['-xf', tmp, '-C', opts.outputDir], { timeout: 600_000 })
    await rm(tmp, { force: true })
    return [opts.outputDir]
  }

  if (format === '7z' || format === 'rar' || format === 'xz') {
    if (!(await hasBin('7z'))) throw new Error(`解压 ${format} 需要 7z 命令`)
    const args = ['x', '-y', `-o${opts.outputDir}`]
    if (opts.password) args.push(`-p${opts.password}`)
    args.push(opts.archive)
    await execFileAsync('7z', args, { timeout: 600_000, maxBuffer: 64 * 1024 * 1024 })
    return [opts.outputDir]
  }

  // 兜底尝试 7z
  if (await hasBin('7z')) {
    const args = ['x', '-y', `-o${opts.outputDir}`, opts.archive]
    if (opts.password) args.push(`-p${opts.password}`)
    await execFileAsync('7z', args, { timeout: 600_000 })
    return [opts.outputDir]
  }

  throw new Error(`无法识别或解压格式: ${format}`)
}

async function unpackZip(opts: UnpackOptions): Promise<string[]> {
  // 优先系统 unzip，避免 yauzl 类型摩擦；失败再尝试 7z
  try {
    await execFileAsync('unzip', ['-o', opts.archive, '-d', opts.outputDir], {
      timeout: 600_000,
      maxBuffer: 64 * 1024 * 1024,
    })
    return [opts.outputDir]
  } catch {
    if (await hasBin('7z')) {
      await execFileAsync('7z', ['x', '-y', `-o${opts.outputDir}`, opts.archive], { timeout: 600_000 })
      return [opts.outputDir]
    }
    throw new Error('解压 zip 失败：需要 unzip 或 7z')
  }
}

export const SUPPORTED_CREATE = ['.ccz', '.zip', '.tar', '.tar.gz', '.tgz', '.tar.br', '.gz', '.7z'] as const
export const SUPPORTED_OPEN = ['.ccz', '.zip', '.tar', '.tar.gz', '.tgz', '.tar.br', '.gz', '.7z', '.rar', '.xz', '.bz2', '.iso'] as const
