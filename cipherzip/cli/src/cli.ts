#!/usr/bin/env node
/**
 * CipherZip CLI —— 命令行压缩 / 解压 / P2P / 信息
 * 用法示例：
 *   cipherzip pack ./dir -o out.ccz -p '密码'
 *   cipherzip pack ./dir -o out.ccz -p '密码' -k ./music.mp3
 *   cipherzip unpack out.ccz -d ./out -p '密码'
 *   cipherzip list out.ccz -p '密码'
 *   cipherzip p2p --port 41234
 */

import { resolve, extname } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  packArchive,
  unpackArchive,
  listCcz,
  detectFormat,
  P2PNode,
  formatBytes,
  SUPPORTED_CREATE,
  SUPPORTED_OPEN,
  type KeyMaterial,
} from '@cipherzip/core'

function usage() {
  console.log(`
CipherZip 命令行工具 v1.0 —— 端到端加密压缩

用法:
  cipherzip pack   <输入...> -o <输出> [-p 密码] [-k 密钥文件] [--format ccz|zip|tar.gz]
  cipherzip unpack <归档>    -d <目录>  [-p 密码] [-k 密钥文件]
  cipherzip list   <归档.ccz> [-p 密码] [-k 密钥文件]
  cipherzip formats
  cipherzip p2p    [--port N] [--host IP] [--nick 昵称]
  cipherzip help

说明:
  · 默认格式 .ccz 强制端到端加密（AES-256-GCM + 文件名加密）
  · 密钥文件可为任意文件（音乐/图片等），读取头/中/尾指纹派生密钥
  · 分享码 / P2P 聊天与文件传输见 p2p 子命令
`)
}

function parseArgs(argv: string[]) {
  const args = argv.slice(2)
  const cmd = args[0]
  const positional: string[] = []
  const flags: Record<string, string | boolean> = {}
  for (let i = 1; i < args.length; i++) {
    const a = args[i]
    if (a === '-o' || a === '--output') flags.output = args[++i]
    else if (a === '-d' || a === '--dir') flags.dir = args[++i]
    else if (a === '-p' || a === '--password') flags.password = args[++i]
    else if (a === '-k' || a === '--keyfile') flags.keyfile = args[++i]
    else if (a === '--format') flags.format = args[++i]
    else if (a === '--port') flags.port = args[++i]
    else if (a === '--host') flags.host = args[++i]
    else if (a === '--nick') flags.nick = args[++i]
    else if (a.startsWith('-')) flags[a.replace(/^--?/, '')] = true
    else positional.push(a)
  }
  return { cmd, positional, flags }
}

function keyFromFlags(flags: Record<string, string | boolean>): KeyMaterial | undefined {
  const p = flags.password as string | undefined
  const k = flags.keyfile as string | undefined
  if (p && k) return { type: 'hybrid', password: p, keyfilePath: resolve(k) }
  if (k) return { type: 'keyfile', path: resolve(k) }
  if (p) return { type: 'password', password: p }
  return undefined
}

