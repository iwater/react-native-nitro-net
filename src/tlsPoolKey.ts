import type { PemInput } from './pem';
import type { ProxyTlsOptions } from './proxy';

/**
 * `https.Agent` 池键里的 TLS 材料部分。
 *
 * 背景：Node 的 `https.Agent` **覆写**了 `http.Agent.getName`，把 `ca` / `cert` /
 * `key` / `pfx` / `rejectUnauthorized` / `servername` 等一并拼进池键（v22.11 实测）。
 * 本包此前没有覆写，于是「同一 host、先按 CA A 建连、再用 CA B 请求」会命中旧连接，
 * 第二份信任配置被静默忽略。
 *
 * 这里只覆盖本包支持的字段。格式用**带标签**的段（`:ca:…:cert:…`），不必与 Node 的
 * 无标签拼接逐字相同 —— 池键是内部标识，关键是「材料不同 ⇒ 键不同」。
 *
 * ⚠️ 缓存按 **options 对象身份**：`getName` 每个请求会被调用 3–4 次，而 PEM 可能很大。
 * 调用方不应在同一个 options 对象上改动这些字段（现有调用链也不会）。
 */

export interface PoolKeyOptions {
    host?: string;
    hostname?: string;
    ca?: PemInput | PemInput[];
    cert?: PemInput | PemInput[];
    key?: PemInput | PemInput[];
    pfx?: PemInput;
    passphrase?: string;
    rejectUnauthorized?: boolean;
    servername?: string;
    proxyTls?: ProxyTlsOptions;
    /** impersonate：不同模式/不同 profile 不能共用连接 */
    impersonate?: boolean | 'chrome';
    profile?: string;
    forceHttp1?: boolean;
    alpnProtocols?: string[];
}

const cache = new WeakMap<object, string>();

// 与 `pem.ts` 的 normalizePem 同义，但**不 import 它**：本模块要能在纯 node
// （--experimental-strip-types）里单测，而本仓源码用的是无扩展名 import。
// 逻辑只有 5 行，重复的成本低于为测试引入一层构建。
function toPemText(value: PemInput, label: string): string {
    if (typeof value === 'string') return value;
    if (value instanceof ArrayBuffer) {
        return Buffer.from(value).toString('utf8');
    }
    if (ArrayBuffer.isView(value)) {
        return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('utf8');
    }
    throw new TypeError(`${label} must be a string, Buffer, TypedArray, or ArrayBuffer`);
}

function material(value: PemInput | PemInput[] | undefined, label: string): string {
    if (value === undefined || value === null) return '';
    const list = Array.isArray(value) ? value : [value];
    return list.map((item) => toPemText(item, label)).join('\u0000');
}

function appendMaterial(out: string, name: string, value: PemInput | PemInput[] | undefined): string {
    const text = material(value, name);
    return text ? `${out}:${name}:${text}` : out;
}

export function tlsPoolKeySuffix(options: PoolKeyOptions): string {
    if (!options || typeof options !== 'object') return '';
    const hit = cache.get(options as object);
    if (hit !== undefined) return hit;

    let out = '';
    out = appendMaterial(out, 'ca', options.ca);
    out = appendMaterial(out, 'cert', options.cert);
    out = appendMaterial(out, 'key', options.key);
    out = appendMaterial(out, 'pfx', options.pfx);
    // passphrase **不**进池键：Node 的 getName 也不含它（只含 pfx 原文），
    // 而不该把口令暴露在 `agent.sockets` 的键字符串里。同一个 pfx 配不同口令
    // 这种极端组合会共用池键 —— 与 Node 行为一致。
    // Node 只在**显式给出**时拼 rejectUnauthorized（undefined 与 true 是两种键）
    if (options.rejectUnauthorized !== undefined) {
        out += `:rejectUnauthorized:${options.rejectUnauthorized}`;
    }
    // Node 只在 servername 与 host 不同时拼
    const host = options.host || options.hostname || 'localhost';
    if (options.servername && options.servername !== host) {
        out += `:servername:${options.servername}`;
    }

    if (options.impersonate) {
        const profile = options.profile || 'chrome';
        const http1Only =
            options.forceHttp1 === true ||
            (Array.isArray(options.alpnProtocols) && !options.alpnProtocols.includes('h2'));
        out += `:impersonate:${profile}:alpn:${http1Only ? 'http/1.1' : 'h2,http/1.1'}`;
    }

    if (options.proxyTls) {
        const proxyTls = options.proxyTls;
        let p = ':proxyTls:';
        p = appendMaterial(p, 'ca', proxyTls.ca);
        p = appendMaterial(p, 'cert', proxyTls.cert);
        p = appendMaterial(p, 'key', proxyTls.key);
        if (proxyTls.rejectUnauthorized !== undefined) {
            p += `:rejectUnauthorized:${proxyTls.rejectUnauthorized}`;
        }
        if (proxyTls.servername) p += `:servername:${proxyTls.servername}`;
        out += p;
    }

    cache.set(options as object, out);
    return out;
}
