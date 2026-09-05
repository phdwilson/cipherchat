# Cipher 平台 · CipherChat + CipherZip 密匣

> 端到端加密协作平台：网页密讯（CipherChat）+ 桌面加密压缩（CipherZip），模块化 monorepo，可独立迭代、可互相联动。

## 仓库结构

```
.
├── cipherchat/                 # 密讯网页端（v1.8.1 + 客户端桥接 API）
│   └── src/app/api/client/*    # 新增：桌面客户端注册/心跳/归档宣告/P2P 信令
├── cipherzip/
│   ├── shared/                 # 共享协议与常量（@cipherzip/shared）
│   ├── core/                   # 核心引擎（@cipherzip/core）
│   │   ├── format/ccz.ts       # 专有强制 E2E 格式 .ccz
│   │   ├── crypto/             # KDF / AEAD / 密钥文件指纹
│   │   ├── formats/            # zip/tar/7z/rar 等传统格式
│   │   ├── p2p/                # 分享码 + 内置 P2P 服务
│   │   ├── mesh/               # 自愿分布式存储与自愈计划
│   │   └── bridge/             # CipherChat HTTP 桥接
│   ├── cli/                    # 命令行工具 cipherzip
│   └── desktop/                # Electron 全中文现代 UI + Windows 安装包
├── docs/                       # 设计文档
├── scripts/                    # 构建 / 打包 / 验证脚本
└── cipherchat-v1.8.1.tar.gz    # 原始上游包（已展开到 cipherchat/）
```

## CipherZip 密匣 · 功能亮点

| 模块 | 能力 |
|------|------|
| **.ccz 格式** | 强制 AES-256-GCM、文件名加密、完整性校验，仅本软件可解 |
| **密钥文件** | 任意文件（音乐/图片/文档）作密钥；读取头/黄金分割中段/尾指纹 |
| **多格式** | 创建 zip/tar/tar.gz/tar.br/gz/7z；打开另含 rar/xz/bz2/iso（7z） |
| **P2P** | 内置 TCP 节点；分享码=16 个英文单词编码 IP/端口/公钥；ECDH 会话 |
| **Mesh** | 自愿存储 content-addressed 分片，冗余副本 + healPlan 自愈 |
| **密讯联动** | 注册/心跳/密文指纹宣告/信令；复用 chat/drive 会话协议 |
| **设置** | 压缩/加密/P2P/Mesh/主题/隐私/性能全面可配 |
| **UI** | 全中文，扁平化（类 Apple / 小米 HyperOS）浅色/深色 |

### .ccz 格式摘要

```
Magic "CCZ1" | Version | Flags(FORCE_E2E) | Cipher/Compress
Salt | AuthHash | 加密 Meta | 加密 TOC | 加密分块... | Trailer
```

详细设计见 [`docs/ccz-format.md`](docs/ccz-format.md)。

## 快速开始

### 环境

- Node.js ≥ 18
- （可选）7-Zip CLI：增强 7z/rar 支持
- 打包 Windows 安装包：建议在 Windows 或 Linux+Wine 下使用 electron-builder

### 安装与测试

```bash
# 根目录
npm install

# 构建共享层与核心
npm run build:core

# 自动化验证（模拟真实用户：压缩/错误密码/密钥文件/P2P/Mesh）
npm test
npm run test:e2e
```

### CLI

```bash
npm run build -w @cipherzip/cli

# 强制加密压缩
npx cipherzip pack ./my-folder -o backup.ccz -p '强密码'

# 音乐当密钥
npx cipherzip pack ./doc -o secret.ccz -p 'pin' -k ./song.mp3

# 解压
npx cipherzip unpack backup.ccz -d ./out -p '强密码'

# P2P
npx cipherzip p2p --port 41234 --host 192.168.1.8
```

### 桌面端（UI 预览 / Electron）

```bash
npm run build -w @cipherzip/desktop
# 浏览器预览静态 UI
npx --prefix cipherzip/desktop vite preview

# Electron（需已 build:core）
cd cipherzip/desktop && npx electron .
```

### Windows 11 安装包

```bash
# 一键脚本（生成 NSIS / Portable / Zip 产物到 cipherzip/desktop/release）
bash scripts/pack-windows.sh

# 或手动
npm run build:core
npm run pack:win -w @cipherzip/desktop
```

产物示例：

- `CipherZip-Setup-1.0.0-x64.exe` — NSIS 安装程序（中文，可选目录）
- `CipherZip-Portable-1.0.0.exe` — 绿色便携版
- `CipherZip-Setup-1.0.0-x64.zip` — 压缩分发包

> 若当前 CI/沙箱为 Linux 且无 Wine，脚本会额外生成 **可移植应用目录 + 安装说明 + 离线安装包结构**，并在有 electron-builder 能力时继续打 Windows 目标。

## CipherChat 联动 API（新增）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/client/register` | 桌面客户端注册，返回 clientToken |
| POST | `/api/client/heartbeat` | 心跳 + 在线计数 |
| POST | `/api/client/archive/announce` | 仅上传 authHash 等密文指纹 |
| GET | `/api/client/archive/lookup` | 按 authHash 查询 |
| POST | `/api/client/signal/offer` | P2P 信令 offer |
| POST | `/api/client/signal/answer` | P2P 信令 answer |
| GET | `/api/client/signal/poll` | 拉取信令 |

实现：`cipherchat/src/lib/server/client-bridge.ts`（JSON 文件存储，可替换 DB，模块化）。

## 模块化升级路径

1. **只改压缩算法**：`cipherzip/core/src/compress`
2. **只改 UI**：`cipherzip/desktop/src`
3. **只改网页**：`cipherchat/`
4. **协议变更**：先改 `@cipherzip/shared`，再两端对齐
5. **合并进密讯站点**：桌面通过 bridge 调用；未来可将 core 编译为 WASM 嵌入 web

## 安全承诺

- 服务器 / 中继 **永远看不到** 密码、密钥文件内容、归档明文、聊天明文（P2P 直连加密）。
- `.ccz` 强制 E2E，无「空密码」后门。
- 密钥材料在内存使用后尽量 `fill(0)` 清理。

## 开发说明

- 包管理：npm workspaces
- 核心测试：vitest（`cipherzip/core/tests`）
- TypeScript strict
- 注释以中文为主，解释设计意图

## 许可证

MIT

---

**CipherChat** 原项目说明见 [`cipherchat/README.md`](cipherchat/README.md) 与 [`cipherchat/安装教程.md`](cipherchat/安装教程.md)。
