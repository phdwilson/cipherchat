'use client'

import { useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { toast } from 'sonner'
import {
  Upload, Search, LayoutGrid, List, Lock, Download, Trash2, Pencil, X, Check,
  Loader2, RefreshCw, HardDrive, FolderLock,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useDriveStore, type DriveFileItem } from '@/store/drive'
import { useChatStore } from '@/store/chat'
import { formatBytes, downloadAndDecrypt } from '@/lib/crypto'
import { explainError, errorToastDescription } from '@/lib/errors'
import { TypeIcon, typeGradient } from '@/components/common/TypeIcon'

export function DriveScreen({ onExit }: { onExit: () => void }) {
  const { driveId, files, usedBytes, quotaBytes, uploads, refresh, uploadFiles, deleteFiles, deleteAll, rename, lock, listLoading } = useDriveStore()
  const { token, channelKey } = { token: useDriveStore((s) => s.token), channelKey: useDriveStore((s) => s.driveKey) }
  const cfg = useChatStore((s) => s.config)

  const [view, setView] = useState<'grid' | 'list'>('grid')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [renameTarget, setRenameTarget] = useState<DriveFileItem | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [previewName, setPreviewName] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [progress, setProgress] = useState<{ id: string; pct: number } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const shown = useMemo(
    () => (query ? files.filter((f) => f.name.toLowerCase().includes(query.toLowerCase())) : files),
    [files, query]
  )
  const pct = quotaBytes > 0 ? Math.min(100, (usedBytes / quotaBytes) * 100) : 0

  const toggleSel = (id: string) =>
    setSelected((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  const doDownload = async (f: DriveFileItem) => {
    if (!channelKey || !token || !cfg) return
    setBusyId(f.id)
    setProgress({ id: f.id, pct: 0 })
    try {
      const blob = await downloadAndDecrypt({
        fetchers: { url: `/api/drive/files/${f.id}`, token },
        key: channelKey,
        fileId: f.id,
        totalChunks: f.totalChunks,
        fileName: f.name,
        mime: f.mime,
        chunkSize: cfg.chunkSize,
        totalPlainBytes: f.size,
        onProgress: (b, t) => t > 0 && setProgress({ id: f.id, pct: Math.round((b / t) * 100) }),
      })
      if (blob) {
        const a = document.createElement('a')
        a.href = URL.createObjectURL(blob)
        a.download = f.name
        a.click()
        setTimeout(() => URL.revokeObjectURL(a.href), 10000)
      }
    } catch (e) {
      // 用户主动取消保存对话框不是错误
      if (e instanceof DOMException && (e.name === 'AbortError' || e.name === 'NotAllowedError')) {
        toast.message('已取消下载')
      } else {
        // v1.8.0：下载/解密失败不再静默 —— 告知原因与修复方式
        const ex = explainError(e, `下载「${f.name}」`)
        toast.error(ex.title, { description: errorToastDescription(ex), duration: 10000 })
      }
    } finally {
      setBusyId(null)
      setProgress(null)
    }
  }

  const doPreview = async (f: DriveFileItem) => {
    if (!channelKey || !token || !cfg) return
    setBusyId(f.id)
    try {
      const blob = await downloadAndDecrypt({
        fetchers: { url: `/api/drive/files/${f.id}`, token },
        key: channelKey,
        fileId: f.id,
        totalChunks: f.totalChunks,
        fileName: f.name,
        mime: f.mime,
        chunkSize: cfg.chunkSize,
        totalPlainBytes: f.size,
      })
      if (blob) {
        setPreviewUrl(URL.createObjectURL(blob))
        setPreviewName(f.name)
      }
    } catch (e) {
      if (e instanceof DOMException && (e.name === 'AbortError' || e.name === 'NotAllowedError')) {
        toast.message('已取消预览')
      } else {
        // v1.8.0：预览失败同样告知原因与修复方式
        const ex = explainError(e, `预览「${f.name}」`)
        toast.error(ex.title, { description: errorToastDescription(ex), duration: 10000 })
      }
    } finally {
      setBusyId(null)
    }
  }

  const handleFiles = (list: FileList | null) => {
    if (!list || list.length === 0) return
    uploadFiles(Array.from(list))
  }

  return (
    <div
      className="flex flex-col h-[100dvh] sm:h-[calc(100dvh-4.5rem)] sm:rounded-[28px] sm:my-9 overflow-hidden bg-white/55 dark:bg-zinc-950/55 backdrop-blur-2xl border border-black/[0.06] dark:border-white/[0.08] shadow-2xl max-w-5xl w-full mx-auto relative"
      onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => { e.preventDefault(); setDragOver(false); handleFiles(e.dataTransfer.files) }}
    >
      {/* 拖拽遮罩 */}
      <AnimatePresence>
        {dragOver && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-3 bg-fuchsia-500/90 backdrop-blur-sm text-white"
          >
            <Upload className="h-12 w-12" />
            <p className="text-base font-semibold">松手即加密上传到你的网盘</p>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 顶栏 */}
      <header className="flex items-center gap-2 px-3 sm:px-5 py-2.5 border-b border-black/[0.05] dark:border-white/[0.08] bg-white/40 dark:bg-zinc-900/40 backdrop-blur-xl z-10">
        <Button variant="ghost" size="sm" onClick={onExit} className="rounded-full gap-1.5 h-9 px-3 text-[13px]">
          <Lock className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">锁定</span>
        </Button>
        <div className="flex-1 min-w-0 text-center">
          <div className="flex items-center justify-center gap-1.5">
            <FolderLock className="h-4 w-4 text-fuchsia-500 shrink-0" />
            <span className="font-semibold font-mono tracking-widest select-all">{driveId}</span>
          </div>
          <div className="flex items-center justify-center gap-2 text-[11px] text-muted-foreground">
            <span>{formatBytes(usedBytes, 1)} / {formatBytes(quotaBytes, 0)}</span>
            <span className="w-24 h-1 rounded-full bg-black/10 dark:bg-white/15 overflow-hidden inline-flex">
              <span className="h-full bg-gradient-to-r from-fuchsia-400 to-pink-500 transition-all" style={{ width: `${pct}%` }} />
            </span>
          </div>
        </div>
        <Button variant="ghost" size="icon" onClick={() => refresh()} className="rounded-full h-9 w-9 text-muted-foreground" title="刷新">
          {listLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
        </Button>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="ghost" size="icon" className="rounded-full h-9 w-9 text-muted-foreground hover:text-red-500" title="清空网盘">
              <Trash2 className="h-4 w-4" />
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent className="rounded-2xl">
            <AlertDialogHeader>
              <AlertDialogTitle>清空整个网盘？</AlertDialogTitle>
              <AlertDialogDescription>所有加密文件将被永久删除，无法恢复。</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel className="rounded-xl">取消</AlertDialogCancel>
              <AlertDialogAction onClick={() => deleteAll()} className="rounded-xl bg-red-500 hover:bg-red-600 text-white">全部删除</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </header>

      {/* 工具栏 */}
      <div className="flex items-center gap-2 px-3 sm:px-5 py-2.5 border-b border-black/[0.04] dark:border-white/[0.06]">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索文件（本地解密匹配）"
            className="h-9 pl-9 rounded-full text-[13px] bg-black/[0.03] dark:bg-white/[0.05] border-transparent"
          />
        </div>
        <div className="flex-1" />
        {selected.size > 0 && (
          <Button variant="destructive" size="sm" className="rounded-full h-9 gap-1.5" onClick={() => { deleteFiles([...selected]); setSelected(new Set()) }}>
            <Trash2 className="h-3.5 w-3.5" /> 删除所选 ({selected.size})
          </Button>
        )}
        <Button
          variant="ghost" size="icon"
          className="h-9 w-9 rounded-full text-muted-foreground"
          onClick={() => setView((v) => (v === 'grid' ? 'list' : 'grid'))}
          title={view === 'grid' ? '切换列表视图' : '切换网格视图'}
        >
          {view === 'grid' ? <List className="h-4 w-4" /> : <LayoutGrid className="h-4 w-4" />}
        </Button>
        <Button
          onClick={() => fileRef.current?.click()}
          className="rounded-full h-9 gap-1.5 px-4 text-[13px] bg-gradient-to-r from-fuchsia-500 to-pink-500 hover:from-fuchsia-600 hover:to-pink-600 text-white shadow-md shadow-fuchsia-500/25"
        >
          <Upload className="h-4 w-4" /> 上传
        </Button>
        <input ref={fileRef} type="file" multiple className="hidden" onChange={(e) => { handleFiles(e.target.files); e.target.value = '' }} />
      </div>

      {/* 文件区 */}
      <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-4">
        {files.length === 0 && !listLoading && (
          <div className="h-full flex flex-col items-center justify-center text-center gap-3 py-16">
            <span className="inline-flex h-16 w-16 items-center justify-center rounded-3xl bg-fuchsia-500/10">
              <HardDrive className="h-8 w-8 text-fuchsia-500" />
            </span>
            <div>
              <p className="font-medium">网盘是空的</p>
              <p className="mt-1 text-[13px] text-muted-foreground">拖拽文件到此处，或点击「上传」按钮 · 单文件最大 5GB</p>
            </div>
          </div>
        )}

        {files.length > 0 && shown.length === 0 && (
          <p className="text-center text-sm text-muted-foreground py-12">没有匹配「{query}」的文件</p>
        )}

        {view === 'grid' ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
            {shown.map((f) => (
              <GridCard
                key={f.id} f={f} selected={selected.has(f.id)}
                busy={busyId === f.id} pct={progress?.id === f.id ? progress.pct : null}
                onToggle={() => toggleSel(f.id)}
                onPreview={() => (f.mime.startsWith('image/') ? doPreview(f) : doDownload(f))}
                onDownload={() => doDownload(f)}
                onRename={() => { setRenameTarget(f); setRenameValue(f.name) }}
                onDelete={() => deleteFiles([f.id])}
              />
            ))}
          </div>
        ) : (
          <div className="space-y-1.5">
            {shown.map((f) => (
              <ListRow
                key={f.id} f={f} selected={selected.has(f.id)}
                busy={busyId === f.id} pct={progress?.id === f.id ? progress.pct : null}
                onToggle={() => toggleSel(f.id)}
                onPreview={() => (f.mime.startsWith('image/') ? doPreview(f) : doDownload(f))}
                onDownload={() => doDownload(f)}
                onRename={() => { setRenameTarget(f); setRenameValue(f.name) }}
                onDelete={() => deleteFiles([f.id])}
              />
            ))}
          </div>
        )}
      </div>

      {/* 上传坞 */}
      <AnimatePresence>
        {uploads.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 20 }}
            className="absolute bottom-4 right-4 z-30 w-72 rounded-2xl glass shadow-2xl p-3 space-y-2"
          >
            <p className="text-[11px] font-semibold text-muted-foreground px-1">加密上传中 · {uploads.filter((u) => u.status === 'uploading').length} 个进行中</p>
            {uploads.map((u) => (
              <div key={u.localId} className="px-1.5">
                <div className="flex items-center justify-between text-[12px] gap-2">
                  <span className="truncate">{u.name}</span>
                  <span className="text-[11px] text-muted-foreground shrink-0">
                    {u.status === 'error' ? u.error || '失败' : u.status === 'done' ? '完成' : `${Math.round(u.progress * 100)}%`}
                  </span>
                </div>
                <div className="mt-1 h-1 rounded-full bg-black/10 dark:bg-white/10 overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${u.status === 'error' ? 'bg-red-500' : 'bg-gradient-to-r from-fuchsia-400 to-pink-500'}`}
                    style={{ width: `${u.status === 'error' ? 100 : Math.round(u.progress * 100)}%` }}
                  />
                </div>
              </div>
            ))}
          </motion.div>
        )}
      </AnimatePresence>

      {/* 重命名弹窗 */}
      <Dialog open={!!renameTarget} onOpenChange={(o) => !o && setRenameTarget(null)}>
        <DialogContent className="rounded-2xl max-w-sm">
          <DialogHeader>
            <DialogTitle>重命名</DialogTitle>
            <DialogDescription>新名称将重新加密后保存，服务器仍然一无所知。</DialogDescription>
          </DialogHeader>
          <Input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value.slice(0, 200))}
            className="h-10 rounded-xl"
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" className="rounded-xl" onClick={() => setRenameTarget(null)}>取消</Button>
            <Button
              className="rounded-xl bg-gradient-to-r from-fuchsia-500 to-pink-500 text-white"
              onClick={async () => {
                if (renameTarget && renameValue.trim()) await rename(renameTarget.id, renameValue.trim())
                setRenameTarget(null)
              }}
            >
              <Check className="h-4 w-4" /> 保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 图片预览 */}
      <Dialog open={!!previewUrl} onOpenChange={(o) => { if (!o && previewUrl) { URL.revokeObjectURL(previewUrl); setPreviewUrl(null) } }}>
        <DialogContent className="rounded-2xl max-w-3xl p-2 sm:p-3">
          <DialogHeader className="px-2 pt-1">
            <DialogTitle className="text-sm truncate">{previewName}</DialogTitle>
          </DialogHeader>
          {previewUrl && (
            <img src={previewUrl} alt={previewName} className="w-full max-h-[75vh] object-contain rounded-xl" />
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

interface RowProps {
  f: DriveFileItem
  selected: boolean
  busy: boolean
  pct: number | null
  onToggle: () => void
  onPreview: () => void
  onDownload: () => void
  onRename: () => void
  onDelete: () => void
}

function GridCard({ f, selected, busy, pct, onToggle, onPreview, onDownload, onRename, onDelete }: RowProps) {
  return (
    <motion.div
      layout
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      className={`group relative rounded-2xl border p-3 transition-all cursor-pointer ${
        selected
          ? 'border-fuchsia-500 bg-fuchsia-500/10'
          : 'border-black/[0.06] dark:border-white/[0.08] bg-white/60 dark:bg-zinc-900/50 hover:border-fuchsia-500/40 hover:-translate-y-0.5'
      }`}
      onClick={onPreview}
    >
      <button
        onClick={(e) => { e.stopPropagation(); onToggle() }}
        className={`absolute top-2 right-2 z-10 h-5 w-5 rounded-full border flex items-center justify-center transition-all ${
          selected ? 'bg-fuchsia-500 border-fuchsia-500 text-white' : 'border-black/20 dark:border-white/25 opacity-0 group-hover:opacity-100'
        }`}
        aria-label="选择"
      >
        {selected && <Check className="h-3 w-3" />}
      </button>

      <div className="flex flex-col items-center py-2">
        <span className={`inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br ${typeGradient(f.mime)} text-white shadow-lg`}>
          <TypeIcon mime={f.mime} size={28} busy={busy} />
        </span>
        <p className="mt-2.5 text-[13px] font-medium w-full text-center truncate" title={f.name}>{f.name}</p>
        <p className="text-[11px] text-muted-foreground">{formatBytes(f.size)}{pct !== null ? ` · ${pct}%` : ''}</p>
      </div>

      <div className="absolute bottom-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity" onClick={(e) => e.stopPropagation()}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-7 w-7 rounded-full" aria-label="更多操作">
              <span className="text-lg leading-none mb-1">⋯</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="rounded-xl">
            <DropdownMenuItem onClick={onDownload} className="gap-2 text-[13px]"><Download className="h-3.5 w-3.5" /> 下载解密</DropdownMenuItem>
            <DropdownMenuItem onClick={onRename} className="gap-2 text-[13px]"><Pencil className="h-3.5 w-3.5" /> 重命名</DropdownMenuItem>
            <DropdownMenuItem onClick={onDelete} className="gap-2 text-[13px] text-red-500 focus:text-red-500"><Trash2 className="h-3.5 w-3.5" /> 删除</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </motion.div>
  )
}

function ListRow({ f, selected, busy, pct, onToggle, onPreview, onDownload, onRename, onDelete }: RowProps) {
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className={`group flex items-center gap-3 rounded-2xl border px-3 py-2.5 transition-all ${
        selected
          ? 'border-fuchsia-500 bg-fuchsia-500/10'
          : 'border-black/[0.05] dark:border-white/[0.07] bg-white/50 dark:bg-zinc-900/40 hover:border-fuchsia-500/40'
      }`}
      onClick={onPreview}
    >
      <button
        onClick={(e) => { e.stopPropagation(); onToggle() }}
        className={`h-5 w-5 shrink-0 rounded-full border flex items-center justify-center transition-all ${
          selected ? 'bg-fuchsia-500 border-fuchsia-500 text-white' : 'border-black/20 dark:border-white/25'
        }`}
        aria-label="选择"
      >
        {selected && <Check className="h-3 w-3" />}
      </button>
      <span className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br ${typeGradient(f.mime)} text-white shadow`}>
        <TypeIcon mime={f.mime} size={18} busy={busy} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[13.5px] font-medium truncate">{f.name}</p>
        <p className="text-[11px] text-muted-foreground">
          {formatBytes(f.size)} · {new Date(f.createdAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
          {pct !== null ? ` · ${pct}%` : ''}
        </p>
      </div>
      <div className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" onClick={(e) => e.stopPropagation()}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full" aria-label="更多操作">
              <span className="text-lg leading-none mb-1">⋯</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="rounded-xl">
            <DropdownMenuItem onClick={onDownload} className="gap-2 text-[13px]"><Download className="h-3.5 w-3.5" /> 下载解密</DropdownMenuItem>
            <DropdownMenuItem onClick={onRename} className="gap-2 text-[13px]"><Pencil className="h-3.5 w-3.5" /> 重命名</DropdownMenuItem>
            <DropdownMenuItem onClick={onDelete} className="gap-2 text-[13px] text-red-500 focus:text-red-500"><Trash2 className="h-3.5 w-3.5" /> 删除</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </motion.div>
  )
}
