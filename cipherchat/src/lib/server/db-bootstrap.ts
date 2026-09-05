// v1.7.1 数据库自举（治本）：
// 解决「全新环境（如一键部署平台）未注入 DATABASE_URL / 未执行 prisma db push」时，
// relay 与 web 任一进程首查即抛错 → chat:join 失败 → 客户端「已连接 · 0 台设备在线 · 发送失败」的问题。
//
// 两步自举：
//   1) resolveDatabaseUrl()  —— DATABASE_URL 缺省时推导绝对路径默认值（web 与 relay 必然同一文件）
//   2) ensureSchema()        —— 关键表缺失时自动执行 prisma db push（单飞幂等，进程内只跑一次）
//
// 安全约定：本文件只操作数据库文件与 schema，不接触任何密文/令牌，日志不输出敏感信息。
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { execFile } from 'child_process'

// ---------------- 项目根定位 ----------------
// 不能依赖 process.cwd()：Next standalone 的 server.js 启动即 process.chdir(__dirname)，
// 且 standalone 目录内含 prisma/schema.prisma 副本 —— 从 CWD 向上找会定位到 .next/standalone
// 而非真实项目根（relay 的 CWD 是项目根）→ web/relay 两进程解析出不同的项目根。
// v1.8.1 修复：优先使用 start-all 启动器注入的 CIPHERCHAT_ROOT 绝对路径锚点（两进程共享同一根），
// 其次按「CWD 向上找 prisma/schema.prisma」推断（systemd WorkingDirectory=项目根 等场景仍正确）。
let cachedRoot: string | null = null

export function getProjectRoot(): string {
  if (cachedRoot) return cachedRoot
  // v1.8.1：启动器显式注入的根优先（start-all 同时拉起 web 与 relay，二者必然一致）
  const injected = process.env.CIPHERCHAT_ROOT?.trim()
  if (injected && injected.startsWith('/')) {
    cachedRoot = injected
    return cachedRoot
  }
  let dir = process.cwd()
  for (let depth = 0; depth < 6; depth++) {
    if (existsSync(join(dir, 'prisma', 'schema.prisma'))) {
      cachedRoot = dir
      return dir
    }
    const parent = dirname(dir)
    if (parent === dir) break // 到达文件系统根
    dir = parent
  }
  cachedRoot = process.cwd() // 兜底：找不到 schema 时维持原行为
  return cachedRoot
}

// ---------------- DATABASE_URL 缺省推导 ----------------
// 必须在 new PrismaClient() 之前调用（Prisma 在构造时读取环境变量）。
// 解析优先级：
//   1) 环境变量 DATABASE_URL（平台注入/运维设置）
//   2) 标记文件 <项目根>/.cipherchat-db（web 进程把自己的解析结果写在此处，
//      供环境变量不一致时拉起的 relay 读取 —— 防止 web/relay 两进程各指一个库的脑裂）
//   3) 绝对路径缺省 <项目根>/prisma/dev.db
export function resolveDatabaseUrl(): string {
  const existing = process.env.DATABASE_URL?.trim()
  if (existing) {
    writeDbMarker(existing)
    return existing
  }
  const marked = readDbMarker()
  if (marked) {
    process.env.DATABASE_URL = marked
    return marked
  }
  const url = 'file:' + join(getProjectRoot(), 'prisma', 'dev.db')
  process.env.DATABASE_URL = url
  return url
}

const DB_MARKER = '.cipherchat-db'

function writeDbMarker(url: string) {
  try {
    const p = join(getProjectRoot(), DB_MARKER)
    // 已一致则不重写（减少磁盘写）
    if (existsSync(p) && readFileSync(p, 'utf-8').trim() === url) return
    writeFileSync(p, url + '\n')
  } catch { /* 只读环境忽略 */ }
}

function readDbMarker(): string | null {
  try {
    const p = join(getProjectRoot(), DB_MARKER)
    if (!existsSync(p)) return null
    const url = readFileSync(p, 'utf-8').trim()
    return url ? url : null
  } catch {
    return null
  }
}

// ---------------- schema 自举 ----------------
// 判定用关键表（覆盖聊天/会话/管理员三条主线；v1.6+ 还应有 ChatReaction、ChatPollVote 等，
// db push 一次性按 schema 全量建立，无需逐表检查）
const CANARY_TABLES = ['ChatMessage', 'ChatSession', 'AdminConfig'] as const

let schemaPromise: Promise<void> | null = null

export function ensureSchema(): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = runEnsure().catch((e) => {
      schemaPromise = null // 失败允许下次重试
      throw e
    })
  }
  return schemaPromise
}

async function hasCanaryTables(): Promise<boolean> {
  // 延迟 import 避免与 db.ts 形成模块环
  const { db } = await import('../db')
  const rows = await db.$queryRawUnsafe<{ name: string }[]>(
    `SELECT name FROM sqlite_master WHERE type='table' AND name IN (${CANARY_TABLES.map((t) => `'${t}'`).join(',')})`
  )
  return new Set(rows.map((r) => r.name)).size >= CANARY_TABLES.length
}

async function runEnsure(): Promise<void> {
  resolveDatabaseUrl()
  if (await hasCanaryTables()) return

  const root = getProjectRoot()
  const localBin = join(root, 'node_modules', '.bin', 'prisma')
  const cmd = existsSync(localBin) ? localBin : 'prisma'
  const args = ['db', 'push', '--skip-generate', '--accept-data-loss']
  console.log(`[db-bootstrap] 检测到数据库缺少数据表，执行自动初始化: prisma db push`)

  await new Promise<void>((resolve, reject) => {
    execFile(
      process.execPath.includes('bun') ? 'bun' : 'node',
      [cmd, ...args],
      { cwd: root, timeout: 90_000, env: { ...process.env } },
      (err, stdout, stderr) => {
        if (err) {
          // 全局/本地都没有 prisma CLI 时给出可读指引（不中断进程：仍可能只是权限问题）
          console.error('[db-bootstrap] prisma db push 失败:', (stderr || err.message || '').slice(0, 500))
          reject(new Error('schema-bootstrap-failed'))
          return
        }
        console.log('[db-bootstrap] prisma db push 完成')
        resolve()
      },
    )
  })

  if (!(await hasCanaryTables())) {
    throw new Error('schema-bootstrap-verify-failed')
  }
}

// 便捷封装：自举失败不抛出（由调用方决定是否降级），但记录原因
export async function ensureDatabase(): Promise<boolean> {
  try {
    await ensureSchema()
    return true
  } catch (e) {
    console.warn('[db-bootstrap] 数据库自举失败:', e instanceof Error ? e.message : e)
    return false
  }
}
