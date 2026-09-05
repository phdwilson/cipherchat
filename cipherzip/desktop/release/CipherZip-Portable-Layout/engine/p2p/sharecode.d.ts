/**
 * 分享码系统
 * 将 {host, port, pub, caps, exp, nick} 编码为易记英文单词序列（或二维码 JSON）。
 *
 * 编码思路：
 * 1. 规范化 IPv4 为 32-bit；IPv6 取前 8 字节摘要
 * 2. 端口 16-bit
 * 3. 公钥 SHA-256 取前 10 字节
 * 4. 能力位 8-bit + 过期（小时粒度 16-bit）
 * 5. 整体 1+4+2+10+1+2 = 20 字节 → 用 2048 词表编为 16 个单词（带校验）
 *
 * 分享码本质是客户端内置词表「加密/编码」后的人类可读地址，
 * 不是服务器发放的 — 完全本地生成。
 */
import type { SharePayload } from '@cipherzip/shared';
export declare function encodeShareCode(payload: SharePayload): string;
export declare function decodeShareCode(code: string): Omit<SharePayload, 'pub' | 'nick'> & {
    pubHash: Buffer;
    hostHint: string;
};
/** 完整 JSON 载荷（用于二维码，可含完整公钥与昵称） */
export declare function encodeShareQr(payload: SharePayload): string;
export declare function decodeShareQr(text: string): SharePayload;
/** 生成 P2P 会话密钥对（X25519） */
export declare function generateP2PIdentity(): {
    publicKey: string;
    privateKey: string;
};
/** 用 HMAC 派生会话传输密钥 */
export declare function deriveSessionKey(privateKeyDerB64: string, peerPublicDerB64: string, salt: string): Buffer;
export declare function randomNick(): string;
