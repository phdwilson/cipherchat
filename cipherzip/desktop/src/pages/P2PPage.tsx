import { useEffect, useState } from 'react'
import { api } from '../lib/api'

export default function P2PPage({ notify }: { notify: (m: string) => void }) {
  const [running, setRunning] = useState(false)
  const [port, setPort] = useState(0)
  const [code, setCode] = useState('')
  const [peerCode, setPeerCode] = useState('')
  const [nick, setNick] = useState('星尘旅人')
  const [chat, setChat] = useState('')
  const [logs, setLogs] = useState<Array<{ kind: string; text: string }>>([])
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    return api.p2pEvents((ev) => {
      if (ev.type === 'chat') {
        const d = ev.data as { nick: string; text: string }
        setLogs((l) => [...l, { kind: 'chat', text: `${d.nick}: ${d.text}` }])
      } else if (ev.type === 'peer') {
        const d = ev.data as { nick: string; joined: boolean }
        setLogs((l) => [...l, { kind: 'sys', text: d.joined ? `${d.nick} 已连接` : `${d.nick} 已离开` }])
        if (d.joined) setConnected(true)
      } else if (ev.type === 'file') {
        setLogs((l) => [...l, { kind: 'sys', text: `收到文件 ${(ev.data as { path: string }).path}` }])
      } else if (ev.type === 'log') {
        setLogs((l) => [...l, { kind: 'sys', text: String(ev.data) }])
      }
    })
  }, [])

  const start = async () => {
    const r = await api.p2pStart(0, nick)
    if (!r.ok) return notify(r.error || '启动失败')
    setRunning(true)
    setPort(r.port || 0)
    setCode(r.code || '')
    notify(`P2P 已监听端口 ${r.port}`)
  }

  const stop = async () => {
    await api.p2pStop()
    setRunning(false)
    setConnected(false)
    notify('已停止')
  }

  const connect = async () => {
    const r = await api.p2pConnect(peerCode.trim())
    if (!r.ok) return notify(r.error || '连接失败')
    setConnected(true)
    notify(`已连接 ${r.nick || ''}`)
  }

  const send = async () => {
    if (!chat.trim()) return
    await api.p2pChat(chat.trim())
    setChat('')
  }

  const sendFile = async () => {
    const f = await api.pickFiles()
    if (!f[0]) return
    const r = await api.p2pSendFile(f[0])
    if (!r.ok) notify(r.error || '发送失败')
    else notify('文件已发送')
  }

  return (
    <div className="grid-2">
      <div className="card">
        <h3>我的节点</h3>
        <div className="field">
          <label>昵称</label>
          <input value={nick} onChange={(e) => setNick(e.target.value)} disabled={running} />
        </div>
        <div className="row">
          {!running ? (
            <button className="btn btn-primary" onClick={start}>启动内置服务器</button>
          ) : (
            <button className="btn btn-danger" onClick={stop}>停止</button>
          )}
          {running && <span className="badge ok">端口 {port}</span>}
        </div>
        {code && (
          <div style={{ marginTop: 14 }}>
            <label style={{ fontSize: 12, color: 'var(--text-secondary)' }}>分享码（16 个英文单词）</label>
            <div className="mono" style={{ marginTop: 6 }}>{code}</div>
            <p style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 8 }}>
              分享码由 IP/端口/公钥本地编码生成，服务器不可见。也可使用二维码 JSON。
            </p>
          </div>
        )}
        <div className="field" style={{ marginTop: 16 }}>
          <label>输入对方分享码连接</label>
          <textarea rows={3} value={peerCode} onChange={(e) => setPeerCode(e.target.value)} placeholder="word-word-word-..." />
        </div>
        <button className="btn btn-secondary" onClick={connect} disabled={!peerCode.trim()}>连接对方</button>
      </div>

      <div className="card">
        <h3>端到端会话 {connected && <span className="badge ok">已加密</span>}</h3>
        <div className="chat-box">
          {logs.length === 0 && <div className="chat-msg sys">连接后可聊天与传文件，消息经 ECDH 会话密钥 AES-GCM 密封。</div>}
          {logs.map((l, i) => (
            <div key={i} className={`chat-msg ${l.kind === 'sys' ? 'sys' : ''}`}>
              {l.kind === 'chat' ? l.text : `· ${l.text}`}
            </div>
          ))}
        </div>
        <div className="row">
          <input style={{ flex: 1 }} value={chat} onChange={(e) => setChat(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && send()} placeholder="输入消息…" />
          <button className="btn btn-primary" onClick={send}>发送</button>
          <button className="btn btn-secondary" onClick={sendFile}>传文件</button>
        </div>
      </div>
    </div>
  )
}
