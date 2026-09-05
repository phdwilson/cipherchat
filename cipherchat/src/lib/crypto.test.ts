// 加密核心单元测试（vitest + Node webcrypto）
// 覆盖：密钥派生一致性 / sealJSON+openJSON 回路 / 分块加解密 AAD 绑定 / 错误输入
import { describe, it, expect } from 'vitest'
import {
  deriveChatKeys,
  sealJSON,
  openJSON,
  encryptChunk,
  decryptChunk,
} from './crypto'

// crypto.ts 使用全局 crypto（浏览器 API），Node 18+ 的 globalThis.crypto 等价可用
const CH = 'test-channel'
const PW = 'Correct-Horse-Battery#2026'

describe('deriveChatKeys', () => {
  it('相同 频道ID+密码 派生出可互解的密钥与相同 authHash', async () => {
    const a = await deriveChatKeys(CH, PW)
    const b = await deriveChatKeys(CH, PW)
    expect(a.authHash).toBe(b.authHash)
    expect(a.authHash).toMatch(/^[a-f0-9]{64}$/)
    // 用 a 加密、b 解密必须成功（跨客户端互操作性）
    const sealed = await sealJSON(a.aesKey, { hello: 'world' })
    expect(await openJSON(b.aesKey, sealed)).toEqual({ hello: 'world' })
  })

  it('不同密码派生的密钥无法解密（openJSON 返回 null）', async () => {
    const a = await deriveChatKeys(CH, PW)
    const wrong = await deriveChatKeys(CH, 'wrong-password')
    const sealed = await sealJSON(a.aesKey, { secret: true })
    expect(await openJSON(wrong.aesKey, sealed)).toBeNull()
  })

  it('不同频道 ID 派生的密钥不同', async () => {
    const a = await deriveChatKeys('chan-a', PW)
    const b = await deriveChatKeys('chan-b', PW)
    const sealed = await sealJSON(a.aesKey, { x: 1 })
    expect(await openJSON(b.aesKey, sealed)).toBeNull()
  })

  it('空密码也能派生（不抛异常，边界值）', async () => {
    const k = await deriveChatKeys(CH, '')
    expect(k.authHash).toMatch(/^[a-f0-9]{64}$/)
  })
})

describe('sealJSON / openJSON', () => {
  it('对象往返一致；每次加密 IV 不同（密文不同）', async () => {
    const { aesKey } = await deriveChatKeys(CH, PW)
    const obj = { nested: { arr: [1, 'two', null], ok: true }, 中文: '值' }
    const s1 = await sealJSON(aesKey, obj)
    const s2 = await sealJSON(aesKey, obj)
    expect(JSON.parse(s1)).toHaveProperty('iv')
    expect(JSON.parse(s1)).toHaveProperty('data')
    expect(s1).not.toBe(s2) // IV 随机 → 同明文不同密文
    expect(await openJSON(aesKey, s1)).toEqual(obj)
  })

  it('篡改密文后解密失败返回 null（GCM 完整性校验）', async () => {
    const { aesKey } = await deriveChatKeys(CH, PW)
    const box = JSON.parse(await sealJSON(aesKey, { t: 'data' }))
    const bytes = Buffer.from(box.data, 'base64')
    bytes[bytes.length - 1] ^= 0x01 // 翻转最后一位
    box.data = bytes.toString('base64')
    expect(await openJSON(aesKey, JSON.stringify(box))).toBeNull()
  })

  it('损坏的密封串（非 JSON / 缺字段）返回 null 而非抛出', async () => {
    const { aesKey } = await deriveChatKeys(CH, PW)
    expect(await openJSON(aesKey, 'not-json')).toBeNull()
    expect(await openJSON(aesKey, '{"iv":"AAAA","data":"AAAA"}')).toBeNull()
    expect(await openJSON(aesKey, '')).toBeNull()
  })

  it('空字符串与 Unicode 边界值往返', async () => {
    const { aesKey } = await deriveChatKeys(CH, PW)
    for (const v of ['', ' ', '🎉🚀', 'a'.repeat(10000), '\n\t\\ "quote"']) {
      const sealed = await sealJSON(aesKey, { v })
      expect((await openJSON<{ v: string }>(aesKey, sealed))?.v).toBe(v)
    }
  })
})

