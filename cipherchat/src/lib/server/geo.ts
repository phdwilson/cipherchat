// IP 地理位置查询（带内存 + 数据库双层缓存；仅使用相对导入，供两个服务共用）
import { createHash } from 'crypto'
import { db } from '../db'

export interface GeoInfo {
  ip: string
  region: string // 如 "中国 广东 深圳" / "局域网" / "未知"
  flagEmoji?: string
  networkType: 'lan' | 'wan' | 'unknown' // 局域网 / 公网 / 未知
}

// v1.7.0：内存缓存加上限（此前每个唯一 IP 永久驻留，可被伪造 XFF 撑爆内存）
const MEM_CACHE_MAX = 4096
const memCache = new Map<string, GeoInfo>()

// v1.7.0：可信代理开关。仅当部署方显式声明前端是可信反代（Caddy/Nginx）时
// 才信任 X-Real-IP / X-Forwarded-For；否则这些头可被任意客户端伪造，
// 从而绕过所有按 IP 的限流与审计。默认开启以保持既有部署兼容。
const TRUST_PROXY = process.env.TRUST_PROXY !== 'off'
const FLAG_MAP: Record<string, string> = {
  中国: '🇨🇳', 美国: '🇺🇸', 日本: '🇯🇵', 韩国: '🇰🇷', 新加坡: '🇸🇬',
  德国: '🇩🇪', 英国: '🇬🇧', 法国: '🇫🇷', 加拿大: '🇨🇦', 澳大利亚: '🇦🇺',
  俄罗斯: '🇷🇺', 印度: '🇮🇳', 巴西: '🇧🇷', 荷兰: '🇳🇱', 香港: '🇭🇰',
  台湾: '🇹🇼', 澳门: '🇲🇴', 泰国: '🇹🇭', 越南: '🇻🇳', 马来西亚: '🇲🇾',
  菲律宾: '🇵🇭', 印度尼西亚: '🇮🇩', 意大利: '🇮🇹', 西班牙: '🇪🇸', 瑞士: '🇨🇭',
  瑞典: '🇸🇪', 土耳其: '🇹🇷', 阿联酋: '🇦🇪',
}

// 本地去重（不再污染全局 Array.prototype）
function uniq<T>(arr: T[]): T[] {
  return Array.from(new Set(arr))
}

function isPrivate(ip: string) {
  const normalized = ip.startsWith('::ffff:') ? ip.slice(7) : ip
  if (!normalized) return true
  return (
    normalized === '::1' ||
    normalized.startsWith('127.') ||
    normalized.startsWith('10.') ||
    normalized.startsWith('192.168.') ||
    normalized.startsWith('169.254.') ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(normalized) ||
    normalized === 'unknown'
  )
}

// 由两位 ISO 国家码生成国旗 emoji（如 CN -> 🇨🇳）
function flagFromCode(code?: string): string | undefined {
  if (!code || code.length !== 2) return undefined
  const base = 0x1f1e6
  const cc = code.toUpperCase()
  return String.fromCodePoint(base + (cc.charCodeAt(0) - 65), base + (cc.charCodeAt(1) - 65))
}

async function fetchWithTimeout(url: string, ms = 4000): Promise<Response | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  try {
    return await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': 'CipherChat/1.0' } })
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

// 顺序尝试多个免费 IP 信息源，返回 [地区文本, ISO 国家码]
async function lookupOnline(ip: string): Promise<{ region: string; code?: string } | null> {
  // 1) ipwho.is（https，含城市）
  try {
    const r1 = await fetchWithTimeout(`https://ipwho.is/${encodeURIComponent(ip)}`)
    if (r1 && r1.ok) {
      const j: any = await r1.json()
      if (j && j.success !== false && (j.country || j.city)) {
        return {
          region: uniq([j.country, j.region, j.city].filter(Boolean)).slice(0, 3).join(' '),
          code: j.country_code,
        }
      }
    }
  } catch { /* next */ }
  // 2) ip-api.com（http，中文）
  try {
    const r2 = await fetchWithTimeout(
      `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=country,countryCode,regionName,city&lang=zh-CN`
    )
    if (r2 && r2.ok) {
      const j: any = await r2.json()
      if (j && (j.country || j.city)) {
        return {
          region: uniq([j.country, j.regionName, j.city].filter(Boolean)).slice(0, 3).join(' '),
          code: j.countryCode,
        }
      }
    }
  } catch { /* give up */ }
  return null
}

export async function resolveGeo(ip: string): Promise<GeoInfo> {
  const key = createHash('sha256').update(ip || '').digest('hex').slice(0, 16)
  const info = (region: string, code?: string): GeoInfo => ({
    ip,
    region,
    flagEmoji: flagFromCode(code) || FLAG_MAP[region.split(' ')[0]],
    networkType: isPrivate(ip) ? 'lan' : 'wan',
  })

  if (isPrivate(ip)) return info('局域网')

  const mem = memCache.get(key)
  if (mem) return mem
  // v1.7.0：缓存已满时驱逐最旧一条（Map 迭代序即插入序，近似 FIFO），防内存无界增长
  if (memCache.size >= MEM_CACHE_MAX) {
    const oldest = memCache.keys().next().value
    if (oldest !== undefined) memCache.delete(oldest)
  }

  // 数据库缓存（7 天有效期）
  try {
    const row = await db.ipCache.findUnique({ where: { ip: key } })
    if (row && Date.now() - row.updatedAt.getTime() < 7 * 24 * 3600 * 1000) {
      const g = info(row.region)
      memCache.set(key, g)
      return g
    }
  } catch { /* ignore */ }

  const hit = await lookupOnline(ip)
  const g = hit ? info(hit.region, hit.code) : info('未知地区')
  memCache.set(key, g)
  try {
    await db.ipCache.upsert({
      where: { ip: key },
      create: { ip: key, region: g.region },
      update: { ip: key, region: g.region, updatedAt: new Date() },
    })
  } catch { /* ignore */ }
  return g
}

// 从请求头中提取客户端真实 IP（可信反代如 Caddy 会注入 X-Real-IP / X-Forwarded-For）
// v1.7.0：仅当 TRUST_PROXY=on（默认）时才信任转发头，否则回退到 TCP 对端地址，防伪造绕限流
export function clientIpFromHeaders(
  h: Record<string, string | string[] | undefined>,
  fallbackIp?: string,
): string {
  if (TRUST_PROXY) {
    const real = h['x-real-ip']
    if (typeof real === 'string' && real) return real.split(',')[0].trim()
    const xff = h['x-forwarded-for']
    if (typeof xff === 'string' && xff) return xff.split(',')[0].trim()
  }
  if (typeof fallbackIp === 'string' && fallbackIp) return normalizeIp(fallbackIp)
  return ''
}

// 去除 IPv6 映射前缀（::ffff:1.2.3.4 → 1.2.3.4），与 isPrivate 判断保持一致
export function normalizeIp(ip: string): string {
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip
}
