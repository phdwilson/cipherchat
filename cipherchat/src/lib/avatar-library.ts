'use client'
// 默认头像库：30 个手绘风格的 SVG 头像（数据 URL，零网络）
// 用户首次进入频道时若未上传头像，自动从库中按设备 ID 哈希挑选一个稳定头像
// 这样每个设备有专属的"卡通形象"，避免千篇一律的首字母头像

// 30 种独立的渐变背景 + 抽象图案（圆形/三角/方框/线条组合），保证视觉差异
const PALETTE: [string, string][] = [
  ['#FF6B6B', '#FFD93D'], ['#6BCB77', '#4D96FF'], ['#A66CFF', '#FF6BCB'],
  ['#FF8E53', '#F6C90E'], ['#3FB8B3', '#2EC4B6'], ['#E71D36', '#FF9F1C'],
  ['#8338EC', '#3A86FF'], ['#FF006E', '#FB5607'], ['#06FFA5', '#118AB2'],
  ['#7209B7', '#560BAD'], ['#F72585', '#B5179E'], ['#4361EE', '#7209B7'],
  ['#4CC9F0', '#4895EF'], ['#F9C74F', '#F8961E'], ['#90BE6D', '#43AA8B'],
  ['#577590', '#6247AA'], ['#F94144', '#F3722C'], ['#F8961E', '#F9844A'],
  ['#90BE6D', '#F9C74F'], ['#577590', '#277DA1'], ['#B5179E', '#560BAD'],
  ['#FF99C8', '#FCF6BD'], ['#D0F4DE', '#A9DEF9'], ['#FFB5A7', '#FCD5CE'],
  ['#E4F1FF', '#C1E1FF'], ['#FFE2E2', '#FFC6C6'], ['#B5EFE9', '#A0E7E5'],
  ['#FFA9BB', '#FFB6C1'], ['#9DAAF2', '#B4A0E5'], ['#FFCFD3', '#F5A3B0'],
]

// 抽象图案集合：4 种主图形 + 多次随机点位叠加形成独特视觉指纹
const PATTERNS: Array<(seed: number) => string> = [
  (s) => `<circle cx="${20 + (s % 30)}" cy="${20 + (s % 30)}" r="14" fill="rgba(255,255,255,0.32)"/><circle cx="${50 + (s % 20)}" cy="${60 + (s % 18)}" r="9" fill="rgba(0,0,0,0.18)"/>`,
  (s) => `<path d="M${30 + s % 10} 22 L${48 + s % 6} ${50 + s % 8} L${22 + s % 8} ${48 + s % 6} Z" fill="rgba(255,255,255,0.4)"/><circle cx="65" cy="65" r="8" fill="rgba(0,0,0,0.16)"/>`,
  (s) => `<rect x="${22 + s % 8}" y="${22 + s % 8}" width="22" height="22" rx="7" fill="rgba(255,255,255,0.32)" transform="rotate(${s % 30} 33 33)"/><rect x="${48 + s % 6}" y="${48 + s % 6}" width="14" height="14" rx="5" fill="rgba(0,0,0,0.16)"/>`,
  (s) => `<path d="M${15 + s % 8} ${30 + s % 10} Q ${35 + s % 8} ${10 + s % 6} ${55 + s % 8} ${30 + s % 10} T ${75 + s % 6} ${30 + s % 8}" stroke="rgba(255,255,255,0.4)" stroke-width="3" fill="none"/><circle cx="65" cy="60" r="7" fill="rgba(0,0,0,0.18)"/>`,
  (s) => `<circle cx="30" cy="30" r="10" fill="rgba(255,255,255,0.35)"/><circle cx="55" cy="35" r="6" fill="rgba(255,255,255,0.25)"/><circle cx="40" cy="55" r="8" fill="rgba(0,0,0,0.16)"/>`,
  (s) => `<polygon points="${30 + s % 5},15 50,30 35,55 18,35" fill="rgba(255,255,255,0.35)"/><circle cx="65" cy="65" r="9" fill="rgba(0,0,0,0.18)"/>`,
]

const AVATAR_COUNT = 30

// 生成单个头像的 SVG data URL
function buildAvatar(idx: number): string {
  const [c1, c2] = PALETTE[idx % PALETTE.length]
  const pat = PATTERNS[idx % PATTERNS.length]
  const angle = (idx * 47) % 360
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 100 100">
<defs>
  <linearGradient id="g${idx}" x1="0%" y1="0%" x2="100%" y2="100%" gradientTransform="rotate(${angle} 0.5 0.5)">
    <stop offset="0%" stop-color="${c1}"/>
    <stop offset="100%" stop-color="${c2}"/>
  </linearGradient>
</defs>
<rect width="100" height="100" rx="22" fill="url(#g${idx})"/>
${pat(idx * 17 + 3)}
</svg>`
  return 'data:image/svg+xml,' + encodeURIComponent(svg.replace(/\n/g, '').trim())
}

// 预生成全部 30 个头像（启动时一次）
const ALL_AVATARS: string[] = Array.from({ length: AVATAR_COUNT }, (_, i) => buildAvatar(i))

export function listAvatars(): string[] {
  return ALL_AVATARS
}

// 根据种子（设备 ID）稳定挑选一个头像：相同 pubId 始终对应同一头像
export function pickAvatarBySeed(seed: string): string {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % AVATAR_COUNT
  return ALL_AVATARS[h]
}

// 随机挑一个（首次进入频道时使用，但会落到本地存储保持稳定）
export function pickRandomAvatar(): string {
  return ALL_AVATARS[Math.floor(Math.random() * AVATAR_COUNT)]
}

// 本地存储默认头像：用户首次进入频道时若未自定义头像，则随机选一个稳定保存
const DEFAULT_AVATAR_KEY = 'cipherchat:default-avatar'

export function getDefaultAvatar(): string | null {
  try {
    return localStorage.getItem(DEFAULT_AVATAR_KEY)
  } catch {
    return null
  }
}

export function setDefaultAvatar(dataUrl: string): void {
  try {
    localStorage.setItem(DEFAULT_AVATAR_KEY, dataUrl)
  } catch { /* ignore */ }
}

export function getOrInitDefaultAvatar(seed: string): string {
  const existing = getDefaultAvatar()
  if (existing) return existing
  const picked = pickAvatarBySeed(seed)
  setDefaultAvatar(picked)
  return picked
}

// 用户当前激活头像：自定义上传优先，否则用默认库
export function resolveActiveAvatar(seed: string, custom: string | null): string {
  if (custom) return custom
  return getOrInitDefaultAvatar(seed)
}
