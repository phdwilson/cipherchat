# .ccz — Cipher Compressed Zip 格式规范 v1

## 设计目标

1. **强制端到端加密**：无明文 TOC、无明文文件名（可选但默认开启）、无未加密内容块。
2. **只有 CipherZip 能正确打开**（魔数 + 专有密封布局 + 自有 KDF 域分隔）。
3. **可扩展**：Flags / reserved 字段预留；版本号协商。
4. **与 CipherChat 分块哲学对齐**：默认 4MiB 逻辑块，AAD 绑定 entryId+index。

## 字节布局（小端）

| 偏移 | 字段 | 说明 |
|------|------|------|
| 0 | `CCZ1` | 4 字节魔数 |
| 4 | version u16 | 当前 1 |
| 6 | flags u32 | 见标志位 |
| 10 | cipher u8 | 1=AES-256-GCM 2=ChaCha20-Poly1305 |
| 11 | compress u8 | 0 none 1 deflate 2 gzip 3 brotli 4 zstd |
| 12 | reserved u16 | 0 |
| 14 | chunkSize u32 | 明文压缩后分块大小 |
| 18 | saltLen u16 + salt | KDF 盐 |
| … | authHash 32B | PBKDF2 认证哈希（快速校验密码） |
| … | headerEncLen + headerEnc | 密封的 ArchiveMeta JSON |
| … | tocEncLen + tocEnc | 密封的 TocEntry[] JSON（含 entryId） |
| … | chunkCount u32 | |
| … | 重复：chunkLen u32 + bytes | 每块 = nonce12 \|\| ct \|\| tag16 |
| end | `CCZE` + bodySHA256[0:16] | 完整性提示 |

## 标志位

| 位 | 名称 | 含义 |
|----|------|------|
| 0 | ENCRYPT_FILENAMES | TOC 内 path/name 为 nameKey 密封 |
| 1 | KEYFILE_MODE | 使用了密钥文件 |
| 2 | SOLID | 预留：固实压缩 |
| 3 | SPLIT | 预留：分卷 |
| 4 | SELF_DESTRUCT | 预留：只读一次 |
| 5 | MESH_SHARD | 预留：分片已入网 |
| 6 | FORCE_E2E | **必须置位**，否则拒读 |

## 密钥派生

```
secret = password | keyfileFingerprint | SHA256(password||keyfile)
contentKey||nameKey = PBKDF2-HMAC-SHA256(secret, "cipherzip:key:"||salt, 310000, 64)
authHash = PBKDF2(..., "cipherzip:auth:"||salt, 120000, 32)
```

### 密钥文件指纹

对任意文件：

1. 读头 1KiB、尾 1KiB
2. 中段：offset = floor(L * φ) 起最多 64KiB（φ≈0.618）
3. `SHA256("cipherzip:keyfile:v1" || head || mid || tail || lenBE8)`

音乐文件同样适用——不依赖音频解码，只依赖字节分布。

## AAD

内容块：`ccz:{entryId}:{index}`  
Meta：`cipherzip:meta`  
TOC：`cipherzip:toc`  
文件名：`cipherzip:name`

## 实现位置

`cipherzip/core/src/format/ccz.ts`
