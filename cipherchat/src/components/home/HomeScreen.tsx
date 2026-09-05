'use client'

import { motion } from 'framer-motion'
import { MessageSquareLock, HardDrive, ShieldCheck, Zap, EyeOff, Globe2, ArrowRight, Sparkles, FileUp, MoonStar, Smartphone, Mic2 } from 'lucide-react'
import { Logo } from '@/components/common/Logo'
import { formatBytes } from '@/lib/crypto'
import type { RuntimeConfig } from '@/store/chat'

const FEATURES = [
  { icon: ShieldCheck, title: 'AES-256-GCM 端到端加密', desc: '文字、图片、视频、文件全部在您的设备上加密后才中继，服务器零知识。' },
  { icon: EyeOff, title: '零知识服务器', desc: '服务器不存密码，也看不到任何消息内容、文件名与网盘数据，数据库被拖走也无法解密。' },
  { icon: Zap, title: '毫秒级实时同步', desc: 'WebSocket 长连接推送，消息、在线状态、正在输入提示即时触达所有设备。' },
  { icon: Globe2, title: '在线设备可见', desc: '查看频道内设备型号、浏览器环境、IP 地址与归属地，异常设备一目了然。' },
  { icon: FileUp, title: '粘贴即传', desc: '截图后 Ctrl+V 直接发送，也支持拖拽与选择文件，聊天单文件最大 1GB。' },
  { icon: MoonStar, title: '暗黑 / 明亮自适应', desc: '跟随系统主题一键切换，夜间护眼，白天清爽，手机平板桌面全自适应。' },
]

const STEPS = [
  { n: '01', title: '输入频道与密码', desc: '频道 ID 随便起，密码即加密密钥 —— 相同频道 ID + 密码的人进入同一个加密房间。' },
  { n: '02', title: '畅聊与传输', desc: '文字、表情包、图片、视频、文件即贴即传，全部端到端加密后经服务器中继。' },
  { n: '03', title: '隐私网盘', desc: '管理员超级密钥授权创建，个人密钥解锁专属仓库，单文件最大 5GB。' },
]

