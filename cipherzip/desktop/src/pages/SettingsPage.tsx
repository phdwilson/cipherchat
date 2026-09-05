import { useEffect, useState } from 'react'
import { api } from '../lib/api'

export default function SettingsPage({
  notify,
  theme,
  setTheme,
}: {
  notify: (m: string) => void
  theme: 'light' | 'dark' | 'system'
  setTheme: (t: 'light' | 'dark' | 'system') => void
}) {
  const [s, setS] = useState({
    defaultFormat: 'ccz',
    encryptFilenames: true,
    allowKeyfile: true,
    level: 6,
    p2pEnabled: true,
    meshEnabled: false,
    meshWilling: false,
    cipherchatUrl: 'http://127.0.0.1:3000',
    cipherchatEnabled: false,
    autoLockMinutes: 15,
    language: 'zh-CN',
    concurrency: 2,
    clearHistoryOnExit: false,
  })

  useEffect(() => {
    api.getSettings().then((raw) => {
      if (raw && Object.keys(raw).length) setS((prev) => ({ ...prev, ...raw as typeof s }))
    })
  }, [])

  const save = async () => {
    await api.saveSettings(s)
    notify('设置已保存')
  }

  const Toggle = ({ on, set, label }: { on: boolean; set: (v: boolean) => void; label: string }) => (
    <div className="switch-row">
      <span>{label}</span>
      <button type="button" className={`switch ${on ? 'on' : ''}`} onClick={() => set(!on)}><i /></button>
    </div>
  )

  return (
    <div className="grid-2">
      <div className="card">
        <h3>通用 / 外观</h3>
        <div className="field">
          <label>界面语言</label>
          <select value={s.language} onChange={(e) => setS({ ...s, language: e.target.value })}>
            <option value="zh-CN">简体中文</option>
            <option value="en-US">English</option>
          </select>
        </div>
        <div className="field">
          <label>主题</label>
          <select value={theme} onChange={(e) => setTheme(e.target.value as typeof theme)}>
            <option value="system">跟随系统</option>
            <option value="light">浅色（小米/苹果风）</option>
            <option value="dark">深色</option>
          </select>
        </div>
        <div className="field">
          <label>默认格式</label>
          <select value={s.defaultFormat} onChange={(e) => setS({ ...s, defaultFormat: e.target.value })}>
            <option value="ccz">.ccz</option>
            <option value="zip">.zip</option>
            <option value="tar.gz">.tar.gz</option>
            <option value="7z">.7z</option>
          </select>
        </div>
        <div className="field">
          <label>压缩级别 {s.level}</label>
          <input type="range" min={0} max={9} value={s.level} onChange={(e) => setS({ ...s, level: Number(e.target.value) })} />
        </div>
        <div className="field">
          <label>并发上传/分块 {s.concurrency}</label>
          <input type="range" min={1} max={8} value={s.concurrency} onChange={(e) => setS({ ...s, concurrency: Number(e.target.value) })} />
        </div>
      </div>

      <div className="card">
        <h3>加密 / 隐私</h3>
        <Toggle on={s.encryptFilenames} set={(v) => setS({ ...s, encryptFilenames: v })} label="默认加密文件名" />
        <Toggle on={s.allowKeyfile} set={(v) => setS({ ...s, allowKeyfile: v })} label="允许密钥文件（音乐等）" />
        <Toggle on={s.clearHistoryOnExit} set={(v) => setS({ ...s, clearHistoryOnExit: v })} label="退出时清除历史" />
        <div className="field" style={{ marginTop: 12 }}>
          <label>自动锁定（分钟）</label>
          <input type="number" min={0} value={s.autoLockMinutes} onChange={(e) => setS({ ...s, autoLockMinutes: Number(e.target.value) })} />
        </div>
      </div>

      <div className="card">
        <h3>网络</h3>
        <Toggle on={s.p2pEnabled} set={(v) => setS({ ...s, p2pEnabled: v })} label="启用 P2P 模块" />
        <Toggle on={s.meshEnabled} set={(v) => setS({ ...s, meshEnabled: v })} label="启用分布式网络模块" />
        <Toggle on={s.meshWilling} set={(v) => setS({ ...s, meshWilling: v })} label="默认愿意贡献存储" />
        <Toggle on={s.cipherchatEnabled} set={(v) => setS({ ...s, cipherchatEnabled: v })} label="启用 CipherChat 联动" />
        <div className="field">
          <label>CipherChat Base URL</label>
          <input value={s.cipherchatUrl} onChange={(e) => setS({ ...s, cipherchatUrl: e.target.value })} />
        </div>
      </div>

      <div className="card">
        <h3>关于模块化</h3>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
          核心引擎 <code>@cipherzip/core</code>、CLI、桌面 UI、CipherChat API 彼此解耦。
          后续升级只需替换对应 workspace 包。共享协议见 <code>@cipherzip/shared</code>。
        </p>
        <div className="row" style={{ marginTop: 16 }}>
          <button className="btn btn-primary" onClick={save}>保存全部设置</button>
        </div>
      </div>
    </div>
  )
}
