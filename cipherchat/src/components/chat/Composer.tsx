'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Paperclip, Send, Smile, X, Loader2, CheckCircle2, AlertCircle, Reply as ReplyIcon, FileUp, Network, Mic, Flame, Zap, Grid3x3 } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useChatStore, useFeatureFlags, isP2pLocalEnabled, setP2pLocalEnabled, type ChatMsg } from '@/store/chat'
import { formatBytes, deriveAdminKeyHash, deriveProbeHash } from '@/lib/crypto'
import { parseToyCommand, TOY_HELP, emptyTttBoard, type TttPayload } from '@/lib/toys'
import { EmojiPicker } from './EmojiPicker'
import { VoiceRecorder } from '@/lib/voice-recorder'
import { explainError, errorToastDescription } from '@/lib/errors'
import { cn } from '@/lib/utils'

export function Composer({ replyTo, onCancelReply }: { replyTo: ChatMsg | null; onCancelReply: () => void }) {
  // v1.7.0：细粒度订阅 —— 此前整店订阅，任何 store 变化（他人上传进度、typing、
  // presence）都会让输入栏重渲染
  const { sendText, sendSticker, sendToy, sendVoiceClip, uploadAndSendFile, setTyping, uploads } = useChatStore(useShallow((s) => ({
    sendText: s.sendText,
    sendSticker: s.sendSticker,
    sendToy: s.sendToy,
    sendVoiceClip: s.sendVoiceClip,
    uploadAndSendFile: s.uploadAndSendFile,
    setTyping: s.setTyping,
    uploads: s.uploads,
  })))
  const config = useChatStore((s) => s.config)
  const removeUpload = useChatStore((s) => s.removeUpload)
  const wsStatus = useChatStore((s) => s.wsStatus)
  const channelId = useChatStore((s) => s.channelId)
  const flags = useFeatureFlags()
  const [text, setText] = useState('')
  const [p2pOn, setP2pOn] = useState(() => isP2pLocalEnabled())
  const [emojiOpen, setEmojiOpen] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [voiceMode, setVoiceMode] = useState(false)
  const [recording, setRecording] = useState(false)
  const [recordingSec, setRecordingSec] = useState(0)
  const [cancelArmed, setCancelArmed] = useState(false)
  const recorderRef = useRef<VoiceRecorder | null>(null)
  const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const textRef = useRef<HTMLTextAreaElement>(null)
  const voiceBtnRef = useRef<HTMLButtonElement>(null)
  const typingOffTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const connected = wsStatus === 'online'

  // v1.6.0 频道草稿箱：按频道 key 自动保存/恢复（切换频道或刷新都不丢未发送内容）
  const draftKey = channelId ? `cipherchat:draft:${channelId}` : ''
  const autoSize = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`
  }
  useEffect(() => {
    if (!draftKey) return
    try {
      const saved = localStorage.getItem(draftKey)
      if (saved) {
        // v1.7.0：恢复草稿放到 rAF 中（react-compiler 规则要求避免在 effect 内
        // 同步 setState 触发级联渲染），顺带完成高度自适应
        requestAnimationFrame(() => {
          setText(saved)
          const el = textRef.current
          if (el) autoSize(el)
        })
      }
    } catch { /* ignore */ }
    // 切频道即换草稿
     
  }, [draftKey])
  const saveDraft = useCallback((v: string) => {
    if (!draftKey) return
    try {
      if (v) localStorage.setItem(draftKey, v)
      else localStorage.removeItem(draftKey)
    } catch { /* ignore */ }
  }, [draftKey])

  // v1.7.0：草稿防抖 —— 此前每个按键都同步写 localStorage（长文本时明显卡顿）
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveDraftDebounced = useCallback((v: string) => {
    if (draftTimer.current) clearTimeout(draftTimer.current)
    draftTimer.current = setTimeout(() => saveDraft(v), 300)
  }, [saveDraft])

  const toggleP2P = () => {
    const next = !p2pOn
    setP2pOn(next)
    setP2pLocalEnabled(next)
    toast.message(next ? 'P2P 直连已启用（双方都开启时优先直连）' : '已切回中继模式（消息落地加密留存）')
  }

  // 移动端：回车换行靠按钮发送；桌面：回车发送
  const isCoarse = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches

  // 引用回复栏出现时聚焦输入框
  useEffect(() => {
    if (replyTo) textRef.current?.focus()
  }, [replyTo])

  // ———— 快捷指令 ————
  const handleCommand = useCallback(async (raw: string) => {
    const t = raw.trim()
    const sp = t.indexOf(' ')
    const cmd = (sp === -1 ? t : t.slice(0, sp)).toLowerCase()
    const rest = sp === -1 ? '' : t.slice(sp + 1).trim()
    const st = useChatStore.getState()

    switch (cmd) {
      case '/help': {
        st.addSystem(
          [
            '可用指令：',
            '/help — 查看本帮助',
            '/roll [3d6] · /coin · /rps · /decide a|b · /8ball — 频道玩具（结果加密广播）',
            '/poll 问题|选项A|选项B — 发起加密投票（实时计票、可改票）',
            '/ttt <对手昵称> — 井字棋对战（谁点格谁落子，全员围观）',
            '/confetti [文案] · /fireworks [文案] — 全屏特效，全员同屏',
            '/mood <表情> — 设置心情状态（空串清除）',
            '/readtip on|off — 开启/关闭已读回执（关闭后你阅读消息不再回执）',
            '/nick <昵称> — 修改我的昵称',
            '/avatar — 查看头像上传指引（设备面板顶部可上传）',
            '/p2p on|off — 开启/关闭 P2P 直连模式（双方都开启时优先直传不留存）',
            '/clear — 清空本频道全部记录',
            '/leave — 离开频道',
            '/admin <超级密钥> — 验证管理员身份',
            '/stats — 查看服务器统计（需管理员）',
            '/destroy <自毁密钥> — 紧急销毁服务器全部数据',
          ].join('\n')
        )
        break
      }
      case '/ttt': {
        // v1.7.0 井字棋对战：发起挑战（谁点格谁接招，X 先手归发起者）
        const opponentNick = rest.slice(0, 24)
        void st.sendToy({
          toy: 'ttt',
          gameId: crypto.randomUUID(),
          challengerId: st.deviceId,
          board: emptyTttBoard(),
          lastMove: null,
          winner: null,
          status: 'playing',
          challengerNick: st.nickname || '挑战者',
          opponentNick: opponentNick || undefined,
        } satisfies TttPayload)
        st.addSystem(opponentNick ? `已向「${opponentNick}」发出井字棋挑战：点棋盘格子即可接招，X 先手` : '已发起井字棋挑战：想玩的同伴点棋盘格子即可接招，X 先手')
        break
      }
      case '/mood': {
        // v1.7.0 心情状态：随 presence 广播，成员面板可见
        await st.setMood(rest)
        break
      }
      case '/readtip': {
        const v = rest.toLowerCase()
        if (v === 'off') {
          try { localStorage.setItem('cipherchat:readtip', 'off') } catch { /* ignore */ }
          st.addSystem('已读回执已关闭：你阅读消息时不再向对方发送已读回执')
        } else if (v === 'on') {
          try { localStorage.setItem('cipherchat:readtip', 'on') } catch { /* ignore */ }
          st.addSystem('已读回执已开启')
        } else {
          st.addSystem('用法：/readtip on 或 /readtip off')
        }
        break
      }
      case '/nick': {
        if (!rest) {
          st.addSystem('用法：/nick <新昵称>')
          break
        }
        await st.setNickname(rest)
        st.addSystem(`昵称已更新为「${rest.slice(0, 24)}」`)
        break
      }
      case '/avatar': {
        st.addSystem('在「设备面板（右上角人像图标）」顶部的「我的资料卡」点击相机按钮即可上传头像；图片将自动裁剪为 256×256，加密后随 presence 广播给本频道其他成员。')
        break
      }
      case '/p2p': {
        const v = rest.toLowerCase()
        if (v === 'off') {
          setP2pLocalEnabled(false)
          setP2pOn(false)
          st.addSystem('P2P 直连已关闭：消息走中继加密留存（默认行为）')
        } else if (v === 'on') {
          setP2pLocalEnabled(true)
          setP2pOn(true)
          st.addSystem('P2P 直连已开启：双方都开启时优先走 WebRTC DataChannel 直传（不留存）。回退中继时仍加密留存。')
        } else {
          st.addSystem('用法：/p2p on 或 /p2p off')
        }
        break
      }
      case '/clear': {
        await st.clearChannel()
        break
      }
      case '/leave': {
        st.leave()
        break
      }
      case '/admin': {
        if (!rest) {
          st.addSystem('用法：/admin <超级密钥>')
          break
        }
        try {
          const adminKeyHash = await deriveAdminKeyHash(rest)
          const res = await fetch('/api/admin/verify', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ adminKeyHash }),
          })
          if (res.ok) {
            useChatStore.setState({ adminVerified: true, adminKeyHashCache: adminKeyHash })
            st.addSystem('管理员身份已验证，可使用 /stats 查看统计、/destroy <自毁密钥> 紧急销毁')
          } else {
            st.addSystem('超级密钥验证失败')
          }
        } catch {
          st.addSystem('验证请求失败，请重试')
        }
        break
      }
      case '/stats': {
        if (!st.adminVerified || !st.adminKeyHashCache) {
          st.addSystem('尚未验证管理员身份，请先输入 /admin <超级密钥>')
          break
        }
        try {
          const res = await fetch('/api/admin/stats', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ adminKeyHash: st.adminKeyHashCache }),
          })
          if (!res.ok) {
            st.addSystem('统计获取失败（管理员身份可能已失效）')
            break
          }
          const d = await res.json()
          const h = Math.floor(d.uptimeSec / 3600)
          const m = Math.floor((d.uptimeSec % 3600) / 60)
          st.addSystem(
            [
              '服务器统计：',
              `聊天消息 ${d.messages} 条 · 聊天文件 ${d.chatFiles} 个（${formatBytes(d.chatBytes)}）`,
              `网盘仓库 ${d.driveRepos} 个 · 网盘文件 ${d.driveFiles} 个（${formatBytes(d.driveBytes)}）`,
              `活跃会话 ${d.sessions} 个 · 运行时长 ${h} 小时 ${m} 分钟`,
            ].join('\n')
          )
        } catch {
          st.addSystem('统计获取失败')
        }
        break
      }
      case '/destroy': {
        if (!rest) {
          st.addSystem('用法：/destroy <自毁密钥>')
          break
        }
        try {
          const probeHash = await deriveProbeHash(rest)
          const res = await fetch('/api/admin/destroy', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ probeHash }),
          })
          const d = await res.json().catch(() => ({}))
          if (d?.destroyed) {
            useChatStore.setState({ wiped: true })
          } else {
            st.addSystem('密钥无效')
          }
        } catch {
          st.addSystem('请求失败，请重试')
        }
        break
      }
      default:
        st.addSystem(`未知指令「${cmd}」，输入 /help 查看可用指令`)
    }
  }, [])

  // v1.5.0 阅后即焚：默认 null=永久留存；选择后本条消息在到期自动焚毁
  const [burnAfterSec, setBurnAfterSec] = useState<number | null>(null)
  const [burnMenuOpen, setBurnMenuOpen] = useState(false)
  const BURN_OPTIONS = [
    { v: null, label: '永久' },
    { v: 300, label: '5 分钟' },
    { v: 1800, label: '30 分钟' },
    { v: 3600, label: '1 小时' },
    { v: 21600, label: '6 小时' },
    { v: 86400, label: '24 小时' },
  ] as const

  // v1.7.0 闪照：开启后下一批发送的文件以阅后即焚方式发送（服务器首次下载后真焚毁）
  const [flashOn, setFlashOn] = useState(false)

  const submit = useCallback(() => {
    const t = text.trim()
    if (!t) return
    setText('')
    if (draftTimer.current) clearTimeout(draftTimer.current)
    saveDraft('')
    setEmojiOpen(false)
    if (textRef.current) textRef.current.style.height = 'auto'
    if (t.startsWith('/')) {
      // v1.6.0：先匹配玩具指令（骰子/硬币/猜拳/选择/魔球），命中即作为加密消息发出
      const toy = parseToyCommand(t)
      if (toy) {
        void sendToy(toy)
        onCancelReply()
        requestAnimationFrame(() => textRef.current?.focus())
        return
      }
      void handleCommand(t)
      onCancelReply()
      return
    }
    sendText(t.slice(0, 8000), replyTo?.id || null, burnAfterSec)
    onCancelReply()
    if (typingOffTimer.current) clearTimeout(typingOffTimer.current)
    requestAnimationFrame(() => textRef.current?.focus())
  }, [text, sendText, sendToy, replyTo, onCancelReply, handleCommand, burnAfterSec, saveDraft])

  // v1.6.0：斜杠指令提示（输入 / 且尚无空格时展示匹配项）
  const slashHints = (() => {
    if (!text.startsWith('/') || text.includes(' ')) return []
    const q = text.toLowerCase()
    return TOY_HELP.filter((h) => h.cmd.startsWith(q)).slice(0, 5)
  })()

  // ———— 表情插入到光标处 ————
  const insertEmoji = (emoji: string) => {
    const el = textRef.current
    if (!el) {
      setText((v) => v + emoji)
      return
    }
    const start = el.selectionStart ?? text.length
    const end = el.selectionEnd ?? text.length
    const next = text.slice(0, start) + emoji + text.slice(end)
    setText(next)
    requestAnimationFrame(() => {
      el.focus()
      el.selectionStart = el.selectionEnd = start + emoji.length
    })
  }

  const sendStickerFn = (emoji: string) => {
    sendSticker(emoji)
    setEmojiOpen(false)
    onCancelReply()
  }

  const handleFiles = useCallback(
    (files: File[]) => {
      for (const f of files.slice(0, 5)) uploadAndSendFile(f, replyTo?.id || null, flashOn ? { viewOnce: true } : undefined)
      onCancelReply()
      // 闪照一次性：发完自动复位，防误连发
      if (flashOn) {
        setFlashOn(false)
        toast.message('⚡ 已按闪照发送：对方只能查看一次，服务器看后即焚')
      }
    },
    [uploadAndSendFile, replyTo, onCancelReply, flashOn]
  )

  // 粘贴上传：Ctrl+V 图片/文件直接发送
  const onPaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData?.files
      if (items && items.length > 0) {
        e.preventDefault()
        handleFiles(Array.from(items))
      }
    },
    [handleFiles]
  )

  // ———— 全窗口拖拽（进入/离开计数，防闪烁） ————
  useEffect(() => {
    let depth = 0
    const onEnter = () => {
      depth += 1
      setDragOver(true)
    }
    const onLeave = () => {
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragOver(false)
    }
    const onOver = (e: DragEvent) => e.preventDefault()
    const onDrop = (e: DragEvent) => {
      e.preventDefault()
      depth = 0
      setDragOver(false)
      const files = [...(e.dataTransfer?.files || [])]
      if (files.length > 0) handleFiles(files)
    }
    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('dragover', onOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('drop', onDrop)
    }
  }, [handleFiles])

  // ———— 输入 → 正在输入事件（4s 自动停） ————
  const notifyTyping = () => {
    setTyping(true)
    if (typingOffTimer.current) clearTimeout(typingOffTimer.current)
    typingOffTimer.current = setTimeout(() => setTyping(false), 4000)
  }

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !isCoarse) {
      e.preventDefault()
      submit()
    }
  }

  // ———— 微信式按住录音→松开发送→上滑取消 ————
  const stopRecordingTimer = () => {
    if (recordingTimerRef.current) {
      clearInterval(recordingTimerRef.current)
      recordingTimerRef.current = null
    }
  }

  const startRecording = async () => {
    if (!connected) { toast.error('连接未就绪'); return }
    try {
      const rec = new VoiceRecorder()
      await rec.start()
      recorderRef.current = rec
      setRecording(true)
      setCancelArmed(false)
      setRecordingSec(0)
      recordingTimerRef.current = setInterval(() => {
        const sec = rec.elapsedSec
        setRecordingSec(sec)
        if (sec >= 60) {
          // 最长 60 秒自动发送
          void finishRecording()
        }
      }, 100)
    } catch (e) {
      // v1.8.0：麦克风失败带原因与修复步骤（此前一律「权限被拒绝」，权限正常时误导用户）
      const ex = explainError(e, '录音')
      toast.error(ex.title, { description: errorToastDescription(ex), duration: 10000 })
    }
  }

  const finishRecording = async (cancelled = false) => {
    stopRecordingTimer()
    const rec = recorderRef.current
    recorderRef.current = null
    setRecording(false)
    if (!rec) return
    if (cancelled) {
      rec.cancel()
      setCancelArmed(false)
      toast.message('录音已取消')
      return
    }
    const res = await rec.stop()
    if (!res) { toast.error('录音失败，请重试'); return }
    if (res.durationSec < 0.5) {
      toast.message('录音过短，已取消')
      return
    }
    await sendVoiceClip(res.blob, res.durationSec)
  }

  // 触摸 / 鼠标在录音按钮上的 hold 行为
  // v1.7.0 修复：录音中不禁用按钮 —— 此前 disabled 随 recording 变化后，
  // Chrome 会吞掉后续 pointerup/pointermove，导致「松开发送/上滑取消」失灵、
  // 录音卡死到 60s 自动发送；改用 setPointerCapture 持续接收手势
  const onVoiceStart = (e: React.PointerEvent) => {
    e.preventDefault()
    try { voiceBtnRef.current?.setPointerCapture(e.pointerId) } catch { /* ignore */ }
    if (!recording) void startRecording()
  }
  const onVoiceEnd = () => {
    if (!recording) return
    void finishRecording(cancelArmed)
  }
  const onVoiceMove = (e: React.PointerEvent) => {
    if (!recording) return
    // 上滑超过 40px → 取消
    const el = voiceBtnRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const deltaY = e.clientY - rect.top
    if (deltaY < -40) setCancelArmed(true)
    else setCancelArmed(false)
  }

  // 清理录音器
  useEffect(() => {
    return () => {
      stopRecordingTimer()
      recorderRef.current?.cancel()
    }
  }, [])

  return (
    <>
      {/* 拖拽浮层（全屏虚线卡片） */}
      {dragOver && (
        <div className="fixed inset-0 z-40 grid place-items-center bg-primary/10 p-6 backdrop-blur-sm">
          <div className="glass flex flex-col items-center gap-3 rounded-3xl border-2 border-dashed border-primary/60 px-10 py-12 shadow-2xl">
            <FileUp className="h-12 w-12 text-primary" />
            <p className="text-lg font-bold">松手即加密上传</p>
            <p className="text-sm text-muted-foreground">文件将在本机加密后中继，服务器无法查看内容</p>
          </div>
        </div>
      )}

      <footer className="glass z-20 border-t px-3 pb-safe pt-2 sm:px-5">
        <div className="mx-auto w-full max-w-4xl">
          {/* 上传队列（横向滚动卡片） */}
          {uploads.length > 0 && (
            <div className="scroll-slim mb-2 flex gap-2 overflow-x-auto pb-1">
              {uploads.map((u) => (
                <div
                  key={u.localId}
                  className={cn(
                    'relative flex w-52 shrink-0 items-center gap-2.5 rounded-xl border bg-card p-2.5 shadow-sm',
                    u.status === 'error' && 'border-destructive/50'
                  )}
                >
                  {u.status === 'uploading' || u.status === 'sending' ? (
                    <Loader2 className="h-5 w-5 shrink-0 animate-spin text-primary" />
                  ) : u.status === 'done' ? (
                    <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-500" />
                  ) : (
                    <AlertCircle className="h-5 w-5 shrink-0 text-destructive" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium">{u.name}</p>
                    {u.status === 'uploading' || u.status === 'sending' ? (
                      <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
                        <div className="h-full rounded-full grad-primary transition-all" style={{ width: `${Math.round(u.progress * 100)}%` }} />
                      </div>
                    ) : (
                      <p className="mt-0.5 text-[10px] text-muted-foreground">
                        {u.status === 'done' ? '已加密发送' : u.error || '上传失败'} · {formatBytes(u.size)}
                      </p>
                    )}
                  </div>
                  {u.status === 'error' && (
                    <button
                      onClick={() => removeUpload(u.localId)}
                      className="shrink-0 rounded-lg p-1 text-muted-foreground hover:bg-muted"
                      aria-label="移除"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* 回复栏 */}
          {replyTo && (
            <div className="mb-2 flex items-center gap-2 rounded-xl border bg-muted/60 px-3 py-2 text-xs">
              <ReplyIcon className="h-3.5 w-3.5 shrink-0 text-primary" />
              <span className="shrink-0 font-semibold text-primary">{replyTo.nick || '匿名'}</span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                {replyTo.kind === 'text'
                  ? replyTo.text
                  : replyTo.kind === 'sticker'
                    ? `[贴纸] ${replyTo.text}`
                    : replyTo.kind === 'voice'
                      ? `[语音] ${replyTo.voice?.duration.toFixed(0)}″`
                      : replyTo.kind === 'toy'
                        ? '[频道玩具]'
                        : `[文件] ${replyTo.file?.name}`}
              </span>
              <button onClick={onCancelReply} className="shrink-0 rounded-lg p-1 hover:bg-muted" aria-label="取消回复">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}

          {/* v1.6.0 斜杠玩具指令提示 */}
          {slashHints.length > 0 && (
            <div className="mb-2 overflow-hidden rounded-xl border bg-card shadow-lg">
              {slashHints.map((h) => (
                <button
                  key={h.cmd}
                  type="button"
                  // 点击直接填入指令（保留参数继续输入）
                  onClick={() => {
                    setText(h.cmd + ' ')
                    saveDraft(h.cmd + ' ')
                    textRef.current?.focus()
                  }}
                  className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-primary/5"
                >
                  <code className="rounded bg-primary/10 px-1.5 py-0.5 text-[12px] font-bold text-primary">{h.example}</code>
                  <span className="text-[12px] text-muted-foreground">{h.desc}</span>
                </button>
              ))}
            </div>
          )}

          {/* 输入栏：附件 · 表情 · 输入框 · 发送 */}
          <div className="flex items-end gap-2 pb-2">
            <input
              ref={fileRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                handleFiles(Array.from(e.target.files || []))
                e.target.value = ''
              }}
            />
            <Button
              variant="ghost"
              size="icon"
              className="h-10 w-10 shrink-0 rounded-xl text-muted-foreground"
              onClick={() => fileRef.current?.click()}
              disabled={!connected}
              aria-label="发送文件"
            >
              <Paperclip className="h-5 w-5" />
            </Button>

            {/* P2P 直连开关（功能开关开启时显示） */}
            {flags.p2pEnabled && (
              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  'h-10 w-10 shrink-0 rounded-xl transition-colors',
                  p2pOn ? 'text-primary bg-primary/10' : 'text-muted-foreground'
                )}
                onClick={toggleP2P}
                disabled={!connected}
                aria-label={p2pOn ? '关闭 P2P 直连' : '开启 P2P 直连'}
                title={p2pOn ? 'P2P 已启用（双方都开启时优先直连）' : 'P2P 未启用（点击切换）'}
              >
                <Network className="h-5 w-5" />
              </Button>
            )}

            <Popover open={emojiOpen} onOpenChange={setEmojiOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn('h-10 w-10 shrink-0 rounded-xl', emojiOpen ? 'text-primary' : 'text-muted-foreground')}
                  aria-label="表情"
                >
                  <Smile className="h-5 w-5" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" side="top" className="w-auto rounded-2xl p-0">
                <EmojiPicker onPick={insertEmoji} onSticker={sendStickerFn} />
              </PopoverContent>
            </Popover>

            {/* v1.7.0 闪照开关：下一批文件按阅后即焚发送（服务器首次下载后真焚毁） */}
            <Button
              variant="ghost"
              size="icon"
              className={cn('h-10 w-10 shrink-0 rounded-xl', flashOn ? 'text-amber-500 bg-amber-500/10' : 'text-muted-foreground')}
              onClick={() => {
                const next = !flashOn
                setFlashOn(next)
                if (next) toast.message('⚡ 闪照模式已开启：下一批发送的文件对方只能查看一次')
              }}
              disabled={!connected}
              aria-label="闪照模式"
              title="闪照：对方只能查看一次，服务器看完即焚"
            >
              <Zap className="h-5 w-5" />
            </Button>

            {/* v1.5.0 阅后即焚定时器：默认永久，可选 5分钟-24小时 */}
            <div className="relative shrink-0">
              <Button
                variant="ghost"
                size="icon"
                className={cn('h-10 w-10 rounded-xl', burnAfterSec ? 'text-orange-500 bg-orange-500/10' : 'text-muted-foreground')}
                onClick={() => setBurnMenuOpen((v) => !v)}
                aria-label="阅后即焚"
                title="阅后即焚：选择本条消息的自动焚毁时间（默认永久留存）"
              >
                <Flame className="h-5 w-5" />
              </Button>
              {burnMenuOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setBurnMenuOpen(false)} />
                  <div className="absolute bottom-12 left-1/2 z-50 -translate-x-1/2 rounded-xl glass border p-1.5 shadow-xl">
                    <p className="px-2 pb-1 pt-0.5 text-[10px] text-muted-foreground">消息保留时长</p>
                    {BURN_OPTIONS.map((o) => (
                      <button
                        key={o.label}
                        type="button"
                        onClick={() => { setBurnAfterSec(o.v); setBurnMenuOpen(false) }}
                        className={cn(
                          'flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left text-[12.5px] hover:bg-muted',
                          burnAfterSec === o.v && 'bg-primary/10 font-semibold text-primary',
                        )}
                      >
                        {burnAfterSec === o.v ? <CheckCircle2 className="h-3.5 w-3.5" /> : <span className="w-3.5" />}
                        {o.v === null ? o.label : `焚毁于 ${o.label}`}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>

            {/* 文本/语音模式切换（语音开关开启时显示） */}
            {flags.voiceEnabled && !recording && (
              <Button
                variant="ghost"
                size="icon"
                className={cn('h-10 w-10 shrink-0 rounded-xl transition-colors', voiceMode ? 'text-primary bg-primary/10' : 'text-muted-foreground')}
                onClick={() => setVoiceMode((v) => !v)}
                disabled={!connected}
                aria-label={voiceMode ? '切回文字' : '切到语音消息'}
                title={voiceMode ? '切回文字输入' : '切到语音消息（按住说话，上滑取消）'}
              >
                <Mic className="h-5 w-5" />
              </Button>
            )}

            {voiceMode && flags.voiceEnabled ? (
              /* 语音模式：按住说话按钮（微信式） */
              <div className="flex min-w-0 flex-1 items-center justify-center">
                <button
                  ref={voiceBtnRef}
                  onPointerDown={onVoiceStart}
                  onPointerUp={onVoiceEnd}
                  onPointerLeave={onVoiceEnd}
                  onPointerMove={onVoiceMove}
                  onPointerCancel={onVoiceEnd}
                  disabled={!connected}
                  className={cn(
                    'relative flex h-10 w-full items-center justify-center gap-2 rounded-2xl text-[14px] font-medium transition-all select-none touch-none',
                    recording
                      ? cancelArmed
                        ? 'bg-red-500/15 text-red-500 border-2 border-dashed border-red-500/50'
                        : 'grad-primary text-white shadow-md shadow-violet-500/30'
                      : 'border bg-card hover:border-primary/40 hover:bg-primary/5',
                  )}
                  aria-label="按住说话，松开发送，上滑取消"
                >
                  {recording ? (
                    <>
                      <span className={cn('h-2 w-2 rounded-full', cancelArmed ? 'bg-red-500' : 'bg-white animate-pulse')} />
                      <span>{cancelArmed ? '松开取消' : `${recordingSec.toFixed(1)}″ 录音中`}</span>
                      <span className="text-[10px] opacity-70">↑ 上滑取消</span>
                    </>
                  ) : (
                    <>
                      <Mic className="h-4 w-4" />
                      <span>按住说话</span>
                    </>
                  )}
                </button>
              </div>
            ) : (
              /* 文字模式 */
              <>
                <div className="flex min-w-0 flex-1 items-end rounded-2xl border bg-card focus-within:border-primary/50 focus-within:ring-2 focus-within:ring-primary/15">
                  <textarea
                    ref={textRef}
                    value={text}
                    onChange={(e) => {
                      setText(e.target.value)
                      saveDraftDebounced(e.target.value)
                      autoSize(e.target)
                      if (e.target.value.length > 0) notifyTyping()
                    }}
                    onPaste={onPaste}
                    onKeyDown={(e) => {
                      // Tab 补全斜杠指令
                      if (e.key === 'Tab' && slashHints.length > 0) {
                        e.preventDefault()
                        setText(slashHints[0].cmd + ' ')
                        saveDraftDebounced(slashHints[0].cmd + ' ')
                        return
                      }
                      onKey(e)
                    }}
                    rows={1}
                    placeholder={
                      !connected
                        ? '连接已断开，正在重连…'
                        : p2pOn && flags.p2pEnabled
                          ? 'P2P 模式·消息直传不留存（回退中继则加密留存）…'
                          : '输入消息…（Enter 发送，Shift+Enter 换行，Ctrl+V 粘贴文件）'
                    }
                    disabled={!connected}
                    className="max-h-[132px] min-h-[40px] w-full resize-none bg-transparent px-3.5 py-2.5 text-[15px] leading-relaxed outline-none placeholder:text-muted-foreground/70 disabled:opacity-60 no-scrollbar"
                    aria-label="消息输入框"
                  />
                </div>

                <Button
                  size="icon"
                  className="h-10 w-10 shrink-0 rounded-xl grad-primary shadow-md shadow-violet-500/25 disabled:opacity-50"
                  onClick={submit}
                  disabled={!connected || text.trim().length === 0}
                  aria-label="发送"
                >
                  <Send className="h-[18px] w-[18px]" />
                </Button>
              </>
            )}
          </div>
        </div>
      </footer>
    </>
  )
}
