'use client'
// v1.7.0 全屏消息特效画布：彩带（confetti）与烟花（fireworks）
// 由频道内的加密玩具消息触发（/confetti /fireworks），全员同屏可见
// 纯 Canvas 2D 实现，requestAnimationFrame 驱动，粒子结束自动卸载，零依赖
import { useEffect, useRef } from 'react'

export type FxKind = 'confetti' | 'fireworks'

interface Particle {
  x: number; y: number
  vx: number; vy: number
  size: number
  color: string
  rot: number; vrot: number
  life: number // 剩余帧
  maxLife: number
  kind: 'rect' | 'spark'
}

const CONFETTI_COLORS = ['#f43f5e', '#f97316', '#facc15', '#4ade80', '#38bdf8', '#a78bfa', '#fb7185']
const FIREWORK_COLORS = ['#fda4af', '#fcd34d', '#86efac', '#7dd3fc', '#c4b5fd', '#ffffff']

function rand(min: number, max: number) { return min + Math.random() * (max - min) }

function spawnConfetti(w: number, h: number, out: Particle[], count: number) {
  for (let i = 0; i < count; i++) {
    out.push({
      x: rand(0, w),
      y: rand(-h * 0.3, -10),
      vx: rand(-1.2, 1.2),
      vy: rand(2, 5),
      size: rand(6, 12),
      color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)],
      rot: rand(0, Math.PI * 2),
      vrot: rand(-0.15, 0.15),
      life: 260,
      maxLife: 260,
      kind: 'rect',
    })
  }
}

function spawnFirework(w: number, h: number, out: Particle[]) {
  const cx = rand(w * 0.2, w * 0.8)
  const cy = rand(h * 0.18, h * 0.45)
  const base = FIREWORK_COLORS[Math.floor(Math.random() * FIREWORK_COLORS.length)]
  const n = Math.floor(rand(46, 70))
  for (let i = 0; i < n; i++) {
    const ang = (Math.PI * 2 * i) / n + rand(-0.05, 0.05)
    const speed = rand(2.2, 6.4)
    out.push({
      x: cx, y: cy,
      vx: Math.cos(ang) * speed,
      vy: Math.sin(ang) * speed,
      size: rand(1.6, 3),
      color: Math.random() < 0.75 ? base : '#ffffff',
      rot: 0, vrot: 0,
      life: Math.floor(rand(60, 100)),
      maxLife: 100,
      kind: 'spark',
    })
  }
}

export function FxCanvas({ fx }: { fx: { kind: FxKind; text?: string; seq: number } | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rafRef = useRef<number>(0)
  const particlesRef = useRef<Particle[]>([])
  const rocketsRef = useRef<Array<{ x: number; y: number; vy: number; color: string }>>([])

  useEffect(() => {
    if (!fx) return
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const w = window.innerWidth
    const h = window.innerHeight
    canvas.width = w * dpr
    canvas.height = h * dpr
    canvas.style.width = `${w}px`
    canvas.style.height = `${h}px`
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    if (fx.kind === 'confetti') {
      spawnConfetti(w, h, particlesRef.current, 160)
      // 两段补充，形成连绵的飘落感
      const t1 = setTimeout(() => spawnConfetti(w, h, particlesRef.current, 100), 450)
      const t2 = setTimeout(() => spawnConfetti(w, h, particlesRef.current, 60), 900)
      return () => { clearTimeout(t1); clearTimeout(t2) }
    }
    // fireworks：三连发（火箭上升 → 爆裂成火花）
    const launch = (delay: number) => {
      setTimeout(() => {
        rocketsRef.current.push({
          x: rand(w * 0.2, w * 0.8),
          y: h + 10,
          vy: rand(-13, -10),
          color: FIREWORK_COLORS[Math.floor(Math.random() * FIREWORK_COLORS.length)],
        })
      }, delay)
    }
    launch(0); launch(520); launch(1040)
    return () => { /* 由主循环统一清理 */ }
  }, [fx?.seq, fx?.kind])  

  // 主渲染循环：挂载后常驻，无粒子时空转成本可忽略（仍在跑但只做清屏判断）
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    let alive = true

    const step = () => {
      if (!alive) return
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const w = canvas.width / dpr
      const h = canvas.height / dpr
      ctx.clearRect(0, 0, w, h)

      // 火箭推进
      for (const r of rocketsRef.current) {
        r.y += r.vy
        ctx.globalAlpha = 1
        ctx.fillStyle = r.color
        ctx.beginPath()
        ctx.arc(r.x, r.y, 2.2, 0, Math.PI * 2)
        ctx.fill()
      }
      // 到顶爆裂
      const exploded = rocketsRef.current.filter((r) => r.y <= h * rand(0.22, 0.45))
      if (exploded.length > 0) {
        rocketsRef.current = rocketsRef.current.filter((r) => !exploded.includes(r))
        for (const r of exploded) {
          const n = Math.floor(rand(46, 70))
          for (let i = 0; i < n; i++) {
            const ang = (Math.PI * 2 * i) / n + rand(-0.05, 0.05)
            const speed = rand(2.2, 6.4)
            particlesRef.current.push({
              x: r.x, y: r.y,
              vx: Math.cos(ang) * speed,
              vy: Math.sin(ang) * speed,
              size: rand(1.6, 3),
              color: Math.random() < 0.75 ? r.color : '#ffffff',
              rot: 0, vrot: 0,
              life: Math.floor(rand(60, 100)),
              maxLife: 100,
              kind: 'spark',
            })
          }
        }
      }

      // 粒子更新与绘制
      const ps = particlesRef.current
      for (let i = ps.length - 1; i >= 0; i--) {
        const p = ps[i]
        p.life--
        if (p.life <= 0) { ps.splice(i, 1); continue }
        if (p.kind === 'rect') {
          p.x += p.vx + Math.sin((p.maxLife - p.life) * 0.08) * 0.6 // 左右摆动
          p.y += p.vy
          p.rot += p.vrot
          ctx.globalAlpha = Math.min(1, p.life / 60)
          ctx.fillStyle = p.color
          ctx.save()
          ctx.translate(p.x, p.y)
          ctx.rotate(p.rot)
          ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2)
          ctx.restore()
        } else {
          p.x += p.vx
          p.y += p.vy
          p.vy += 0.045 // 重力
          p.vx *= 0.985
          p.vy *= 0.985
          ctx.globalAlpha = Math.max(0, p.life / p.maxLife)
          ctx.fillStyle = p.color
          ctx.beginPath()
          ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2)
          ctx.fill()
        }
      }
      ctx.globalAlpha = 1
      rafRef.current = requestAnimationFrame(step)
    }
    rafRef.current = requestAnimationFrame(step)
    return () => {
      alive = false
      cancelAnimationFrame(rafRef.current)
    }
  }, [])

  return (
    <div className="pointer-events-none fixed inset-0 z-[90]" aria-hidden>
      {fx?.text && (
        <div className="absolute left-1/2 top-[16%] -translate-x-1/2 rounded-full glass border px-6 py-2.5 text-lg font-bold shadow-xl animate-in fade-in zoom-in-95 duration-300">
          {fx.text}
        </div>
      )}
      <canvas ref={canvasRef} className="absolute inset-0" />
    </div>
  )
}
