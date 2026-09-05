'use client'
// 语音消息气泡：点击播放/暂停，本地解密后用 Audio 播放
// v1.8.0：播放/加载失败不再静默 —— 每类失败给出原因与修复方式
import { useEffect, useRef, useState } from 'react'
import { Play, Pause, Loader2, AlertCircle } from 'lucide-react'
import { toast } from 'sonner'
import { downloadAndDecrypt, formatBytes } from '@/lib/crypto'
import { useChatStore, type VoiceClipMeta } from '@/store/chat'
import { explainError, errorToastDescription } from '@/lib/errors'
import { cn } from '@/lib/utils'

export function VoiceBubble({ voice, mine }: { voice: VoiceClipMeta; mine: boolean }) {
  const { token, channelKey, config } = useChatStore()
  const [url, setUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [progress, setProgress] = useState(0)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const revoked = useRef(false)

  // 总块数
  const totalChunks = Math.max(1, Math.ceil(voice.size / (config?.chunkSize || 4 * 1024 * 1024)))

  useEffect(() => {
    revoked.current = false
    return () => {
      revoked.current = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [voice.fileId, url])

  const load = async () => {
    if (!channelKey || !token || !config || busy) return
    if (url) return // 已加载
    setBusy(true)
    setErr(null)
    try {
      const blob = await downloadAndDecrypt({
        fetchers: { url: `/api/chat/file/${voice.fileId}`, token },
        key: channelKey,
        fileId: voice.fileId,
        totalChunks,
        fileName: `voice-${voice.fileId}.webm`,
        mime: 'audio/webm',
        chunkSize: config.chunkSize,
        totalPlainBytes: voice.size,
      })
      if (blob && !revoked.current) {
        const u = URL.createObjectURL(blob)
        setUrl(u)
        // 加载完直接播放
        requestAnimationFrame(() => {
          const a = audioRef.current
          if (a) {
            a.src = u
            // v1.8.0：autoplay 被拒不再静默吞掉 —— 告知用户原因（浏览器自动播放策略）与解法
            a.play().catch((playErr: DOMException) => {
              if (playErr?.name === 'NotAllowedError') {
                toast.warning('自动播放被浏览器拦截', {
                  description: '原因：浏览器的自动播放策略要求用户先与页面交互。\n处理：点击本条语音的播放按钮即可正常播放（之后自动播放会恢复）。',
                  duration: 8000,
                })
              }
            })
          }
        })
      }
    } catch (e) {
      // v1.8.0：下载/解密失败带原因与修复方式（区分会话过期/网络/密钥不匹配）
      const ex = explainError(e, '语音加载')
      setErr(ex.title)
      toast.error(ex.title, { description: errorToastDescription(ex), duration: 10000 })
    } finally {
      setBusy(false)
    }
  }

  const toggle = async () => {
    if (err) { setErr(null); await load(); return }
    if (!url) { await load(); return }
    const a = audioRef.current
    if (!a) return
    if (playing) { a.pause() } else {
      // v1.8.0：手动点击播放失败也要告知原因，不再静默
      try {
        await a.play()
      } catch (playErr) {
        const name = playErr instanceof DOMException ? playErr.name : ''
        if (name === 'NotAllowedError') {
          toast.error('浏览器拒绝播放', { description: '原因：自动播放策略。\n处理：再次点击播放按钮（用户手势已满足策略）即可。' })
        } else {
          toast.error('播放失败', { description: `原因：${playErr instanceof Error ? playErr.message : '未知'}，可能是音频编码不受支持。\n处理：换用 Chrome/Edge/Firefox 最新版重试。` })
        }
      }
    }
  }

  return (
    <div className={cn('flex items-center gap-2 py-1.5 px-1', mine ? 'flex-row-reverse' : 'flex-row')}>
      <button
        onClick={() => void toggle()}
        disabled={busy}
        className={cn(
          'inline-flex h-10 w-10 items-center justify-center rounded-full transition-transform active:scale-95 disabled:opacity-50',
          mine ? 'bg-white/20 text-white' : 'bg-violet-500/15 text-violet-600 dark:text-violet-400',
        )}
        aria-label={playing ? '暂停' : '播放语音'}
      >
        {busy ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : err ? (
          <AlertCircle className="h-4 w-4 text-red-300" />
        ) : playing ? (
          <Pause className="h-4 w-4" />
        ) : (
          <Play className="h-4 w-4 translate-x-0.5" />
        )}
      </button>

      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-1.5">
          {/* 进度条 + 时长 */}
          <div className="relative h-1 flex-1 rounded-full bg-black/10 dark:bg-white/15 overflow-hidden">
            <div
              className="absolute inset-y-0 left-0 transition-all rounded-full"
              style={{ width: `${Math.min(progress * 100, 100)}%`, background: mine ? 'rgba(255,255,255,0.55)' : 'currentColor', opacity: mine ? 1 : 0.55 }}
            />
          </div>
          <span className={cn('text-[11px] tabular-nums', mine ? 'text-white/70' : 'text-muted-foreground')}>
            {voice.duration.toFixed(1)}″
          </span>
        </div>
        {err && (
          <span className={cn('text-[10px]', mine ? 'text-white/60' : 'text-red-500')}>{err}（点击重试）</span>
        )}
        {!err && (
          <span className={cn('text-[10px]', mine ? 'text-white/55' : 'text-muted-foreground/70')}>
            {formatBytes(voice.size)} · 点击播放
          </span>
        )}
      </div>

      <audio
        ref={audioRef}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => { setPlaying(false); setProgress(0) }}
        // v1.8.0：解码/格式错误不再静默 —— 浏览器支持的编码不同时给出明确提示
        onError={() => {
          setErr('音频无法解码')
          toast.error('语音无法播放', {
            description: '原因：录音编码（webm/opus 等）不被当前浏览器解码。\n处理：换用 Chrome / Edge / Firefox 最新版；若所有浏览器都失败，则录音可能损坏。',
            duration: 10000,
          })
        }}
        onTimeUpdate={(e) => {
          const a = e.currentTarget
          if (a.duration > 0) setProgress(a.currentTime / a.duration)
        }}
        preload="metadata"
      />
    </div>
  )
}
