// v1.7.1 构建后整理：把静态资源与 Prisma 客户端拷进 standalone 的实际目录。
// 背景：Next standalone 的输出目录会因「父目录存在锁文件（monorepo 根推断）」而嵌套
// （如 .next/standalone/workspace/v17/server.js），固定路径的 cp 链会拷错位置。
// 本脚本自动定位 server.js 所在目录，兼容嵌套与非嵌套两种布局。
import { cpSync, existsSync, mkdirSync } from 'fs'
import { readdirSync } from 'fs'
import { join } from 'path'

function findStandaloneDir(dir: string, depth = 0): string | null {
  if (depth > 4) return null
  if (existsSync(join(dir, 'server.js'))) return dir
  let entries: string[] = []
  try {
    entries = readdirSync(dir, { withFileTypes: true }).map((e) => e.name)
  } catch {
    return null
  }
  for (const name of entries) {
    const found = findStandaloneDir(join(dir, name), depth + 1)
    if (found) return found
  }
  return null
}

const root = process.cwd()
const base = join(root, '.next', 'standalone')
const target = findStandaloneDir(base)

if (!target) {
  console.error('[postbuild] 未找到 .next/standalone/**/server.js，请确认 next build 成功')
  process.exit(1)
}

const rel = target.slice(root.length + 1)
console.log(`[postbuild] standalone 目录: ${rel}`)

// 1) 静态资源（前端可跑的前提）
const staticSrc = join(root, '.next', 'static')
if (existsSync(staticSrc)) {
  mkdirSync(join(target, '.next'), { recursive: true })
  cpSync(staticSrc, join(target, '.next', 'static'), { recursive: true })
  console.log('[postbuild] 已拷贝 .next/static')
}

// 2) public（PWA/图标）
if (existsSync(join(root, 'public'))) {
  cpSync(join(root, 'public'), join(target, 'public'), { recursive: true })
  console.log('[postbuild] 已拷贝 public')
}

// 3) Prisma 客户端（引擎二进制在 node_modules/.prisma）
for (const pkg of ['.prisma', '@prisma']) {
  const src = join(root, 'node_modules', pkg)
  if (existsSync(src)) {
    mkdirSync(join(target, 'node_modules'), { recursive: true })
    cpSync(src, join(target, 'node_modules', pkg), { recursive: true })
    console.log(`[postbuild] 已拷贝 node_modules/${pkg}`)
  }
}

console.log('[postbuild] 完成')
