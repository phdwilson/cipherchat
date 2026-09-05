// v1.6.0 频道玩具箱：以 / 开头的趣味指令，结果在发送端生成后作为加密消息广播
// v1.7.0 新增：/poll 加密投票、/ttt 井字棋对战、/confetti /fireworks 全屏特效
// 全部为纯函数，便于单元测试；随机结果随消息落库（其他成员看到的就是发送者掷出的结果）

export type RollPayload = { toy: 'roll'; expr: string; rolls: number[]; sides: number; total: number }
export type CoinPayload = { toy: 'coin'; result: 'heads' | 'tails' }
export type RpsPayload = {
  toy: 'rps'
  choice: 'rock' | 'paper' | 'scissors' | null
  result: 'rock' | 'paper' | 'scissors'
  outcome: 'win' | 'lose' | 'tie' | null
}
export type DecidePayload = { toy: 'decide'; options: string[]; picked: string }
export type Ball8Payload = { toy: 'ball8'; question: string; answer: string }

// ---- v1.7.0 加密投票 ----
// 题目与选项文字随 ToyPayload 整体加密落库；服务器只存「谁投了第几项」的元数据
export type PollPayload = { toy: 'poll'; question: string; options: string[]; multiple?: boolean }

// ---- v1.7.0 井字棋对战 ----
// board 为长度 9 的数组：null=空 / 0=挑战者(X) / 1=应战者(O)；走子生成新消息，
// 全频道都能围观棋局，仅对局双方可落子（客户端按 senderId 判定身份）
export type TttPayload = {
  toy: 'ttt'
  gameId: string
  challengerId: string // v1.7.0 补丁：挑战者 pubId（修复棋子归属误判：角色应绑定对局发起者而非当前消息发送者）
  board: Array<0 | 1 | null>
  lastMove: number | null
  winner: 0 | 1 | 'draw' | null // 对局结束时填充；draw=平局
  status: 'playing' | 'over'
  challengerNick: string
  opponentNick?: string // 应战者落第一子时补充
}

// ---- v1.7.0 全屏消息特效 ----
export type FxPayload = { toy: 'fx'; effect: 'confetti' | 'fireworks'; text?: string }

export type ToyPayload = RollPayload | CoinPayload | RpsPayload | DecidePayload | Ball8Payload | PollPayload | TttPayload | FxPayload

const rnd = (n: number) => 1 + Math.floor(Math.random() * n)

const RPS_WORD: Record<'rock' | 'paper' | 'scissors', string[]> = {
  rock: ['石头', '石', 'rock', 'r', '拳头'],
  paper: ['布', '纸', 'paper', 'p'],
  scissors: ['剪刀', '剪', 'scissors', 's'],
}

export function parseRpsChoice(input: string): 'rock' | 'paper' | 'scissors' | null {
  const q = input.trim().toLowerCase()
  for (const k of ['rock', 'paper', 'scissors'] as const) {
    if (RPS_WORD[k].some((w) => q === w)) return k
  }
  return null
}

function rpsOutcome(me: 'rock' | 'paper' | 'scissors', opp: 'rock' | 'paper' | 'scissors'): 'win' | 'lose' | 'tie' {
  if (me === opp) return 'tie'
  const beats: Record<'rock' | 'paper' | 'scissors', 'rock' | 'paper' | 'scissors'> = {
    rock: 'scissors',
    scissors: 'paper',
    paper: 'rock',
  }
  return beats[me] === opp ? 'win' : 'lose'
}

const BALL8_ANSWERS = [
  '那当然啦', '我看行', '毫无疑问', '放心冲', '迹象表明是的', '很有可能',
  '现在还不好说', '再等等看', '别问我，问你自己', '也许吧…大概…',
  '我觉得悬', '最好别', '答案是否定的', '醒醒，不可能', '概率渺茫', '洗洗睡吧',
]

// 解析骰子表达式：支持 "3d6"、"d20"、"20"（=1d20）、"2D6+1"（修饰符仅做加法展示）
export function parseDiceExpr(input: string): { count: number; sides: number; mod: number; expr: string } | null {
  // 只有出现 d 时第一个分组（数量）才存在，避免 "20" 被误吞为 count
  const m = input.trim().toLowerCase().match(/^(?:(?:(\d{1,2})\s*)?d\s*)?(\d{1,3})(?:\s*([+-])\s*(\d{1,3}))?$/)
  if (!m) return null
  const count = m[1] ? Number(m[1]) : 1
  const sides = Number(m[2])
  const mod = m[3] && m[4] ? (m[3] === '+' ? 1 : -1) * Number(m[4]) : 0
  if (!Number.isInteger(count) || count < 1 || count > 20) return null
  if (!Number.isInteger(sides) || sides < 2 || sides > 100) return null
  const expr = `${count}d${sides}${mod ? (mod > 0 ? `+${mod}` : String(mod)) : ''}`
  return { count, sides, mod, expr }
}

// ---------------- v1.7.0 井字棋核心（纯函数，可单测） ----------------
// 胜利线：三连即胜
const TTT_LINES: Array<[number, number, number]> = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8], // 横
  [0, 3, 6], [1, 4, 7], [2, 5, 8], // 竖
  [0, 4, 8], [2, 4, 6], // 斜
]

export function emptyTttBoard(): Array<0 | 1 | null> {
  return [null, null, null, null, null, null, null, null, null]
}

