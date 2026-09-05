// 频道 ID 相关工具：随机生成（防重复）/ 随机示例 / 安全上下文检测

const ID_ADJECTIVES = [
  'starlight', 'moonlit', 'silent', 'cosmic', 'amber', 'crimson', 'frozen', 'golden', 'hidden', 'lunar',
  'misty', 'northern', 'obsidian', 'phantom', 'quantum', 'rapid', 'shadow', 'silver', 'solar', 'twilight',
  'velvet', 'wild', 'zenith', 'aurora', 'cobalt', 'emerald', 'frost', 'neon', 'onyx', 'polar',
  'scarlet', 'stellar', 'tidal', 'urban', 'violet', 'arctic', 'blaze', 'crystal', 'dusk', 'echo',
]
const ID_NOUNS = [
  'corridor', 'harbor', 'garden', 'station', 'canyon', 'meadow', 'orbit', 'ridge', 'valley', 'bunker',
  'citadel', 'cottage', 'depot', 'falcon', 'gate', 'haven', 'island', 'junction', 'keep', 'lagoon',
  'manor', 'nest', 'outpost', 'peak', 'quarry', 'refuge', 'sanctum', 'tower', 'vault', 'watchtower',
  'whisper', 'workshop', 'atelier', 'bazaar', 'chapel', 'dungeon', 'embassy', 'forest', 'gallery', 'hamlet',
]
// 中文频道示例（随机挑选展示）
const CN_EXAMPLES = ['项目协作组', '深夜闲聊室', '家庭相册馆', '游戏开黑房', '摸鱼交流组', '老友记频道', '读书会秘密基地', '周末爬山队', '猫咪表情包大战', '夜宵情报局']
const GEN_HISTORY_KEY = 'cipherchat_gen_ids'

// 生成一个随机频道 ID；通过 localStorage 历史记录避免重复生成
export function generateChannelId(): string {
  let history: string[] = []
  try {
    history = JSON.parse(localStorage.getItem(GEN_HISTORY_KEY) || '[]').slice(-200)
  } catch { /* ignore */ }

  let id = ''
  const maxTries = 32
  for (let i = 0; i < maxTries; i++) {
    const adj = ID_ADJECTIVES[Math.floor(Math.random() * ID_ADJECTIVES.length)]
    const noun = ID_NOUNS[Math.floor(Math.random() * ID_NOUNS.length)]
    const num = String(Math.floor(Math.random() * 900) + 100) // 100-999
    id = `${adj}-${noun}-${num}`
    if (!history.includes(id)) break // 与本机历史不重复
  }

  history.push(id)
  try {
    localStorage.setItem(GEN_HISTORY_KEY, JSON.stringify(history.slice(-200)))
  } catch { /* ignore */ }
  return id
}

// 每次页面加载生成一组随机示例（3 个英文随机 + 1 个中文随机），替代固定静态示例
export function randomExamples(): string[] {
  return [
    generateChannelId(),
    generateChannelId(),
    generateChannelId(),
    CN_EXAMPLES[Math.floor(Math.random() * CN_EXAMPLES.length)],
  ]
}

// 安全上下文检测：非 HTTPS（且非 localhost）时浏览器禁用 WebCrypto，需明确提示
export function isSecureContextOk(): boolean {
  try {
    return typeof window !== 'undefined' && window.isSecureContext === true && !!(window.crypto && window.crypto.subtle)
  } catch {
    return false
  }
}
