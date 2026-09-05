'use client'

// 极光渐变背景（性能友好：纯 CSS 动画，GPU 合成）
export function Backdrop() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 overflow-hidden -z-10">
      {/* 三颗极光光球：紫罗兰 / 洋红 / 青色 */}
      <div className="orb animate-orb-a left-[-10%] top-[-15%] h-[46vmax] w-[46vmax] bg-violet-400/25 dark:bg-violet-600/20" />
      <div className="orb animate-orb-b right-[-12%] top-[10%] h-[40vmax] w-[40vmax] bg-fuchsia-400/20 dark:bg-fuchsia-600/15" />
      <div className="orb animate-orb-c bottom-[-18%] left-[20%] h-[44vmax] w-[44vmax] bg-teal-300/20 dark:bg-teal-500/10" />
      {/* 中心晕影，突出前景内容 */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_35%,var(--background)_100%)]" />
    </div>
  )
}
