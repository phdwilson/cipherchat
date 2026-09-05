'use client'
// v1.6.0 频道玩具消息渲染：骰子 / 硬币 / 猜拳 / 帮你选 / 神奇魔球
// v1.7.0 新增：加密投票（实时计票、可改票）与井字棋对战（点格落子）
// 结果在发送端随机生成并随加密消息落库，这里只负责展示与入场动画
import { motion } from 'framer-motion'
import { BarChart3, Grid3x3, Swords } from 'lucide-react'
import type { ToyPayload } from '@/lib/toys'
import { cn } from '@/lib/utils'

const RPS_EMOJI = { rock: '✊', paper: '✋', scissors: '✌️' } as const
const RPS_NAME = { rock: '石头', paper: '布', scissors: '剪刀' } as const

function DiceFace({ n, sides, index }: { n: number; sides: number; index: number }) {
  // 6 面及以下用 Unicode 点数面，更多面用数字牌面
  const faces = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅']
  return (
    <motion.span
      initial={{ rotate: -180, scale: 0.4, opacity: 0 }}
      animate={{ rotate: 0, scale: 1, opacity: 1 }}
      transition={{ delay: 0.08 * index, type: 'spring', stiffness: 260, damping: 16 }}
      className="inline-grid h-9 min-w-9 place-items-center rounded-xl bg-white/80 px-1 text-lg font-bold shadow-sm dark:bg-white/10"
      title={`点数 ${n}`}
    >
      {sides <= 6 ? faces[(n - 1) % 6] : n}
    </motion.span>
  )
}

export interface ToyBubbleExtras {
  msgId: string
  senderId: string
  pollVotes?: Record<string, number>
  myId: string
  onVote?: (optionIndex: number) => void
  onTttMove?: (msgId: string, moveIdx: number) => void
  tttInteractive?: boolean // 是否是该 gameId 的最新棋局（旧棋局只读）
}

