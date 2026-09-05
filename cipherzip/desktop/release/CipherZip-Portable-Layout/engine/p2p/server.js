/**
 * 内置小型 P2P 服务器 / 客户端
 * - TCP JSON 行协议（每行一个 JSON 消息）
 * - 端到端：握手后用 ECDH 派生会话密钥，后续 payload 均为 AES-GCM 密封
 * - 支持：chat 文本、file 分块传输、ping、mesh 宣告
 */
import { createServer, connect } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { seal, open } from '../crypto/aead.js';
import { encodeShareCode, encodeShareQr, decodeShareCode, decodeShareQr, generateP2PIdentity, deriveSessionKey, randomNick, } from './sharecode.js';
export class P2PNode {
    server = null;
    identity = generateP2PIdentity();
    peers = new Map();
    nick;
    caps;
    downloadDir;
    port = 0;
    host = '0.0.0.0';
    events;
    fileBuffers = new Map();
    constructor(opts = {}) {
        this.nick = opts.nick || randomNick();
        this.caps = opts.caps || ['chat', 'file'];
        this.downloadDir = opts.downloadDir || join(process.cwd(), 'cipherzip-inbox');
        this.events = opts.events || {};
    }
    get publicKey() {
        return this.identity.publicKey;
    }
    get listenPort() {
        return this.port;
    }
    async start(port = 0, host = '0.0.0.0') {
        this.host = host;
        await mkdir(this.downloadDir, { recursive: true });
        return new Promise((resolve, reject) => {
            this.server = createServer((socket) => this.accept(socket));
            this.server.on('error', reject);
            this.server.listen(port, host, () => {
                const addr = this.server.address();
                this.port = typeof addr === 'object' && addr ? addr.port : port;
                this.events.onLog?.(`P2P 节点已监听 ${host}:${this.port}`);
                resolve(this.port);
            });
        });
    }
    async stop() {
        for (const p of this.peers.values())
            p.socket.destroy();
        this.peers.clear();
        await new Promise((resolve) => this.server?.close(() => resolve()) || resolve());
    }
    /** 生成分享码（需提供对外可达 host） */
    makeShare(publicHost, ttlMs = 24 * 3600_000) {
        const payload = {
            v: 1,
            host: publicHost,
            port: this.port,
            pub: this.identity.publicKey,
            caps: this.caps,
            exp: Date.now() + ttlMs,
            nick: this.nick,
        };
        return { code: encodeShareCode(payload), qr: encodeShareQr(payload), payload };
    }
    /** 通过分享码或二维码 JSON 连接对方 */
    async connectShare(codeOrQr) {
        let host;
        let port;
        let peerPub;
        const trimmed = codeOrQr.trim();
        if (trimmed.startsWith('{')) {
            const p = decodeShareQr(trimmed);
            host = p.host;
            port = p.port;
            peerPub = p.pub;
        }
        else {
            const p = decodeShareCode(trimmed);
            host = p.host;
            port = p.port;
        }
        return this.connect(host, port, peerPub);
    }
    async connect(host, port, _peerPub) {
        return new Promise((resolve, reject) => {
            const socket = connect({ host, port }, () => {
                const peer = this.wireSocket(socket, true);
                // 主动方先发 hello
                this.sendRaw(peer, {
                    type: 'hello',
                    nick: this.nick,
                    pub: this.identity.publicKey,
                    caps: this.caps,
                });
                const onHelloOk = (msg) => {
                    if (msg.type === 'hello-ok') {
                        peer.nick = msg.nick;
                        peer.remotePub = msg.pub;
                        peer.sessionKey = deriveSessionKey(this.identity.privateKey, msg.pub, 'cipherzip-p2p-v1');
                        this.events.onPeer?.(peer, true);
                        resolve(peer);
                    }
                };
                peer._once = onHelloOk;
            });
            socket.on('error', reject);
        });
    }
    sendChat(peer, text) {
        this.sendSecure(peer, { type: 'chat', text, ts: Date.now() });
    }
    async sendFile(peer, filePath, onProgress) {
        const data = await readFile(filePath);
        const id = randomBytes(8).toString('hex');
        const sha256 = createHash('sha256').update(data).digest('hex');
        const name = basename(filePath);
        const chunkSize = 64 * 1024;
        const total = Math.max(1, Math.ceil(data.length / chunkSize));
        this.sendSecure(peer, { type: 'file-meta', name, size: data.length, sha256, id });
        for (let i = 0; i < total; i++) {
            const slice = data.subarray(i * chunkSize, Math.min((i + 1) * chunkSize, data.length));
            this.sendSecure(peer, {
                type: 'file-chunk',
                id,
                index: i,
                total,
                data: slice.toString('base64'),
            });
            onProgress?.(i + 1, total);
        }
        this.sendSecure(peer, { type: 'file-done', id });
    }
    accept(socket) {
        const peer = this.wireSocket(socket, false);
        this.events.onLog?.(`新连接 ${socket.remoteAddress}`);
    }
    wireSocket(socket, _outbound) {
        const id = randomBytes(8).toString('hex');
        const peer = { id, nick: '未知', socket };
        this.peers.set(id, peer);
        let buf = '';
        socket.setEncoding('utf8');
        socket.on('data', (chunk) => {
            buf += chunk;
            let idx;
            while ((idx = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, idx);
                buf = buf.slice(idx + 1);
                if (!line.trim())
                    continue;
                try {
                    this.onLine(peer, line);
                }
                catch (e) {
                    this.events.onLog?.(`协议错误: ${e instanceof Error ? e.message : e}`);
                }
            }
        });
        socket.on('close', () => {
            this.peers.delete(id);
            this.events.onPeer?.(peer, false);
        });
        return peer;
    }
    onLine(peer, line) {
        let msg;
        // 加密帧：{"e":"<base64>"}
        const raw = JSON.parse(line);
        if ('e' in raw && typeof raw.e === 'string') {
            if (!peer.sessionKey)
                throw new Error('尚未完成握手');
            const plain = open(peer.sessionKey, Buffer.from(raw.e, 'base64'));
            msg = JSON.parse(plain.toString('utf8'));
        }
        else {
            msg = raw;
        }
        const once = peer._once;
        if (once) {
            once(msg);
            delete peer._once;
        }
        switch (msg.type) {
            case 'hello': {
                peer.nick = msg.nick;
                peer.remotePub = msg.pub;
                peer.sessionKey = deriveSessionKey(this.identity.privateKey, msg.pub, 'cipherzip-p2p-v1');
                this.sendRaw(peer, { type: 'hello-ok', nick: this.nick, pub: this.identity.publicKey });
                this.events.onPeer?.(peer, true);
                break;
            }
            case 'chat':
                this.events.onChat?.(peer, msg.text);
                break;
            case 'file-meta': {
                this.fileBuffers.set(msg.id, { name: msg.name, chunks: [], total: 0, peer });
                break;
            }
            case 'file-chunk': {
                const fb = this.fileBuffers.get(msg.id);
                if (!fb)
                    break;
                fb.total = msg.total;
                fb.chunks[msg.index] = Buffer.from(msg.data, 'base64');
                break;
            }
            case 'file-done': {
                const fb = this.fileBuffers.get(msg.id);
                if (!fb)
                    break;
                const data = Buffer.concat(fb.chunks.filter(Boolean));
                const dest = join(this.downloadDir, fb.name);
                writeFile(dest, data).then(() => {
                    this.events.onFileReceived?.(peer, dest);
                    this.fileBuffers.delete(msg.id);
                });
                break;
            }
            case 'ping':
                this.sendSecure(peer, { type: 'pong', t: msg.t });
                break;
            default:
                break;
        }
    }
    sendRaw(peer, msg) {
        peer.socket.write(JSON.stringify(msg) + '\n');
    }
    sendSecure(peer, msg) {
        if (!peer.sessionKey) {
            this.sendRaw(peer, msg);
            return;
        }
        const wire = seal(peer.sessionKey, Buffer.from(JSON.stringify(msg), 'utf8'));
        peer.socket.write(JSON.stringify({ e: wire.toString('base64') }) + '\n');
    }
    listPeers() {
        return [...this.peers.values()].map((p) => ({ id: p.id, nick: p.nick }));
    }
}
