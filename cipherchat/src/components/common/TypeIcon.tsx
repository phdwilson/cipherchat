'use client'

// 文件类型图标（统一组件，避免在 render 中动态创建组件）
import {
  FileText, FileImage, FileVideo, FileAudio, FileArchive, File as FileIcon, Loader2,
} from 'lucide-react'

export function TypeIcon({ mime, size = 20, busy = false }: { mime: string; size?: number; busy?: boolean }) {
  if (busy) return <Loader2 style={{ width: size, height: size }} className="animate-spin" />
  let Icon = FileIcon
  if (mime.startsWith('image/')) Icon = FileImage
  else if (mime.startsWith('video/')) Icon = FileVideo
  else if (mime.startsWith('audio/')) Icon = FileAudio
  else if (/zip|rar|7z|tar|gz/.test(mime)) Icon = FileArchive
  else if (mime.startsWith('text/') || /pdf|word|doc|xls|ppt/.test(mime)) Icon = FileText
  return <Icon style={{ width: size, height: size }} />
}

export function typeGradient(mime: string) {
  if (mime.startsWith('image/')) return 'from-violet-400 to-fuchsia-500 shadow-violet-500/25'
  if (mime.startsWith('video/')) return 'from-rose-400 to-red-500 shadow-rose-500/25'
  if (mime.startsWith('audio/')) return 'from-amber-400 to-orange-500 shadow-amber-500/25'
  if (/zip|rar|7z|tar|gz/.test(mime)) return 'from-yellow-400 to-amber-500 shadow-yellow-500/25'
  return 'from-fuchsia-400 to-pink-500 shadow-fuchsia-500/25'
}
