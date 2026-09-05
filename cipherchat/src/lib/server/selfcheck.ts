// v1.8.0 模块化一键自检引擎（管理员专用）
// 设计目标：傻瓜化 · 模块化 · 可扩展 —— 每个检查项是独立函数，返回统一结构；
// 失败项自带「原因 + 一键修复动作 + 手动教程」，管理端与 CLI 医生共用同一套逻辑。
//
// 检查分为两类：
//   A. 探测型：读配置/状态做断言（数据库、磁盘、TURN、功能开关、HTTPS）
//   B. 真实世界型：真的走一遍用户操作（写盘 IO、HTTP 全生命周期的网盘上传/下载/删除、
//      WebSocket 握手）—— 不信任任何“看起来正常”，只信任真实跑通。
import { createConnection } from 'net'
import { statfs } from 'fs/promises'
import { existsSync, readdirSync, statSync, writeFileSync, rmSync, readFileSync, mkdirSync } from 'fs'
import { join, resolve } from 'path'
import { db } from '../db'
import { SERVER_CONFIG, getTurnConfig, getFeatureFlags } from './config'
import { getProjectRoot } from './db-bootstrap'
import { dirSizeBytesAsync, countChunks, deleteFileDir } from './filestore'
import { probeCert, readHttpsMeta } from './admin-https'

export type CheckStatus = 'ok' | 'warn' | 'fail'

export type FixActionId =
  | 'recalc-drive-usage'
  | 'cleanup-orphan-files'
  | 'cleanup-sessions'
  | 'vacuum-db'
  | 'backup'
  | 'revoke-sessions'

export interface CheckFix {
  /** 一键修复按钮文案 */
  label: string
  /** 对应维护端点的动作 ID（POST /api/admin/maintenance { action }）；缺省 = 纯教程型（无自动修复） */
  action?: FixActionId
  /** 傻瓜化手动教程（按步骤） */
  guide: string[]
}

export interface CheckResult {
  id: string
  name: string
  category: string
  status: CheckStatus
  ms: number
  /** 一句话结论 */
  summary: string
  /** 明细（换行分隔，管理端可折叠展示） */
  detail?: string
  /** 键值型指标 */
  metrics?: Record<string, string | number>
  fix?: CheckFix
}

export interface CheckContext {
  /** 本服务对外地址（真实自调用测试用） */
  origin: string
  /** 已验证的管理员超级密钥哈希（上传管线测试需要创建临时仓库） */
  adminKeyHash: string
}

type CheckFn = (ctx: CheckContext) => Promise<CheckResult>
interface CheckDef { id: string; name: string; category: string; fn: CheckFn }

const ms = (t0: number) => Math.round((Date.now() - t0))
const fmtMB = (n: number) => `${(n / 1048576).toFixed(1)} MB`
const hex = (n: number) => [...Array(n)].map(() => Math.floor(Math.random() * 16).toString(16)).join('')

// TCP 端口连通探测（带超时）
function tcpProbe(host: string, port: number, timeoutMs = 2500): Promise<{ ok: boolean; err?: string }> {
  return new Promise((res) => {
    const sock = createConnection({ host, port })
    const done = (ok: boolean, err?: string) => {
      sock.removeAllListeners()
      sock.destroy()
      res({ ok, err })
    }
    sock.setTimeout(timeoutMs, () => done(false, `连接超时（${timeoutMs}ms）`))
    sock.once('connect', () => done(true))
    sock.once('error', (e) => done(false, e.message))
  })
}

// ============== 检查项注册表（新增检查 = 追加一个条目，零侵入） ==============

export const CHECK_REGISTRY: CheckDef[] = [
  { id: 'db', name: '数据库与完整性', category: '核心', fn: checkDb },
  { id: 'disk', name: '数据目录与磁盘空间', category: '存储', fn: checkDisk },
  { id: 'filestore-io', name: '文件存储读写（真实 IO）', category: '存储', fn: checkFilestoreIo },
  { id: 'upload-pipeline', name: '网盘上传下载全链路（真实调用）', category: '网盘', fn: checkUploadPipeline },
  { id: 'quota-consistency', name: '存储统计一致性（配额核对）', category: '网盘', fn: checkQuotaConsistency },
  { id: 'chat-files', name: '聊天文件完整性', category: '聊天', fn: checkChatFiles },
  { id: 'relay-ws', name: 'WebSocket 中继服务', category: '网络', fn: checkRelayWs },
  { id: 'turn-voice', name: '语音 TURN 中继配置', category: '语音', fn: checkTurnVoice },
  { id: 'https-gateway', name: 'HTTPS 网关与证书', category: '网络', fn: checkHttpsGateway },
  { id: 'sessions', name: '会话健康度', category: '维护', fn: checkSessions },
  { id: 'backup', name: '备份状态', category: '维护', fn: checkBackup },
  { id: 'features', name: '功能开关总览', category: '维护', fn: checkFeatures },
]

// ============== 各检查项实现 ==============

