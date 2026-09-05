/**
 * 端到端自动化：模拟真实用户压缩 → 列表 → 错误密码 → 正确解压 → 密钥文件 → P2P
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdir, writeFile, readFile, rm, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  createCcz,
  extractCcz,
  listCcz,
  packArchive,
  unpackArchive,
  extractKeyfileMaterial,
  P2PNode,
  MeshStorage,
  encodeShareCode,
  decodeShareCode,
  generateP2PIdentity,
  defaultSettings,
  sha256Buf,
} from '../src/index.js'

let root: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'cipherzip-e2e-'))
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src', 'hello.txt'), '你好，CipherZip！Hello E2E.\n' + 'x'.repeat(10_000))
  await writeFile(join(root, 'src', 'data.bin'), Buffer.from(Array.from({ length: 50_000 }, () => Math.floor(Math.random() * 256))))
  await mkdir(join(root, 'src', 'sub'))
  await writeFile(join(root, 'src', 'sub', 'nested.md'), '# nested\nsecret=42\n')
  // 伪音乐密钥文件
  await writeFile(join(root, 'music-key.mp3'), Buffer.concat([
    Buffer.from('ID3'),
    Buffer.alloc(2048, 0xab),
    Buffer.from('audio-payload-mock'),
    Buffer.alloc(8192, 0xcd),
  ]))
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('CCZ 强制加密归档', () => {
  it('密码创建 → 列表 → 解压，内容一致', async () => {
    const out = join(root, 'a.ccz')
    const r = await createCcz({
      inputs: [join(root, 'src')],
      output: out,
      key: { type: 'password', password: '正确密码-Test#1' },
      encryptFilenames: true,
      comment: 'e2e',
    })
    expect(r.entryCount).toBeGreaterThan(0)
    expect(r.authHash).toMatch(/^[0-9a-f]{64}$/)

    const listed = await listCcz(out, { type: 'password', password: '正确密码-Test#1' })
    expect(listed.meta.comment).toBe('e2e')
    expect(listed.entries.some((e) => e.path.includes('hello.txt') || e.name.includes('hello'))).toBe(true)

    await expect(
      listCcz(out, { type: 'password', password: '错误密码' })
    ).rejects.toThrow(/不正确/)

    const dest = join(root, 'out-a')
    const ex = await extractCcz({
      archivePath: out,
      outputDir: dest,
      key: { type: 'password', password: '正确密码-Test#1' },
    })
    expect(ex.files.length).toBeGreaterThan(0)
    const hello = await readFile(join(dest, 'hello.txt'), 'utf8').catch(() =>
      readFile(join(dest, 'src', 'hello.txt'), 'utf8')
    )
    expect(hello).toContain('CipherZip')
  })

  it('密钥文件（音乐）+ 密码双因子', async () => {
    const out = join(root, 'b.ccz')
    const keyfile = join(root, 'music-key.mp3')
    const mat = await extractKeyfileMaterial(keyfile)
    expect(mat.length).toBe(32)

    await createCcz({
      inputs: [join(root, 'src', 'hello.txt')],
      output: out,
      key: { type: 'hybrid', password: 'mix', keyfilePath: keyfile },
    })

    await expect(
      extractCcz({
        archivePath: out,
        outputDir: join(root, 'out-bad'),
        key: { type: 'password', password: 'mix' }, // 缺 keyfile
      })
    ).rejects.toThrow()

    const dest = join(root, 'out-b')
    await extractCcz({
      archivePath: out,
      outputDir: dest,
      key: { type: 'hybrid', password: 'mix', keyfilePath: keyfile },
    })
    const files = await readFile(join(dest, 'hello.txt'), 'utf8')
    expect(files).toContain('你好')
  })

  it('无密钥文件仅 keyfile 模式', async () => {
    const out = join(root, 'c.ccz')
    const keyfile = join(root, 'music-key.mp3')
    await packArchive({
      inputs: [join(root, 'src', 'sub')],
      output: out,
      format: 'ccz',
      key: { type: 'keyfile', path: keyfile },
    })
    const dest = join(root, 'out-c')
    const files = await unpackArchive({
      archive: out,
      outputDir: dest,
      key: { type: 'keyfile', path: keyfile },
    })
    expect(files.length).toBeGreaterThan(0)
  })
})

describe('传统 zip（无密码）', () => {
  it('创建并解压 zip', async () => {
    const out = join(root, 'plain.zip')
    await packArchive({
      inputs: [join(root, 'src', 'hello.txt')],
      output: out,
      format: 'zip',
    })
    const dest = join(root, 'out-zip')
    await unpackArchive({ archive: out, outputDir: dest })
    const content = await readFile(join(dest, 'hello.txt'), 'utf8')
    expect(content).toContain('CipherZip')
  })

  it('带密码的 zip 自动升级为 ccz', async () => {
    const out = join(root, 'sec.zip')
    const real = await packArchive({
      inputs: [join(root, 'src', 'hello.txt')],
      output: out,
      format: 'zip',
      password: 'secret',
    })
    expect(real.endsWith('.ccz')).toBe(true)
  })
})

describe('分享码', () => {
  it('编码解码往返（IPv4）', () => {
    const id = generateP2PIdentity()
    const code = encodeShareCode({
      v: 1,
      host: '192.168.1.20',
      port: 41234,
      pub: id.publicKey,
      caps: ['chat', 'file'],
      exp: Date.now() + 86400_000,
      nick: '测试',
    })
    expect(code.split('-').length).toBe(16)
    const d = decodeShareCode(code)
    expect(d.host).toBe('192.168.1.20')
    expect(d.port).toBe(41234)
    expect(d.caps).toContain('chat')
  })
})

describe('P2P 端到端聊天与文件', () => {
  it('双节点连接、聊天、传文件', async () => {
    const inboxA = join(root, 'inbox-a')
    const inboxB = join(root, 'inbox-b')
    const chats: string[] = []
    const files: string[] = []

    const a = new P2PNode({
      nick: '爱丽丝',
      downloadDir: inboxA,
      events: {
        onChat: (_p, t) => chats.push('A:' + t),
        onFileReceived: (_p, pth) => files.push(pth),
      },
    })
    const b = new P2PNode({
      nick: '鲍勃',
      downloadDir: inboxB,
      events: {
        onChat: (_p, t) => chats.push('B:' + t),
        onFileReceived: (_p, pth) => files.push(pth),
      },
    })

    const portA = await a.start(0, '127.0.0.1')
    await b.start(0, '127.0.0.1')
    const share = a.makeShare('127.0.0.1')
    // 分享码可能因端口/哈希导致 host 正确
    expect(share.code.split('-')).toHaveLength(16)

    const peer = await b.connect('127.0.0.1', portA)
    // 等握手完成
    await new Promise((r) => setTimeout(r, 300))
    b.sendChat(peer, '你好爱丽丝')
    await new Promise((r) => setTimeout(r, 300))

    const aPeers = a.listPeers()
    expect(aPeers.length).toBeGreaterThanOrEqual(1)

    await b.sendFile(peer, join(root, 'src', 'hello.txt'))
    await new Promise((r) => setTimeout(r, 800))

    expect(chats.some((c) => c.includes('你好爱丽丝'))).toBe(true)
    expect(files.length).toBeGreaterThanOrEqual(1)
    if (files[0]) {
      const got = await readFile(files[0], 'utf8')
      expect(got).toContain('CipherZip')
    }

    await a.stop()
    await b.stop()
  }, 30_000)
})

describe('Mesh 存储自愈计划', () => {
  it('分片存取与 healPlan', async () => {
    const dir = join(root, 'mesh')
    const mesh = new MeshStorage({ dataDir: dir, willing: true, maxStorageBytes: 50 * 1024 * 1024, redundancy: 3 })
    await mesh.init()
    const payload = Buffer.from('mesh-payload-' + 'z'.repeat(1000))
    const hashes = await mesh.putObject(payload, 128)
    expect(hashes.length).toBeGreaterThan(0)
    const back = await mesh.getObject(hashes)
    expect(sha256Buf(back)).toBe(sha256Buf(payload))
    const plan = await mesh.healPlan()
    // 单节点 redundancy=3 → 需要复制
    expect(plan.length).toBeGreaterThan(0)
    expect(mesh.info().willing).toBe(true)
  })
})

describe('设置模型', () => {
  it('默认设置为中文与 ccz', () => {
    const s = defaultSettings()
    expect(s.general.language).toBe('zh-CN')
    expect(s.general.defaultFormat).toBe('ccz')
    expect(s.encryption.encryptFilenames).toBe(true)
  })
})
