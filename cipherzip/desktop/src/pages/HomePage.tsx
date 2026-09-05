import type { PageId } from '../App'
import { api } from '../lib/api'

export default function HomePage({ onNavigate }: { onNavigate: (p: PageId) => void }) {
  return (
    <div>
      <div className="card" style={{ background: 'linear-gradient(135deg, var(--accent-soft), transparent)' }}>
        <h3>端到端加密压缩平台</h3>
        <p style={{ color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 16 }}>
          CipherZip 密匣以 <strong>.ccz</strong> 专有格式强制端到端加密（AES-256-GCM），
          支持密码、任意密钥文件（音乐/图片等指纹派生）、文件名加密。
          内置 P2P 聊天/传文件、自愿分布式存储，并可对接 CipherChat 密讯网页后端。
        </p>
        <div className="row">
          <button className="btn btn-primary" onClick={() => onNavigate('compress')}>开始压缩</button>
          <button className="btn btn-secondary" onClick={() => onNavigate('extract')}>打开压缩包</button>
          <button className="btn btn-ghost" onClick={() => onNavigate('p2p')}>P2P 互连</button>
          <span className="badge">{api.isElectron() ? '桌面引擎' : '预览模式'}</span>
        </div>
      </div>

      <div className="grid-3" style={{ marginTop: 16 }}>
        <div className="stat">
          <div className="n">.ccz</div>
          <div className="l">强制 E2E 专有格式</div>
        </div>
        <div className="stat">
          <div className="n">AES-256</div>
          <div className="l">GCM 认证加密</div>
        </div>
        <div className="stat">
          <div className="n">P2P</div>
          <div className="l">分享码 / 二维码互联</div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h3>支持格式</h3>
        <p style={{ color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.7 }}>
          <strong>创建：</strong> .ccz（推荐）· .zip · .tar · .tar.gz · .tar.br · .gz · .7z
          <br />
          <strong>打开：</strong> 以上全部 + .rar · .xz · .bz2 · .iso（依赖系统 7z 时）
          <br />
          带密码创建传统 zip 时，会自动升级为更安全的 .ccz，避免弱加密。
        </p>
      </div>
    </div>
  )
}