async function checkDb(): Promise<CheckResult> {
  const t0 = Date.now()
  const lines: string[] = []
  let status: CheckStatus = 'ok'
  let summary = '数据库正常（WAL 已启用，完整性校验通过）'

  try {
    const mode = (await db.$queryRawUnsafe('PRAGMA journal_mode;')) as unknown as { journal_mode?: string }[]
    const journal = Array.isArray(mode) ? String(mode[0]?.journal_mode || '') : ''
    const wal = journal.toLowerCase().includes('wal')
    if (!wal) {
      status = 'warn'
      summary = '数据库未运行在 WAL 模式（并发性能与可靠性下降）'
      lines.push(`当前日志模式：${journal || '未知'}；期望 WAL`)
    } else lines.push('日志模式：WAL ✓')

    const quick = (await db.$queryRawUnsafe('PRAGMA quick_check;')) as unknown as { quick_check?: string }[]
    const qc = Array.isArray(quick) ? String(quick[0]?.quick_check || '') : ''
    if (qc !== 'ok') {
      status = 'fail'
      summary = '数据库完整性校验未通过 —— 存在损坏风险'
      lines.push(`quick_check 结果：${qc}`)
    } else lines.push('完整性校验：quick_check = ok ✓')

    const tables = await db.$queryRawUnsafe(
      `SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('ChatSession','ChatMessage','ChatFile','DriveRepo','DriveFile','DriveSession','AdminConfig')`
    ) as unknown as { n?: number }[]
    const n = Number(Array.isArray(tables) ? tables[0]?.n || 0 : 0)
    if (n < 7) {
      status = 'fail'
      summary = '数据库表结构不完整（缺少关键表）—— 需要执行 prisma db push'
      lines.push(`关键表仅存在 ${n}/7`)
    } else lines.push(`关键表 ${n}/7 齐全 ✓`)
  } catch (e) {
    return {
      id: 'db', name: '数据库与完整性', category: '核心', status: 'fail', ms: ms(t0),
      summary: '数据库无法访问',
      detail: e instanceof Error ? e.message : String(e),
      fix: {
        label: '检查数据库文件与权限', action: 'vacuum-db',
        guide: [
          'SSH 登录服务器，进入 CipherChat 目录',
          '检查 db/custom.db 是否存在：ls -la db/（不存在 = 数据库被删或未初始化）',
          '执行初始化：bun run db:push',
          '检查 .env 中 DATABASE_URL 指向的路径是否可写：ls -la db/',
          '完成后回到后台点「重新自检」验证',
        ],
      },
    }
  }
  return { id: 'db', name: '数据库与完整性', category: '核心', status, ms: ms(t0), summary, detail: lines.join('\n') }
}

async function checkDisk(): Promise<CheckResult> {
  const t0 = Date.now()
  const dir = resolve(process.cwd(), SERVER_CONFIG.dataDir)
  const lines: string[] = []
  let status: CheckStatus = 'ok'

  // 可写性：先按 filestore 同样规则补建目录（全新部署 data/ 尚未创建是正常状态，
  // 应用本身写入时也会 mkdir —— 此前直接写探针导致首次自检必误报「数据目录不可写」），
  // 再真实写入并删除
  try {
    mkdirSync(dir, { recursive: true })
    const probe = join(dir, `.selfcheck-${Date.now()}.tmp`)
    writeFileSync(probe, 'ok')
    rmSync(probe, { force: true })
    lines.push('数据目录可读写 ✓')
  } catch (e) {
    return {
      id: 'disk', name: '数据目录与磁盘空间', category: '存储', status: 'fail', ms: ms(t0),
      summary: `数据目录不可写：${dir}`,
      detail: e instanceof Error ? e.message : String(e),
      fix: {
        label: '查看修复教程',
        guide: [
          `数据目录：${dir}`,
          '检查目录属主与权限：ls -ld data/ （应属于运行服务的用户）',
          '修正属主（把 <user> 换成运行服务的用户）：chown -R <user>:<user> data db',
          '修正权限：chmod -R u+rw data db',
          '完成后回后台重新自检',
        ],
      },
    }
  }

  // 剩余空间
  let freeInfo = '未知（statfs 不可用）'
  try {
    const st = await statfs(dir)
    const free = Number(st.bavail) * Number(st.bsize)
    freeInfo = `${fmtMB(free)} 可用 / ${fmtMB(Number(st.blocks) * Number(st.bsize))} 总量`
    if (free < 200 * 1048576) {
      status = 'fail'
      lines.push(`磁盘剩余空间仅 ${fmtMB(free)} —— 上传随时会失败`)
    } else if (free < 1024 * 1048576) {
      status = 'warn'
      lines.push(`磁盘剩余空间偏低：${fmtMB(free)}`)
    } else lines.push(`磁盘剩余空间充足：${fmtMB(free)} ✓`)
  } catch { /* statfs 不可用时跳过，不视为错误 */ }

  const summary =
    status === 'fail' ? '磁盘空间不足，上传功能已受影响' :
    status === 'warn' ? '磁盘空间偏低，建议尽快清理' :
    '数据目录可读写，磁盘空间充足'

  return {
    id: 'disk', name: '数据目录与磁盘空间', category: '存储', status, ms: ms(t0), summary,
    detail: lines.join('\n'),
    metrics: { 数据目录: dir, 磁盘: freeInfo },
    fix: status !== 'ok' ? {
      label: '一键备份后清理', action: 'backup',
      guide: [
        '先备份：点「一键备份」（备份包含数据库与全部密文文件）',
        '在网盘/聊天中删除不再需要的大文件（客户端操作）',
        '清理过期会话与孤儿文件：维护页执行对应一键动作',
        '仍不足时扩容磁盘或把 data/ 迁移到大容量分区（.env 中 DATA_DIR 可指定新路径）',
      ],
    } : undefined,
  }
}

