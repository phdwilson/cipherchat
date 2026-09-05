// v1.6.0 频道玩具箱纯逻辑测试（vitest）
import { describe, it, expect } from 'vitest'
import { parseToyCommand, parseDiceExpr, parseRpsChoice, validateTttMove, judgeTttBoard, emptyTttBoard } from './toys'

describe('parseDiceExpr', () => {
  it('支持 NdM / dM / 纯数字 / 修饰符', () => {
    expect(parseDiceExpr('3d6')).toMatchObject({ count: 3, sides: 6, mod: 0, expr: '3d6' })
    expect(parseDiceExpr('d20')).toMatchObject({ count: 1, sides: 20 })
    expect(parseDiceExpr('20')).toMatchObject({ count: 1, sides: 20 })
    expect(parseDiceExpr('2d6+1')).toMatchObject({ count: 2, sides: 6, mod: 1, expr: '2d6+1' })
    expect(parseDiceExpr('1d4-2')).toMatchObject({ mod: -2 })
    // 大小写不敏感、容忍空格
    expect(parseDiceExpr(' 2 D 8 ')).toMatchObject({ count: 2, sides: 8 })
  })

  it('拒绝越界与非法表达式', () => {
    expect(parseDiceExpr('0d6')).toBeNull() // 数量 0
    expect(parseDiceExpr('21d6')).toBeNull() // 数量超 20
    expect(parseDiceExpr('3d1')).toBeNull() // 面数 <2
    expect(parseDiceExpr('3d101')).toBeNull() // 面数 >100
    expect(parseDiceExpr('abc')).toBeNull()
    expect(parseDiceExpr('')).toBeNull()
  })
})

describe('parseRpsChoice', () => {
  it('识别中英文出招', () => {
    expect(parseRpsChoice('石头')).toBe('rock')
    expect(parseRpsChoice('剪刀')).toBe('scissors')
    expect(parseRpsChoice('布')).toBe('paper')
    expect(parseRpsChoice('R')).toBe('rock')
    expect(parseRpsChoice('paper')).toBe('paper')
    expect(parseRpsChoice('飞镖')).toBeNull()
  })
})

describe('parseToyCommand /roll', () => {
  it('默认 1d6，点数全部落在 [1,6]，total=sum+mod', () => {
    for (let i = 0; i < 50; i++) {
      const t = parseToyCommand('/roll')
      expect(t?.toy).toBe('roll')
      if (t?.toy !== 'roll') throw new Error('guard')
      expect(t.rolls).toHaveLength(1)
      expect(t.rolls[0]).toBeGreaterThanOrEqual(1)
      expect(t.rolls[0]).toBeLessThanOrEqual(6)
      expect(t.total).toBe(t.rolls.reduce((a, b) => a + b, 0))
    }
  })

  it('3d20+2：点数范围与合计正确', () => {
    const t = parseToyCommand('/roll 3d20+2')
    expect(t?.toy).toBe('roll')
    if (t?.toy !== 'roll') throw new Error('guard')
    expect(t.rolls).toHaveLength(3)
    for (const n of t.rolls) {
      expect(n).toBeGreaterThanOrEqual(1)
      expect(n).toBeLessThanOrEqual(20)
    }
    expect(t.total).toBe(t.rolls.reduce((a, b) => a + b, 0) + 2)
  })

  it('非法骰子表达式返回 null（不会误发消息）', () => {
    expect(parseToyCommand('/roll 99d999')).toBeNull()
  })
})

describe('parseToyCommand /coin', () => {
  it('结果只可能是 heads/tails，别名可用', () => {
    for (const cmd of ['/coin', '/flip', '/硬币']) {
      const t = parseToyCommand(cmd)
      expect(t?.toy).toBe('coin')
      if (t?.toy !== 'coin') throw new Error('guard')
      expect(['heads', 'tails']).toContain(t.result)
    }
  })
})

describe('parseToyCommand /rps', () => {
  it('不带出招：随机出招且 outcome 为 null', () => {
    const t = parseToyCommand('/rps')
    expect(t?.toy).toBe('rps')
    if (t?.toy !== 'rps') throw new Error('guard')
    expect(t.choice).toBeNull()
    expect(t.outcome).toBeNull()
    expect(['rock', 'paper', 'scissors']).toContain(t.result)
  })

  it('带出招时胜负关系自洽（石头克剪刀）', () => {
    // 穷举验证 outcome 与 result/choice 的关系
    for (let i = 0; i < 30; i++) {
      const t = parseToyCommand('/rps 石头')
      if (t?.toy !== 'rps') throw new Error('guard')
      expect(t.choice).toBe('rock')
      if (t.result === 'scissors') expect(t.outcome).toBe('win')
      if (t.result === 'paper') expect(t.outcome).toBe('lose')
      if (t.result === 'rock') expect(t.outcome).toBe('tie')
    }
  })

  it('非法出招返回 null', () => {
    expect(parseToyCommand('/rps 飞')).toBeNull()
  })
})

