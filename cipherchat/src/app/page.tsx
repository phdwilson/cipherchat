'use client'

import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { toast } from 'sonner'
import { MessageSquareLock, HardDrive, House, ShieldCheck, Mic2 } from 'lucide-react'
import { Backdrop } from '@/components/common/Backdrop'
import { ThemeToggle } from '@/components/common/ThemeToggle'
import { Logo } from '@/components/common/Logo'
import { HomeScreen } from '@/components/home/HomeScreen'
import { ChatJoin } from '@/components/chat/ChatJoin'
import { ChatScreen } from '@/components/chat/ChatScreen'
import { InviteJoin, extractInviteCode } from '@/components/chat/InviteJoin'
import { DriveUnlock } from '@/components/drive/DriveUnlock'
import { DriveScreen } from '@/components/drive/DriveScreen'
import { AdminScreen } from '@/components/admin/AdminScreen'
import { VoiceLobby } from '@/components/voice/VoiceLobby'
import { DMCallModal } from '@/components/voice/DMCallModal'
import { useChatStore, type RuntimeConfig } from '@/store/chat'
import { useDriveStore } from '@/store/drive'

type Screen = 'home' | 'chat' | 'drive' | 'admin' | 'voice'

// 自毁/重置时的无害提示池（可否认性：不暴露发生了什么，仅呈现一句平常话）
const RESET_TOASTS = [
  '已进入频道，祝你一切顺利 ✨',
  '夜色温柔，愿你今晚好梦 🌙',
  '晚风掠过山岗，一切如常 🍃',
  '新的对话空间已就绪 🎵',
  '信号良好，通讯一切正常 📡',
  '今天也是适合聊天的好日子 ☀️',
  '云朵飘过，天空依然明亮 ☁️',
  '愿你拥有平静而美好的一天 🕊️',
]

