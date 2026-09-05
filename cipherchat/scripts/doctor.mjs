#!/usr/bin/env bun
// v1.8.0 CipherChat 服务器医生（CLI 版一键自检 + 一键修复）
// 与管理后台「自检」页共用同一套服务端引擎 —— 这里只是另一个入口。
//
// 常用法：
//   bun scripts/doctor.mjs --key 你的超级密钥              # 全量自检（12 项真实世界测试）
//   bun scripts/doctor.mjs --key 你的超级密钥 --fix-all    # 自检 + 自动修复全部可修复项
//   bun scripts/doctor.mjs --key 你的超级密钥 --recalc     # 直接重算网盘占用（修复历史统计错误）
//   bun scripts/doctor.mjs --key 你的超级密钥 --cleanup    # 直接清理孤儿文件
//   bun scripts/doctor.mjs --key 你的超级密钥 --json       # 输出 JSON（供脚本消费）
//   URL 默认 http://127.0.0.1:3000，可用 --url 覆盖
//
// 说明：--key 传「超级密钥原文」，脚本用与网页端完全相同的 PBKDF2 参数派生哈希后调用 API，
// 原文不落任何日志。也可以直接传 64 位十六进制哈希（以 --hash 开头）跳过派生。
const args = process.argv.slice(2)
const getOpt = (name) => {
  const i = args.indexOf('--' + name)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null
}
const hasFlag = (name) => args.includes('--' + name)

const BASE = (getOpt('url') || process.env.BASE || 'http://127.0.0.1:3000').replace(/\/$/, '')
const RAW_KEY = getOpt('key')
const HASH_DIRECT = getOpt('hash')
const JSON_MODE = hasFlag('json')
const FIX_ALL = hasFlag('fix-all')
const YES = hasFlag('yes')
const DIRECT = {
  recalc: hasFlag('recalc'),
  cleanup: hasFlag('cleanup'),
  'cleanup-sessions': hasFlag('cleanup-sessions'),
  backup: hasFlag('backup'),
  vacuum: hasFlag('vacuum'),
}

// 与 src/lib/crypto.ts 完全一致的派生参数（勿改，改了就对不上）
const PBKDF2_ITERS = 120000
async function deriveAdminKeyHash(superKey) {
  const enc = new TextEncoder()
  const base = await crypto.subtle.importKey('raw', enc.encode(superKey), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode('cipherchat:admin'), iterations: PBKDF2_ITERS },
    base, 256
  )
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

const C = {
  reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  cyan: '\x1b[36m', dim: '\x1b[2m', bold: '\x1b[1m',
}
const ICON = { ok: `${C.green}✓${C.reset}`, warn: `${C.yellow}△${C.reset}`, fail: `${C.red}✗${C.reset}` }

async function jpost(url, body) {
  const res = await fetch(BASE + url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(90_000),
  })
  const data = await res.json().catch(() => ({}))
  return { status: res.status, ok: res.ok, data }
}

