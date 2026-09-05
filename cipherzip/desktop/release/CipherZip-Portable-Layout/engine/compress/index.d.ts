/**
 * 压缩 / 解压适配层（可插拔）
 * 支持 NONE / DEFLATE / GZIP / BROTLI；ZSTD 在原生模块可用时启用，否则回退 DEFLATE。
 */
import { CompressAlgo } from '@cipherzip/shared';
export interface CompressOptions {
    level?: number;
}
export declare function compress(data: Buffer, algo: CompressAlgo, opts?: CompressOptions): Buffer;
export declare function decompress(data: Buffer, algo: CompressAlgo): Buffer;
export declare function compressAlgoLabel(algo: CompressAlgo): string;
