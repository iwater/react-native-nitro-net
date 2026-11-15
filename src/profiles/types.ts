/**
 * Chrome profile 的静态数据结构。
 *
 * 设计原则（docs/chrome_fingerprint_impersonation_design.md §6）：
 * - profile 是**数据**，不是代码；所有值必须来自真实抓包（`spikes/m0b/reference/`）。
 * - TLS 字段供 native 的 btls 映射；http2 字段供 M2 的 H2 引擎；headers 供 H1/H2 的请求头层。
 */

export interface ChromeTlsSettings {
    alpn: string[];
    /**
     * ⚠️ TLS 层只把协议名 "h2" 放进 ClientHello 的 0x44cd 扩展；
     * settingsPayload 是 **H2 数据面**的 SETTINGS payload（M2 使用），
     * 必须与 http2.settings 的 6 字节序列一致（校验会强制）。
     */
    alps: { protocol: 'h2'; settingsPayload: string };
    /** BoringSSL `set_cipher_list` 的字符串；只含 TLS1.2 及以下（TLS1.3 由 BoringSSL 固定） */
    cipherList: string;
    curvesList: string;
    sigalgsList: string;
    /** 预留：M1 的 key share 由 curves 决定 */
    keyShares?: string;
    certificateCompression: string[];
    grease: boolean;
    permuteExtensions: boolean;
    echGrease: boolean;
    ocspStapling: boolean;
    signedCertTimestamps: boolean;
}

export interface ChromeHttp2Settings {
    settings: Array<{ id: number; value: number }>;
    settingsOrder: number[];
    windowUpdate: number;
    pseudoHeaderOrder: string[];
    headerOrder: string[];
    priorityFrames: unknown[];
}

export interface ChromeTlsProfile {
    schemaVersion: 1;
    id: string;
    browser: 'chrome';
    version: string;
    platform: 'macos' | 'android' | 'windows' | 'linux';
    tls: ChromeTlsSettings;
    http2: ChromeHttp2Settings;
    headers: Array<[string, string]>;
}
