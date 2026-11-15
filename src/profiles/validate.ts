import type { ChromeTlsProfile } from './types';

/** HTTP/2 规范里的已知 setting id（未列出的视为非法，防止手填漂移）。 */
const KNOWN_SETTING_IDS = new Set([1, 2, 3, 4, 5, 6, 8, 9]);
const BOOLEAN_SETTING_IDS = new Set([2, 8, 9]); // ENABLE_PUSH / ENABLE_CONNECT_PROTOCOL / NO_RFC7540_PRIORITIES
const COMPRESSION_ALGORITHMS = new Set(['brotli', 'zlib', 'zstd']);
const PSEUDO_ORDER = [':method', ':authority', ':scheme', ':path'];

function fail(message: string): never {
    throw new Error(`Invalid chrome profile: ${message}`);
}

function isObject(value: unknown): value is Record<string, any> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** settings 的线缆形态：每项 u16 id + u32 value。 */
export function encodeSettingsPayload(settings: Array<{ id: number; value: number }>): Buffer {
    const out = Buffer.alloc(settings.length * 6);
    settings.forEach((s, i) => {
        out.writeUInt16BE(s.id, i * 6);
        out.writeUInt32BE(s.value, i * 6 + 2);
    });
    return out;
}

/**
 * 校验并返回 profile。拒绝手填错误：ALPS/settings 不一致、重复 pseudo、CRLF 头、
 * 未知 setting id、缺失 http/1.1（H1 回退依赖它）等。
 */
export function validateProfile(json: unknown): ChromeTlsProfile {
    if (!isObject(json)) fail('profile must be an object');
    if (json.schemaVersion !== 1) fail(`unsupported schemaVersion: ${String(json.schemaVersion)}`);
    if (typeof json.id !== 'string' || json.id.length === 0) fail('id must be a non-empty string');
    if (json.browser !== 'chrome') fail(`unsupported browser: ${String(json.browser)}`);
    if (typeof json.version !== 'string' || json.version.length === 0) fail('version must be a non-empty string');
    if (!['macos', 'android', 'windows', 'linux'].includes(json.platform)) {
        fail(`unsupported platform: ${String(json.platform)}`);
    }

    const tls = json.tls;
    if (!isObject(tls)) fail('tls must be an object');
    if (!Array.isArray(tls.alpn) || tls.alpn.length === 0) fail('tls.alpn must be a non-empty array');
    if (!tls.alpn.every((p: unknown) => typeof p === 'string' && p.length > 0)) {
        fail('tls.alpn entries must be strings');
    }
    if (!tls.alpn.includes('http/1.1')) fail('tls.alpn must include http/1.1');
    for (const key of ['cipherList', 'curvesList', 'sigalgsList'] as const) {
        if (typeof tls[key] !== 'string' || tls[key].length === 0) fail(`tls.${key} must be non-empty`);
    }
    if (!Array.isArray(tls.certificateCompression)) fail('tls.certificateCompression must be an array');
    for (const alg of tls.certificateCompression) {
        if (!COMPRESSION_ALGORITHMS.has(alg)) fail(`unknown certificate compression algorithm: ${String(alg)}`);
    }
    for (const key of ['grease', 'permuteExtensions', 'echGrease', 'ocspStapling', 'signedCertTimestamps'] as const) {
        if (typeof tls[key] !== 'boolean') fail(`tls.${key} must be a boolean`);
    }
    if (!isObject(tls.alps) || tls.alps.protocol !== 'h2' || typeof tls.alps.settingsPayload !== 'string') {
        fail('tls.alps must be { protocol: "h2", settingsPayload: base64 }');
    }

    const http2 = json.http2;
    if (!isObject(http2)) fail('http2 must be an object');
    if (!Array.isArray(http2.settings) || http2.settings.length === 0) fail('http2.settings must be non-empty');
    for (const setting of http2.settings) {
        if (!isObject(setting) || !Number.isInteger(setting.id) || !Number.isInteger(setting.value)) {
            fail('http2.settings entries must be { id, value } integers');
        }
        if (!KNOWN_SETTING_IDS.has(setting.id)) fail(`unknown http2 setting id: ${setting.id}`);
        if (setting.value < 0 || setting.value > 0xffffffff) fail(`http2 setting ${setting.id} out of range`);
        if (BOOLEAN_SETTING_IDS.has(setting.id) && setting.value !== 0 && setting.value !== 1) {
            fail(`http2 setting ${setting.id} must be 0 or 1`);
        }
    }
    const ids = http2.settings.map((s: any) => s.id);
    if (new Set(ids).size !== ids.length) fail('http2.settings contains duplicate ids');

    if (!Array.isArray(http2.settingsOrder) || http2.settingsOrder.length !== ids.length) {
        fail('http2.settingsOrder must list every setting once');
    }
    if (new Set(http2.settingsOrder).size !== http2.settingsOrder.length) {
        fail('http2.settingsOrder contains duplicates');
    }
    for (const id of http2.settingsOrder) {
        if (!ids.includes(id)) fail(`http2.settingsOrder references missing setting ${id}`);
    }

    const alpsPayload = Buffer.from(tls.alps.settingsPayload, 'base64');
    const expected = encodeSettingsPayload(http2.settings);
    if (!alpsPayload.equals(expected)) {
        fail('tls.alps.settingsPayload must match http2.settings bytes');
    }

    if (!Array.isArray(http2.pseudoHeaderOrder)) fail('http2.pseudoHeaderOrder must be an array');
    if (
        http2.pseudoHeaderOrder.length !== PSEUDO_ORDER.length ||
        !PSEUDO_ORDER.every((name, i) => http2.pseudoHeaderOrder[i] === name)
    ) {
        fail(`http2.pseudoHeaderOrder must be exactly ${PSEUDO_ORDER.join(',')}`);
    }
    if (!Array.isArray(http2.headerOrder)) fail('http2.headerOrder must be an array');
    if (!Number.isInteger(http2.windowUpdate) || http2.windowUpdate < 0) {
        fail('http2.windowUpdate must be a non-negative integer');
    }

    if (!Array.isArray(json.headers)) fail('headers must be an array');
    for (const entry of json.headers) {
        if (!Array.isArray(entry) || entry.length !== 2) fail('headers entries must be [name, value]');
        const [name, value] = entry;
        if (typeof name !== 'string' || typeof value !== 'string') fail('header name/value must be strings');
        if (name.length === 0 || name !== name.toLowerCase()) fail(`header name must be lowercase: ${name}`);
        if (name.startsWith(':')) fail('headers must not contain pseudo-headers');
        if (/[\r\n]/.test(name) || /[\r\n]/.test(value)) fail(`header contains CRLF: ${name}`);
    }

    return json as ChromeTlsProfile;
}
