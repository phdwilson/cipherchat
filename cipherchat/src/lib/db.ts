import { PrismaClient } from '@prisma/client'
// v1.7.1：必须在 PrismaClient 构造前解析 DATABASE_URL 缺省值。
// 一键部署等全新环境可能没有 .env / 环境变量，缺省时推导出绝对路径（项目根/prisma/dev.db），
// 保证 web（CWD 可能是 .next/standalone）与 relay（CWD 是项目根）必然指向同一个 SQLite 文件。
import { resolveDatabaseUrl } from './server/db-bootstrap'

resolveDatabaseUrl()

const globalForPrisma = globalThis as unknown as {
  prisma: (PrismaClient & { __cipherchatReady?: Promise<void> }) | undefined
}

function createClient() {
  const client = new PrismaClient({
    // 注意：不要开启 query 日志，避免任何会话哈希/数据出现在日志中
    log: ['error'],
  }) as PrismaClient & { __cipherchatReady?: Promise<void> }
  // SQLite 并发优化：WAL + busy_timeout（web 与 ws 两个进程共用同一个库）
  // 注意：PRAGMA journal_mode 会返回结果集，必须用 queryRawUnsafe
  const setup = async () => {
    try {
      await client.$queryRawUnsafe('PRAGMA journal_mode=WAL;')
      await client.$queryRawUnsafe('PRAGMA busy_timeout=5000;')
      await client.$queryRawUnsafe('PRAGMA synchronous=NORMAL;')
    } catch {
      // ignore
    }
  }
  // v1.7.0：把 PRAGMA 生效 promise 挂到实例上；客户端连接前（socket.io listen、
  // Next 首个 API 命中）由调用方 await dbReady()，避免首查与 PRAGMA 竞态
  client.__cipherchatReady = setup()
  return client
}

export const db = globalForPrisma.prisma ?? createClient()

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db

// v1.7.0：等待 PRAGMA 初始化完成（幂等，任何进程启动早期调用一次即可）
export async function dbReady(): Promise<void> {
  try {
    await (db as PrismaClient & { __cipherchatReady?: Promise<void> }).__cipherchatReady
  } catch {
    /* ignore */
  }
}
