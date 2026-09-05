// 轻量 .env 加载器（供 ws 中继服务使用；Next.js 自身会自动加载 .env）
// 仅使用相对导入，确保 mini-services 也能直接 import 本文件。
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

export function loadEnvFile(cwd: string = process.cwd()) {
  const envPath = join(cwd, '.env')
  if (!existsSync(envPath)) return
  try {
    const text = readFileSync(envPath, 'utf-8')
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) continue
      const eq = line.indexOf('=')
      if (eq <= 0) continue
      const key = line.slice(0, eq).trim()
      const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
      if (!(key in process.env)) process.env[key] = value
    }
  } catch {
    // ignore
  }
}
