# CipherZip 密匣 更新日志

## v1.0.0

### 首次交付

- 专有强制端到端加密格式 **.ccz**（AES-256-GCM、文件名加密、完整性校验）
- 密钥文件：任意文件（音乐/图片等）头/中/尾指纹派生；可与密码双因子
- 多格式：zip / tar / tar.gz / tar.br / gz / 7z 创建；rar/xz 等打开（7z）
- 全中文扁平化桌面 UI（浅色/深色，类 Apple / HyperOS）
- 内置 P2P：分享码（16 英文单词）+ 二维码 JSON + ECDH 会话加密聊天/传文件
- Mesh 自愿分布式存储 + healPlan 自愈计划
- CipherChat 桥接 API（register / heartbeat / archive announce / signal）
- CLI：`cipherzip pack|unpack|list|p2p|formats`
- Windows 11 便携安装包 / zip 分发包
- 自动化 E2E：压缩、错误密码、密钥文件、P2P、Mesh、CLI 真实流程全通过
