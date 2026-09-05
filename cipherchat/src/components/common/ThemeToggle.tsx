'use client'

import { useTheme } from 'next-themes'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Moon, Sun, MonitorSmartphone } from 'lucide-react'
import { Button } from '@/components/ui/button'

const emptySubscribe = () => () => {}

export function ThemeToggle() {
  const { theme, setTheme, resolvedTheme } = useTheme()
  const mounted = useSyncExternalStore(emptySubscribe, () => true, () => false)

  const cycle = () => {
    // light -> dark -> system -> light
    const current = theme === 'system' ? (resolvedTheme || 'light') : theme
    if (current === 'light') setTheme('dark')
    else if (current === 'dark') setTheme('system')
    else setTheme('light')
  }

  const label = !mounted ? '主题' : theme === 'system' ? '跟随系统' : theme === 'dark' ? '深色' : '浅色'

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={cycle}
      aria-label={`切换主题（当前：${label}）`}
      title={`主题：${label}（点击切换）`}
      className="relative rounded-full h-9 w-9 text-muted-foreground hover:text-foreground transition-all duration-300"
    >
      {mounted && theme === 'dark' && <Moon className="h-[18px] w-[18px]" />}
      {mounted && theme === 'light' && <Sun className="h-[18px] w-[18px]" />}
      {mounted && theme === 'system' && <MonitorSmartphone className="h-[18px] w-[18px]" />}
      {!mounted && <Sun className="h-[18px] w-[18px] opacity-0" />}
    </Button>
  )
}