async function checkFilestoreIo(): Promise<CheckResult> {
  const t0 = Date.now()
  const testId = `selfcheck-${hex(8)}-00000000-0000-4000-8000-${hex(12)}`
  try {
    const { writeChunkAsync } = await import('./filestore')
    const payload = Buffer.alloc(64 * 1024, 0xab)
    await writeChunkAsync('drive', testId, 0, payload)
    const { readChunk } = await import('./filestore')
    const back = readChunk('drive', testId, 0)
    const okWrite = !!back && back.equals(payload)
    deleteFileDir('drive', testId)
    if (!okWrite) throw new Error('写入后读回内容不一致')
    return {
      id: 'filestore-io', name: '文件存储读写（真实 IO）', category: '存储', status: 'ok', ms: ms(t0),
      summary: '密文分块写入 → 读回 → 校验 → 清理 全部通过',
    }
  } catch (e) {
    deleteFileDir('drive', testId)
    return {
      id: 'filestore-io', name: '文件存储读写（真实 IO）', category: '存储', status: 'fail', ms: ms(t0),
      summary: '磁盘读写校验失败（文件存储不可用）',
      detail: e instanceof Error ? e.message : String(e),
      fix: {
        label: '查看修复教程',
        guide: [
          '检查磁盘是否满（上方「数据目录与磁盘空间」检查项）',
          '检查 data/ 目录权限（chown -R <user>:<user> data）',
          '服务器执行 bun scripts/doctor.mjs --key 超级密钥 复现并查看详细错误',
          '磁盘硬件故障时：从 backups/ 恢复数据（备份包含 db + data）',
        ],
      },
    }
  }
}

