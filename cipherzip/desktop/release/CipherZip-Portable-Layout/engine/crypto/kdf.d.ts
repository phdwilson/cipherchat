/**
 * 密钥派生（KDF）
 * - 密码：PBKDF2-SHA256（与 CipherChat 参数对齐，便于跨端互通）
 * - 密钥文件：读取任意文件的「指纹切片」+ 全文件哈希混合
 * - 混合模式：password ⊕ keyfile 双因子
 *
 * 密钥文件设计（天马行空但可落地）：
 * 用户可上传音乐/图片/任意文件作为密钥。我们不是简单 hash 全文件，
 * 而是：
 *  1. 取文件长度 L
 *  2. 在固定相对位置取样：offset = floor(L * φ) % max(1, L-4096)
 *     （φ = 黄金比例 0.618...，保证不同长度文件取样点分布稳定）
 *  3. 读取最多 64KiB 的「中段切片」
 *  4. 另取文件头 1KiB + 文件尾 1KiB
 *  5. SHA-256(head || mid || tail || lengthBE) 作为 keyfile 材料
 * 这样即使文件很大也只需读少量字节，且对内容局部改动敏感。
 */
import { type KeyMaterial } from '@cipherzip/shared';
export interface DerivedKeys {
    /** AES-256 内容加密密钥 */
    contentKey: Buffer;
    /** 文件名加密密钥（与内容密钥分离） */
    nameKey: Buffer;
    /** 可公开的认证哈希（不可逆推密钥，用于服务端登记） */
    authHash: string;
    /** 随机盐（需写入归档头） */
    salt: Buffer;
}
/**
 * 从任意文件提取稳定密钥材料（不需要读完整文件）。
 */
export declare function extractKeyfileMaterial(filePath: string): Promise<Buffer>;
/**
 * 主派生：产出 contentKey / nameKey / authHash
 * @param salt 若省略则随机生成（创建归档时）；打开归档时必须传入文件头中的盐
 */
export declare function deriveKeys(material: KeyMaterial, salt?: Buffer, iters?: number): Promise<DerivedKeys>;
/** 与 CipherChat 频道密钥互通：同一 channelId+password 可派生兼容密钥 */
export declare function deriveCipherChatCompatible(channelId: string, password: string): Promise<{
    aesKey: Buffer;
    authHash: string;
}>;
export declare function safeEqualHex(a: string, b: string): boolean;
export declare function sha256File(path: string): Promise<string>;
export declare function sha256Buf(data: Buffer | Uint8Array): string;
