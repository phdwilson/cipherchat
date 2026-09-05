'use client'

// 品牌标识：紫渐变盾牌 + 闪电
export function Logo({ size = 36, className = '' }: { size?: number; className?: string }) {
  return (
    <span
      className={`inline-grid place-items-center rounded-xl grad-primary shadow-lg shadow-violet-500/25 ${className}`}
      style={{ width: size, height: size }}
      aria-hidden
    >
      <svg
        width={size * 0.62}
        height={size * 0.62}
        viewBox="0 0 24 24"
        fill="none"
        stroke="white"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12 2l8 3v6.2c0 4.9-3.3 9-8 10.8-4.7-1.8-8-5.9-8-10.8V5l8-3z" fill="rgba(255,255,255,.14)" />
        <path d="M13.6 7.5L9 12.2h3.2L10.4 17l4.6-4.7h-3.2l1.8-4.8z" fill="white" stroke="none" />
      </svg>
    </span>
  )
}
