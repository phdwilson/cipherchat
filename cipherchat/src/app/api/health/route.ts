// 健康检查
export const dynamic = 'force-dynamic'

export function GET() {
  return Response.json({ ok: true, ts: Date.now() })
}
