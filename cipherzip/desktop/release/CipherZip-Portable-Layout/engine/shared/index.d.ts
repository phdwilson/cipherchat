/**
 * @cipherzip/shared
 * 跨模块共享类型、常量与协议定义。
 * CipherZip 桌面端 / CLI / CipherChat 桥接均依赖此包，保证协议一致。
 */
/** 自定义强制加密压缩格式魔数与版本 */
export declare const CCZ_MAGIC: Uint8Array<ArrayBuffer>;
export declare const CCZ_VERSION = 1;
export declare const CCZ_MIME = "application/x-cipherzip";
export declare const CCZ_EXTENSION = ".ccz";
/** 与 CipherChat 对齐的 KDF 参数（可互操作派生） */
export declare const PBKDF2_AUTH_ITERS = 120000;
export declare const PBKDF2_KEY_ITERS = 310000;
export declare const ARGON2_TIME = 3;
export declare const ARGON2_MEM_KIB: number;
export declare const ARGON2_PARALLELISM = 4;
/** 分块大小：与 CipherChat 默认 4MiB 对齐，便于网盘互传 */
export declare const DEFAULT_CHUNK_SIZE: number;
/** 加密算法标识 */
export declare enum CipherAlgo {
    AES_256_GCM = 1,
    CHACHA20_POLY1305 = 2
}
/** 压缩算法标识 */
export declare enum CompressAlgo {
    NONE = 0,
    DEFLATE = 1,
    GZIP = 2,
    BROTLI = 3,
    ZSTD = 4
}
/** 归档功能标志位 */
export declare enum ArchiveFlags {
    NONE = 0,
    ENCRYPT_FILENAMES = 1,
    KEYFILE_MODE = 2,
    SOLID = 4,
    SPLIT = 8,
    SELF_DESTRUCT = 16,
    MESH_SHARD = 32,
    /** 强制端到端：.ccz 永远置位 */
    FORCE_E2E = 64
}
/** 密钥材料来源 */
export type KeyMaterial = {
    type: 'password';
    password: string;
} | {
    type: 'keyfile';
    path: string;
    password?: string;
} | {
    type: 'hybrid';
    password: string;
    keyfilePath: string;
} | {
    type: 'raw';
    key: Uint8Array;
};
/** 目录条目（TOC） */
export interface TocEntry {
    /** 相对路径（可能已加密混淆） */
    path: string;
    /** 原始文件名（仅内存态，落盘时加密） */
    name: string;
    size: number;
    compressedSize: number;
    mtime: number;
    mode: number;
    isDir: boolean;
    /** 内容分块索引 */
    chunkIndexes: number[];
    sha256: string;
    mime?: string;
}
export interface ArchiveMeta {
    version: number;
    flags: number;
    cipher: CipherAlgo;
    compress: CompressAlgo;
    chunkSize: number;
    createdAt: number;
    comment?: string;
    /** 创建者设备公开指纹（可选，用于 P2P 溯源） */
    creatorFingerprint?: string;
    /** CipherChat 联动：可选频道/网盘绑定 */
    cipherchat?: {
        baseUrl?: string;
        channelId?: string;
        driveId?: string;
    };
}
export interface SharePayload {
    /** 协议版本 */
    v: 1;
    /** 对端可达地址 */
    host: string;
    port: number;
    /** 会话公钥（base64） */
    pub: string;
    /** 能力位：chat / file / mesh */
    caps: string[];
    /** 过期时间 unix ms */
    exp: number;
    /** 昵称 */
    nick?: string;
}
export interface MeshNodeInfo {
    nodeId: string;
    address: string;
    port: number;
    storageFree: number;
    willing: boolean;
    lastSeen: number;
}
/** CipherChat 客户端桥接 API 路径约定 */
export declare const CIPHERCHAT_CLIENT_API: {
    readonly health: "/api/health";
    readonly config: "/api/config";
    /** 新增：桌面客户端注册 / 能力宣告 */
    readonly clientRegister: "/api/client/register";
    readonly clientHeartbeat: "/api/client/heartbeat";
    /** 新增：压缩包元数据登记（仅密文指纹，无明文） */
    readonly archiveAnnounce: "/api/client/archive/announce";
    readonly archiveLookup: "/api/client/archive/lookup";
    /** 新增：P2P 信令中继（可选） */
    readonly signalOffer: "/api/client/signal/offer";
    readonly signalAnswer: "/api/client/signal/answer";
    readonly signalPoll: "/api/client/signal/poll";
    /** 网盘 / 聊天复用 */
    readonly driveSession: "/api/drive/session";
    readonly driveFiles: "/api/drive/files";
    readonly chatSession: "/api/chat/session";
};
export declare const WORDLIST_ZH_HINT = "\u5206\u4EAB\u7801\u7531\u6613\u8BB0\u82F1\u6587\u5355\u8BCD\u7F16\u7801 IP/\u7AEF\u53E3/\u516C\u94A5\u6458\u8981\uFF0C\u672C\u5730\u751F\u6210\uFF0C\u670D\u52A1\u5668\u4E0D\u53EF\u89C1\u3002";
export declare function formatBytes(n: number, digits?: number): string;
