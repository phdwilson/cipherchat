// 管理员后台服务端扩展：HTTPS 证书状态探测 / 域名绑定 / 维护操作
// 全部仅超级密钥可用；日志不输出任何密钥
import { exec } from 'child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync } from 'fs'
import { join, resolve, basename } from 'path'
import { db } from '../db'
import { getProjectRoot } from './db-bootstrap'

function appDir(): string {
  // v1.8.1：与数据目录同源（项目根）—— 备份 tar 的 -C 上下文必须包含真实 data/，
  // standalone 模式下 process.cwd() 是 .next/standalone，不能作为基准
  return getProjectRoot()
}

export interface HttpsMeta {
  domain: string
  mode: 'self-signed' | 'acme-dns' | 'acme-http01' | 'custom' | 'none'
  configuredAt: string
  gatewayPort?: number
}

export function readHttpsMeta(): HttpsMeta | null {
  try {
    const p = join(appDir(), 'https-meta.json')
    if (!existsSync(p)) return null
    return JSON.parse(readFileSync(p, 'utf-8')) as HttpsMeta
  } catch {
    return null
  }
}

export function writeHttpsMeta(meta: HttpsMeta) {
  writeFileSync(join(appDir(), 'https-meta.json'), JSON.stringify(meta, null, 2))
}

export function readHttpsPending(): { domain: string; mode: string; requestedAt: string; requestedBy?: string } | null {
  try {
    const p = join(appDir(), 'https-pending.json')
    if (!existsSync(p)) return null
    return JSON.parse(readFileSync(p, 'utf-8'))
  } catch {
    return null
  }
}

export function writeHttpsPending(domain: string, mode: string) {
  writeFileSync(
    join(appDir(), 'https-pending.json'),
    JSON.stringify({ domain, mode, requestedAt: new Date().toISOString() }, null, 2)
  )
}

export function clearHttpsPending() {
  try {
    rmSync(join(appDir(), 'https-pending.json'))
  } catch { /* ignore */ }
}

function run(cmd: string, timeoutMs = 8000): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolvePromise) => {
    exec(cmd, { timeout: timeoutMs }, (err, stdout, stderr) => {
      const out = `${stdout || ''}${stderr || ''}`.trim()
      resolvePromise({ ok: !err, out })
    })
  })
}

export interface CertProbe {
  available: boolean
  subject?: string
  issuer?: string
  notAfter?: string
  daysLeft?: number
  error?: string
}

// 实时 TLS 探测：openssl s_client 直连本机网关，读回当前生效证书
export async function probeCert(domain: string, port: number): Promise<CertProbe> {
  const sni = domain && /^[\p{L}\p{N}.-]+$/u.test(domain) ? domain : '127.0.0.1'
  const r = await run(
    `echo | openssl s_client -connect 127.0.0.1:${port} -servername ${sni} 2>/dev/null | openssl x509 -noout -subject -issuer -enddate 2>/dev/null`
  )
  if (!r.ok || !r.out.includes('notAfter')) {
    return { available: false, error: 'TLS 握手失败（网关可能仍在 HTTP 模式或未监听）' }
  }
  const subject = r.out.match(/subject=(.*)/)?.[1]?.trim()
  const issuer = r.out.match(/issuer=(.*)/)?.[1]?.trim()
  const notAfterRaw = r.out.match(/notAfter=(.*)/)?.[1]?.trim()
  const notAfterDate = notAfterRaw ? new Date(notAfterRaw) : null
  const daysLeft = notAfterDate ? Math.floor((notAfterDate.getTime() - Date.now()) / 86400_000) : undefined
  return {
    available: true,
    subject,
    issuer,
    notAfter: notAfterDate ? notAfterDate.toISOString() : undefined,
    daysLeft,
  }
}

