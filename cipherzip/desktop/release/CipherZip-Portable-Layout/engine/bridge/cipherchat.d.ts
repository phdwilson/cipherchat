/**
 * CipherChat 桥接客户端
 * 桌面端通过 HTTP 对接 CipherChat 网页后端（含新增 /api/client/*）。
 * 仅上传密文指纹 / 能力宣告，从不上传密码或明文。
 */
import { type ArchiveMeta } from '@cipherzip/shared';
export interface BridgeConfig {
    baseUrl: string;
    /** 桌面客户端标识 */
    clientId?: string;
    userAgent?: string;
}
export interface ClientCapabilities {
    version: string;
    features: string[];
    p2pPort?: number;
    meshWilling?: boolean;
    nodeId?: string;
}
export declare class CipherChatBridge {
    private base;
    private clientId;
    private token;
    private ua;
    constructor(cfg: BridgeConfig);
    private req;
    health(): Promise<{
        ok: boolean;
        data?: unknown;
    }>;
    getConfig(): Promise<Record<string, unknown>>;
    /** 注册桌面客户端能力 */
    register(caps: ClientCapabilities): Promise<{
        ok: boolean;
        clientToken?: string;
    }>;
    heartbeat(extra?: Record<string, unknown>): Promise<void>;
    /** 宣告归档密文指纹（无明文） */
    announceArchive(info: {
        authHash: string;
        size: number;
        entryCount: number;
        meta?: Partial<ArchiveMeta>;
        fingerprint?: string;
    }): Promise<void>;
    lookupArchive(authHash: string): Promise<unknown>;
    /** 加入聊天频道（复用 CipherChat 会话协议） */
    joinChannel(channelId: string, password: string): Promise<{
        token: string;
        authHash: string;
    }>;
    /** P2P 信令：发布 offer */
    signalOffer(room: string, offer: unknown): Promise<void>;
    signalAnswer(room: string, answer: unknown): Promise<void>;
    signalPoll(room: string): Promise<unknown>;
}
