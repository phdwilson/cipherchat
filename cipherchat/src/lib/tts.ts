'use client'
// 频道内 TTS 朗读（无障碍 / 不方便看屏幕场景）
// 使用浏览器内置 speechSynthesis，文本不出设备
// v1.8.0：朗读失败不再静默 —— 返回结果并给出原因与修复方式
import { toast } from 'sonner'
let autoRead = (() => {
  try { return localStorage.getItem('cipherchat:tts-auto') === 'on' } catch { return false }
})()

export function isTtsAuto(): boolean { return autoRead }
export function setTtsAuto(on: boolean) {
  autoRead = on
  try { localStorage.setItem('cipherchat:tts-auto', on ? 'on' : 'off') } catch { /* ignore */ }
  if (!on) stopSpeaking()
}

// v1.7.0：Chrome 首次调用 getVoices() 常返回空列表（voices 异步加载），
// 监听 voiceschanged 事件预热缓存
let voicesCache: SpeechSynthesisVoice[] | null = null
function primeVoices() {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return
  if (!voicesCache) voicesCache = window.speechSynthesis.getVoices()
  if (voicesCache.length === 0) {
    window.speechSynthesis.addEventListener('voiceschanged', () => {
      voicesCache = window.speechSynthesis.getVoices()
    }, { once: true })
  }
}
if (typeof window !== 'undefined') primeVoices()

export function speakText(text: string): boolean {
  const clean = text.replace(/\s+/g, ' ').trim().slice(0, 600)
  if (!clean) return false
  // v1.8.0：不支持 speechSynthesis 的环境明确告知（此前静默返回，用户以为在读）
  if (typeof window === 'undefined') return false
  if (!('speechSynthesis' in window)) {
    toast.error('当前浏览器不支持语音朗读', {
      description: '原因：浏览器未提供 speechSynthesis 能力（常见于老旧 WebView / 部分手机内置浏览器）。\n处理：换用 Chrome / Edge / Safari 最新版即可朗读。',
      duration: 8000,
    })
    return false
  }
  try {
    window.speechSynthesis.cancel()
    const u = new SpeechSynthesisUtterance(clean)
    // 优先选择中文语音（带缓存 + voiceschanged 预热，避免首次读到外文语音）
    const voices = voicesCache?.length ? voicesCache : window.speechSynthesis.getVoices()
    voicesCache = voices
    const zh = voices.find((v) => v.lang?.toLowerCase().startsWith('zh'))
    if (zh) u.voice = zh
    u.lang = zh?.lang || 'zh-CN'
    u.rate = 1.05
    window.speechSynthesis.speak(u)
    return true
  } catch (e) {
    // v1.8.0：异常不再吞掉 —— 告知原因与处理方式
    toast.error('语音朗读启动失败', {
      description: `原因：${e instanceof Error ? e.message : '浏览器语音引擎异常'}。\n处理：刷新页面后重试；若反复失败，可能系统语音引擎损坏，重启浏览器/设备可修复。`,
      duration: 8000,
    })
    return false
  }
}

export function stopSpeaking() {
  try { window.speechSynthesis?.cancel() } catch { /* ignore */ }
}
