// 内存滑动窗口限流器（简单高效，适用于单实例部署）
const buckets = new Map<string, number[]>() // key -> timestamps

export function rateLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now()
  const arr = (buckets.get(key) || []).filter((t) => now - t < windowMs)
  if (arr.length >= max) {
    buckets.set(key, arr)
    return false
  }
  arr.push(now)
  buckets.set(key, arr)
  // 防止内存无限增长
  if (buckets.size > 10000) {
    for (const [k, v] of buckets) {
      if (!v.some((t) => now - t < windowMs)) buckets.delete(k)
    }
  }
  return true
}

export function rateLimitRemaining(key: string, windowMs: number): number {
  const now = Date.now()
  const arr = (buckets.get(key) || []).filter((t) => now - t < windowMs)
  return arr.length
}