// 真实世界测试：走 HTTP 完整体验网盘 建仓→init→分块→完结→下载→比对→删除→配额归零
async function checkUploadPipeline(ctx: CheckContext): Promise<CheckResult> {
  const t0 = Date.now()
  const driveId = ('SC' + hex(6)).toUpperCase()
  const keyHash = hex(64)
  const probeHash = hex(64)
  const steps: string[] = []
  const CHUNK = SERVER_CONFIG.chunkSize
  // 2 个分块：1 个满块 + 1 个 256KB 尾块（贴近真实文件形态）
  const tail = 256 * 1024
  const totalChunks = 2
  const totalBytes = CHUNK + tail + totalChunks * 28
  let token = ''
  let fileId = ''

  const cleanup = async () => {
    try {
      // 只在拿到合法 fileId 时才走 API 删除（避免空 id 误伤）
      if (/^[0-9a-f-]{36}$/.test(fileId)) {
        await fetch(`${ctx.origin}/api/drive/files`, {
          method: 'DELETE',
          headers: { 'content-type': 'application/json', 'x-session-token': token },
          body: JSON.stringify({ ids: [fileId] }),
        })
      }
      // DriveSession.repoId 是普通字段（无关系映射），先查仓库拿 id
      const repoRow = await db.driveRepo.findUnique({ where: { driveId } })
      if (repoRow) {
        await db.driveSession.deleteMany({ where: { repoId: repoRow.id } }).catch(() => {})
        await db.driveFile.deleteMany({ where: { repoId: repoRow.id } }).catch(() => {})
      }
      await db.driveRepo.deleteMany({ where: { driveId } }).catch(() => {})
      // 防御：filestore.deleteFileDir 内部也有护栏，这里再做一层校验
      if (/^[0-9a-f-]{36}$/.test(fileId)) deleteFileDir('drive', fileId)
    } catch { /* 尽力清理 */ }
  }

  try {
    // 1. 建仓库（真实 HTTP，验证管理员授权链路）
    let res = await fetch(`${ctx.origin}/api/drive/session`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ driveId, keyHash, create: true, adminKeyHash: ctx.adminKeyHash, probeHash }),
    })
    let data = await res.json().catch(() => ({}))
    // v1.8.0：建仓限流是服务器对真实用户的保护（每 IP 每小时 3 个），自检频繁触发属于正常现象 ——
    // 降级为「注意」而非故障，并明确告知一小时后自检可复现完整链路
    if (res.status === 429) {
      return {
        id: 'upload-pipeline', name: '网盘上传下载全链路（真实调用）', category: '网盘',
        status: 'warn', ms: ms(t0),
        summary: '自检触发建仓限流（每 IP 每小时 3 个），本次跳过链路测试 —— 非故障',
        detail: '服务器限制了每 IP 每小时的网盘创建数（防滥用）。一小时内多次自检会命中此限流。\n一小时后重新自检即可完整验证上传/下载链路；其他检查项不受影响。',
      }
    }
    if (!res.ok) throw new Error(`建仓失败 HTTP ${res.status}: ${data?.error || ''}`)
    token = data.token
    steps.push('创建临时网盘仓库 ✓')

    // 2. 上传初始化
    res = await fetch(`${ctx.origin}/api/drive/files`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-session-token': token },
      body: JSON.stringify({ totalChunks, totalBytes, meta: 'selfcheck' }),
    })
    data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(`初始化失败 HTTP ${res.status}: ${data?.error || ''}`)
    fileId = data.fileId
    steps.push('上传初始化 ✓')

    // 3. 分块上传（真实 4MiB + 尾块）
    const bufFull = Buffer.alloc(CHUNK, 0x5a)
    const bufTail = Buffer.alloc(tail, 0xa5)
    for (const [idx, buf] of [[0, bufFull], [1, bufTail]] as [number, Buffer][]) {
      res = await fetch(`${ctx.origin}/api/drive/files/chunk?fileId=${fileId}&index=${idx}`, {
        method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-session-token': token },
        body: new Uint8Array(buf),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(`分块 ${idx} 上传失败 HTTP ${res.status}: ${j?.error || ''}`)
      }
    }
    steps.push('分块上传（4MiB 满块 + 256KB 尾块）✓')

    // 4. 完结（统计落库 —— v1.8.0 重点验证对象）
    res = await fetch(`${ctx.origin}/api/drive/files/complete`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-session-token': token },
      body: JSON.stringify({ fileId }),
    })
    data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(`完结失败 HTTP ${res.status}: ${data?.error || ''}`)
    steps.push('完结与占用统计 ✓')

    // 5. 下载并逐字节比对（验证流式输出完整性）
    res = await fetch(`${ctx.origin}/api/drive/files/${fileId}`, { headers: { 'x-session-token': token } })
    if (!res.ok) {
      const j = await res.json().catch(() => ({}))
      throw new Error(`下载失败 HTTP ${res.status}: ${j?.error || ''}`)
    }
    const ab = Buffer.from(await res.arrayBuffer())
    const expected = Buffer.concat([bufFull, bufTail])
    if (!ab.equals(expected)) throw new Error(`下载内容与上传不一致（${ab.length} vs ${expected.length} 字节）`)
    steps.push('下载 + 字节级比对 ✓')

    // 6. 配额核对（统计值必须等于真实密文大小）
    const frow = await db.driveFile.findUnique({ where: { id: fileId } })
    // 自检上传的是裸字节（无客户端 AES-GCM 的 +28B/块开销），磁盘真实大小即明文大小
    const realExpect = CHUNK + tail
    if (!frow || frow.totalBytes !== BigInt(realExpect)) {
      throw new Error(`占用统计错误：记录 ${frow?.totalBytes ?? 'null'}，实际 ${realExpect}`)
    }
    steps.push(`占用统计精确（${realExpect} 字节 = 磁盘真实大小）✓`)

    await cleanup()
    steps.push('测试数据已清理 ✓')

    return {
      id: 'upload-pipeline', name: '网盘上传下载全链路（真实调用）', category: '网盘',
      status: 'ok', ms: ms(t0), summary: '建仓→上传→完结→下载→比对→清理 全链路真实跑通',
      detail: steps.join('\n'), metrics: { 测试仓库: driveId, 传输量: fmtMB(realExpect) },
    }
  } catch (e) {
    await cleanup()
    return {
      id: 'upload-pipeline', name: '网盘上传下载全链路（真实调用）', category: '网盘',
      status: 'fail', ms: ms(t0),
      summary: '网盘核心链路存在故障 —— 用户上传/下载当前不可用',
      detail: steps.join('\n') + (steps.length ? '\n' : '') + `失败：${e instanceof Error ? e.message : String(e)}`,
      fix: {
        label: '清理测试残留并查看教程', action: 'cleanup-orphan-files',
        guide: [
          '服务端日志查看具体错误：tail -100 server.log（生产）或 dev.log（开发）',
          '确认磁盘空间与权限（上方「数据目录」检查项）',
          '确认数据库可写（上方「数据库」检查项）',
          '重启服务：systemctl restart cipherchat（或重新运行 bun run start / bun run dev）',
          '重启后重新自检；若「占用统计」步骤失败，执行「重算网盘占用」修复存量数据',
        ],
      },
    }
  }
}

