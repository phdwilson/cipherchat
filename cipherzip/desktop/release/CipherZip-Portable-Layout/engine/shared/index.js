/**
 * @cipherzip/shared
 * 跨模块共享类型、常量与协议定义。
 * CipherZip 桌面端 / CLI / CipherChat 桥接均依赖此包，保证协议一致。
 */
/** 自定义强制加密压缩格式魔数与版本 */
export const CCZ_MAGIC = new Uint8Array([0x43, 0x43, 0x5a, 0x31]); // "CCZ1"
export const CCZ_VERSION = 1;
export const CCZ_MIME = 'application/x-cipherzip';
export const CCZ_EXTENSION = '.ccz';
/** 与 CipherChat 对齐的 KDF 参数（可互操作派生） */
export const PBKDF2_AUTH_ITERS = 120_000;
export const PBKDF2_KEY_ITERS = 310_000;
export const ARGON2_TIME = 3;
export const ARGON2_MEM_KIB = 64 * 1024;
export const ARGON2_PARALLELISM = 4;
/** 分块大小：与 CipherChat 默认 4MiB 对齐，便于网盘互传 */
export const DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024;
/** 加密算法标识 */
export var CipherAlgo;
(function (CipherAlgo) {
    CipherAlgo[CipherAlgo["AES_256_GCM"] = 1] = "AES_256_GCM";
    CipherAlgo[CipherAlgo["CHACHA20_POLY1305"] = 2] = "CHACHA20_POLY1305";
})(CipherAlgo || (CipherAlgo = {}));
/** 压缩算法标识 */
export var CompressAlgo;
(function (CompressAlgo) {
    CompressAlgo[CompressAlgo["NONE"] = 0] = "NONE";
    CompressAlgo[CompressAlgo["DEFLATE"] = 1] = "DEFLATE";
    CompressAlgo[CompressAlgo["GZIP"] = 2] = "GZIP";
    CompressAlgo[CompressAlgo["BROTLI"] = 3] = "BROTLI";
    CompressAlgo[CompressAlgo["ZSTD"] = 4] = "ZSTD";
})(CompressAlgo || (CompressAlgo = {}));
/** 归档功能标志位 */
export var ArchiveFlags;
(function (ArchiveFlags) {
    ArchiveFlags[ArchiveFlags["NONE"] = 0] = "NONE";
    ArchiveFlags[ArchiveFlags["ENCRYPT_FILENAMES"] = 1] = "ENCRYPT_FILENAMES";
    ArchiveFlags[ArchiveFlags["KEYFILE_MODE"] = 2] = "KEYFILE_MODE";
    ArchiveFlags[ArchiveFlags["SOLID"] = 4] = "SOLID";
    ArchiveFlags[ArchiveFlags["SPLIT"] = 8] = "SPLIT";
    ArchiveFlags[ArchiveFlags["SELF_DESTRUCT"] = 16] = "SELF_DESTRUCT";
    ArchiveFlags[ArchiveFlags["MESH_SHARD"] = 32] = "MESH_SHARD";
    /** 强制端到端：.ccz 永远置位 */
    ArchiveFlags[ArchiveFlags["FORCE_E2E"] = 64] = "FORCE_E2E";
})(ArchiveFlags || (ArchiveFlags = {}));
/** CipherChat 客户端桥接 API 路径约定 */
export const CIPHERCHAT_CLIENT_API = {
    health: '/api/health',
    config: '/api/config',
    /** 新增：桌面客户端注册 / 能力宣告 */
    clientRegister: '/api/client/register',
    clientHeartbeat: '/api/client/heartbeat',
    /** 新增：压缩包元数据登记（仅密文指纹，无明文） */
    archiveAnnounce: '/api/client/archive/announce',
    archiveLookup: '/api/client/archive/lookup',
    /** 新增：P2P 信令中继（可选） */
    signalOffer: '/api/client/signal/offer',
    signalAnswer: '/api/client/signal/answer',
    signalPoll: '/api/client/signal/poll',
    /** 网盘 / 聊天复用 */
    driveSession: '/api/drive/session',
    driveFiles: '/api/drive/files',
    chatSession: '/api/chat/session',
};
export const WORDLIST_ZH_HINT = '分享码由易记英文单词编码 IP/端口/公钥摘要，本地生成，服务器不可见。';
export function formatBytes(n, digits = 1) {
    if (!Number.isFinite(n))
        return '-';
    if (n < 1024)
        return `${n} B`;
    if (n < 1024 ** 2)
        return `${(n / 1024).toFixed(digits)} KB`;
    if (n < 1024 ** 3)
        return `${(n / 1024 ** 2).toFixed(digits)} MB`;
    return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