async function main() {
  console.log(`${C.bold}CipherChat 服务器医生 v1.8.0${C.reset}  ${C.dim}目标 ${BASE}${C.reset}\n`)

  if (!RAW_KEY && !HASH_DIRECT) {
    console.log(`${C.red}用法：bun scripts/doctor.mjs --key <超级密钥> [--fix-all] [--recalc] [--cleanup] [--json] [--url http://...]${C.reset}`)
    console.log(`${C.dim}更多参数：--hash <64位哈希> --cleanup-sessions --backup --vacuum --yes --checks id1,id2${C.reset}`)
    process.exit(1)
  }

  let adminKeyHash = HASH_DIRECT || ''
  if (!adminKeyHash) {
    process.stdout.write('派生密钥中… ')
    adminKeyHash = await deriveAdminKeyHash(RAW_KEY)
    console.log('完成')
  }

  // 直连修复模式（不走自检，直接执行维护动作）
  const directActions = Object.entries(DIRECT).filter(([, v]) => v).map(([k]) =>
    k === 'recalc' ? 'recalc-drive-usage' : k === 'cleanup' ? 'cleanup-orphan-files' : k === 'vacuum' ? 'vacuum-db' : k
  )
  if (directActions.length > 0) {
    for (const action of directActions) {
      const r = await jpost('/api/admin/maintenance', { adminKeyHash, action })
      if (r.ok) console.log(`${ICON.ok} ${action}：${r.data?.message || '完成'}`)
      else console.log(`${ICON.fail} ${action} 失败：${r.data?.error || `HTTP ${r.status}`}`)
    }
    process.exit(0)
  }

  // 自检模式
  const checks = getOpt('checks')
  const r = await jpost('/api/admin/selfcheck', { adminKeyHash, ...(checks ? { checks: checks.split(',').map((s) => s.trim()) } : {}) })
  if (!r.ok) {
    console.log(`${C.red}自检请求失败：${r.data?.error || `HTTP ${r.status}`}${C.reset}`)
    if (r.status === 403) console.log(`${C.yellow}提示：超级密钥不正确（或管理员尚未初始化）。--key 传的是网页后台那个超级密钥原文。${C.reset}`)
    if (r.status === 0 || !r.status) console.log(`${C.yellow}提示：服务不可达。确认 ${BASE} 正在运行，或用 --url 指定正确地址。${C.reset}`)
    process.exit(1)
  }

  const report = r.data
  if (JSON_MODE) {
    console.log(JSON.stringify(report, null, 2))
    process.exit(report.summary.fail > 0 ? 2 : 0)
  }

  // 分组打印
  const groups = {}
  for (const item of report.results) (groups[item.category] ||= []).push(item)
  for (const [cat, items] of Object.entries(groups)) {
    console.log(`${C.cyan}${C.bold}【${cat}】${C.reset}`)
    for (const item of items) {
      console.log(`  ${ICON[item.status]} ${item.name}  ${C.dim}(${item.ms}ms)${C.reset}`)
      console.log(`     ${item.summary}`)
      if (item.detail && item.status !== 'ok') {
        for (const line of item.detail.split('\n')) console.log(`     ${C.dim}${line}${C.reset}`)
      }
    }
    console.log('')
  }
  console.log(`${C.bold}合计：${C.green}${report.summary.ok} 正常${C.reset} · ${C.yellow}${report.summary.warn} 注意${C.reset} · ${C.red}${report.summary.fail} 故障${C.reset} · 耗时 ${(report.durationMs / 1000).toFixed(1)}s`)

  // 可修复项处理：有真实修复动作的走一键修复，纯教程型的只展示教程
  const fixables = report.results.filter((x) => x.fix?.action && x.status !== 'ok')
  const guideOnly = report.results.filter((x) => x.fix && !x.fix.action && x.status !== 'ok')
  if (guideOnly.length > 0) {
    console.log(`\n${C.bold}以下 ${guideOnly.length} 项需人工处理（无自动修复，附教程）：${C.reset}`)
    for (const f of guideOnly) {
      console.log(`  ${ICON[f.status]} ${f.name}`)
      f.fix.guide.forEach((g, i) => console.log(`     ${C.dim}${i + 1}. ${g}${C.reset}`))
    }
  }
  if (fixables.length === 0) {
    console.log(guideOnly.length > 0 || report.summary.warn > 0
      ? `\n${C.yellow}上述均为环境/配置项，按教程处理完后重跑本脚本验证。${C.reset}`
      : `\n${C.green}一切正常，无需修复。${C.reset}`)
    process.exit(0)
  }

  if (!FIX_ALL) {
    console.log(`\n${C.bold}以下 ${fixables.length} 项可一键修复：${C.reset}`)
    for (const f of fixables) console.log(`  ${ICON[f.status]} [${f.fix.action}] ${f.name} —— ${f.fix.label}`)
    console.log(`\n重新运行并加 ${C.cyan}--fix-all${C.reset} 自动修复全部（会先展示每步结果）`)
    for (const f of fixables) {
      console.log(`\n${C.bold}「${f.name}」手动修复教程：${C.reset}`)
      f.fix.guide.forEach((g, i) => console.log(`  ${i + 1}. ${g}`))
    }
    process.exit(2)
  }

  // --fix-all：逐项修复
  console.log(`\n${C.bold}开始一键修复（${fixables.length} 项）…${C.reset}`)
  for (const f of fixables) {
    const action = f.fix.action
    const r2 = await jpost('/api/admin/maintenance', { adminKeyHash, action })
    if (r2.ok) console.log(`  ${ICON.ok} ${f.name}：${r2.data?.message || '完成'}`)
    else {
      console.log(`  ${ICON.fail} ${f.name} 修复失败：${r2.data?.error || `HTTP ${r2.status}`}`)
      console.log(`${C.dim}     手动教程：${f.fix.guide.join(' → ')}${C.reset}`)
    }
  }

  // 修复后复查
  console.log(`\n${C.bold}修复完成，自动复查…${C.reset}`)
  const r3 = await jpost('/api/admin/selfcheck', { adminKeyHash })
  if (r3.ok) {
    const s = r3.data.summary
    console.log(`${C.bold}复查结果：${C.green}${s.ok} 正常${C.reset} · ${C.yellow}${s.warn} 注意${C.reset} · ${C.red}${s.fail} 故障${C.reset}`)
    if (s.fail > 0) {
      console.log(`\n${C.yellow}仍有故障项，多为需要人工介入的环境问题（磁盘/端口/证书），按上方教程处理后重跑本脚本。${C.reset}`)
      process.exit(2)
    }
  } else {
    console.log(`${C.yellow}复查请求失败（${r3.data?.error || r3.status}）—— 修复动作本身已执行，可稍后手动复查。${C.reset}`)
  }
}

main().catch((e) => {
  console.error(`${C.red}医生脚本异常：${e?.message || e}${C.reset}`)
  console.error(`${C.dim}若为 fetch failed：服务未运行或地址不对，用 --url 指定。${C.reset}`)
  process.exit(1)
})