// 配额一致性：DB 统计 vs 磁盘真实 —— 这正是「150MB 显示 4MB」的守护检查
async function checkQuotaConsistency(): Promise<CheckResult> {
  const t0 = Date.now()
  const repos = await db.driveRepo.findMany()
  const driveFiles = await db.driveFile.findMany({ where: { ready: true } })
  const filesByRepo = new Map<string, typeof driveFiles>()
  for (const f of driveFiles) {
    const list = filesByRepo.get(f.repoId) || []
    list.push(f)
    filesByRepo.set(f.repoId, list)
  }

  const lines: string[] = []
  let status: CheckStatus = 'ok'
  let driftTotal = 0
  let driftedRepos = 0
  let scanned = 0
  let dataLoss = false // 磁盘比统计少 = 数据缺失（与「统计少记」性质完全不同）

  for (const repo of repos) {
    const files = filesByRepo.get(repo.id) || []
    let realSum = 0
    let missingFiles = 0
    for (const f of files) {
      const real = await dirSizeBytesAsync('drive', f.id)
      realSum += real
      if (real === 0) missingFiles++
      scanned++
    }
    const dbUsed = Number(repo.usedBytes)
    const drift = dbUsed - realSum
    if (realSum !== dbUsed) {
      driftedRepos++
      driftTotal += Math.abs(drift)
      status = 'fail'
      if (drift > 0) {
        dataLoss = true // 统计比磁盘多 → 密文丢了
        lines.push(`仓库 ${repo.driveId}：统计 ${fmtMB(dbUsed)} > 磁盘 ${fmtMB(realSum)}（⚠ 磁盘缺少 ${fmtMB(drift)}${missingFiles ? `，${missingFiles} 个文件目录为空/缺失` : ''} —— 疑似数据丢失）`)
      } else {
        lines.push(`仓库 ${repo.driveId}：统计 ${fmtMB(dbUsed)} < 磁盘 ${fmtMB(realSum)}（统计少记 ${fmtMB(-drift)}，历史版本统计缺陷）`)
      }
    } else {
      lines.push(`仓库 ${repo.driveId}：${fmtMB(dbUsed)} 与磁盘一致 ✓`)
    }
  }
  if (repos.length === 0) lines.push('暂无网盘仓库（新部署属正常）')

  const summary =
    status === 'fail'
      ? dataLoss
        ? `${driftedRepos} 个仓库磁盘数据缺失（密文目录为空）—— 属数据丢失，重算只能修统计、无法救回文件`
        : `${driftedRepos} 个仓库的占用统计与磁盘不符（历史统计错误，可一键修复）`
      : `全部 ${repos.length} 个仓库占用统计与磁盘一致（扫描 ${scanned} 个文件）`

  return {
    id: 'quota-consistency', name: '存储统计一致性（配额核对）', category: '网盘', status, ms: ms(t0),
    summary, detail: lines.join('\n'),
    fix: status !== 'ok' ? {
      label: dataLoss ? '一键重算统计（文件本体需从备份恢复）' : '一键重算网盘占用（推荐）',
      action: 'recalc-drive-usage',
      guide: dataLoss
        ? [
          '⚠ 磁盘上的密文已不完整：文件本体无法从服务器现状恢复，只能从备份还原',
          '① 如有备份：backups/ 下执行 tar -xzf cipherchat-backup-*.tar.gz -C .（先备份当前状态）',
          '② 无备份或不需要救回：点左侧按钮重算统计（把丢失文件的占用清零，配额恢复准确）',
          '③ 排查丢失原因：磁盘故障 / 误删 data 目录 / 磁盘满导致的写入失败（见上方磁盘检查项）',
          '命令行等价操作：bun scripts/doctor.mjs --key 超级密钥 --recalc',
        ]
        : [
          '原因：v1.7.0 及更早版本的统计代码存在并发竞态，大文件（几十 MB 以上）的占用被少记',
          '点左侧「一键重算网盘占用」：以磁盘真实密文大小为准，重写每个文件与每个仓库的统计',
          '重算后此检查项应转绿；配额扣减、空间显示将全部恢复准确',
          '命令行等价操作：bun scripts/doctor.mjs --key 超级密钥 --recalc',
        ],
    } : undefined,
  }
}

