import type { ChromeTlsProfile } from './types';

/**
 * 内置 `chrome` profile（桌面参考，值为 2026-10-21 实测抓包）。
 *
 * 来源：`rust_c_net/spikes/m0b/reference/chrome_accepted.json`
 * （curl_cffi 0.16.3 `chrome150`，对目标墙返回 200）。所有值都必须能在抓包里找到，
 * 不允许手填猜测。
 */
const SETTINGS = [
    { id: 1, value: 65536 }, // HEADER_TABLE_SIZE
    { id: 2, value: 0 }, // ENABLE_PUSH
    { id: 4, value: 6291456 }, // INITIAL_WINDOW_SIZE
    { id: 6, value: 262144 }, // MAX_HEADER_LIST_SIZE
];

/** 上表的线缆形态（4 × 6 字节）；validateProfile 会强制它与 settings 一致。 */
const ALPS_SETTINGS_B64 = 'AAEAAQAAAAIAAAAAAAQAYAAAAAYABAAA';

/**
 * 12 个**可设置**的 TLS1.2 cipher（BoringSSL 名称，顺序即指纹）。
 * TLS1.3 的 1301/1302/1303 由 BoringSSL 固定，不进 set_cipher_list。
 */
const CIPHER_LIST = [
    'ECDHE-ECDSA-AES128-GCM-SHA256',
    'ECDHE-RSA-AES128-GCM-SHA256',
    'ECDHE-ECDSA-AES256-GCM-SHA384',
    'ECDHE-RSA-AES256-GCM-SHA384',
    'ECDHE-ECDSA-CHACHA20-POLY1305',
    'ECDHE-RSA-CHACHA20-POLY1305',
    'ECDHE-RSA-AES128-SHA',
    'ECDHE-RSA-AES256-SHA',
    'AES128-GCM-SHA256',
    'AES256-GCM-SHA384',
    'AES128-SHA',
    'AES256-SHA',
].join(':');

const SIGALGS_LIST = [
    'mldsa44',
    'mldsa65',
    'mldsa87',
    'ecdsa_secp256r1_sha256',
    'rsa_pss_rsae_sha256',
    'rsa_pkcs1_sha256',
    'ecdsa_secp384r1_sha384',
    'rsa_pss_rsae_sha384',
    'rsa_pkcs1_sha384',
    'rsa_pss_rsae_sha512',
    'rsa_pkcs1_sha512',
].join(':');

const HEADER_ORDER = [
    'sec-ch-ua',
    'sec-ch-ua-mobile',
    'sec-ch-ua-platform',
    'upgrade-insecure-requests',
    'user-agent',
    'accept',
    'sec-fetch-site',
    'sec-fetch-mode',
    'sec-fetch-user',
    'sec-fetch-dest',
    'accept-encoding',
    'accept-language',
    'priority',
];

const HEADERS: Array<[string, string]> = [
    ['sec-ch-ua', '"Not;A=Brand";v="8", "Chromium";v="150", "Google Chrome";v="150"'],
    ['sec-ch-ua-mobile', '?0'],
    ['sec-ch-ua-platform', '"macOS"'],
    ['upgrade-insecure-requests', '1'],
    [
        'user-agent',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
    ],
    [
        'accept',
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    ],
    ['sec-fetch-site', 'none'],
    ['sec-fetch-mode', 'navigate'],
    ['sec-fetch-user', '?1'],
    ['sec-fetch-dest', 'document'],
    ['accept-encoding', 'gzip, deflate, br, zstd'],
    ['accept-language', 'en-US,en;q=0.9'],
    ['priority', 'u=0, i'],
];

export const CHROME_DESKTOP: ChromeTlsProfile = {
    schemaVersion: 1,
    id: 'chrome',
    browser: 'chrome',
    version: '150',
    platform: 'macos',
    tls: {
        alpn: ['h2', 'http/1.1'],
        alps: { protocol: 'h2', settingsPayload: ALPS_SETTINGS_B64 },
        cipherList: CIPHER_LIST,
        curvesList: 'X25519MLKEM768:X25519:P-256:P-384',
        sigalgsList: SIGALGS_LIST,
        certificateCompression: ['brotli'],
        grease: true,
        permuteExtensions: true,
        echGrease: true,
        ocspStapling: true,
        signedCertTimestamps: true,
    },
    http2: {
        settings: SETTINGS,
        settingsOrder: [1, 2, 4, 6],
        windowUpdate: 15663105,
        pseudoHeaderOrder: [':method', ':authority', ':scheme', ':path'],
        headerOrder: HEADER_ORDER,
        priorityFrames: [],
    },
    headers: HEADERS,
};

/** 内置 profile 表；`defineProfile` 注册的会追加到这里（M1 Task 2 使用）。 */
export const BUILTIN_PROFILES: Record<string, ChromeTlsProfile> = {
    chrome: CHROME_DESKTOP,
};
