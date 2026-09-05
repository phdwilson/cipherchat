// v1.6.0 消息文本内联格式解析（纯函数，无 React 依赖，便于单测）
// 目前支持：||剧透遮罩|| —— 渲染为模糊块，点击才揭示；未闭合的 || 按普通文本处理

export type TextSegment =
  | { type: 'text'; value: string }
  | { type: 'spoiler'; value: string }

const SPOILER_RE = /\|\|([^|]+?)\|\|/g

export function parseSegments(text: string): TextSegment[] {
  if (!text) return []
  const out: TextSegment[] = []
  let last = 0
  // 全局正则在循环外重置（复用同一模块时避免 lastIndex 残留）
  const re = new RegExp(SPOILER_RE.source, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ type: 'text', value: text.slice(last, m.index) })
    out.push({ type: 'spoiler', value: m[1] })
    last = m.index + m[0].length
  }
  if (last < text.length) out.push({ type: 'text', value: text.slice(last) })
  return out
}

// 是否包含任何特殊格式（组件决定是否走分段渲染）
export function hasRichFormat(text: string | undefined | null): boolean {
  return !!text && /\|\|[^|]+\|\|/.test(text)
}
