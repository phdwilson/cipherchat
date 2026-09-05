'use client'

// 表情选择器（分类 / 最近使用 / 大表情贴纸 / 快捷反应）
import { useState } from 'react'
import { Trash2, Clock3 } from 'lucide-react'
import { EMOJI_CATEGORIES, STICKERS, QUICK_REACTIONS } from '@/lib/emoji'
import { cn } from '@/lib/utils'

const RECENT_KEY = 'cipherchat_recent_emoji'

function getRecent(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]').slice(0, 24)
  } catch {
    return []
  }
}

function pushRecent(emoji: string) {
  try {
    const list = [emoji, ...getRecent().filter((e) => e !== emoji)].slice(0, 24)
    localStorage.setItem(RECENT_KEY, JSON.stringify(list))
  } catch { /* ignore */ }
}

export function EmojiPicker({
  onPick,
  onSticker,
}: {
  onPick: (e: string) => void
  onSticker: (e: string) => void
}) {
  const [tab, setTab] = useState<string>('recent')
  const [recent, setRecent] = useState<string[]>(getRecent)

  const pick = (emoji: string) => {
    pushRecent(emoji)
    setRecent(getRecent())
    onPick(emoji)
  }

  const tabs = [
    { key: 'recent', label: '最近', icon: <Clock3 className="h-4 w-4" /> },
    { key: 'sticker', label: '大表情', icon: <span className="text-sm">😀</span> },
    ...EMOJI_CATEGORIES.map((c) => ({ key: c.key, label: c.label, icon: <span className="text-sm">{c.icon}</span> })),
  ]

  const current = EMOJI_CATEGORIES.find((c) => c.key === tab)

  return (
    <div className="select-none w-[288px] sm:w-[320px]">
      {/* 快捷反应（点击直接发送） */}
      <div className="flex items-center gap-1 border-b px-2.5 py-2">
        {QUICK_REACTIONS.map((q) => (
          <button
            key={q}
            onClick={() => onSticker(q)}
            className="grid h-9 w-9 place-items-center rounded-lg text-xl transition-transform hover:scale-125 hover:bg-muted"
            title={`直接发送 ${q}`}
          >
            {q}
          </button>
        ))}
        <span className="ml-auto text-[10px] text-muted-foreground">点击直接发送</span>
      </div>

      {/* 内容区 */}
      <div className="scroll-slim h-60 overflow-y-auto p-2">
        {tab === 'recent' && (
          <div>
            <p className="px-1 pb-1.5 pt-1 text-[11px] font-semibold text-muted-foreground">最近使用</p>
            {recent.length === 0 ? (
              <p className="px-1 py-6 text-center text-xs text-muted-foreground">还没有使用记录</p>
            ) : (
              <div className="grid grid-cols-8 gap-0.5">
                {recent.map((e, i) => (
                  <button key={`${e}-${i}`} onClick={() => pick(e)} className="grid h-9 place-items-center rounded-lg text-lg hover:bg-muted">
                    {e}
                  </button>
                ))}
              </div>
            )}
            {recent.length > 0 && (
              <button
                onClick={() => {
                  try { localStorage.removeItem(RECENT_KEY) } catch { /* ignore */ }
                  setRecent([])
                }}
                className="mt-2 flex items-center gap-1 rounded-lg px-1.5 py-1 text-[11px] text-muted-foreground hover:text-destructive"
              >
                <Trash2 className="h-3 w-3" /> 清除记录
              </button>
            )}
          </div>
        )}

        {tab === 'sticker' && (
          <div>
            <p className="px-1 pb-1.5 pt-1 text-[11px] font-semibold text-muted-foreground">大表情（以贴纸发送）</p>
            <div className="grid grid-cols-6 gap-1">
              {STICKERS.map((s) => (
                <button
                  key={s}
                  onClick={() => onSticker(s)}
                  className="grid h-12 place-items-center rounded-xl text-3xl transition-transform hover:scale-110 hover:bg-muted"
                  title="作为大表情发送"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {current && (
          <div>
            <p className="px-1 pb-1.5 pt-1 text-[11px] font-semibold text-muted-foreground">{current.label}</p>
            <div className="grid grid-cols-8 gap-0.5">
              {current.emojis.map((e) => (
                <button key={e} onClick={() => pick(e)} className="grid h-9 place-items-center rounded-lg text-lg hover:bg-muted">
                  {e}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 底部分类标签 */}
      <div className="scroll-slim flex items-center gap-0.5 overflow-x-auto border-t px-1.5 py-1.5">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            aria-label={t.label}
            title={t.label}
            className={cn(
              'grid h-8 w-8 shrink-0 place-items-center rounded-lg transition-colors',
              tab === t.key ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-muted'
            )}
          >
            {t.icon}
          </button>
        ))}
      </div>
    </div>
  )
}
