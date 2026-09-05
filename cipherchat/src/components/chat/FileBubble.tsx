'use client'

import { useEffect, useRef, useState } from 'react'
import {
  Download, Loader2, Play, Eye, Zap, Flame,
} from 'lucide-react'
import { formatBytes, downloadAndDecrypt } from '@/lib/crypto'
import type { ChatFileMeta } from '@/store/chat'
import { useChatStore } from '@/store/chat'
import { TypeIcon } from '@/components/common/TypeIcon'

// v1.7.0：图片自动预览阈值从 15MB 降到 5MB，且必须滚入视口才触发
//（此前挂载即下载解密：翻历史时几十张图并行解密，手机直接烫手）
const AUTO_PREVIEW_IMAGE = 5 * 1024 * 1024
const VIDEO_PREVIEW_MAX = 300 * 1024 * 1024 // 300MB 内视频可在线播放

export function FileBubble({ file, mine }: { file: ChatFileMeta; mine: boolean }) {
  const token = useChatStore((s) => s.token)
  const channelKey = useChatStore((s) => s.channelKey)
  const config = useChatStore((s) => s.config)
  const [busy, setBusy] = useState(false)
  const [imgUrl, setImgUrl] = useState<string | null>(null)
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const revoked = useRef(false)
  // v1.7.0 闪照状态：burned=已被查看（服务器已焚毁，无法再次拉取）
  const [burned, setBurned] = useState(false)
  const [revealed, setRevealed] = useState(false)

  useEffect(() => {
    revoked.current = false
    return () => {
      revoked.current = true
      if (imgUrl) URL.revokeObjectURL(imgUrl)
      if (videoUrl) URL.revokeObjectURL(videoUrl)
    }
  }, [file.fileId, imgUrl, videoUrl])

  const totalChunks = Math.max(1, Math.ceil(file.size / (config?.chunkSize || 4 * 1024 * 1024)))

  // v1.7.0：懒解密 —— IntersectionObserver 观察气泡滚入视口才触发自动预览
  const rootRef = useRef<HTMLDivElement>(null)
  const autoLoaded = useRef(false)
  useEffect(() => {
    if (autoLoaded.current) return
    if (file.viewOnce) return // 闪照绝不自动预览（看一眼就没了）
    const el = rootRef.current
    if (!el || typeof IntersectionObserver === 'undefined') {
      // 无 IO 支持时回退：小图直接加载
      if (file.mime.startsWith('image/') && file.size <= AUTO_PREVIEW_IMAGE && channelKey && token && config) {
        autoLoaded.current = true
        loadPreview()
      }
      return
    }
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting && !autoLoaded.current) {
          autoLoaded.current = true
          io.disconnect()
          if (file.mime.startsWith('image/') && file.size <= AUTO_PREVIEW_IMAGE && channelKey && token && config) {
            loadPreview()
          }
        }
      }
    }, { rootMargin: '200px' })
    io.observe(el)
    return () => io.disconnect()
     
  }, [channelKey, token, config, file.fileId, file.mime, file.size, file.viewOnce])

  const loadPreview = async () => {
    if (!channelKey || !token || !config || busy) return
    setBusy(true)
    setErr(null)
    try {
      const blob = await downloadAndDecrypt({
        fetchers: { url: `/api/chat/file/${file.fileId}`, token },
        key: channelKey,
        fileId: file.fileId,
        totalChunks,
        fileName: file.name,
        mime: file.mime,
        chunkSize: config.chunkSize,
        totalPlainBytes: file.size,
      })
      if (blob && !revoked.current) {
        const url = URL.createObjectURL(blob)
        if (file.mime.startsWith('image/')) setImgUrl(url)
        else setVideoUrl(url)
        setRevealed(true)
      }
    } catch (e) {
      // 410/404 = 闪照已被焚毁（服务器在首次下载后删除密文与记录）
      const msg = e instanceof Error ? e.message : ''
      if (msg.includes('焚毁') || msg.includes('410') || msg.includes('不存在')) setBurned(true)
      else setErr('解密失败')
    } finally {
      setBusy(false)
    }
  }

  const save = async () => {
    if (!channelKey || !token || !config) return
    setBusy(true)
    setErr(null)
    setProgress(0)
    try {
      const blob = await downloadAndDecrypt({
        fetchers: { url: `/api/chat/file/${file.fileId}`, token },
        key: channelKey,
        fileId: file.fileId,
        totalChunks,
        fileName: file.name,
        mime: file.mime,
        chunkSize: config.chunkSize,
        totalPlainBytes: file.size,
        onProgress: (b, t) => t > 0 && setProgress(Math.round((b / t) * 100)),
      })
      if (blob) {
        const a = document.createElement('a')
        a.href = URL.createObjectURL(blob)
        a.download = file.name
        a.click()
        setTimeout(() => URL.revokeObjectURL(a.href), 10000)
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : ''
      if (msg.includes('焚毁') || msg.includes('410') || msg.includes('不存在')) setBurned(true)
      else setErr('下载失败')
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  // ---------- v1.7.0 闪照卡片：遮罩 + 点击查看一次 ----------
  if (file.viewOnce) {
    return (
      <div ref={rootRef} className={`relative w-[240px] overflow-hidden rounded-2xl ${mine ? 'bg-white/15' : 'bg-black/[0.04] dark:bg-white/[0.06]'} border ${mine ? 'border-white/20' : 'border-black/5 dark:border-white/10'}`}>
        {imgUrl ? (
          <img src={imgUrl} alt={file.name} className="block h-auto w-full max-h-[380px] object-cover" />
        ) : burned ? (
          <div className="flex h-[180px] flex-col items-center justify-center gap-2 text-center">
            <Flame className="h-8 w-8 text-orange-500" />
            <p className="text-sm font-semibold">⚡ 闪照已焚毁</p>
            <p className="px-4 text-[11px] opacity-60">照片已被查看，服务器密文已删除，无法再次查看</p>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => { if (!busy && !revealed) void loadPreview() }}
            className="flex h-[180px] w-full flex-col items-center justify-center gap-2"
            aria-label="查看闪照（仅一次）"
          >
            {busy ? (
              <>
                <Loader2 className="h-8 w-8 animate-spin text-amber-500" />
                <p className="text-xs opacity-70">解密中…</p>
              </>
            ) : (
              <>
                <Zap className="h-8 w-8 text-amber-500" />
                <p className="text-sm font-bold">⚡ 闪照 · 点击查看</p>
                <p className="text-[11px] opacity-60">仅可查看一次，离开即焚毁</p>
                <p className="text-[10px] opacity-40">{formatBytes(file.size)}</p>
              </>
            )}
          </button>
        )}
        {err && <p className="px-3 pb-2 text-[11px] text-red-400">{err}</p>}
      </div>
    )
  }

  // ---------- 普通文件/图片/视频卡片 ----------
  return (
    <div ref={rootRef} className={`rounded-2xl overflow-hidden ${mine ? 'bg-white/15' : 'bg-black/[0.04] dark:bg-white/[0.06]'} border ${mine ? 'border-white/20' : 'border-black/5 dark:border-white/10'}`}>
      {/* 图片预览 */}
      {imgUrl && (
        <button
          onClick={() => window.open(imgUrl, '_blank')}
          className="block w-full max-w-[320px] sm:max-w-[360px] cursor-zoom-in"
        >
          <img src={imgUrl} alt={file.name} className="w-full h-auto object-cover max-h-[380px]" loading="lazy" />
        </button>
      )}
      {/* 视频预览 */}
      {videoUrl && (
        <video src={videoUrl} controls className="w-full max-w-[360px] max-h-[380px] bg-black" preload="metadata" />
      )}

      <div className="flex items-center gap-3 p-3 min-w-0">
        <span className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${mine ? 'bg-white/20 text-white' : 'bg-violet-500/10 text-violet-600 dark:text-violet-400'}`}>
          <TypeIcon mime={file.mime} size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{file.name}</p>
          <p className="text-[11px] opacity-70">{formatBytes(file.size)}</p>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {err && <span className="text-[11px] text-red-400 mr-1">{err}</span>}
          {/* 自动预览小图 / 按钮预览大图与视频 */}
          {!imgUrl && !videoUrl && file.mime.startsWith('image/') && file.size <= AUTO_PREVIEW_IMAGE && busy === false && (
            <button onClick={loadPreview} title="预览" className="inline-flex h-9 w-9 items-center justify-center rounded-full hover:bg-black/10 dark:hover:bg-white/10 transition-colors">
              <Eye className="h-4 w-4" />
            </button>
          )}
          {!imgUrl && !videoUrl && file.mime.startsWith('image/') && file.size > AUTO_PREVIEW_IMAGE && (
            <button onClick={loadPreview} title="解密预览大图" className="inline-flex h-9 w-9 items-center justify-center rounded-full hover:bg-black/10 dark:hover:bg-white/10 transition-colors">
              <Eye className="h-4 w-4" />
            </button>
          )}
          {!imgUrl && !videoUrl && file.mime.startsWith('video/') && file.size <= VIDEO_PREVIEW_MAX && (
            <button onClick={loadPreview} title="播放" className="inline-flex h-9 w-9 items-center justify-center rounded-full hover:bg-black/10 dark:hover:bg-white/10 transition-colors">
              <Play className="h-4 w-4" />
            </button>
          )}
          <button
            onClick={save}
            disabled={busy}
            title="下载（本地解密）"
            className="inline-flex h-9 w-9 items-center justify-center rounded-full hover:bg-black/10 dark:hover:bg-white/10 transition-colors disabled:opacity-50"
          >
            {busy && progress === null ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : busy && progress !== null ? (
              <span className="text-[10px] font-semibold">{progress}%</span>
            ) : (
              <Download className="h-4 w-4" />
            )}
          </button>
        </div>
      </div>
      {busy && progress !== null && (
        <div className="h-0.5 bg-black/10 dark:bg-white/10">
          <div className="h-full bg-current opacity-60 transition-all" style={{ width: `${progress}%` }} />
        </div>
      )}
    </div>
  )
}
