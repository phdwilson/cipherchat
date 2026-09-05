/**
 * 自愈分布式存储网络（Mesh）
 *
 * 设计（可渐进实现）：
 * 1. 用户自愿加入：willing=true 时接受分片存储请求
 * 2. 文件分片：按固定大小切块，每块 content-addressed（sha256）
 * 3. 冗余：默认 3 副本，优先放到空闲空间大的节点
 * 4. 自愈：定期心跳；节点掉线后，持有副本的节点向网络重新复制
 * 5. 与 CipherChat 可选联动：通过 /api/client/* 宣告在线节点
 *
 * 本模块提供本地存储引擎 + 简单 gossip 协议，不依赖中心服务器。
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
export class MeshStorage {
    nodeId;
    dataDir;
    shardDir;
    metaPath;
    maxStorage;
    willing;
    redundancy;
    peers = new Map();
    shards = new Map();
    constructor(cfg) {
        this.nodeId = cfg.nodeId || randomBytes(16).toString('hex');
        this.dataDir = cfg.dataDir;
        this.shardDir = join(cfg.dataDir, 'shards');
        this.metaPath = join(cfg.dataDir, 'mesh-meta.json');
        this.maxStorage = cfg.maxStorageBytes ?? 5 * 1024 ** 3;
        this.willing = cfg.willing ?? false;
        this.redundancy = cfg.redundancy ?? 3;
    }
    async init() {
        await mkdir(this.shardDir, { recursive: true });
        try {
            const raw = await readFile(this.metaPath, 'utf8');
            const j = JSON.parse(raw);
            for (const s of j.shards || [])
                this.shards.set(s.hash, s);
        }
        catch {
            /* fresh */
        }
    }
    async persist() {
        await writeFile(this.metaPath, JSON.stringify({ nodeId: this.nodeId, shards: [...this.shards.values()] }, null, 2));
    }
    async usedBytes() {
        let total = 0;
        try {
            for (const f of await readdir(this.shardDir)) {
                const st = await stat(join(this.shardDir, f));
                total += st.size;
            }
        }
        catch {
            /* empty */
        }
        return total;
    }
    async freeBytes() {
        return Math.max(0, this.maxStorage - (await this.usedBytes()));
    }
    /** 切分并本地存储（返回分片哈希列表） */
    async putObject(data, chunkSize = 256 * 1024) {
        const hashes = [];
        for (let i = 0; i * chunkSize < data.length || (data.length === 0 && i === 0); i++) {
            const slice = data.subarray(i * chunkSize, Math.min((i + 1) * chunkSize, data.length));
            const hash = createHash('sha256').update(slice).digest('hex');
            await this.storeShard(hash, slice);
            hashes.push(hash);
        }
        return hashes;
    }
    async getObject(hashes) {
        const parts = [];
        for (const h of hashes) {
            const p = await this.loadShard(h);
            if (!p)
                throw new Error(`缺失分片: ${h}`);
            parts.push(p);
        }
        return Buffer.concat(parts);
    }
    async storeShard(hash, data) {
        if (!this.willing && this.shards.size > 0) {
            // 仍允许存自己的对象
        }
        const free = await this.freeBytes();
        if (data.length > free)
            return false;
        const path = join(this.shardDir, hash);
        await writeFile(path, data);
        const meta = this.shards.get(hash) || {
            hash,
            size: data.length,
            storedAt: Date.now(),
            owners: [this.nodeId],
        };
        if (!meta.owners.includes(this.nodeId))
            meta.owners.push(this.nodeId);
        this.shards.set(hash, meta);
        await this.persist();
        return true;
    }
    async loadShard(hash) {
        try {
            return await readFile(join(this.shardDir, hash));
        }
        catch {
            return null;
        }
    }
    async dropShard(hash) {
        await rm(join(this.shardDir, hash), { force: true });
        this.shards.delete(hash);
        await this.persist();
    }
    upsertPeer(info) {
        this.peers.set(info.nodeId, { ...info, lastSeen: Date.now() });
    }
    listPeers() {
        return [...this.peers.values()];
    }
    /**
     * 自愈扫描：找出 owners 不足 redundancy 的分片，标记需要复制
     * （实际网络复制由 P2P 层完成）
     */
    async healPlan() {
        const plan = [];
        const now = Date.now();
        // 清理过期 peer（5 分钟无心跳）
        for (const [id, p] of this.peers) {
            if (now - p.lastSeen > 5 * 60_000)
                this.peers.delete(id);
        }
        for (const s of this.shards.values()) {
            // 过滤仍在线的 owners
            const alive = s.owners.filter((o) => o === this.nodeId || this.peers.has(o));
            s.owners = alive;
            if (alive.length < this.redundancy) {
                plan.push({ hash: s.hash, need: this.redundancy - alive.length });
            }
        }
        await this.persist();
        return plan;
    }
    info() {
        return {
            nodeId: this.nodeId,
            address: '127.0.0.1',
            port: 0,
            storageFree: this.maxStorage,
            willing: this.willing,
            lastSeen: Date.now(),
            shardCount: this.shards.size,
        };
    }
}
