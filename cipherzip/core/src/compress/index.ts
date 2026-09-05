/**
 * 压缩 / 解压适配层（可插拔）
 * 支持 NONE / DEFLATE / GZIP / BROTLI；ZSTD 在原生模块可用时启用，否则回退 DEFLATE。
 */

import { brotliCompressSync, brotliDecompressSync, deflateSync, inflateSync, gzipSync, gunzipSync, constants } from 'node:zlib'
import { CompressAlgo } from '@cipherzip/shared'

export interface CompressOptions {
  level?: number // 0-9
}

export function compress(data: Buffer, algo: CompressAlgo, opts: CompressOptions = {}): Buffer {
  const level = opts.level ?? 6
  switch (algo) {
    case CompressAlgo.NONE:
      return Buffer.from(data)
    case CompressAlgo.DEFLATE:
      return deflateSync(data, { level })
    case CompressAlgo.GZIP:
      return gzipSync(data, { level })
    case CompressAlgo.BROTLI:
      return brotliCompressSync(data, {
        params: {
          [constants.BROTLI_PARAM_QUALITY]: Math.min(11, Math.max(0, level + 2)),
        },
      })
    case CompressAlgo.ZSTD:
      // 无原生 zstd 时优雅回退 deflate，保证可移植
      return deflateSync(data, { level })
    default:
      return deflateSync(data, { level })
  }
}

export function decompress(data: Buffer, algo: CompressAlgo): Buffer {
  switch (algo) {
    case CompressAlgo.NONE:
      return Buffer.from(data)
    case CompressAlgo.DEFLATE:
    case CompressAlgo.ZSTD: // 与 compress 回退对称
      return inflateSync(data)
    case CompressAlgo.GZIP:
      return gunzipSync(data)
    case CompressAlgo.BROTLI:
      return brotliDecompressSync(data)
    default:
      return inflateSync(data)
  }
}

export function compressAlgoLabel(algo: CompressAlgo): string {
  const map: Record<number, string> = {
    [CompressAlgo.NONE]: '无压缩',
    [CompressAlgo.DEFLATE]: 'Deflate',
    [CompressAlgo.GZIP]: 'GZIP',
    [CompressAlgo.BROTLI]: 'Brotli',
    [CompressAlgo.ZSTD]: 'Zstd/Deflate',
  }
  return map[algo] || '未知'
}