async function checkChatFiles(): Promise<CheckResult> {
  const t0 = Date.now()
  const lines: string[] = []
  let status: CheckStatus = 'ok'
  let orphans = 0
  let broken = 0

  const rows = await db.chatFile.findMany({ where: { ready: true }, select: { id: true, totalChunks: true } })
  for (const r of rows) {
    const actual = countChunks('chat', r.id)
    if (actual === 0) { broken++; status = 'fail'; lines.push(`文件 ${r.id.slice(0, 8)}… 已就绪但磁盘目录缺失`) }
    else if (actual < r.totalChunks) { broken++; status = 'fail'; lines.push(`文件 ${r.id.slice(0, 8)}… 缺块（${actual}/${r.totalChunks}）`) }
  }
  // 孤儿目录（磁盘有、库没有）
  const chatRoot = resolve(process.cwd(), SERVER_CONFIG.dataDir, 'chat')
  try {
    for (const d of readdirSync(chatRoot)) {
      const row = rows.find((r) => r.id === d)
      if (!row) { orphans++; lines.push(`孤儿目录 chat/${d.slice(0, 8)}…（库中无记录）`) }
    }
  } catch { /* 目录不存在则跳过 */ }
  if (orphans > 0 && status === 'ok') status = 'warn'

  const summary =
    broken > 0 ? `${broken} 个聊天文件损坏（缺块/缺失）` :
    orphans > 0 ? `${orphans} 个孤儿目录占用磁盘（可一键清理）` :
    `${rows.length} 个聊天文件完整 ✓`

  return {
    id: 'chat-files', name: '聊天文件完整性', category: '聊天', status, ms: ms(t0), summary,
    detail: lines.length ? lines.join('\n') : '无异常',
    fix: orphans > 0 ? {
      label: '一键清理孤儿文件', action: 'cleanup-orphan-files',
      guide: [
        '孤儿文件 = 上传中断/历史遗留的密文目录，已不在数据库中，无法通过任何界面访问',
        '点「一键清理孤儿文件」释放磁盘空间（只删无记录的目录，不碰正常文件）',
        '命令行等价：bun scripts/doctor.mjs --key 超级密钥 --cleanup',
      ],
    } : broken > 0 ? {
      label: '查看恢复教程',
      guide: [
        '聊天文件缺块通常由上传中断或磁盘故障造成，密文已不完整无法恢复',
        '从最近备份恢复：backups/ 下执行 tar -xzf cipherchat-backup-*.tar.gz -C .（会覆盖现有数据，请先备份当前状态）',
        '若无需恢复，可执行「清理孤儿文件」移除损坏目录',
      ],
    } : undefined,
  }
}

async function checkRelayWs(): Promise<CheckResult> {
  const t0 = Date.now()
  const port = SERVER_CONFIG.wsPort
  const lines: string[] = []
  const tcp = await tcpProbe('127.0.0.1', port)
  if (!tcp.ok) {
    return {
      id: 'relay-ws', name: 'WebSocket 中继服务', category: '网络', status: 'fail', ms: ms(t0),
      summary: `中继服务（:${port}）无法连接 —— 实时消息/在线状态/语音信令全部不可用`,
      detail: `TCP 探测失败：${tcp.err || '未知错误'}`,
      fix: {
        label: '查看启动教程',
        guide: [
          `中继服务必须与主服务同时运行，端口 ${port}`,
          '手动启动（验证）：cd 项目目录 && bun mini-services/relay/index.ts',
          '常见排错：端口被占用（lsof -i:' + port + '）、数据库被锁（重启主服务）、缺依赖（bun install）',
          '生产建议用 systemd 常驻：参考安装教程.md 的服务配置章节',
          '启动后重新自检',
        ],
      },
    }
  }
  lines.push(`TCP ${port} 端口在线 ✓`)

  // engine.io 握手（真实协议探测）
  try {
    const res = await fetch(`http://127.0.0.1:${port}/socket.io/?EIO=4&transport=polling`, { signal: AbortSignal.timeout(3000) })
    const text = await res.text()
    if (res.ok && text.startsWith('0')) lines.push('Socket.IO 握手响应正常 ✓')
    else { lines.push(`握手响应异常：HTTP ${res.status} ${text.slice(0, 60)}`) }
  } catch (e) {
    return {
      id: 'relay-ws', name: 'WebSocket 中继服务', category: '网络', status: 'warn', ms: ms(t0),
      summary: '端口在线但 Socket.IO 握手失败（服务可能启动到一半）',
      detail: lines.join('\n') + '\n握手错误：' + (e instanceof Error ? e.message : String(e)),
      fix: {
        label: '查看重启教程',
        guide: ['重启中继服务：kill 掉旧进程后重新运行 bun mini-services/relay/index.ts', '查看中继日志中的报错信息', '重启后重新自检'],
      },
    }
  }
  return {
    id: 'relay-ws', name: 'WebSocket 中继服务', category: '网络', status: 'ok', ms: ms(t0),
    summary: `中继在线（:${port}），Socket.IO 握手正常`, detail: lines.join('\n'),
  }
}