// 维护操作
export async function maintenanceAction(action: string): Promise<{ ok: boolean; message: string; detail?: Record<string, unknown> }> {
  switch (action) {
    case 'cleanup-sessions': {
      const now = new Date()
      const a = await db.chatSession.deleteMany({ where: { expiresAt: { lt: now } } })
      const b = await db.driveSession.deleteMany({ where: { expiresAt: { lt: now } } })
      return { ok: true, message: `已清理 ${a.count + b.count} 个过期会话`, detail: { chat: a.count, drive: b.count } }
    }
    case 'revoke-sessions': {
      const a = await db.chatSession.deleteMany({})
      const b = await db.driveSession.deleteMany({})
      return { ok: true, message: `已吊销全部 ${a.count + b.count} 个会话（在线设备将在下次操作时被要求重新验证）`, detail: { chat: a.count, drive: b.count } }
    }
    case 'backup': {
      const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
      const backupDir = join(appDir(), 'backups')
      if (!existsSync(backupDir)) mkdirSync(backupDir, { recursive: true })
      const target = join(backupDir, `cipherchat-backup-${stamp}.tar.gz`)
      // v1.8.1 修复：旧命令固定打包 <根>/db —— 默认布局的库在 prisma/dev.db，
      // 平台注入 DATABASE_URL 时库可能在项目根之外（如 /home/z/my-project/db/custom.db），
      // 两种情况都会静默丢库（tar 对不存在的路径只报 2>/dev/null 吞掉的错）。
      // 现按实际解析出的库文件逐项存在才打包，多段 -C 兼容库在根内/根外两种布局。
      const root = appDir()
      const dbUrl = (process.env.DATABASE_URL || '').replace(/^file:/, '')
      // SQLite URL 相对路径以 prisma schema 目录为基准（Prisma 约定）
      const dbFile = dbUrl.startsWith('/') ? dbUrl : resolve(root, 'prisma', dbUrl || 'dev.db')
      const dbDir = resolve(dbFile, '..')
      const dbStems = [basename(dbFile), basename(dbFile) + '-wal', basename(dbFile) + '-shm']
        .filter((f) => existsSync(join(dbDir, f)))
      const rootItems = ['data', '.env', 'https-meta.json', 'prisma']
        .map((f) => (existsSync(join(root, f)) ? f : null))
        .filter((x): x is string => x !== null)
      let cmd = `tar -czf ${JSON.stringify(target)}`
      if (rootItems.length > 0) cmd += ` -C ${JSON.stringify(root)} ${rootItems.map((f) => JSON.stringify(f)).join(' ')}`
      if (dbStems.length > 0 && dbDir !== root) cmd += ` -C ${JSON.stringify(dbDir)} ${dbStems.map((f) => JSON.stringify(f)).join(' ')}`
      const r = await run(cmd + ' 2>/dev/null')
      if (!r.ok && !existsSync(target)) {
        return { ok: false, message: '备份失败（详见服务日志）' }
      }
      if (!existsSync(target)) {
        return { ok: false, message: '备份失败：没有任何可打包的内容（数据库与数据目录均不存在）' }
      }
      return { ok: true, message: `备份完成：${resolve(target)}`, detail: { file: target, db: dbFile } }
    }
    // ============== v1.8.0 新增：一键修复动作（自检系统配套） ==============
    case 'recalc-drive-usage': {
      // 以磁盘真实密文大小为唯一事实来源，重写全部存储统计
      // 修复场景：v1.7.0 及之前「150MB 文件统计成 4MB」的历史坏数据
      const { dirSizeBytesAsync } = await import('./filestore')
      const repos = await db.driveRepo.findMany()
      const files = await db.driveFile.findMany({})
      const filesByRepo = new Map<string, typeof files>()
      for (const f of files) {
        const list = filesByRepo.get(f.repoId) || []
        list.push(f)
        filesByRepo.set(f.repoId, list)
      }
      let fixedFiles = 0
      let fixedRepos = 0
      let removedPhantoms = 0
      let driftAbs = 0
      // 第一遍：逐文件重算 + 清理幽灵行（ready 但磁盘目录为空 —— 反正已无法下载）
      for (const f of files) {
        const real = await dirSizeBytesAsync('drive', f.id)
        if (f.ready && real === 0) {
          await db.driveFile.deleteMany({ where: { id: f.id, ready: true } }).catch(() => {})
          removedPhantoms++
          continue
        }
        if (f.totalBytes !== BigInt(real)) {
          driftAbs += Math.abs(Number(f.totalBytes) - real)
          await db.driveFile.update({ where: { id: f.id }, data: { totalBytes: BigInt(real) } }).catch(() => {})
          fixedFiles++
        }
      }
      // 第二遍：按仓库重建 usedBytes（幽灵行已删，不参与求和）
      for (const repo of repos) {
        const list = filesByRepo.get(repo.id) || []
        let sum = 0
        for (const f of list) {
          if (!f.ready) continue
          const real = await dirSizeBytesAsync('drive', f.id)
          if (real === 0) continue // 幽灵行已删，跳过
          sum += real
        }
        if (repo.usedBytes !== BigInt(sum)) {
          await db.driveRepo.update({ where: { id: repo.id }, data: { usedBytes: BigInt(sum) } }).catch(() => {})
          fixedRepos++
        }
      }
      return {
        ok: true,
        message: `重算完成：修正 ${fixedFiles} 个文件、${fixedRepos} 个仓库的占用统计（纠正偏差 ${driftAbs} 字节${removedPhantoms ? `；清理 ${removedPhantoms} 个磁盘已丢失的幽灵文件记录（文件本体需从备份恢复）` : ''}）`,
        detail: { fixedFiles, fixedRepos, removedPhantoms, driftBytes: driftAbs, totalFiles: files.length, totalRepos: repos.length },
      }
    }
    case 'cleanup-orphan-files': {
      // 孤儿 = 磁盘目录存在但数据库无记录（上传中断/历史遗留）→ 删目录
      // 过期上传 = ready=false 超 24h → 删行删目录
      const { deleteFileDir } = await import('./filestore')
      const dataRoot = resolve(appDir(), 'data')
      let orphanDirs = 0
      let staleRows = 0
      for (const ns of ['chat', 'drive'] as const) {
        const root = join(dataRoot, ns)
        if (!existsSync(root)) continue
        const dirs = readdirSync(root)
        const rows = ns === 'chat'
          ? await db.chatFile.findMany({ select: { id: true } })
          : await db.driveFile.findMany({ select: { id: true } })
        const ids = new Set(rows.map((r) => r.id))
        for (const d of dirs) {
          if (!ids.has(d)) {
            deleteFileDir(ns, d)
            orphanDirs++
          }
        }
        // 过期上传（超过 24h 仍未完结的）
        if (ns === 'chat') {
          const stale = await db.chatFile.findMany({ where: { ready: false, createdAt: { lt: new Date(Date.now() - 86400_000) } }, select: { id: true } })
          for (const s of stale) { deleteFileDir('chat', s.id); staleRows++ }
          await db.chatFile.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } }).catch(() => {})
        } else {
          const stale = await db.driveFile.findMany({ where: { ready: false, createdAt: { lt: new Date(Date.now() - 86400_000) } }, select: { id: true } })
          for (const s of stale) { deleteFileDir('drive', s.id); staleRows++ }
          await db.driveFile.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } }).catch(() => {})
        }
      }
      return {
        ok: true,
        message: `清理完成：删除 ${orphanDirs} 个孤儿目录、${staleRows} 条过期上传记录`,
        detail: { orphanDirs, staleRows },
      }
    }
    case 'vacuum-db': {
      // WAL 落盘 + 压缩数据库文件（安全操作，可在运行中执行）
      try {
        await db.$queryRawUnsafe('PRAGMA wal_checkpoint(TRUNCATE);')
        await db.$queryRawUnsafe('VACUUM;')
        return { ok: true, message: '数据库已整理：WAL 已合并、空间已回收' }
      } catch (e) {
        return { ok: false, message: `数据库整理失败：${e instanceof Error ? e.message : String(e)}（若提示锁定，请稍后重试）` }
      }
    }
    default:
      return { ok: false, message: '未知操作' }
  }
}

// 网盘仓库列表（仅元信息，文件名均不可见）
export async function listDriveRepos() {
  const repos = await db.driveRepo.findMany({ orderBy: { createdAt: 'desc' }, take: 100 })
  return repos.map((r) => ({
    driveId: r.driveId,
    usedBytes: Number(r.usedBytes),
    quotaBytes: Number(r.quotaBytes),
    createdAt: r.createdAt.toISOString(),
    lastActiveAt: r.lastActiveAt.toISOString(),
  }))
}
