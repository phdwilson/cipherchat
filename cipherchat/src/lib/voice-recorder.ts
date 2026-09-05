'use client'
// 浏览器麦克风录音器：MediaRecorder → webm/opus Blob
// 微信式按住→松开发送→上滑取消的录音控制使用此类

export class VoiceRecorder {
  private stream: MediaStream | null = null
  private recorder: MediaRecorder | null = null
  private chunks: Blob[] = []
  private startTime = 0
  private mime = 'audio/webm'

  async start(): Promise<void> {
    if (this.recorder) return
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    })
    // 优先选择 opus 编码（Chrome/Firefox 支持，Safari 用 mp4 兜底）
    const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']
    let picked = ''
    for (const m of candidates) {
      if (MediaRecorder.isTypeSupported(m)) { picked = m; break }
    }
    this.recorder = picked ? new MediaRecorder(this.stream, { mimeType: picked }) : new MediaRecorder(this.stream)
    if (picked) this.mime = picked
    this.chunks = []
    this.recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this.chunks.push(e.data)
    }
    this.recorder.start(250) // 每 250ms 触发一次 dataavailable
    this.startTime = Date.now()
  }

  // 结束录音，返回 { blob, durationSec }
  // onCancel=true 时仅清理，不返回数据
  stop(): Promise<{ blob: Blob; durationSec: number; mime: string } | null> {
    return new Promise((resolve) => {
      if (!this.recorder || this.recorder.state === 'inactive') {
        this.cleanup()
        resolve(null)
        return
      }
      const rec = this.recorder
      rec.onstop = () => {
        const duration = (Date.now() - this.startTime) / 1000
        if (this.chunks.length === 0) {
          this.cleanup()
          resolve(null)
          return
        }
        const blob = new Blob(this.chunks, { type: this.mime })
        this.cleanup()
        resolve({ blob, durationSec: Math.max(0.1, duration), mime: this.mime })
      }
      try {
        rec.stop()
      } catch {
        this.cleanup()
        resolve(null)
      }
    })
  }

  cancel(): void {
    if (this.recorder && this.recorder.state !== 'inactive') {
      try { this.recorder.stop() } catch { /* ignore */ }
    }
    this.cleanup()
  }

  private cleanup(): void {
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    this.recorder = null
    this.chunks = []
  }

  get elapsedSec(): number {
    return (Date.now() - this.startTime) / 1000
  }
}

// 把 Blob 体积友好显示（KB / MB）
export function formatBlobSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}
