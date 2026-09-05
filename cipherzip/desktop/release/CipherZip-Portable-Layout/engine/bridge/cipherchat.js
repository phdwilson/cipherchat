/**
 * CipherChat 桥接客户端
 * 桌面端通过 HTTP 对接 CipherChat 网页后端（含新增 /api/client/*）。
 * 仅上传密文指纹 / 能力宣告，从不上传密码或明文。
 */
import { CIPHERCHAT_CLIENT_API, } from '@cipherzip/shared';
import { deriveCipherChatCompatible } from '../crypto/kdf.js';
export class CipherChatBridge {
    base;
    clientId;
    token = null;
    ua;
    constructor(cfg) {
        this.base = cfg.baseUrl.replace(/\/$/, '');
        this.clientId = cfg.clientId || `cz-${Date.now().toString(36)}`;
        this.ua = cfg.userAgent || 'CipherZip/1.0';
    }
    async req(path, init = {}) {
        const headers = new Headers(init.headers || {});
        headers.set('user-agent', this.ua);
        headers.set('x-cipherzip-client', this.clientId);
        if (this.token)
            headers.set('x-session-token', this.token);
        if (init.body && !headers.has('content-type')) {
            headers.set('content-type', 'application/json');
        }
        return fetch(`${this.base}${path}`, { ...init, headers });
    }
    async health() {
        try {
            const r = await this.req(CIPHERCHAT_CLIENT_API.health);
            const data = await r.json().catch(() => ({}));
            return { ok: r.ok, data };
        }
        catch (e) {
            return { ok: false, data: { error: e instanceof Error ? e.message : String(e) } };
        }
    }
    async getConfig() {
        const r = await this.req(CIPHERCHAT_CLIENT_API.config);
        if (!r.ok)
            throw new Error('获取 CipherChat 配置失败');
        return (await r.json());
    }
    /** 注册桌面客户端能力 */
    async register(caps) {
        const r = await this.req(CIPHERCHAT_CLIENT_API.clientRegister, {
            method: 'POST',
            body: JSON.stringify({ clientId: this.clientId, ...caps }),
        });
        const data = (await r.json().catch(() => ({})));
        if (!r.ok)
            throw new Error(data.error || '客户端注册失败');
        if (data.clientToken)
            this.token = data.clientToken;
        return { ok: true, clientToken: data.clientToken };
    }
    async heartbeat(extra = {}) {
        await this.req(CIPHERCHAT_CLIENT_API.clientHeartbeat, {
            method: 'POST',
            body: JSON.stringify({ clientId: this.clientId, ts: Date.now(), ...extra }),
        });
    }
    /** 宣告归档密文指纹（无明文） */
    async announceArchive(info) {
        const r = await this.req(CIPHERCHAT_CLIENT_API.archiveAnnounce, {
            method: 'POST',
            body: JSON.stringify({ clientId: this.clientId, ...info }),
        });
        if (!r.ok) {
            const j = (await r.json().catch(() => ({})));
            throw new Error(j.error || '归档宣告失败');
        }
    }
    async lookupArchive(authHash) {
        const r = await this.req(`${CIPHERCHAT_CLIENT_API.archiveLookup}?authHash=${encodeURIComponent(authHash)}`);
        if (!r.ok)
            throw new Error('查询失败');
        return r.json();
    }
    /** 加入聊天频道（复用 CipherChat 会话协议） */
    async joinChannel(channelId, password) {
        const keys = await deriveCipherChatCompatible(channelId, password);
        const r = await this.req(CIPHERCHAT_CLIENT_API.chatSession, {
            method: 'POST',
            body: JSON.stringify({
                channelId,
                authHash: keys.authHash,
                probeHash: '',
                pubId: this.clientId,
            }),
        });
        const data = (await r.json().catch(() => ({})));
        if (!r.ok)
            throw new Error(data.error || '加入频道失败');
        this.token = data.token || null;
        return { token: data.token || '', authHash: keys.authHash };
    }
    /** P2P 信令：发布 offer */
    async signalOffer(room, offer) {
        await this.req(CIPHERCHAT_CLIENT_API.signalOffer, {
            method: 'POST',
            body: JSON.stringify({ room, offer, clientId: this.clientId }),
        });
    }
    async signalAnswer(room, answer) {
        await this.req(CIPHERCHAT_CLIENT_API.signalAnswer, {
            method: 'POST',
            body: JSON.stringify({ room, answer, clientId: this.clientId }),
        });
    }
    async signalPoll(room) {
        const r = await this.req(`${CIPHERCHAT_CLIENT_API.signalPoll}?room=${encodeURIComponent(room)}&clientId=${encodeURIComponent(this.clientId)}`);
        return r.json();
    }
}
