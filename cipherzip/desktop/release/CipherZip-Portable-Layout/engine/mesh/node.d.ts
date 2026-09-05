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
import type { MeshNodeInfo } from '@cipherzip/shared';
export interface MeshConfig {
    dataDir: string;
    nodeId?: string;
    maxStorageBytes?: number;
    willing?: boolean;
    redundancy?: number;
}
export interface ShardMeta {
    hash: string;
    size: number;
    storedAt: number;
    owners: string[];
}
export declare class MeshStorage {
    readonly nodeId: string;
    private dataDir;
    private shardDir;
    private metaPath;
    private maxStorage;
    willing: boolean;
    redundancy: number;
    private peers;
    private shards;
    constructor(cfg: MeshConfig);
    init(): Promise<void>;
    persist(): Promise<void>;
    usedBytes(): Promise<number>;
    freeBytes(): Promise<number>;
    /** 切分并本地存储（返回分片哈希列表） */
    putObject(data: Buffer, chunkSize?: number): Promise<string[]>;
    getObject(hashes: string[]): Promise<Buffer>;
    storeShard(hash: string, data: Buffer): Promise<boolean>;
    loadShard(hash: string): Promise<Buffer | null>;
    dropShard(hash: string): Promise<void>;
    upsertPeer(info: MeshNodeInfo): void;
    listPeers(): MeshNodeInfo[];
    /**
     * 自愈扫描：找出 owners 不足 redundancy 的分片，标记需要复制
     * （实际网络复制由 P2P 层完成）
     */
    healPlan(): Promise<Array<{
        hash: string;
        need: number;
    }>>;
    info(): MeshNodeInfo & {
        shardCount: number;
    };
}
