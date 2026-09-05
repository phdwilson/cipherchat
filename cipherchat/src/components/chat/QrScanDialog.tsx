'use client'
// 二维码扫码加入入口（v1.4.3）：ChatJoin 表单内直接扫描邀请二维码
// 使用 Barcode Detection API（Chrome/Edge/Android 原生支持），
// 不支持的浏览器回退为「上传二维码图片解码」
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { ScanLine, Loader2, X, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'

// 从邀请 URL 中提取短码（#/invite=CODE）
export function extractInviteCodeFromText(text: string): string | null {
  const m = text.match(/invite=([A-Za-z0-9]{8,32})/)
  return m ? m[1] : null
}

export function QrScanDialog({
  onCode,
  onClose,
}: {
  onCode: (code: string) => void
  onClose: () => void
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [scanning, setScanning] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const rafRef = useRef<number>(0)

  useEffect(() => {
    let cancelled = false
    const start = async () => {
      try {
        // @ts-expect-error BarcodeDetector 类型尚未进入 TS 标准库
        if (typeof window.BarcodeDetector === 'undefined') {
          setErr('当前浏览器不支持摄像头扫码（需 Chrome/Edge）。可截图后用下方「从图片识别」。')
          return
        }
        // @ts-expect-error 同上
        const detector = new window.BarcodeDetector({ formats: ['qr_code'] })
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return }
        streamRef.current = stream
        setScanning(true)
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          await videoRef.current.play()
        }
        const tick = async () => {
          if (cancelled || !videoRef.current) return
          try {
            const codes = await detector.detect(videoRef.current)
            for (const c of codes) {
              const raw = c.rawValue || ''
              const code = extractInviteCodeFromText(raw)
              if (code) {
                stop()
                onCode(code)
                return
              }
            }
          } catch { /* 单帧失败忽略 */ }
          rafRef.current = requestAnimationFrame(tick)
        }
        void tick()
      } catch (e) {
        setErr(e instanceof Error && e.name === 'NotAllowedError'
          ? '摄像头权限被拒绝，请允许后重试，或使用「从图片识别」'
          : '无法启动摄像头')
      }
    }
    const stop = () => {
      cancelled = true
      cancelAnimationFrame(rafRef.current)
      streamRef.current?.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }
    void start()
    return stop
  }, [onCode])

  // 从图片文件识别（不支持摄像头的浏览器兜底）
  const fromFile = async (f: File) => {
    try {
      const bmp = await createImageBitmap(f)
      // @ts-expect-error BarcodeDetector 非标准类型
      if (typeof window.BarcodeDetector === 'undefined') throw new Error('unsupported')
      // @ts-expect-error 同上
      const detector = new window.BarcodeDetector({ formats: ['qr_code'] })
      const codes = await detector.detect(bmp)
      for (const c of codes) {
        const code = extractInviteCodeFromText(c.rawValue || '')
        if (code) { onCode(code); return }
      }
      toast.error('图片中未识别到 CipherChat 邀请二维码')
    } catch {
      toast.error('当前浏览器不支持二维码识别（需 Chrome/Edge）')
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4 backdrop-blur-sm" role="dialog" aria-modal="true">
      <div className="glass w-full max-w-sm rounded-2xl border p-5 shadow-2xl">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-base font-bold"><ScanLine className="h-5 w-5 text-primary" /> 扫码加入</h2>
          <Button variant="ghost" size="icon" className="h-8 w-8 rounded-lg" onClick={() => { streamRef.current?.getTracks().forEach((t) => t.stop()); onClose() }} aria-label="关闭">
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="relative overflow-hidden rounded-xl border bg-black/80 aspect-square">
          { }
          <video ref={videoRef} muted playsInline className="h-full w-full object-cover" />
          {!scanning && !err && (
            <div className="absolute inset-0 grid place-items-center text-white/70"><Loader2 className="h-6 w-6 animate-spin" /></div>
          )}
          {/* 取景框 */}
          {scanning && (
            <div className="pointer-events-none absolute inset-8 rounded-xl border-2 border-primary/70 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]" />
          )}
        </div>
        {err && (
          <p className="mt-3 rounded-xl bg-red-500/10 px-3 py-2 text-[12px] leading-relaxed text-red-600 dark:text-red-400">{err}</p>
        )}
        <label className="mt-3 flex cursor-pointer items-center justify-center gap-1.5 rounded-xl border px-3 py-2 text-[13px] font-medium hover:bg-muted/50">
          <Upload className="h-4 w-4" /> 从图片识别二维码
          <input type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void fromFile(f) }} />
        </label>
      </div>
    </div>
  )
}
