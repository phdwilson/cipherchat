// HTTPS 域名绑定（写入待应用配置；实际 Caddy 重载需在服务器执行一条 sudo 命令，避免 Web 进程持有 root 权限）
import { NextRequest } from 'next/server'
import { verifySuperKeyHash, isAdminInitialized } from '@/lib/server/admin'
import { writeHttpsPending, readHttpsPending, clearHttpsPending } from '@/lib/server/admin-https'
import { jsonError, jsonOk, reqIp } from '@/lib/server/api'
import { rateLimit } from '@/lib/server/ratelimit'

export const dynamic = 'force-dynamic'

const VALID_MODES = ['self-signed', 'acme-dns', 'acme-http01', 'custom']

export async function POST(req: NextRequest) {
  const ip = reqIp(req)
  if (!rateLimit('admin-https-bind:' + ip, 20, 3600_000)) {
    return jsonError('请求过于频繁，请稍后再试', 429)
  }

  let body: { adminKeyHash?: string; domain?: string; mode?: string; action?: string }
  try {
    body = await req.json()
  } catch {
    return jsonError('请求格式错误')
  }

  const h = (body.adminKeyHash || '').trim().toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(h)) return jsonError('数据格式错误')
  if (!(await isAdminInitialized())) return jsonError('管理员密钥尚未初始化', 403)
  if (!(await verifySuperKeyHash(h))) return jsonError('超级密钥错误', 403)

  // 撤销待应用配置
  if (body.action === 'clear-pending') {
    clearHttpsPending()
    return jsonOk({ message: '已撤销待应用的 HTTPS 配置' })
  }

  const domain = (body.domain || '').trim().toLowerCase()
  const mode = (body.mode || '').trim()

  if (!VALID_MODES.includes(mode)) return jsonError('模式不合法')
  if (mode !== 'self-signed' && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
    return jsonError('请输入有效的域名（例如 chat.example.com）')
  }
  if (mode === 'self-signed' && domain && !/^[a-z0-9.:-]+$/.test(domain)) {
    return jsonError('自签模式下可留空或填 IP/主机名')
  }

  writeHttpsPending(domain, mode)

  return jsonOk({
    message: '已保存待应用配置。请在服务器上执行以下命令完成证书签发与 Caddy 重载：',
    applyCommand: 'sudo bash /opt/cipherchat/deploy/https.sh --apply-pending',
    pending: readHttpsPending(),
  })
}
