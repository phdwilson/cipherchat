// v1.6.0 剧透遮罩文本解析测试（vitest）
import { describe, it, expect } from 'vitest'
import { parseSegments, hasRichFormat } from './textfmt'

describe('parseSegments', () => {
  it('无遮罩时整段为 text', () => {
    expect(parseSegments('普通文本')).toEqual([{ type: 'text', value: '普通文本' }])
    expect(parseSegments('')).toEqual([])
  })

  it('解析单个 ||剧透||', () => {
    expect(parseSegments('开头||秘密||结尾')).toEqual([
      { type: 'text', value: '开头' },
      { type: 'spoiler', value: '秘密' },
      { type: 'text', value: '结尾' },
    ])
  })

  it('解析多个遮罩段并保持顺序', () => {
    const segs = parseSegments('a||x||b||y||c')
    expect(segs).toEqual([
      { type: 'text', value: 'a' },
      { type: 'spoiler', value: 'x' },
      { type: 'text', value: 'b' },
      { type: 'spoiler', value: 'y' },
      { type: 'text', value: 'c' },
    ])
  })

  it('未闭合的 || 按普通文本处理（不丢内容）', () => {
    expect(parseSegments('半截||剧透')).toEqual([{ type: 'text', value: '半截||剧透' }])
  })

  it('空遮罩 || 不视为剧透（内部必须有内容）', () => {
    expect(parseSegments('a||||b')).toEqual([{ type: 'text', value: 'a||||b' }])
  })

  it('遮罩内不允许再嵌套 |（非贪婪到最近闭合）', () => {
    const segs = parseSegments('||a|b||')
    expect(segs).toEqual([{ type: 'text', value: '||a|b||' }])
  })
})

describe('hasRichFormat', () => {
  it('正确判定是否含遮罩', () => {
    expect(hasRichFormat('||x||')).toBe(true)
    expect(hasRichFormat('plain')).toBe(false)
    expect(hasRichFormat('')).toBe(false)
    expect(hasRichFormat(undefined)).toBe(false)
    expect(hasRichFormat('未闭合||x')).toBe(false)
  })
})
