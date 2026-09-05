/**
 * 全面设置模型（持久化 JSON）
 * 覆盖压缩、加密、P2P、Mesh、CipherChat 联动、外观、性能等。
 */
import { CompressAlgo, CipherAlgo } from '@cipherzip/shared';
export interface CipherZipSettings {
    general: {
        language: 'zh-CN' | 'en-US';
        theme: 'light' | 'dark' | 'system';
        defaultFormat: 'ccz' | 'zip' | 'tar.gz' | '7z';
        defaultOutputDir: string;
        checkUpdate: boolean;
        startWithSystem: boolean;
        minimizeToTray: boolean;
    };
    compression: {
        algorithm: CompressAlgo;
        level: number;
        solid: boolean;
        followSymlinks: boolean;
        excludePatterns: string[];
        chunkSize: number;
    };
    encryption: {
        algorithm: CipherAlgo;
        encryptFilenames: boolean;
        /** 默认要求密码 */
        requirePassword: boolean;
        /** 允许密钥文件 */
        allowKeyfile: boolean;
        /** 密钥文件取样说明已在 KDF 实现 */
        keyfileHint: string;
        wipeFreeSpace: boolean;
        autoLockMinutes: number;
    };
    p2p: {
        enabled: boolean;
        listenPort: number;
        publicHost: string;
        nick: string;
        shareTtlHours: number;
        downloadDir: string;
        allowChat: boolean;
        allowFile: boolean;
    };
    mesh: {
        enabled: boolean;
        willing: boolean;
        maxStorageGb: number;
        redundancy: number;
        dataDir: string;
    };
    cipherchat: {
        enabled: boolean;
        baseUrl: string;
        autoRegister: boolean;
        announceArchives: boolean;
        channelId: string;
    };
    performance: {
        concurrency: number;
        throttleBps: number;
        useMemoryMap: boolean;
    };
    privacy: {
        clearHistoryOnExit: boolean;
        historyLimit: number;
        telemetry: boolean;
    };
}
export declare function defaultSettings(): CipherZipSettings;
export declare function settingsPath(custom?: string): string;
export declare function loadSettings(path?: string): Promise<CipherZipSettings>;
export declare function saveSettings(s: CipherZipSettings, path?: string): Promise<void>;