describe('parseToyCommand /decide', () => {
  it('支持 | 、中文顿号、空格分隔，结果必在候选中', () => {
    const t1 = parseToyCommand('/decide 火锅|烧烤|面条')
    expect(t1?.toy).toBe('decide')
    if (t1?.toy !== 'decide') throw new Error('guard')
    expect(t1.options).toEqual(['火锅', '烧烤', '面条'])
    expect(t1.options).toContain(t1.picked)

    const t2 = parseToyCommand('/choose 咖啡 茶 可乐')
    if (t2?.toy !== 'decide') throw new Error('guard')
    expect(t2.options).toHaveLength(3)
    expect(t2.options).toContain(t2.picked)
  })

  it('少于 2 个候选或超过 20 个返回 null', () => {
    expect(parseToyCommand('/decide 只有一个')).toBeNull()
    expect(parseToyCommand(`/decide ${Array.from({ length: 21 }, (_, i) => `o${i}`).join('|')}`)).toBeNull()
  })
})

describe('parseToyCommand /8ball', () => {
  it('必须带问题，答案非空字符串', () => {
    expect(parseToyCommand('/8ball')).toBeNull()
    const t = parseToyCommand('/8ball 今天能下班吗')
    expect(t?.toy).toBe('ball8')
    if (t?.toy !== 'ball8') throw new Error('guard')
    expect(t.question).toBe('今天能下班吗')
    expect(t.answer.length).toBeGreaterThan(0)
  })
})

describe('parseToyCommand /poll（v1.7.0）', () => {
  it('问题 + 选项解析正确，别名可用', () => {
    for (const cmd of ['/poll', '/vote', '/投票']) {
      const t = parseToyCommand(`${cmd} 周末去哪|爬山|看电影`)
      expect(t?.toy).toBe('poll')
      if (t?.toy !== 'poll') throw new Error('guard')
      expect(t.question).toBe('周末去哪')
      expect(t.options).toEqual(['爬山', '看电影'])
    }
  })

  it('选项重复、少于 3 段、超过 20 选项返回 null', () => {
    expect(parseToyCommand('/poll 只有标题')).toBeNull()
    expect(parseToyCommand('/poll 问题|一样|一样')).toBeNull()
    expect(parseToyCommand(`/poll 问题|${Array.from({ length: 21 }, (_, i) => `o${i}`).join('|')}`)).toBeNull()
  })
})

describe('parseToyCommand /confetti /fireworks（v1.7.0）', () => {
  it('带文案与不带文案都合法', () => {
    const t1 = parseToyCommand('/confetti 生日快乐！')
    expect(t1?.toy).toBe('fx')
    if (t1?.toy !== 'fx') throw new Error('guard')
    expect(t1.effect).toBe('confetti')
    expect(t1.text).toBe('生日快乐！')

    const t2 = parseToyCommand('/fireworks')
    if (t2?.toy !== 'fx') throw new Error('guard')
    expect(t2.effect).toBe('fireworks')
    expect(t2.text).toBeUndefined()
  })
})

describe('井字棋核心（v1.7.0）', () => {
  it('空盘轮到 X（挑战者），落子后轮到 O', () => {
    const b = emptyTttBoard()
    expect(validateTttMove(b, 0, 0).ok).toBe(true)
    expect(validateTttMove(b, 1, 0).ok).toBe(false) // 先手是 X
    const b2 = [...b]
    b2[0] = 0
    expect(validateTttMove(b2, 1, 4).ok).toBe(true)
    expect(validateTttMove(b2, 0, 4).ok).toBe(false) // 轮到 O
  })

  it('已占格与越界落子被拒绝', () => {
    const b = emptyTttBoard()
    b[3] = 0
    expect(validateTttMove(b, 1, 3).ok).toBe(false)
    expect(validateTttMove(b, 0, 9).ok).toBe(false)
    expect(validateTttMove(b, 0, -1).ok).toBe(false)
  })

  it('横竖斜三连判定胜负，满盘无三连为平局', () => {
    const win0 = [0, 0, 0, 1, 1, null, null, null, null] as Array<0 | 1 | null>
    expect(judgeTttBoard(win0)).toBe(0)
    const win1 = [0, 0, 1, 0, 1, 1, 1, 0, 0] as Array<0 | 1 | null>
    expect(judgeTttBoard(win1)).toBe(1) // 反斜线 2,4,6
    const draw = [0, 0, 1, 1, 1, 0, 0, 1, 0] as Array<0 | 1 | null>
    expect(judgeTttBoard(draw)).toBe('draw')
    const ongoing = [0, null, null, null, 1, null, null, null, null] as Array<0 | 1 | null>
    expect(judgeTttBoard(ongoing)).toBeNull()
  })
})

describe('非玩具指令', () => {
  it('普通文本、未知斜杠指令、空串返回 null', () => {
    expect(parseToyCommand('你好')).toBeNull()
    expect(parseToyCommand('/help')).toBeNull()
    expect(parseToyCommand('')).toBeNull()
    expect(parseToyCommand('  ')).toBeNull()
  })
})
