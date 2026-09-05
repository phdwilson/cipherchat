import { useState } from 'react'
import { api } from '../lib/api'

export default function CompressPage({ notify }: { notify: (m: string) => void }) {
  const [files, setFiles] = useState<string[]>([])
  const [output, setOutput] = useState('archive.ccz')
  const [password, setPassword] = useState('')
  const [password2, setPassword2] = useState('')
  const [keyfile, setKeyfile] = useState('')
  const [format, setFormat] = useState('ccz')
  const [encNames, setEncNames] = useState(true)
  const [level, setLevel] = useState(6)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(0)
  const [drag, setDrag] = useState(false)

  const addFiles = async () => {
    const f = await api.pickFiles()
    if (f.length) setFiles((prev) => [...new Set([...prev, ...f])])
  }

  const pickKey = async () => {
    const f = await api.pickFiles()
    if (f[0]) setKeyfile(f[0])
  }

  const pickOut = async () => {
    const ext = format === 'ccz' ? 'ccz' : format
    const p = await api.pickSave(`archive.${ext}`)
    if (p) setOutput(p)
  }

  const run = async () => {
    if (!files.length) return notify('请先添加文件')
    if (format === 'ccz' && !password && !keyfile) return notify('.ccz 必须设置密码或密钥文件')
    if (password && password !== password2) return notify('两次密码不一致')
    setBusy(true)
    setProgress(15)
    const t = setInterval(() => setProgress((p) => Math.min(90, p + 8)), 200)
    try {
      const r = await api.pack({
        inputs: files,
        output,
        password: password || undefined,
        keyfilePath: keyfile || undefined,
        format,
        encryptFilenames: encNames,
        level,
      })
      clearInterval(t)
      setProgress(100)
      if (!r.ok) notify(r.error || '压缩失败')
      else notify(`已创建：${r.output}`)
    } catch (e) {
      notify(String(e))
    } finally {
      clearInterval(t)
      setBusy(false)
      setTimeout(() => setProgress(0), 800)
    }
  }

  return (
    <div className="grid-2">
      <div className="card">
        <h3>选择文件</h3>
        <div
          className={`dropzone ${drag ? 'drag' : ''}`}
          onClick={addFiles}
          onDragOver={(e) => { e.preventDefault(); setDrag(true) }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDrag(false)
            const names = [...e.dataTransfer.files].map((f) => (f as File & { path?: string }).path || f.name)
            setFiles((p) => [...new Set([...p, ...names])])
          }}
        >
          <div className="big">＋</div>
          <p><strong>点击或拖放</strong> 添加文件 / 文件夹</p>
        </div>
        {files.length > 0 && (
          <ul className="file-list">
            {files.map((f) => (
              <li key={f}>
                <span>{f}</span>
                <button className="btn btn-ghost" style={{ padding: '2px 8px' }} onClick={() => setFiles((p) => p.filter((x) => x !== f))}>移除</button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="card">
        <h3>加密与输出</h3>
        <div className="field">
          <label>格式（推荐 .ccz 强制端到端）</label>
          <select value={format} onChange={(e) => setFormat(e.target.value)}>
            <option value="ccz">.ccz 密匣（强制 E2E）</option>
            <option value="zip">.zip</option>
            <option value="tar.gz">.tar.gz</option>
            <option value="tar.br">.tar.br</option>
            <option value="7z">.7z</option>
            <option value="tar">.tar</option>
          </select>
        </div>
        <div className="field">
          <label>输出路径</label>
          <div className="row">
            <input style={{ flex: 1 }} value={output} onChange={(e) => setOutput(e.target.value)} />
            <button className="btn btn-secondary" onClick={pickOut}>浏览</button>
          </div>
        </div>
        <div className="field">
          <label>密码</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="建议 12 位以上" />
        </div>
        <div className="field">
          <label>确认密码</label>
          <input type="password" value={password2} onChange={(e) => setPassword2(e.target.value)} />
        </div>
        <div className="field">
          <label>密钥文件（可选，音乐/图片/任意文件）</label>
          <div className="row">
            <input style={{ flex: 1 }} value={keyfile} readOnly placeholder="未选择" />
            <button className="btn btn-secondary" onClick={pickKey}>选择</button>
            {keyfile && <button className="btn btn-ghost" onClick={() => setKeyfile('')}>清除</button>}
          </div>
        </div>
        <div className="switch-row">
          <span>加密文件名</span>
          <button className={`switch ${encNames ? 'on' : ''}`} onClick={() => setEncNames((v) => !v)} type="button"><i /></button>
        </div>
        <div className="field">
          <label>压缩级别 {level}</label>
          <input type="range" min={0} max={9} value={level} onChange={(e) => setLevel(Number(e.target.value))} />
        </div>
        <div className="progress"><i style={{ width: `${progress}%` }} /></div>
        <div className="row" style={{ marginTop: 14 }}>
          <button className="btn btn-primary" disabled={busy} onClick={run}>
            {busy ? '正在加密压缩…' : '开始'}
          </button>
          <span className="badge">E2E</span>
        </div>
      </div>
    </div>
  )
}