export function ToyBubble({ toy, mine, extras }: { toy: ToyPayload; mine: boolean; extras?: ToyBubbleExtras }) {
  const accent = mine ? 'text-white/90' : 'text-foreground'

  // ---------- v1.7.0 加密投票 ----------
  if (toy.toy === 'poll') {
    const votes = extras?.pollVotes || {}
    const voters = Object.keys(votes)
    const tally = toy.options.map((_, i) => voters.filter((v) => votes[v] === i).length)
    const total = voters.length
    const myVote = extras ? votes[extras.myId] : undefined
    return (
      <div className="flex min-w-[220px] max-w-[320px] flex-col gap-2">
        <span className={cn('flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider opacity-70', accent)}>
          <BarChart3 className="h-3.5 w-3.5" /> 投票 {total > 0 && `· ${total} 票`}
        </span>
        <span className={cn('text-[15px] font-bold leading-snug', accent)}>{toy.question}</span>
        <div className="flex flex-col gap-1.5">
          {toy.options.map((opt, i) => {
            const count = tally[i]
            const pct = total > 0 ? Math.round((count / total) * 100) : 0
            const isMine = myVote === i
            return (
              <button
                key={i}
                type="button"
                onClick={(e) => {
                  e.stopPropagation() // 防止触发气泡的 DropdownMenu
                  extras?.onVote?.(i)
                }}
                onPointerDown={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
                className={cn(
                  'group relative w-full overflow-hidden rounded-lg border px-2.5 py-1.5 text-left text-[13px] transition-all',
                  mine ? 'border-white/25 hover:bg-white/10' : 'border-black/10 dark:border-white/10 hover:border-primary/40 hover:bg-primary/5',
                  isMine && (mine ? 'ring-1 ring-white/60' : 'ring-1 ring-primary/60'),
                )}
                aria-label={`投票给 ${opt}${isMine ? '（当前我的选择）' : ''}`}
              >
                <span
                  className={cn('absolute inset-y-0 left-0 -z-0 transition-all duration-500', mine ? 'bg-white/15' : 'bg-primary/10')}
                  style={{ width: `${pct}%` }}
                />
                <span className="relative z-10 flex items-center justify-between gap-2">
                  <span className={cn('truncate', isMine && 'font-bold')}>
                    {isMine ? '✓ ' : ''}{opt}
                  </span>
                  <span className="shrink-0 text-[11px] opacity-70">{total > 0 ? `${count} · ${pct}%` : ''}</span>
                </span>
              </button>
            )
          })}
        </div>
        <span className={cn('text-[11px] opacity-60', accent)}>
          {myVote === undefined ? '点击选项投票 · 可改票' : '已投票（点击其他选项可改票）'}
        </span>
      </div>
    )
  }

  // ---------- v1.7.0 井字棋对战 ----------
  if (toy.toy === 'ttt') {
    // 我在该局中的棋子：发起者=X(0) 先手，应战者=O(1)
    // v1.7.0 补丁：按 challengerId 判定（senderId 会随落子者变化导致误判）
    const myMark: 0 | 1 | null = extras ? (toy.challengerId === extras.myId ? 0 : 1) : null
    const placed = toy.board.filter((c) => c !== null).length
    const turnMark: 0 | 1 = placed % 2 === 0 ? 0 : 1
    const isMyTurn = toy.status === 'playing' && myMark === turnMark
    const canPlace = !!extras?.tttInteractive && isMyTurn && !!extras?.onTttMove
    const who = toy.status === 'over'
      ? toy.winner === 'draw' ? '平局 🤝'
        : toy.winner === null ? ''
          : `${toy.winner === 0 ? toy.challengerNick : toy.opponentNick || '应战者'} 获胜 🏆`
      : `轮到 ${turnMark === 0 ? toy.challengerNick : toy.opponentNick || '应战者'} 落子（${turnMark === 0 ? 'X' : 'O'}）`
    return (
      <div className="flex flex-col gap-2">
        <span className={cn('flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider opacity-70', accent)}>
          <Grid3x3 className="h-3.5 w-3.5" /> 井字棋 {toy.status === 'playing' && `· 第 ${placed + 1} 手`}
        </span>
        <span className={cn('text-[12px] opacity-80', accent)}>
          <Swords className="mr-1 inline h-3.5 w-3.5" />
          {toy.challengerNick}（X） vs {toy.opponentNick || '虚位以待'}（O）
        </span>
        <div className="grid w-[168px] grid-cols-3 gap-1">
          {toy.board.map((cell, i) => (
            <button
              key={i}
              type="button"
              disabled={!canPlace || cell !== null}
              onClick={(e) => {
                e.stopPropagation() // 防止触发气泡的 DropdownMenu
                extras?.onTttMove?.(extras.msgId, i)
              }}
              onPointerDown={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
              className={cn(
                'grid h-[52px] w-[52px] place-items-center rounded-xl border text-2xl font-black transition-all',
                cell === 0 && (mine ? 'bg-white/25 text-white' : 'bg-primary/15 text-primary'),
                cell === 1 && 'bg-amber-500/20 text-amber-500',
                cell === null && canPlace && (mine ? 'border-white/30 hover:bg-white/15' : 'border-black/15 dark:border-white/15 hover:bg-primary/10 hover:border-primary/40'),
                cell === null && !canPlace && (mine ? 'border-white/15' : 'border-black/10 dark:border-white/10'),
                i === toy.lastMove && 'ring-2 ring-emerald-400/70',
              )}
              aria-label={`第 ${i + 1} 格${cell === null ? '（空）' : ''}`}
            >
              {cell === 0 ? '✕' : cell === 1 ? '◯' : ''}
            </button>
          ))}
        </div>
        <span className={cn('text-[13px] font-bold', accent)}>{who}</span>
      </div>
    )
  }

  // ---------- v1.7.0 全屏特效 ----------
  if (toy.toy === 'fx') {
    return (
      <div className="flex items-center gap-2.5">
        <motion.span
          initial={{ scale: 0.4, rotate: -20 }}
          animate={{ scale: 1, rotate: 0 }}
          transition={{ type: 'spring', stiffness: 300, damping: 14 }}
          className="text-3xl"
        >
          {toy.effect === 'confetti' ? '🎉' : '🎆'}
        </motion.span>
        <div className="flex flex-col">
          <span className={cn('text-[11px] font-semibold uppercase tracking-wider opacity-70', accent)}>
            {toy.effect === 'confetti' ? '全频道撒彩带' : '全频道放烟花'}
          </span>
          {toy.text && <span className={cn('text-sm font-bold', accent)}>{toy.text}</span>}
        </div>
      </div>
    )
  }

  if (toy.toy === 'roll') {
    return (
      <div className="flex flex-col gap-1.5">
        <span className={cn('text-[11px] font-semibold uppercase tracking-wider opacity-70', accent)}>
          🎲 掷骰 {toy.expr}
        </span>
        <div className="flex flex-wrap items-center gap-1.5">
          {toy.rolls.map((n, i) => <DiceFace key={i} n={n} sides={toy.sides} index={i} />)}
        </div>
        <span className={cn('text-sm font-bold', accent)}>
          合计 <span className="text-base">{toy.total}</span>
          {toy.rolls.length > 1 ? `（${toy.rolls.join(' + ')}）` : ''}
        </span>
      </div>
    )
  }

  if (toy.toy === 'coin') {
    return (
      <div className="flex items-center gap-3">
        <motion.span
          initial={{ rotateY: 0 }}
          animate={{ rotateY: 720 }}
          transition={{ duration: 0.7, ease: 'easeOut' }}
          className="text-3xl"
        >
          🪙
        </motion.span>
        <div className="flex flex-col">
          <span className={cn('text-[11px] font-semibold uppercase tracking-wider opacity-70', accent)}>抛硬币</span>
          <span className={cn('text-base font-bold', accent)}>{toy.result === 'heads' ? '正面' : '反面'}</span>
        </div>
      </div>
    )
  }

  if (toy.toy === 'rps') {
    return (
      <div className="flex items-center gap-3">
        <span className="text-3xl">{toy.choice ? RPS_EMOJI[toy.choice] : '🤔'}</span>
        <span className={cn('text-xl opacity-70', accent)}>VS</span>
        <motion.span
          initial={{ scale: 0.3, rotate: -30 }}
          animate={{ scale: 1, rotate: 0 }}
          transition={{ delay: 0.25, type: 'spring', stiffness: 300, damping: 14 }}
          className="text-3xl"
        >
          {RPS_EMOJI[toy.result]}
        </motion.span>
        <div className="flex flex-col">
          <span className={cn('text-[11px] font-semibold uppercase tracking-wider opacity-70', accent)}>猜拳</span>
          <span className={cn('text-sm font-bold', accent)}>
            我出{RPS_NAME[toy.result]}
            {toy.outcome === 'win' && ' · 你赢了 🎉'}
            {toy.outcome === 'lose' && ' · 你输了'}
            {toy.outcome === 'tie' && ' · 平局'}
          </span>
        </div>
      </div>
    )
  }

  if (toy.toy === 'decide') {
    return (
      <div className="flex flex-col gap-1.5">
        <span className={cn('text-[11px] font-semibold uppercase tracking-wider opacity-70', accent)}>🎯 帮你选</span>
        <div className="flex flex-wrap gap-1">
          {toy.options.map((o) => (
            <span
              key={o}
              className={cn(
                'rounded-full px-2 py-0.5 text-[12px]',
                o === toy.picked
                  ? mine
                    ? 'bg-white/25 font-bold'
                    : 'bg-primary/15 font-bold text-primary'
                  : 'bg-black/5 opacity-70 dark:bg-white/10',
              )}
            >
              {o === toy.picked ? '👉 ' : ''}{o}
            </span>
          ))}
        </div>
        <span className={cn('text-sm font-bold', accent)}>就决定是「{toy.picked}」了</span>
      </div>
    )
  }

  // ball8
  return (
    <div className="flex flex-col gap-1">
      <span className={cn('text-[12px] opacity-80', accent)}>🔮 {toy.question}</span>
      <motion.span
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3 }}
        className={cn('text-sm font-bold', accent)}
      >
        魔球说：{toy.answer}
      </motion.span>
    </div>
  )
}