// 校验一步落子是否合法：格子为空且轮到该方（挑战者 X 先手；按已落子数推断轮次）
export function validateTttMove(board: Array<0 | 1 | null>, player: 0 | 1, moveIdx: number): { ok: boolean; error?: string } {
  if (!Number.isInteger(moveIdx) || moveIdx < 0 || moveIdx > 8) return { ok: false, error: '落子位置不合法' }
  if (board[moveIdx] !== null) return { ok: false, error: '这个格子已经有子了' }
  const placed = board.filter((c) => c !== null).length
  const turn: 0 | 1 = (placed % 2 === 0 ? 0 : 1) // X 先手，偶数子数轮到挑战者
  if (turn !== player) return { ok: false, error: '还没轮到你' }
  return { ok: true }
}

// 落子后判定胜负：0/1=对应方胜，'draw'=平局，null=继续
export function judgeTttBoard(board: Array<0 | 1 | null>): 0 | 1 | 'draw' | null {
  for (const [a, b, c] of TTT_LINES) {
    const v = board[a]
    if (v !== null && v === board[b] && v === board[c]) return v
  }
  if (board.every((c) => c !== null)) return 'draw'
  return null
}

// 解析一条以 / 开头的玩具指令；不是玩具指令（或参数非法）时返回 null。
// 支持：/roll [NdM]、/coin、/rps、/decide、/8ball、/poll、/confetti、/fireworks
export function parseToyCommand(raw: string): ToyPayload | null {
  const text = raw.trim()
  if (!text.startsWith('/')) return null
  const sp = text.indexOf(' ')
  const cmd = (sp < 0 ? text : text.slice(0, sp)).toLowerCase()
  const arg = sp < 0 ? '' : text.slice(sp + 1).trim()

  switch (cmd) {
    case '/roll': case '/r': case '/dice': case '/骰子': {
      const parsed = parseDiceExpr(arg || '1d6')
      if (!parsed) return null
      const rolls = Array.from({ length: parsed.count }, () => rnd(parsed.sides))
      const total = rolls.reduce((a, b) => a + b, 0) + parsed.mod
      return { toy: 'roll', expr: parsed.expr, rolls, sides: parsed.sides, total }
    }
    case '/coin': case '/flip': case '/硬币': {
      return { toy: 'coin', result: Math.random() < 0.5 ? 'heads' : 'tails' }
    }
    case '/rps': case '/猜拳': {
      const choice = arg ? parseRpsChoice(arg) : null
      if (arg && !choice) return null
      const result = (['rock', 'paper', 'scissors'] as const)[rnd(3) - 1]
      return { toy: 'rps', choice, result, outcome: choice ? rpsOutcome(choice, result) : null }
    }
    case '/decide': case '/choose': case '/pick': case '/选': {
      const options = arg
        .split(/[|｜,，、;；\n]+|\s{1,}/)
        .map((s) => s.trim())
        .filter(Boolean)
      if (options.length < 2 || options.length > 20) return null
      return { toy: 'decide', options, picked: options[rnd(options.length) - 1] }
    }
    case '/8ball': case '/ball': case '/魔球': {
      if (!arg) return null
      return { toy: 'ball8', question: arg.slice(0, 120), answer: BALL8_ANSWERS[rnd(BALL8_ANSWERS.length) - 1] }
    }
    // v1.7.0 加密投票：/poll 问题|选项A|选项B…（至少 2 项，至多 20 项）
    case '/poll': case '/vote': case '/投票': {
      if (!arg) return null
      const parts = arg
        .split(/[|｜\n]+/)
        .map((s) => s.trim())
        .filter(Boolean)
      if (parts.length < 3) return null // 问题 + 至少两个选项
      const question = parts[0].slice(0, 120)
      const options = parts.slice(1).map((o) => o.slice(0, 40))
      if (options.length < 2 || options.length > 20) return null
      if (new Set(options).size !== options.length) return null // 选项不能重复
      return { toy: 'poll', question, options }
    }
    // v1.7.0 全屏特效：/confetti [文案] /fireworks [文案]
    case '/confetti': case '/彩带': {
      return { toy: 'fx', effect: 'confetti', text: arg ? arg.slice(0, 60) : undefined }
    }
    case '/fireworks': case '/烟花': {
      return { toy: 'fx', effect: 'fireworks', text: arg ? arg.slice(0, 60) : undefined }
    }
    default:
      return null
  }
}

// 玩具指令的帮助文本（输入框提示用）
export const TOY_HELP: Array<{ cmd: string; example: string; desc: string }> = [
  { cmd: '/roll', example: '/roll 3d6', desc: '掷骰子（可指定数量与面数，如 2d20+1）' },
  { cmd: '/coin', example: '/coin', desc: '抛硬币' },
  { cmd: '/rps', example: '/rps 石头', desc: '猜拳（可带自己的出招比胜负）' },
  { cmd: '/decide', example: '/decide 火锅|烧烤|面条', desc: '帮你做选择' },
  { cmd: '/8ball', example: '/8ball 今天能下班吗', desc: '神奇魔球答疑' },
  { cmd: '/poll', example: '/poll 周末去哪|爬山|看电影', desc: '发起加密投票（全员实时计票）' },
  { cmd: '/confetti', example: '/confetti 生日快乐！', desc: '全频道撒彩带特效' },
  { cmd: '/fireworks', example: '/fireworks 新年快乐', desc: '全频道放烟花特效' },
]