async function main() {
  const { cmd, positional, flags } = parseArgs(process.argv)
  if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help') {
    usage()
    return
  }

  if (cmd === 'formats') {
    console.log('可创建:', SUPPORTED_CREATE.join(', '))
    console.log('可打开:', SUPPORTED_OPEN.join(', '))
    return
  }

  if (cmd === 'pack') {
    if (!positional.length || !flags.output) {
      console.error('需要输入路径与 -o 输出')
      process.exit(2)
    }
    const output = resolve(String(flags.output))
    const key = keyFromFlags(flags)
    const out = await packArchive({
      inputs: positional.map((p) => resolve(p)),
      output,
      format: (flags.format as string) as never || detectFormat(output),
      password: flags.password as string | undefined,
      keyfilePath: flags.keyfile ? resolve(String(flags.keyfile)) : undefined,
      key,
      onProgress: (d, t, f) => {
        process.stdout.write(`\r压缩中 ${Math.floor((d / t) * 100)}% ${f || ''}/   `)
      },
    })
    console.log(`\n✓ 已创建: ${out}`)
    return
  }

  if (cmd === 'unpack') {
    if (!positional[0] || !flags.dir) {
      console.error('需要归档路径与 -d 输出目录')
      process.exit(2)
    }
    const files = await unpackArchive({
      archive: resolve(positional[0]),
      outputDir: resolve(String(flags.dir)),
      password: flags.password as string | undefined,
      keyfilePath: flags.keyfile ? resolve(String(flags.keyfile)) : undefined,
      key: keyFromFlags(flags),
      onProgress: (d, t, f) => {
        process.stdout.write(`\r解压中 ${Math.floor((d / t) * 100)}% ${f || ''}/   `)
      },
    })
    console.log(`\n✓ 已解压 ${files.length} 个路径 → ${flags.dir}`)
    return
  }

  if (cmd === 'list') {
    if (!positional[0]) {
      console.error('需要 .ccz 路径')
      process.exit(2)
    }
    const key = keyFromFlags(flags)
    if (!key) {
      console.error('.ccz 列表需要 -p 或 -k')
      process.exit(2)
    }
    const { meta, entries } = await listCcz(resolve(positional[0]), key)
    console.log(`版本 ${meta.version}  压缩 ${meta.compress}  标志 ${meta.flags}`)
    console.log(`创建于 ${new Date(meta.createdAt).toLocaleString()}`)
    if (meta.comment) console.log(`注释: ${meta.comment}`)
    console.log('─'.repeat(60))
    for (const e of entries) {
      const mark = e.isDir ? 'DIR ' : 'FILE'
      console.log(`${mark}  ${formatBytes(e.size).padStart(10)}  ${e.path}`)
    }
    return
  }

  if (cmd === 'p2p') {
    const node = new P2PNode({
      nick: (flags.nick as string) || undefined,
      events: {
        onLog: (m) => console.log('[p2p]', m),
        onChat: (peer, text) => console.log(`[${peer.nick}] ${text}`),
        onFileReceived: (peer, path) => console.log(`[文件] 来自 ${peer.nick}: ${path}`),
        onPeer: (peer, joined) => console.log(joined ? `+ ${peer.nick}` : `- ${peer.nick}`),
      },
    })
    const port = flags.port ? Number(flags.port) : 0
    const listen = await node.start(port)
    const host = (flags.host as string) || '127.0.0.1'
    const share = node.makeShare(host)
    console.log(`P2P 已启动 端口=${listen}`)
    console.log(`分享码: ${share.code}`)
    console.log(`二维码JSON长度: ${share.qr.length}`)
    console.log('按 Ctrl+C 退出。stdin 输入 "chat <文字>" 或 "connect <分享码>"')

    const readline = await import('node:readline')
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    let currentPeer: import('@cipherzip/core').P2PPeer | null = null
    rl.on('line', async (line) => {
      const t = line.trim()
      if (t.startsWith('connect ')) {
        try {
          currentPeer = await node.connectShare(t.slice(8).trim())
          console.log('已连接', currentPeer.nick)
        } catch (e) {
          console.error('连接失败', e)
        }
      } else if (t.startsWith('chat ') && currentPeer) {
        node.sendChat(currentPeer, t.slice(5))
      } else if (t === 'share') {
        console.log(node.makeShare(host).code)
      } else if (t === 'peers') {
        console.log(node.listPeers())
      }
    })
    return
  }

  console.error('未知命令:', cmd)
  usage()
  process.exit(1)
}

// 直接运行
const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isMain || process.argv[1]?.endsWith('cli.ts') || process.argv[1]?.endsWith('cli.js')) {
  main().catch((e) => {
    console.error('错误:', e instanceof Error ? e.message : e)
    process.exit(1)
  })
}

export { main }