export default function Page() {
  const [screen, setScreen] = useState<Screen>('home')
  const [config, setConfigState] = useState<RuntimeConfig | null>(null)
  const setConfig = useChatStore((s) => s.setConfig)
  const chatJoined = useChatStore((s) => s.joined)
  const driveUnlocked = useDriveStore((s) => s.unlocked)
  // 邀请链接进入：#/invite=CODE → 直接显示分享进入页
  const [inviteCode, setInviteCode] = useState<string | null>(null)

  useEffect(() => {
    const checkInvite = () => {
      if (extractInviteCode()) setInviteCode(extractInviteCode())
    }
    checkInvite()
    window.addEventListener('hashchange', checkInvite)
    return () => window.removeEventListener('hashchange', checkInvite)
  }, [])

  useEffect(() => {
    fetch('/api/config')
      .then((r) => r.json())
      .then((c: RuntimeConfig) => {
        setConfigState(c)
        setConfig(c)
      })
      .catch(() => {})
  }, [setConfig])

  // 自毁/重置响应：任何入口检测到自毁密钥 / 收到全局自毁广播 →
  // 静默清空本地状态回到首页，仅呈现一句随机无害提示（可否认性设计）
  const wipeHandled = useRef(false)
  useEffect(() => {
    const checkWipe = () => {
      const wiped = useChatStore.getState().wiped || useDriveStore.getState().wiped
      if (wiped && !wipeHandled.current) {
        wipeHandled.current = true
        useChatStore.getState().leave()
        useDriveStore.getState().lock()
        setScreen('home')
        toast(RESET_TOASTS[Math.floor(Math.random() * RESET_TOASTS.length)], { duration: 4000 })
      } else if (!wiped) {
        wipeHandled.current = false
      }
    }
    const u1 = useChatStore.subscribe(checkWipe)
    const u2 = useDriveStore.subscribe(checkWipe)
    return () => {
      u1()
      u2()
    }
  }, [])

  const go = (s: Screen) => {
    setScreen(s)
    if (typeof window !== 'undefined') window.scrollTo({ top: 0 })
  }

  return (
    <div className="min-h-[100dvh] flex flex-col relative">
      <Backdrop />

      {/* 顶栏（聊天全屏模式下隐藏，聊天页自带头部） */}
      {!(screen === 'chat' && chatJoined) && (
        <header className="sticky top-0 z-40 pt-safe">
          <div className="mx-auto max-w-6xl px-4 sm:px-6 py-2.5 flex items-center gap-2">
            <button onClick={() => go('home')} className="flex items-center gap-2 group" aria-label="返回首页">
              <Logo size={30} className="transition-transform group-hover:scale-110" />
              <span className="font-semibold tracking-tight text-[15px]">
                密讯<span className="text-muted-foreground font-normal"> CipherChat</span>
              </span>
            </button>

            <div className="flex-1" />

            <nav className="flex items-center gap-1 rounded-full bg-white/60 dark:bg-zinc-900/60 backdrop-blur-xl border border-black/[0.06] dark:border-white/[0.08] p-1 shadow-sm">
              <NavBtn active={screen === 'home'} onClick={() => go('home')} icon={<House className="h-4 w-4" />} label="首页" />
              <NavBtn active={screen === 'voice'} onClick={() => go('voice')} icon={<Mic2 className="h-4 w-4" />} label="语音" />
              <NavBtn active={screen === 'chat'} onClick={() => go('chat')} icon={<MessageSquareLock className="h-4 w-4" />} label="聊天" dot={chatJoined} />
              <NavBtn active={screen === 'drive'} onClick={() => go('drive')} icon={<HardDrive className="h-4 w-4" />} label="网盘" dot={driveUnlocked} />
              <NavBtn active={screen === 'admin'} onClick={() => go('admin')} icon={<ShieldCheck className="h-4 w-4" />} label="管理" />
            </nav>

            <ThemeToggle />
          </div>
        </header>
      )}

      {/* 主体 */}
      <main className="flex-1 flex flex-col w-full">
        <AnimatePresence mode="wait">
          {inviteCode && !chatJoined ? (
            <motion.div key="invite" className="flex-1 flex flex-col" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <InviteJoin onBack={() => { window.location.hash = ''; setInviteCode(null); go('home') }} />
              <Footer />
            </motion.div>
          ) : screen === 'home' && (
            <motion.div key="home" className="w-full" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, y: -10 }} transition={{ duration: 0.25 }}>
              <HomeScreen go={go} config={config} />
              <Footer />
            </motion.div>
          )}
          {screen === 'chat' && chatJoined ? (
            /* 聊天全屏模式：无边距无内边，ChatScreen 自带玻璃头部/底部 */
            <motion.div key="chat-live" className="flex-1 flex flex-col" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
              <ChatScreen onExit={() => { useChatStore.getState().leave(); go('home') }} />
            </motion.div>
          ) : screen === 'chat' ? (
            <motion.div key="chat-join" className="flex-1 flex flex-col" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} transition={{ duration: 0.28, ease: [0.2, 0.8, 0.25, 1] }}>
              <ChatJoin onBack={() => go('home')} />
              <Footer />
            </motion.div>
          ) : null}
          {screen === 'drive' && (
            <motion.div key="drive" className="flex-1 flex flex-col px-0 sm:px-6" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} transition={{ duration: 0.28, ease: [0.2, 0.8, 0.25, 1] }}>
              {driveUnlocked ? (
                <DriveScreen onExit={() => { useDriveStore.getState().lock(); go('home') }} />
              ) : (
                <>
                  <DriveUnlock onBack={() => go('home')} />
                  <Footer />
                </>
              )}
            </motion.div>
          )}
          {screen === 'admin' && (
            <motion.div key="admin" className="flex-1 flex flex-col" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} transition={{ duration: 0.28, ease: [0.2, 0.8, 0.25, 1] }}>
              <AdminScreen onBack={() => go('home')} />
              <Footer />
            </motion.div>
          )}
          {screen === 'voice' && (
            <motion.div key="voice" className="flex-1 flex flex-col" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} transition={{ duration: 0.28, ease: [0.2, 0.8, 0.25, 1] }}>
              <VoiceLobby onExit={() => go('home')} />
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* 私聊语音通话弹窗（全局，跨界面） */}
      <DMCallModal />
    </div>
  )
}

function NavBtn({ active, onClick, icon, label, dot }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string; dot?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`relative inline-flex items-center gap-1.5 rounded-full px-3 sm:px-3.5 h-8 text-[13px] font-medium transition-all active:scale-95 ${
        active ? 'bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white shadow-md shadow-violet-500/25' : 'text-muted-foreground hover:text-foreground hover:bg-black/[0.04] dark:hover:bg-white/[0.06]'
      }`}
      aria-current={active ? 'page' : undefined}
    >
      {icon}
      <span className="hidden xs:inline sm:inline">{label}</span>
      {dot && <span className="absolute -top-0 -right-0 h-1.5 w-1.5 rounded-full bg-violet-400 ring-2 ring-white dark:ring-zinc-900" />}
    </button>
  )
}

function Footer() {
  return (
    <footer className="mt-auto pb-safe">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 py-6 flex flex-col sm:flex-row items-center justify-between gap-2 text-[11.5px] text-muted-foreground">
        <p>密讯 CipherChat · 端到端加密中继 · 服务器零知识</p>
        <p>AES-256-GCM / PBKDF2 310k / WebSocket Relay</p>
      </div>
    </footer>
  )
}
