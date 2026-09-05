// v1.7.1 单命令启动器：同时拉起 WebSocket 中继与 Next.js standalone web。
// 背景：chat.z.ai 一键部署等平台只会执行 package.json 的 start 脚本，
// 此前 start 仅启动 web，relay 需要手工拉起——漏拉即「已连接 · 0 台设备在线 · 发送失败」。
// 行为：任一子进程退出 → 杀掉另一个并以其退出码退出（容器/平台托管语义）。
import { spawn, type ChildProcess } from 'child_process'
import { existsSync, readdirSync } from 'fs'
import { join } from 'path'
// v1.7.1：在拉起子进程前统一裁决 DATABASE_URL（环境变量 → 标记文件 → 绝对路径缺省），
// 并把裁决结果写回自身环境 —— 两个子进程必然指向同一个 SQLite 文件，杜绝脑裂
import { resolveDatabaseUrl, ensureDatabase } from '../src/lib/server/db-bootstrap'

resolveDatabaseUrl()

// v1.8.1：注入项目根锚点。web（standalone server.js 启动即 chdir 到 .next/standalone，且该目录
// 内含 prisma 副本）与 relay（CWD=项目根）对「项目根」的推断会分叉 → DATA_DIR/标记文件等
// 相对路径解析脑裂。显式注入后两进程共享同一根（按脚本自身位置推导，不依赖调用方 CWD）。
const ROOT = join(import.meta.dir, '..')
process.env.CIPHERCHAT_ROOT = ROOT

const kids: ChildProcess[] = []
let shuttingDown = false

function forward(child: ChildProcess, tag: string) {
  if (!child.stdout || !child.stderr) return
  child.stdout.on('data', (d: Buffer) => process.stdout.write(`[relay] ${d}`))
  child.stderr.on('data', (d: Buffer) => process.stderr.write(`[relay] ${d}`))
  void tag
}

function shutdown(code: number) {
  if (shuttingDown) return
  shuttingDown = true
  for (const k of kids) {
    try { k.kill('SIGTERM') } catch { /* ignore */ }
  }
  // 兜底 3s 强杀
  setTimeout(() => process.exit(code), 3000).unref()
  process.exitCode = code
}

function start(cmd: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn(cmd, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  kids.push(child)
  child.on('exit', (code, signal) => {
    console.error(`[start-all] 子进程退出 (${cmd} ${args.join(' ')}) code=${code} signal=${signal}`)
    shutdown(code ?? 1)
  })
  return child
}

const wsPort = process.env.WS_PORT || '3003'
const webPort = process.env.PORT || '3000'

// 数据库就绪检查（幂等；缺表时自动 prisma db push，失败不阻塞 —— 子进程内还有二道兑底）
void ensureDatabase().then((ok) => {
  console.log(`[start-all] database ready=${ok} -> ${String(process.env.DATABASE_URL || '').replace(/^file:/, '')}`)
})

// 1) WebSocket 中继（内含数据库自举）
const relay = start(process.execPath, ['mini-services/relay/index.ts'], { WS_PORT: wsPort })
// 中继日志不打 tag（其自带 [relay] 前缀），直接透传
relay.stdout?.on('data', (d: Buffer) => process.stdout.write(d))
relay.stderr?.on('data', (d: Buffer) => process.stderr.write(d))

// 2) Next.js standalone web（自动定位 server.js：兼容 monorepo 根推断导致的嵌套输出）
import { existsSync } from 'fs'
import { join } from 'path'
function findWebServer(): string {
  const direct = '.next/standalone/server.js'
  if (existsSync(direct)) return direct
  // 嵌套布局：.next/standalone/<...>/server.js，最多向下 4 层
  const queue = ['.next/standalone']
  while (queue.length) {
    const dir = queue.shift()!
    let names: string[] = []
    try { names = readdirSync(dir) } catch { continue }
    if (names.includes('server.js')) return join(dir, 'server.js')
    for (const n of names) queue.push(join(dir, n))
  }
  return direct // 找不到时按原路径报错，信息最直观
}
const webEntry = findWebServer()
const web = start(process.execPath, [webEntry], {
  NODE_ENV: 'production',
  PORT: webPort,
  HOSTNAME: process.env.HOSTNAME || '0.0.0.0',
})
web.stdout?.on('data', (d: Buffer) => process.stdout.write(d))
web.stderr?.on('data', (d: Buffer) => process.stderr.write(d))

console.log(`[start-all] relay=:${wsPort} web=:${webPort}（Ctrl/Cmd+C 或 SIGTERM 一起退出）`)

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => shutdown(0))
}
void forward
