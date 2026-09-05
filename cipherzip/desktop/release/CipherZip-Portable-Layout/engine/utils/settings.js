/**
 * 全面设置模型（持久化 JSON）
 * 覆盖压缩、加密、P2P、Mesh、CipherChat 联动、外观、性能等。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { CompressAlgo, CipherAlgo, DEFAULT_CHUNK_SIZE } from '@cipherzip/shared';
export function defaultSettings() {
    const home = homedir();
    return {
        general: {
            language: 'zh-CN',
            theme: 'system',
            defaultFormat: 'ccz',
            defaultOutputDir: join(home, 'Documents', 'CipherZip'),
            checkUpdate: true,
            startWithSystem: false,
            minimizeToTray: true,
        },
        compression: {
            algorithm: CompressAlgo.BROTLI,
            level: 6,
            solid: false,
            followSymlinks: false,
            excludePatterns: ['.DS_Store', 'Thumbs.db', 'node_modules/**'],
            chunkSize: DEFAULT_CHUNK_SIZE,
        },
        encryption: {
            algorithm: CipherAlgo.AES_256_GCM,
            encryptFilenames: true,
            requirePassword: true,
            allowKeyfile: true,
            keyfileHint: '可使用任意文件（音乐/图片/文档）作为密钥，系统读取头/中/尾特征指纹。',
            wipeFreeSpace: false,
            autoLockMinutes: 15,
        },
        p2p: {
            enabled: true,
            listenPort: 0,
            publicHost: '127.0.0.1',
            nick: '',
            shareTtlHours: 24,
            downloadDir: join(home, 'Documents', 'CipherZip', 'inbox'),
            allowChat: true,
            allowFile: true,
        },
        mesh: {
            enabled: false,
            willing: false,
            maxStorageGb: 5,
            redundancy: 3,
            dataDir: join(home, '.cipherzip', 'mesh'),
        },
        cipherchat: {
            enabled: false,
            baseUrl: 'http://127.0.0.1:3000',
            autoRegister: true,
            announceArchives: true,
            channelId: '',
        },
        performance: {
            concurrency: 2,
            throttleBps: 0,
            useMemoryMap: true,
        },
        privacy: {
            clearHistoryOnExit: false,
            historyLimit: 100,
            telemetry: false,
        },
    };
}
export function settingsPath(custom) {
    return custom || join(homedir(), '.cipherzip', 'settings.json');
}
export async function loadSettings(path) {
    const p = settingsPath(path);
    try {
        const raw = await readFile(p, 'utf8');
        return { ...defaultSettings(), ...JSON.parse(raw) };
    }
    catch {
        return defaultSettings();
    }
}
export async function saveSettings(s, path) {
    const p = settingsPath(path);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, JSON.stringify(s, null, 2), 'utf8');
}
