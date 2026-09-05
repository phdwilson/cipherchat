# 架构说明

## 分层

```
┌─────────────────────────────────────────────┐
│  Desktop UI (React)  ·  CLI  ·  未来 WASM   │
├─────────────────────────────────────────────┤
│  @cipherzip/core  引擎（Node/Electron）      │
│  ccz · legacy formats · p2p · mesh · bridge │
├─────────────────────────────────────────────┤
│  @cipherzip/shared  协议 / 标志位 / API 路径 │
├─────────────────────────────────────────────┤
│  CipherChat Next.js  ·  client-bridge API   │
└─────────────────────────────────────────────┘
```

## 进程模型（桌面）

- **渲染进程**：仅 UI，通过 `preload` 白名单 IPC 调主进程。
- **主进程**：加载 `@cipherzip/core`，持有 P2PNode / MeshStorage 生命周期。
- **可选**：用户配置 CipherChat `baseUrl` 后，主进程用 `CipherChatBridge` 注册。

## 安全边界

| 数据 | 出现位置 |
|------|----------|
| 密码 / 密钥文件 | 仅本地内存，派生后尽量清零 |
| authHash | 可上传服务器（不可逆推） |
| 归档明文 | 仅本地解密后目录 |
| P2P 消息 | ECDH 会话密钥密封，中继只见密文信令 |

## 迭代建议

- 新压缩算法：实现 `compress/decompress` 分支并分配 `CompressAlgo` 枚举值。
- 新客户端能力：`shared.CIPHERCHAT_CLIENT_API` 加路径 → `client-bridge` 实现 → bridge 客户端方法 → UI。
- 自愈网络下一阶段：在 P2P 消息中增加 `mesh-fetch` / `mesh-store` 真正跨节点复制 healPlan 中的分片。
