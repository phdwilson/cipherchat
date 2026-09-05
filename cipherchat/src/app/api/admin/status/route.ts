// 管理员配置状态（是否已初始化）—— 公开，供前端决定显示初始化表单还是解锁表单
import { isAdminInitialized } from '@/lib/server/admin'

export const dynamic = 'force-dynamic'

export async function GET() {
  return Response.json({ initialized: await isAdminInitialized() })
}
