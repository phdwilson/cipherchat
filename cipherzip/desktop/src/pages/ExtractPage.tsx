import { useState } from 'react'
import { api } from '../lib/api'

export default function ExtractPage({ notify }: { notify: (m: string) => void }) {
  const [archive, setArchive] = useState('')
  const [outDir, setOutDir] = useState('')
  const [password, setPassword] = useState('')
  const [keyfile, setKeyfile] = useState('')
  const [entries, setEntries] = useState<Array<{ path: string; size: number; isDir: boolean }> | null>(null)
  const [busy, setBusy] = useState(false)

  const pickArchive = async () => {
    const f = await api.pickFiles()
    if (f[0]) {
      setArchive(f[0])
      setEntries(null)
    }
  }

  const pickKey = async () => {
    const f = await api.pickFiles()
    if (f[0]) setKeyfile(f[0])
  }

  const pickOut = async () => {
    const d = await api.pickDir()
    if (d) setOutDir(d)
  }

  const list = async () => {
    if (!archive) return notify('请选择压缩包')
    const r = await api.listCcz(archive, password || undefined, keyfile || undefined)
    if (!r.ok) return notify(r.error || '无法列出（可能不是 .ccz 或密钥错误）')
    setEntries(r.entries || [])
    notify(`共 ${r.entries?.length || 0} 个条目`)
  }

  const run = async () => {
    if (!archive) return notify('请选择压缩包')
    if (!outDir) return notify('请选择输出目录')
    setBusy(true)
    try {
      const r = await api.unpack({
        archive,
        outputDir: outDir,
        password: password || undefined,
        keyfilePath: keyfile || undefined,
      })
      if (!r.ok) notify(r.error || '解压失败')
      else notify(`已解压 ${r.files?.length || 0} 项`)
    } catch (e) {
      notify(String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid-2">
      <div className="card">
        <h3>打开归档</h3>
        <div className="field">
          <label>压缩包路径</label>
          <div className="row">
            <input style={{ flex: 1 }} value={archive} onChange={(e) => setArchive(e.target.value)} placeholder="选择 .ccz / .zip / .7z …" />
            <button className="btn btn-secondary" onClick={pickArchive}>浏览</button>
          </div>
        </div>
        <div className="field">
          <label>密码</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <div className="field">
          <label>密钥文件</label>
          <div className="row">
            <input style={{ flex: 1 }} value={keyfile} readOnly />
            <button className="btn btn-secondary" onClick={pickKey}>选择</button>
          </div>
        </div>
        <div className="field">
          <label>解压到</label>
          <div className="row">
            <input style={{ flex: 1 }} value={outDir} onChange={(e) => setOutDir(e.target.value)} />
            <button className="btn btn-secondary" onClick={pickOut}>目录</button>
          </div>
        </div>
        <div className="row">
          <button className="btn btn-secondary" onClick={list}>预览列表</button>
          <button className="btn btn-primary" disabled={busy} onClick={run}>{busy ? '解压中…' : '解密解压'}</button>
        </div>
      </div>
      <div className="card">
        <h3>内容列表</h3>
        {!entries && <p style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>.ccz 需正确密钥才能预览文件名（文件名亦可能加密存储）。</p>}
        {entries && (
          <ul className="file-list" style={{ maxHeight: 360 }}>
            {entries.map((e) => (
              <li key={e.path}>
                <span>{e.isDir ? '📁' : '📄'} {e.path}</span>
                <span style={{ color: 'var(--text-tertiary)' }}>{e.isDir ? '—' : `${e.size} B`}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
