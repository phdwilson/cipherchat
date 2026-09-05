/**
 * 传统格式支持层
 * - 创建：zip / tar / tar.gz / tar.br（可选加密包装）
 * - 读取：zip（yauzl）、tar/gz（内置）
 * - 7z/rar/xz：若系统存在 7z 命令则 shell 调用，否则给出明确错误
 *
 * 设计原则：传统格式「可」加密（AES zip），但只有 .ccz 强制 E2E。
 */
import { type KeyMaterial } from '@cipherzip/shared';
export type LegacyFormat = 'zip' | 'tar' | 'tar.gz' | 'tgz' | 'tar.br' | 'gz' | 'ccz' | '7z' | 'rar' | 'xz';
export declare function detectFormat(pathOrName: string): LegacyFormat;
export interface PackOptions {
    inputs: string[];
    output: string;
    format?: LegacyFormat;
    password?: string;
    key?: KeyMaterial;
    level?: number;
    encryptFilenames?: boolean;
    keyfilePath?: string;
    onProgress?: (done: number, total: number, file?: string) => void;
}
/**
 * 统一打包入口：按扩展名/format 分发
 */
export declare function packArchive(opts: PackOptions): Promise<string>;
export interface UnpackOptions {
    archive: string;
    outputDir: string;
    password?: string;
    key?: KeyMaterial;
    keyfilePath?: string;
    onProgress?: (done: number, total: number, file?: string) => void;
}
export declare function unpackArchive(opts: UnpackOptions): Promise<string[]>;
export declare const SUPPORTED_CREATE: readonly [".ccz", ".zip", ".tar", ".tar.gz", ".tgz", ".tar.br", ".gz", ".7z"];
export declare const SUPPORTED_OPEN: readonly [".ccz", ".zip", ".tar", ".tar.gz", ".tgz", ".tar.br", ".gz", ".7z", ".rar", ".xz", ".bz2", ".iso"];
