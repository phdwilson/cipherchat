// 聊天文件下载（流式返回密文，客户端解密）
// v1.7.0 闪照：viewOnce 文件首个设备开始下载即锁定（原子置 viewOnceBurnedAt），
// 流结束后彻底删除磁盘密文与数据库行 —— 第二次下载直接 410，服务器真实焚毁
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { verifyChatSession } from '@/lib/server/session'
import { jsonError, sessionToken } from '@/lib/server/api'
import { streamFile, missingChunksAsync, deleteFileDir } from '@/lib/server/filestore'
import { rateLimit } from '@/lib/server/ratelimit'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest, ctx: { params: Promise<{ fileId: string }> }) {
  const token = sessionToken(req)
  const session = token ? await verifyChatSession(token) : null
  if (!session) return jsonError('会话无效或已过期', 401)
  if (!rateLimit('filedl:' + session.pubId, 20, 60_000)) {
    return jsonError('下载过于频繁，请稍后再试', 429)
  }

  const { fileId } = await ctx.params
  if (!/^[0-9a-fA-F-]{36}$/.test(fileId)) return jsonError('文件 ID 不合法')

  const file = await db.chatFile.findUnique({ where: { id: fileId } })
  if (!file || file.channelKeyId !== session.channelKeyId || !file.ready) {
    return jsonError('文件不存在或尚未就绪', 404)
  }

  // ---- v1.7.0 闪照：原子抢占唯一一次下载资格 ----
  if (file.viewOnce) {
    const claimed = await db.chatFile.updateMany({
      where: { id: fileId, viewOnce: true, viewOnceBurnedAt: null },
      data: { viewOnceBurnedAt: new Date() },
    })
    if (claimed.count === 0) {
      return jsonError('⚡ 闪照已被查看并焚毁', 410)
    }
  }

  // 下载前校验分块完整性，缺块直接报错而不是静默拼出必然解密失败的坏流
  // v1.7.0：单次 readdir 的异步校验替代逐块 existsSync（万级分块不再卡事件循环）
  const missing = await missingChunksAsync('chat', fileId, file.totalChunks)
  if (missing.length > 0) {
    console.warn(`[file] ${fileId} 缺失 ${missing.length}/${file.totalChunks} 个分块，拒绝下载`)
    return jsonError('文件分块不完整（可能上传中断或已损坏），无法下载', 409)
  }

  const wireBytes = file.totalBytes // init 时声明的密文总大小（分块密文流长度）
  let burned = false
  const burnOnce = () => {
    if (burned) return
    burned = true
    if (!file.viewOnce) return
    // 密文已送达首个查看者 → 立即焚毁磁盘密文与记录（幂等，失败由定时任务兜底可容忍）
    deleteFileDir('chat', fileId)
    db.chatFile.delete({ where: { id: fileId } }).catch(() => {})
  }

  const source = streamFile('chat', fileId, file.totalChunks)
  // 包一层 ReadableStream：正常读完或客户端中断（cancel）都触发焚毁，
  // 防止反复拉流试探密文
  const guarded = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      const reader = source.getReader()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          ctrl.enqueue(value)
        }
        burnOnce() // 正常读完 → 焚毁
      } finally {
        reader.releaseLock()
      }
      ctrl.close()
    },
    cancel() {
      burnOnce() // 客户端中断也按已查看处理
    },
  })

  return new Response(guarded, {
    headers: {
      'content-type': 'application/octet-stream',
      'cache-control': 'no-store',
      'content-length': String(wireBytes),
      'x-chunk-size-hint': String(file.totalChunks),
    },
  })
}