export function HomeScreen({ go, config }: { go: (s: 'chat' | 'drive' | 'voice') => void; config: RuntimeConfig | null }) {
  return (
    <div className="w-full max-w-5xl mx-auto px-4 sm:px-8">
      {/* Hero */}
      <section className="flex flex-col items-center py-10 text-center sm:py-16">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
        >
          <span className="inline-flex items-center gap-1.5 rounded-full glass border border-primary/30 bg-primary/5 px-3.5 py-1.5 text-xs font-medium text-primary mb-5">
            <Sparkles className="h-3.5 w-3.5" />
            服务端零知识 · 密钥永不上传
          </span>
          <h1 className="mx-auto max-w-2xl text-3xl font-extrabold leading-tight tracking-tight sm:text-5xl">
            让每一次传输，
            <br className="sm:hidden" />
            <span className="text-grad">只属于你和对方</span>
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-sm leading-relaxed text-muted-foreground sm:text-base">
            输入相同的频道 ID 与密码即可建立加密频道，文字、表情包、图片、视频与文件畅行无阻；
            隐私网盘凭个人密钥解锁，随机仓库 ID 防机器人滥用。
          </p>
        </motion.div>

        {/* 三大功能卡片 */}
        <div className="mt-10 grid w-full gap-4 sm:mt-14 sm:grid-cols-2 lg:grid-cols-3">
          <motion.button
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.1 }}
            onClick={() => go('voice')}
            className="group glass relative overflow-hidden rounded-3xl border p-6 text-left transition-all duration-300 hover:-translate-y-1 hover:shadow-xl hover:shadow-emerald-500/15 focus-visible:outline-2 focus-visible:outline-primary sm:p-8"
          >
            <div className="absolute -right-10 -top-10 h-36 w-36 rounded-full bg-emerald-500 opacity-10 blur-2xl transition-opacity group-hover:opacity-25" />
            <div className="mb-5 grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br from-emerald-400 to-teal-500 text-white shadow-lg shadow-emerald-500/30">
              <Mic2 className="h-7 w-7" />
            </div>
            <h2 className="mb-2 text-xl font-bold">语音开黑大厅</h2>
            <p className="mb-5 text-sm leading-relaxed text-muted-foreground">
              Discord 风格的临时语音房间：自由讲话 + 按键讲话（PTT 自定义键）。
            </p>
            <ul className="mb-6 space-y-1.5 text-sm text-muted-foreground">
              <li>· 8 人 mesh 拓扑 · WebRTC P2P 直传 · SRTP 加密</li>
              <li>· 临时房间不持久化 · 全员离开即销毁</li>
              <li>· 大厅 ID + 密钥即房间，密钥即加密密钥</li>
            </ul>
            <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-emerald-600 dark:text-emerald-400">
              进入大厅 <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
            </span>
          </motion.button>

          <motion.button
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.2 }}
            onClick={() => go('chat')}
            className="group glass relative overflow-hidden rounded-3xl border p-6 text-left transition-all duration-300 hover:-translate-y-1 hover:shadow-xl hover:shadow-violet-500/15 focus-visible:outline-2 focus-visible:outline-primary sm:p-8"
          >
            <div className="absolute -right-10 -top-10 h-36 w-36 rounded-full grad-primary opacity-10 blur-2xl transition-opacity group-hover:opacity-25" />
            <div className="mb-5 grid h-14 w-14 place-items-center rounded-2xl grad-primary text-white shadow-lg shadow-violet-500/30">
              <MessageSquareLock className="h-7 w-7" />
            </div>
            <h2 className="mb-2 text-xl font-bold">加密频道聊天</h2>
            <p className="mb-5 text-sm leading-relaxed text-muted-foreground">
              频道 ID + 密码即房间。密码同时是 AES-256 加密密钥与门禁凭证 —— 服务端只见密文。
            </p>
            <ul className="mb-6 space-y-1.5 text-sm text-muted-foreground">
              <li>· 文字 / 表情包 / 贴纸 / 图片 / 视频 / 任意文件</li>
              <li>· 微信式按住语音消息 · 在线设备型号 · IP 归属</li>
              <li>· 消息送达 / 已读状态 · 快捷指令 · 可全局自毁</li>
            </ul>
            <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-primary">
              进入频道 <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
            </span>
          </motion.button>

          <motion.button
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.3 }}
            onClick={() => go('drive')}
            className="group glass relative overflow-hidden rounded-3xl border p-6 text-left transition-all duration-300 hover:-translate-y-1 hover:shadow-xl hover:shadow-fuchsia-500/15 focus-visible:outline-2 focus-visible:outline-primary sm:p-8"
          >
            <div className="absolute -right-10 -top-10 h-36 w-36 rounded-full bg-fuchsia-500 opacity-10 blur-2xl transition-opacity group-hover:opacity-25" />
            <div className="mb-5 grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br from-fuchsia-400 to-pink-500 text-white shadow-lg shadow-fuchsia-500/30">
              <HardDrive className="h-7 w-7" />
            </div>
            <h2 className="mb-2 text-xl font-bold">隐私网盘</h2>
            <p className="mb-5 text-sm leading-relaxed text-muted-foreground">
              个人加密密钥即仓库：一把密钥对应一个独立网盘，管理员超级密钥授权创建，防滥用。
            </p>
            <ul className="mb-6 space-y-1.5 text-sm text-muted-foreground">
              <li>· 单文件最大 {config ? formatBytes(config.maxDriveFileBytes, 0) : '5 GB'}，分块加密上传</li>
              <li>· 文件名、类型全部加密存储</li>
              <li>· 随机仓库 ID + 超级密钥门禁</li>
            </ul>
            <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-fuchsia-600 dark:text-fuchsia-400">
              解锁网盘 <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
            </span>
          </motion.button>
        </div>
      </section>

      {/* 特性矩阵 */}
      <section className="mt-4 sm:mt-8">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f, i) => (
            <motion.div
              key={f.title}
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.4, delay: i * 0.05 }}
              className="glass rounded-2xl border p-5"
            >
              <f.icon className="mb-3 h-5 w-5 text-primary" />
              <h3 className="mb-1.5 text-sm font-bold">{f.title}</h3>
              <p className="text-xs leading-relaxed text-muted-foreground">{f.desc}</p>
            </motion.div>
          ))}
        </div>
      </section>

      {/* 三步开始 */}
      <section className="mt-8 sm:mt-12">
        <h2 className="mb-6 text-center text-xl font-bold tracking-tight sm:text-2xl">三步开始密讯</h2>
        <div className="grid gap-4 sm:grid-cols-3">
          {STEPS.map((s, i) => (
            <motion.div
              key={s.n}
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.4, delay: i * 0.08 }}
              className="glass relative rounded-2xl border p-6"
            >
              <span className="text-4xl font-extrabold text-grad opacity-40">{s.n}</span>
              <h3 className="mt-2 font-bold">{s.title}</h3>
              <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">{s.desc}</p>
            </motion.div>
          ))}
        </div>
      </section>

      {/* 技术条 */}
      <section className="mb-4 mt-8 sm:mt-12">
        <div className="glass rounded-2xl border p-5 sm:p-6 flex flex-wrap items-center justify-center gap-x-8 gap-y-3 text-xs sm:text-sm text-muted-foreground">
          <span className="inline-flex items-center gap-1.5"><ShieldCheck className="h-4 w-4 text-primary" /> AES-256-GCM</span>
          <span className="inline-flex items-center gap-1.5"><ShieldCheck className="h-4 w-4 text-primary" /> PBKDF2-SHA256 · 310,000 轮</span>
          <span className="inline-flex items-center gap-1.5"><ShieldCheck className="h-4 w-4 text-primary" /> WebSocket 实时中继</span>
          <span className="inline-flex items-center gap-1.5"><ShieldCheck className="h-4 w-4 text-primary" /> 分块流式加解密</span>
          <span className="inline-flex items-center gap-1.5"><Logo size={16} /> 自建私有化部署</span>
        </div>
      </section>
    </div>
  )
}
