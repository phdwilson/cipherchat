import { useEffect, useMemo, useState } from 'react'
import CompressPage from './pages/CompressPage'
import ExtractPage from './pages/ExtractPage'
import P2PPage from './pages/P2PPage'
import MeshPage from './pages/MeshPage'
import SettingsPage from './pages/SettingsPage'
import BridgePage from './pages/BridgePage'
import HomePage from './pages/HomePage'

export type PageId = 'home' | 'compress' | 'extract' | 'p2p' | 'mesh' | 'bridge' | 'settings'

const NAV: Array<{ id: PageId; label: string; ico: string }> = [
  { id: 'home', label: '概览', ico: '◇' },
  { id: 'compress', label: '压缩加密', ico: '▣' },
  { id: 'extract', label: '解密解压', ico: '▤' },
  { id: 'p2p', label: '端到端互连', ico: '⇄' },
  { id: 'mesh', label: '分布式网络', ico: '◎' },
  { id: 'bridge', label: '密讯联动', ico: '☁' },
  { id: 'settings', label: '全部设置', ico: '⚙' },
]

const TITLES: Record<PageId, string> = {
  home: '欢迎使用 CipherZip 密匣',
  compress: '压缩并端到端加密',
  extract: '解密并解压',
  p2p: 'P2P 端到端聊天 / 文件',
  mesh: '自愿加入的自愈存储网络',
  bridge: 'CipherChat 密讯平台联动',
  settings: '设置中心',
}

export default function App() {
  const [page, setPage] = useState<PageId>('home')
  const [theme, setTheme] = useState<'light' | 'dark' | 'system'>('system')
  const [toast, setToast] = useState<string | null>(null)

  const resolvedTheme = useMemo(() => {
    if (theme !== 'system') return theme
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }, [theme])

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', resolvedTheme)
  }, [resolvedTheme])

  const notify = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 3200)
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="logo">
          <div className="logo-mark">CZ</div>
          <div>
            <h1>CipherZip 密匣</h1>
            <p>强制端到端 · 模块化</p>
          </div>
        </div>
        {NAV.map((n) => (
          <button
            key={n.id}
            className={`nav-item ${page === n.id ? 'active' : ''}`}
            onClick={() => setPage(n.id)}
          >
            <span className="ico">{n.ico}</span>
            {n.label}
          </button>
        ))}
        <div className="sidebar-foot">
          v1.0.0 · .ccz 专有格式
          <br />
          与 CipherChat 协同进化
        </div>
      </aside>

      <section className="main">
        <header className="topbar">
          <h2>{TITLES[page]}</h2>
          <div className="actions">
            <button
              className="btn btn-secondary"
              onClick={() =>
                setTheme((t) => (t === 'light' ? 'dark' : t === 'dark' ? 'system' : 'light'))
              }
            >
              {theme === 'light' ? '浅色' : theme === 'dark' ? '深色' : '跟随系统'}
            </button>
          </div>
        </header>
        <div className="content">
          {page === 'home' && <HomePage onNavigate={setPage} />}
          {page === 'compress' && <CompressPage notify={notify} />}
          {page === 'extract' && <ExtractPage notify={notify} />}
          {page === 'p2p' && <P2PPage notify={notify} />}
          {page === 'mesh' && <MeshPage notify={notify} />}
          {page === 'bridge' && <BridgePage notify={notify} />}
          {page === 'settings' && <SettingsPage notify={notify} theme={theme} setTheme={setTheme} />}
        </div>
      </section>

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