describe('encryptChunk / decryptChunk', () => {
  const fileId = '01234567-89ab-cdef-0123-456789abcdef'
  const mkKey = async () => (await deriveChatKeys(CH, PW)).aesKey

  it('分块加解密回路（含空块与单字节边界值）', async () => {
    const key = await mkKey()
    for (const size of [0, 1, 16, 4096]) {
      const plain = new Uint8Array(size).map((_, i) => i % 256)
      const wire = await encryptChunk(key, fileId, 0, plain.buffer as ArrayBuffer)
      // 密文格式：12B IV + 明文长度 + 16B GCM tag
      expect(wire.length).toBe(12 + size + 16)
      const pt = await decryptChunk(key, fileId, 0, wire.slice().buffer as ArrayBuffer)
      expect(Buffer.from(pt).equals(Buffer.from(plain))).toBe(true)
    }
  })

  it('AAD 绑定 fileId:index —— 换序/换文件名的块拒绝解密', async () => {
    const key = await mkKey()
    const plain = new Uint8Array([1, 2, 3])
    const wire = await encryptChunk(key, fileId, 5, plain.buffer as ArrayBuffer)
    // 同一块用不同 index 解密应失败
    await expect(decryptChunk(key, fileId, 6, wire.slice().buffer as ArrayBuffer)).rejects.toThrow()
    // 不同 fileId 也应失败
    await expect(
      decryptChunk(key, 'ffffffff-0000-0000-0000-000000000000', 5, wire.slice().buffer as ArrayBuffer),
    ).rejects.toThrow()
    // 正确 index 成功
    const pt = await decryptChunk(key, fileId, 5, wire.slice().buffer as ArrayBuffer)
    expect(Array.from(pt)).toEqual([1, 2, 3])
  })

  it('错误密钥解密分块失败', async () => {
    const k1 = (await deriveChatKeys(CH, PW)).aesKey
    const k2 = (await deriveChatKeys(CH, 'other-password')).aesKey
    const wire = await encryptChunk(k1, fileId, 0, new Uint8Array([9]).buffer as ArrayBuffer)
    await expect(decryptChunk(k2, fileId, 0, wire.slice().buffer as ArrayBuffer)).rejects.toThrow()
  })

  it('密文被截断时解密失败（防截断攻击）', async () => {
    const key = await mkKey()
    const wire = await encryptChunk(key, fileId, 0, new Uint8Array(64).buffer as ArrayBuffer)
    const truncated = wire.slice(0, wire.length - 10)
    await expect(decryptChunk(key, fileId, 0, truncated.slice().buffer as ArrayBuffer)).rejects.toThrow()
  })
})

// v1.8.1 回归测试：上传 worker 并发领取分块序号的竞态修复
// 背景：旧实现 while 检查与 nextIndex++ 之间夹着 await waitIfPaused()，并发 worker
// 同时通过检查后先后领取，后者领取到 totalChunks（越界）→ 服务端 400「分块序号超出范围」。
// 本测试模拟两个并发 worker（concurrency: 2）上传单块与多块文件，断言：
//   1. 每个被领取的 index 都 < totalChunks（不越界）
//   2. 全部块恰好上传一次（无遗漏、无重复）
import { uploadEncryptedFile } from './crypto'

