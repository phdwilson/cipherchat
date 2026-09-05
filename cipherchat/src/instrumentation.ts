// v1.7.1：Next.js 服务启动钩子（standalone/dev 通用）
// 在 web 进程启动时完成数据库自举：DATABASE_URL 缺省推导 + 缺表自动 prisma db push。
// 此前该步骤只存在于 Docker entrypoint；一键部署等环境没有 entrypoint，
// 导致 web 能建会话、relay 却查询报错（或反之），表现为「已连接 · 0 台设备在线 · 发送失败」。
export async function register() {
  // 仅在 Node/Bun 服务端运行时执行；edge 运行时直接跳过
  if (process.env.NEXT_RUNTIME && process.env.NEXT_RUNTIME !== 'nodejs') return
  try {
    const { ensureDatabase, resolveDatabaseUrl } = await import('./lib/server/db-bootstrap')
    resolveDatabaseUrl()
    const ok = await ensureDatabase()
    if (!ok) {
      console.warn('[instrumentation] 数据库自举失败，请检查磁盘权限或手动执行 prisma db push')
    }
  } catch (e) {
    console.warn('[instrumentation] 数据库自举异常:', e instanceof Error ? e.message : e)
  }
}
