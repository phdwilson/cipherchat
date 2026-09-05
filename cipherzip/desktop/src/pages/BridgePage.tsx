import { useState } from 'react'
import { api } from '../lib/api'

export default function BridgePage({ notify }: { notify: (m: string) => void }) {
  const [baseUrl, setBaseUrl] = useState('http://127.0.0.1:3000')
  const [health, setHealth] = useState<string>('')
  const [reg, setReg] = useState<string>('')

  const check = async () => {
    const r = await api.bridgeHealth(baseUrl)
    setHealth(JSON.stringify(r, null, 2))
    notify(r.ok ? 'CipherChat 可达' : '无法连接')
  }

  const register = async () => {
    const r = await api.bridgeRegister(baseUrl)
    setReg(JSON.stringify(r, null, 2))
    notify(r.ok ? '客户端已注册' : r.error || '注册失败')
  }

  return (
    <div>
      <div className="card">
        <h3>CipherChat 密讯联动</h3>
        <p style={{ color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.6, marginBottom: 12 }}>
          桌面端通过模块化 HTTP API 对接网页后端：客户端注册、心跳、归档密文指纹宣告、P2P 信令中继。
          <strong>密码与明文永不上传</strong>。后续可将压缩能力合并进 CipherChat 统一体验。
        </p>
        <div className="field">
          <label>CipherChat 服务地址</label>
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://your-cipherchat.example" />
        </div>
        <div className="row">
          <button className="btn btn-secondary" onClick={check}>健康检查</button>
          <button className="btn btn-primary" onClick={register}>注册本客户端</button>
        </div>
      </div>
      {health && (
        <div className="card">
          <h3>健康检查响应</h3>
          <pre className="mono">{health}</pre>
        </div>
      )}
      {reg && (
        <div className="card">
          <h3>注册响应</h3>
          <pre className="mono">{reg}</pre>
        </div>
      )}
      <div className="card">
        <h3>已对接 API</h3>
        <ul style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.8, paddingLeft: 18 }}>
          <li>POST /api/client/register</li>
          <li>POST /api/client/heartbeat</li>
          <li>POST /api/client/archive/announce</li>
          <li>GET  /api/client/archive/lookup</li>
          <li>POST /api/client/signal/offer|answer · GET poll</li>
          <li>复用 /api/chat/session · /api/drive/* · /api/config</li>
        </ul>
      </div>
    </div>
  )
}