describe('uploadEncryptedFile 并发竞态（v1.8.1 修复回归）', () => {
  const mkKey = async () => (await deriveChatKeys(CH, PW)).aesKey

  it('单块文件并发上传：恰好上传 index 0，绝不越界（v1.8.1 修复前 100% 复现越界）', async () => {
    // 通过 mock fetch 观察真实 uploadEncryptedFile 的行为
    const seen: number[] = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url)
      if (u.includes('/init')) {
        seen.push(-1) // 标记 init 被调用一次
        return new Response(JSON.stringify({ fileId: 'f1000000-0000-4000-8000-000000000001' }), { status: 200 })
      }
      if (u.includes('/chunk')) {
        const idx = Number(new URL(u).searchParams.get('index'))
        seen.push(idx)
        // 服务端语义：index >= totalChunks（此处为 1）即 400 —— 复现真实行为
        if (idx >= 1) return new Response(JSON.stringify({ error: '分块序号超出范围' }), { status: 400 })
        await new Promise((r) => setTimeout(r, 1)) // 模拟网络延迟（放大竞态窗口）
        return new Response(JSON.stringify({ received: idx }), { status: 200 })
      }
      if (u.includes('/complete')) return new Response(JSON.stringify({ ok: true }), { status: 200 })
      return new Response('{}', { status: 200 })
    }) as typeof fetch

    try {
      const key = await mkKey()
      const plain = new Uint8Array(256 * 1024).map((_, i) => i % 251) // 256KB < 4MiB → 1 块
      const file = new File([plain], 'racy-single.bin')
      const result = await uploadEncryptedFile({
        file,
        key,
        chunkSize: 4 * 1024 * 1024,
        token: 't',
        concurrency: 2, // 两个并发 worker —— 旧实现必现竞态
        initUrl: 'http://test/init',
        chunkUrl: (fid, idx) => `http://test/chunk?fileId=${fid}&index=${idx}`,
        completeUrl: 'http://test/complete',
      })
      expect(result.totalChunks).toBe(1)
      // init 恰好 1 次、chunk 0 恰好 1 次、绝无 index 1
      expect(seen.filter((x) => x === -1).length).toBe(1)
      expect(seen.filter((x) => x >= 0)).toEqual([0])
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it('多块文件并发上传：全部块恰好各一次，无越界无遗漏', async () => {
    const realFetch = globalThis.fetch
    const seen: number[] = []
    const TOTAL = 6 // 5MiB+123 / 1MiB 分块 = 6 块
    globalThis.fetch = (async (url: string | URL | Request) => {
      const u = String(url)
      if (u.includes('/init')) {
        return new Response(JSON.stringify({ fileId: 'f2000000-0000-4000-8000-000000000002' }), { status: 200 })
      }
      if (u.includes('/chunk')) {
        const idx = Number(new URL(u).searchParams.get('index'))
        seen.push(idx)
        if (idx >= TOTAL) return new Response(JSON.stringify({ error: '分块序号超出范围' }), { status: 400 })
        await new Promise((r) => setTimeout(r, 2)) // 随机化延迟放大竞态
        return new Response(JSON.stringify({ received: idx }), { status: 200 })
      }
      if (u.includes('/complete')) return new Response(JSON.stringify({ ok: true }), { status: 200 })
      return new Response('{}', { status: 200 })
    }) as typeof fetch

    try {
      const key = await mkKey()
      const plain = new Uint8Array(5 * 1024 * 1024 + 123).map((_, i) => i % 251) // 5 块 + 尾巴
      const file = new File([plain], 'racy-multi.bin')
      const result = await uploadEncryptedFile({
        file,
        key,
        chunkSize: 1024 * 1024, // 1MiB 分块 → 6 块（Math.ceil(5MiB+123 / 1MiB)）
        token: 't',
        concurrency: 3,
        initUrl: 'http://test/init',
        chunkUrl: (fid, idx) => `http://test/chunk?fileId=${fid}&index=${idx}`,
        completeUrl: 'http://test/complete',
      })
      const chunks = seen.filter((x) => x >= 0)
      expect(result.totalChunks).toBe(6)
      expect(chunks.length).toBe(6)
      expect(new Set(chunks).size).toBe(6) // 无重复
      expect(chunks.every((c) => c < 6)).toBe(true) // 无越界
    } finally {
      globalThis.fetch = realFetch
    }
  })
})
