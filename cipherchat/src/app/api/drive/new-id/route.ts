// 生成新的网盘 ID（随机 8 位；仅生成，不写库；限流防机器人滥用）
import { NextRequest } from 'next/server'
import { randomInt } from 'crypto'
import { jsonError, jsonOk, reqIp } from '@/lib/server/api'
import { rateLimit } from '@/lib/server/ratelimit'

export const dynamic = 'force-dynamic'

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789' // 去除易混淆字符 I L O 0 1

export function generateDriveId(): string {
  let s = ''
  for (let i = 0; i < 8; i++) s += ALPHABET[randomInt(ALPHABET.length)]
  return s
}

export async function POST(req: NextRequest) {
  const ip = reqIp(req)
  // 防滥用：每个 IP 每小时最多生成 12 次
  if (!rateLimit('drive-newid:' + ip, 12, 3600_000)) {
    return jsonError('操作过于频繁，请一小时后再试', 429)
  }
  return jsonOk({ driveId: generateDriveId() })
}
