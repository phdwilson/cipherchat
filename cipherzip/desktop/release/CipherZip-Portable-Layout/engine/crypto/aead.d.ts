/**
 * AEAD 加解密封装
 * 默认 AES-256-GCM；可选 ChaCha20-Poly1305
 * 密文线格式：12B nonce || ciphertext || 16B tag（Node 的 createCipheriv 已附加 tag）
 */
import { CipherAlgo } from '@cipherzip/shared';
/**
 * 加密一块明文。
 * @param aad 附加认证数据（绑定 fileId/index，防调换）
 */
export declare function seal(key: Buffer, plain: Buffer | Uint8Array, aad?: Buffer | Uint8Array, algo?: CipherAlgo): Buffer;
export declare function open(key: Buffer, wire: Buffer | Uint8Array, aad?: Buffer | Uint8Array, algo?: CipherAlgo): Buffer;
/** 文件名专用：确定性不足（仍用随机 nonce），输出 base64url */
export declare function sealName(nameKey: Buffer, name: string): string;
export declare function openName(nameKey: Buffer, sealed: string): string;
export declare function aadChunk(entryId: string, index: number): Buffer;
