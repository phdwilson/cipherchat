// API 路由通用辅助
import { NextRequest } from 'next/server'
import { parseUA } from './ua'
import { clientIpFromHeaders } from './geo'

export function jsonError(message: string, status = 400) {
  return Response.json({ error: message }, { status })
}

export function jsonOk(data: Record<string, unknown> = {}) {
  return Response.json({ ok: true, ...data })
}

export function reqIp(req: NextRequest | Request): string {
  const h = req.headers as unknown as Record<string, string | string[] | undefined>
  // v1.7.0：TRUST_PROXY=off 时回退到 TCP 对端地址（x-forwarded 有信口可伪造）
  let remote = ''
  try {
    const anyReq = req as unknown as { ip?: string }
    if (typeof anyReq.ip === 'string') remote = anyReq.ip
  } catch { /* ignore */ }
  return clientIpFromHeaders(h, remote) || '127.0.0.1'
}

export function reqDeviceLabel(req: NextRequest | Request): string {
  return parseUA(req.headers.get('user-agent') || '').label
}

export function sessionToken(req: NextRequest | Request): string | null {
  const t = req.headers.get('x-session-token')
  return t && t.length >= 32 ? t : null
}
