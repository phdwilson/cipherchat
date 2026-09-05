/**
 * .ccz — Cipher Compressed Zip（强制端到端加密自定义格式）
 *
 * 文件布局（小端）：
 * ┌──────────────────────────────────────────────────────────┐
 * │ Magic "CCZ1" (4)                                         │
 * │ Version u16 (2)                                          │
 * │ Flags u32 (4)          必含 FORCE_E2E                    │
 * │ Cipher u8 / Compress u8 / reserved u16 (4)               │
 * │ ChunkSize u32 (4)                                        │
 * │ SaltLen u16 + Salt (var)                                 │
 * │ AuthHash 32B（密钥正确性快速校验，不可逆推）               │
 * │ HeaderEncLen u32 + HeaderEnc (AES-GCM 密封的 JSON meta)  │
 * │ TocEncLen u32 + TocEnc（密封的目录表）                    │
 * │ ChunkCount u32                                           │
 * │ 重复 ChunkCount 次： chunkLen u32 + chunkBytes           │
 * │ TrailerMagic "CCZE" (4) + archiveSha256 前 16B 校验      │
 * └──────────────────────────────────────────────────────────┘
 *
 * 只有 CipherZip 能正确打开：无密钥则 Header/TOC/内容全部不可读。
 */
import { CipherAlgo, CompressAlgo, type ArchiveMeta, type TocEntry, type KeyMaterial } from '@cipherzip/shared';
import { type DerivedKeys } from '../crypto/kdf.js';
export interface CreateCczOptions {
    inputs: string[];
    output: string;
    key: KeyMaterial;
    compress?: CompressAlgo;
    cipher?: CipherAlgo;
    level?: number;
    encryptFilenames?: boolean;
    chunkSize?: number;
    comment?: string;
    cipherchat?: ArchiveMeta['cipherchat'];
    onProgress?: (done: number, total: number, file?: string) => void;
    /** base 目录，用于计算相对路径 */
    baseDir?: string;
}
export interface OpenCczResult {
    meta: ArchiveMeta;
    entries: TocEntry[];
    keys: DerivedKeys;
    chunks: Buffer[];
}
/**
 * 创建 .ccz 归档（强制 E2E）
 */
export declare function createCcz(opts: CreateCczOptions): Promise<{
    output: string;
    authHash: string;
    entryCount: number;
}>;
/**
 * 打开并解析 .ccz（验证密钥）
 */
export declare function openCcz(filePath: string, key: KeyMaterial): Promise<OpenCczResult>;
export declare function openCczBuffer(data: Buffer, key: KeyMaterial): Promise<OpenCczResult>;
export interface ExtractOptions {
    archivePath: string;
    outputDir: string;
    key: KeyMaterial;
    /** 仅提取指定相对路径 */
    filter?: string[];
    onProgress?: (done: number, total: number, file?: string) => void;
}
/**
 * 解密解压提取到目录
 */
export declare function extractCcz(opts: ExtractOptions): Promise<{
    files: string[];
}>;
/** 仅列出内容（需密钥） */
export declare function listCcz(archivePath: string, key: KeyMaterial): Promise<{
    meta: ArchiveMeta;
    entries: TocEntry[];
}>;