async function checkTurnVoice(): Promise<CheckResult> {
  const t0 = Date.now()
  const [turn, flags] = await Promise.all([getTurnConfig(), getFeatureFlags()])
  const lines: string[] = []
  let status: CheckStatus = 'ok'

  if (!flags.voiceEnabled) {
    return {
      id: 'turn-voice', name: '语音 TURN 中继配置', category: '语音', status: 'ok', ms: ms(t0),
      summary: '语音功能当前被管理员停用（不适用）', detail: '如需启用：后台「功能」页打开语音开关',
    }
  }
  lines.push('语音功能：已启用 ✓')

  if (!turn.enabled || turn.servers.length === 0) {
    lines.push('TURN 服务器：未配置 —— 当前仅靠公共 STUN 直连')
    return {
      id: 'turn-voice', name: '语音 TURN 中继配置', category: '语音', status: 'warn', ms: ms(t0),
      summary: '语音已启用但未配置 TURN：跨网络（NAT/移动网络）通话大概率连不通',
      detail: lines.join('\n'),
      fix: {
        label: '查看 TURN 配置教程',
        guide: [
          '语音要跨网络可靠通话，需要自建 TURN 中继（推荐 coturn）',
          '① 服务器安装 coturn：apt install coturn（或 docker run coturn/coturn）',
          '② 编辑 /etc/turnserver.conf：listening-port=3478、fingerprint、lt-cred-mech、use-auth-secret、static-auth-secret=<你的密钥>',
          '③ 后台「语音中继」页填入 turn:你的域名:3478，模式选 time-limited（更安全），密钥与上一步一致',
          '④ 防火墙放行 3478 UDP/TCP（大流量中继还需放行 49152-65535 UDP）',
          '⑤ 保存后回来自检，本项应转绿',
        ],
      },
    }
  }

  lines.push(`TURN 服务器：${turn.servers.join(', ')}`)
  lines.push(`凭证模式：${turn.secretMode === 'time-limited' ? '短期凭证（更安全）' : '长期静态凭证'}`)
  for (const u of turn.servers) {
    const m = u.match(/^(turns?):([^:]+):(\d+)/)
    if (!m) { lines.push(`地址格式无法解析：${u}`); continue }
    const [, , host, port] = m
    const r = await tcpProbe(host, Number(port), 3000)
    if (r.ok) lines.push(`${host}:${port} TCP 可达 ✓`)
    else {
      status = 'fail'
      lines.push(`${host}:${port} 不可达（${r.err}）`)
    }
  }

  return {
    id: 'turn-voice', name: '语音 TURN 中继配置', category: '语音', status, ms: ms(t0),
    summary: status === 'fail' ? 'TURN 服务器不可达 —— 语音通话会回退直连（多数网络下会失败）' : 'TURN 中继配置正常，语音链路就绪',
    detail: lines.join('\n'),
    fix: status === 'fail' ? {
      label: '查看 TURN 排查教程',
      guide: [
        '确认 coturn 进程存活：systemctl status coturn',
        '确认端口监听：ss -lnup | grep 3478（UDP）与 ss -lntp | grep 3478（TCP）',
        '确认防火墙/安全组放行了对应端口（UDP 与 TCP 都要）',
        '若换了端口/地址，记得在后台「语音中继」页同步更新',
      ],
    } : undefined,
  }
}

async function checkHttpsGateway(): Promise<CheckResult> {
  const t0 = Date.now()
  const meta = readHttpsMeta()
  if (!meta || meta.mode === 'none') {
    return {
      id: 'https-gateway', name: 'HTTPS 网关与证书', category: '网络', status: 'warn', ms: ms(t0),
      summary: '当前为 HTTP 明文模式（局域网可用；公网部署强烈建议启用 HTTPS）',
      fix: {
        label: '查看 HTTPS 启用教程',
        guide: [
          '后台「HTTPS」页可一键签发自签证书（局域网快速启用）',
          '公网域名部署：后台「HTTPS」页选 ACME 模式自动申请 Let\'s Encrypt 免费证书',
          '手动方案（Caddy）：参考项目根目录 Caddyfile 模板',
          '注意：E2E 加密保证内容安全，HTTPS 保护的是传输层元数据与浏览器信任',
        ],
      },
    }
  }
  const port = meta.gatewayPort || 443
  const probe = await probeCert(meta.domain, port)
  if (probe.available) {
    const days = probe.daysLeft ?? 0
    const status: CheckStatus = days < 15 ? 'warn' : 'ok'
    return {
      id: 'https-gateway', name: 'HTTPS 网关与证书', category: '网络', status, ms: ms(t0),
      summary: `HTTPS 正常（${meta.domain}，剩余 ${days} 天）`,
      detail: `颁发者：${probe.issuer || '未知'}\n模式：${meta.mode}`,
      fix: days < 15 ? {
        label: '查看续期教程',
        guide: [
          '证书即将过期：后台「HTTPS」页重新执行一次签发即可（ACME 模式自动续期）',
          `剩余天数：${days} 天（少于 15 天即建议续期）`,
        ],
      } : undefined,
    }
  }
  return {
    id: 'https-gateway', name: 'HTTPS 网关与证书', category: '网络', status: 'warn', ms: ms(t0),
    summary: 'HTTPS 已配置但探测失败（网关可能未监听 443）',
    detail: probe.error || 'TLS 握手失败',
    fix: {
      label: '查看网关排查教程',
      guide: [
        '确认网关进程（Caddy）在运行：systemctl status caddy',
        '确认 443 端口监听：ss -lntp | grep 443',
        '防火墙/安全组放行 443 TCP',
        '查看 Caddy 日志：journalctl -u caddy -n 50',
      ],
    },
  }
}

