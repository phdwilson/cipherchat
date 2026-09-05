/**
 * 内置小型 P2P 服务器 / 客户端
 * - TCP JSON 行协议（每行一个 JSON 消息）
 * - 端到端：握手后用 ECDH 派生会话密钥，后续 payload 均为 AES-GCM 密封
 * - 支持：chat 文本、file 分块传输、ping、mesh 宣告
 */
import { type Socket } from 'node:net';
import type { SharePayload } from '@cipherzip/shared';
export type P2PMessage = {
    type: 'hello';
    nick: string;
    pub: string;
    caps: string[];
} | {
    type: 'hello-ok';
    nick: string;
    pub: string;
} | {
    type: 'chat';
    text: string;
    ts: number;
} | {
    type: 'file-meta';
    name: string;
    size: number;
    sha256: string;
    id: string;
} | {
    type: 'file-chunk';
    id: string;
    index: number;
    total: number;
    data: string;
} | {
    type: 'file-done';
    id: string;
} | {
    type: 'mesh-announce';
    nodeId: string;
    free: number;
} | {
    type: 'ping';
    t: number;
} | {
    type: 'pong';
    t: number;
} | {
    type: 'error';
    message: string;
};
export interface P2PPeer {
    id: string;
    nick: string;
    socket: Socket;
    sessionKey?: Buffer;
    remotePub?: string;
}
export interface P2PEvents {
    onChat?: (peer: P2PPeer, text: string) => void;
    onFileReceived?: (peer: P2PPeer, path: string) => void;
    onPeer?: (peer: P2PPeer, joined: boolean) => void;
    onLog?: (msg: string) => void;
}
export declare class P2PNode {
    private server;
    private identity;
    private peers;
    private nick;
    private caps;
    private downloadDir;
    private port;
    private host;
    private events;
    private fileBuffers;
    constructor(opts?: {
        nick?: string;
        caps?: string[];
        downloadDir?: string;
        events?: P2PEvents;
    });
    get publicKey(): string;
    get listenPort(): number;
    start(port?: number, host?: string): Promise<number>;
    stop(): Promise<void>;
    /** 生成分享码（需提供对外可达 host） */
    makeShare(publicHost: string, ttlMs?: number): {
        code: string;
        qr: string;
        payload: SharePayload;
    };
    /** 通过分享码或二维码 JSON 连接对方 */
    connectShare(codeOrQr: string): Promise<P2PPeer>;
    connect(host: string, port: number, _peerPub?: string): Promise<P2PPeer>;
    sendChat(peer: P2PPeer, text: string): void;
    sendFile(peer: P2PPeer, filePath: string, onProgress?: (i: number, n: number) => void): Promise<void>;
    private accept;
    private wireSocket;
    private onLine;
    private sendRaw;
    private sendSecure;
    listPeers(): Array<{
        id: string;
        nick: string;
    }>;
}
