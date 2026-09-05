# CipherZip 密匣 更新日志

## v1.1.0

### 重大 BUG 修复

- **修复打包后无法使用（"Cannot find module 'archiver-utils'"）**：Windows 便携版 / 安装包在解压运行时，
  压缩引擎（`archiver` 及其依赖 `archiver-utils`/`zip-stream` 等）因 npm workspaces 提升 + electron-builder
  依赖收集不一致，导致嵌套 node_modules 缺失、压缩功能完全崩溃。现改为使用 esbuild 将 `@cipherzip/core`
  连同其全部运行时依赖打包为单一自包含文件（`cipherzip-core.bundle.cjs`），打包后运行不再依赖 node_modules 解析。
- **修复构建流程缺失 `@cipherzip/shared` 步骤**：根目录 `build:core` / `build:all` / `test` 等脚本此前未构建
  `@cipherzip/shared`，导致全新克隆后按 README 操作会因找不到共享模块而构建失败。现所有构建/测试脚本已自动串联。
- **移除仓库中误提交的旧版打包产物**（`cipherzip/desktop/release/`，约 73MB，含损坏的旧版便携 exe），
  避免用户直接下载到复现崩溃的过期安装包；已补充 `.gitignore` 规则防止再次提交构建产物。
- 修复 `npm test` / `npm run test:e2e` 脚本路径错误（`@cipherzip/cli` 无测试文件时报错退出、
  `@cipherzip/core` 的 `tests/e2e` 目录不存在导致 e2e 校验从未真正跑过）。
- 修复主题（浅色/深色/跟随系统）设置不持久化的问题：重启应用后总是回退为「跟随系统」。
- 修复「解密解压」页面异常未被捕获导致的未处理 rejection。

### UI 优化

- 侧边导航增加当前页高亮指示条、按下态反馈；表单控件补充无障碍聚焦环；滚动条样式跨浏览器统一。

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