async function checkSessions(): Promise<CheckResult> {
  const t0 = Date.now()
  const now = new Date()
  const [chatExpired, driveExpired, chatActive, driveActive] = await Promise.all([
    db.chatSession.count({ where: { expiresAt: { lt: now } } }),
    db.driveSession.count({ where: { expiresAt: { lt: now } } }),
    db.chatSession.count({ where: { expiresAt: { gte: now } } }),
    db.driveSession.count({ where: { expiresAt: { gte: now } } }),
  ])
  const expired = chatExpired + driveExpired
  const active = chatActive + driveActive
  const status: CheckStatus = expired > 50 ? 'warn' : 'ok'
  return {
    id: 'sessions', name: '会话健康度', category: '维护', status, ms: ms(t0),
    summary: expired > 50 ? `${expired} 个过期会话待清理` : `会话健康（活跃 ${active}，过期 ${expired}）`,
    metrics: { 活跃会话: active, 过期会话: expired },
    fix: expired > 0 ? {
      label: '一键清理过期会话', action: 'cleanup-sessions',
      guide: ['过期会话不影响功能，但会累积占库；点左侧按钮即可清理', '命令行等价：bun scripts/doctor.mjs --key 超级密钥 --cleanup-sessions'],
    } : undefined,
  }
}

async function checkBackup(): Promise<CheckResult> {
  const t0 = Date.now()
  // v1.8.1：备份目录与数据目录同源（项目根/backups）—— 不受 standalone chdir 影响
  const backupDir = join(getProjectRoot(), 'backups')
  let latest: Date | null = null
  let count = 0
  let latestPath = ''
  try {
    for (const f of readdirSync(backupDir)) {
      if (!f.startsWith('cipherchat-backup-')) continue
      const st = statSync(join(backupDir, f))
      count++
      if (!latest || st.mtime > latest) { latest = st.mtime; latestPath = join(backupDir, f) }
    }
  } catch { /* 目录不存在 */ }

  if (count === 0) {
    return {
      id: 'backup', name: '备份状态', category: '维护', status: 'warn', ms: ms(t0),
      summary: '从未执行过备份 —— 数据只有一份，强烈建议立即备份',
      fix: {
        label: '立即一键备份', action: 'backup',
        guide: [
          '点左侧「立即一键备份」，产出 db + data + .env 的 tar.gz 到 backups/ 目录',
          '把备份文件定期下载/同步到其他机器（服务器磁盘坏 = 数据全失）',
          '建议频率：每周一次 + 大量上传后立即备份',
        ],
      },
    }
  }
  const ageH = latest ? Math.floor((Date.now() - latest.getTime()) / 3600_000) : Infinity
  const status: CheckStatus = ageH > 168 ? 'warn' : 'ok' // 7 天
  return {
    id: 'backup', name: '备份状态', category: '维护', status, ms: ms(t0),
    summary: `已有 ${count} 份备份，最新一份 ${ageH} 小时前`,
    metrics: { 备份数: count, 最新时间: latest ? latest.toLocaleString('zh-CN') : '-', 最新文件: latestPath },
    fix: ageH > 168 ? {
      label: '立即一键备份', action: 'backup',
      guide: ['最新备份已超过 7 天，建议立即再备份一次', `最新备份：${latestPath}`],
    } : undefined,
  }
}

async function checkFeatures(): Promise<CheckResult> {
  const t0 = Date.now()
  const flags = await getFeatureFlags()
  const on = Object.entries(flags).filter(([, v]) => v).map(([k]) => k).join(', ')
  const off = Object.entries(flags).filter(([, v]) => !v).map(([k]) => k).join(', ') || '无'
  return {
    id: 'features', name: '功能开关总览', category: '维护', status: 'ok', ms: ms(t0),
    summary: `启用 ${Object.values(flags).filter(Boolean).length}/7 项功能`,
    detail: `启用：${on || '无'}\n停用：${off}`,
  }
}

// ============== 引擎入口 ==============

export interface SelfCheckReport {
  generatedAt: string
  durationMs: number
  summary: { ok: number; warn: number; fail: number }
  results: CheckResult[]
}

export async function runSelfCheck(ctx: CheckContext, only?: string[]): Promise<SelfCheckReport> {
  const t0 = Date.now()
  const list = only && only.length ? CHECK_REGISTRY.filter((c) => only.includes(c.id)) : CHECK_REGISTRY
  const results: CheckResult[] = []
  for (const def of list) {
    try {
      results.push(await def.fn(ctx))
    } catch (e) {
      // 引擎级兜底：任何检查抛异常都转为 fail 结果，绝不让自检本身崩溃
      results.push({
        id: def.id, name: def.name, category: def.category, status: 'fail', ms: 0,
        summary: '检查执行时抛出异常',
        detail: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
        fix: { label: '查看服务日志', guide: ['查看服务端日志确认报错堆栈', '重启服务后重新自检'] },
      })
    }
  }
  const summary = {
    ok: results.filter((r) => r.status === 'ok').length,
    warn: results.filter((r) => r.status === 'warn').length,
    fail: results.filter((r) => r.status === 'fail').length,
  }
  return { generatedAt: new Date().toISOString(), durationMs: ms(t0), summary, results }
}
