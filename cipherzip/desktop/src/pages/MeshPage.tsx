import { useState } from 'react'
import { api } from '../lib/api'

export default function MeshPage({ notify }: { notify: (m: string) => void }) {
  const [willing, setWilling] = useState(false)
  const [maxGb, setMaxGb] = useState(5)
  const [info, setInfo] = useState<Record<string, unknown> | null>(null)
  const [hashes, setHashes] = useState<string[]>([])

  const init = async () => {
    const r = await api.meshInit(willing, maxGb)
    if (!r.ok) return notify(r.error || '初始化失败')
    setInfo(r.info as Record<string, unknown>)
    notify(willing ? '已加入分布式网络（愿意提供存储）' : '已初始化本地节点（仅自用）')
  }

  const put = async () => {
    const f = await api.pickFiles()
    if (!f[0]) return
    const r = await api.meshPut(f[0])
    if (!r.ok) return notify(r.error || '分片失败')
    setHashes(r.hashes || [])
    notify(`已切分为 ${r.hashes?.length || 0} 个内容寻址分片`)
  }

  return (
    <div>
      <div className="card">
        <h3>自愈分布式加密网络</h3>
        <p style={{ color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.6, marginBottom: 12 }}>
          所有运行 CipherZip 的用户可自愿加入：帮助存储加密分片（content-addressed），
          默认 3 副本。节点掉线后，持有副本的节点自动触发再平衡（healPlan）。
          明文从不上传；分片本身已是密文或哈希块。
        </p>
        <div className="switch-row">
          <span>我愿意贡献存储空间</span>
          <button className={`switch ${willing ? 'on' : ''}`} type="button" onClick={() => setWilling((v) => !v)}><i /></button>
        </div>
        <div className="field">
          <label>最大贡献容量（GB）{maxGb}</label>
          <input type="range" min={1} max={100} value={maxGb} onChange={(e) => setMaxGb(Number(e.target.value))} />
        </div>
        <div className="row">
          <button className="btn btn-primary" onClick={init}>初始化 / 应用</button>
          <button className="btn btn-secondary" onClick={put}>切分本地文件入网</button>
        </div>
      </div>
      {info && (
        <div className="card">
          <h3>节点信息</h3>
          <pre className="mono">{JSON.stringify(info, null, 2)}</pre>
        </div>
      )}
      {hashes.length > 0 && (
        <div className="card">
          <h3>最近分片哈希</h3>
          <div className="mono">{hashes.join('\n')}</div>
        </div>
      )}
    </div>
  )
}
