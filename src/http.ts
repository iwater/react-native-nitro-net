// 说明符用 core 名 `stream`，理由同 `net.ts` 顶部那条（宿主内建表 / RN 的 npm 别名指向同一份
// readable-stream@4；改回裸 `readable-stream` 会在 RN 上重新分裂，见 #51）。
import { Writable, Readable } from 'stream'
// EventEmitter 基类在运行期选定：宿主有 `events` 用它，没有才回退 `eventemitter3`。
// 必须是 CJS 垫片（不能用 ESM import），理由见 eventEmitterCompat.js 顶部注释。
import { EventEmitter } from './eventEmitterCompat'
import { Buffer } from 'react-native-nitro-buffer'

import { Driver } from './Driver'
import { Socket, Server as NetServer, isIPv6 } from './net'
import { TLSSocket, serializeProfileTlsOptions, serializeProfileProxy } from './tls'
import { debugLog as loggerDebugLog } from './Logger'
import { GlobalAgentRegistry } from './agentResolver'
import { applyAgentConnectOverrides, HTTP_CONNECT_FIELDS } from './agentConnectOptions'
import { normalizeSocketPort } from './socketPort'
import { nextTick } from './nextTick'
import { parseProxy, type ParsedProxy, type ProxyTlsOptions } from './proxy'
import { armAgentSocketTimeout, validateAgentTimeout } from './agentTimeout'
import { renderHeaderLines, type ProfileHeaderPolicy } from './httpHeaderSerializer'
import {
    buildImpersonationConnectOptions,
    type ImpersonationConnectOptions,
} from './impersonation'
import {
    getImpersonationConfig,
    isHttp2Available,
    isImpersonationAvailable,
    lookupProfile,
} from './profiles/registry'
import { Http2Session, Http2SessionSocket, type Http2ResponseHeaders } from './http2Session'
import type { NetSocketDriver } from './Net.nitro'
import { buildH2RequestJson } from './http2Headers'
import { canUseHttp2, canRetryH2Request } from './h2Eligibility'
// 全局 `URL` 的存在性守卫抽到 urlCompat.ts：http 与 https **两处**都要用
// （只修 http 一侧时 `https.request({...})` 会以 `URL is not defined` 失败，实测过）。
import { isURLLike, requireGlobalURL, urlBasicAuth } from './urlCompat'

function debugLog(message: string | (() => string)) {
    loggerDebugLog('HTTP', message)
}

// ========== STATUS_CODES ==========

// ⚠️ 这张表必须与 Node 的 `http.STATUS_CODES` **逐项一致**：它决定响应状态行里的
// reason phrase（`HTTP/1.1 418 <phrase>`），也经由 `res.statusMessage` 暴露给用户。
// 缺项/大小写不一致会让状态行与 Node 不同 —— 例如 `res.sendStatus(418)`：
// 状态码与 body 都对，只有状态行是 `418 I'm a teapot`（Node 是 `I'm a Teapot`）。
// 核对方法：`node -e "console.log(require('http').STATUS_CODES)"` 与本地表 diff
// （parity 用例 `http_status_codes` 锁住）。
export const STATUS_CODES: Record<number, string> = {
    100: 'Continue',
    101: 'Switching Protocols',
    102: 'Processing',
    103: 'Early Hints',
    200: 'OK',
    201: 'Created',
    202: 'Accepted',
    203: 'Non-Authoritative Information',
    204: 'No Content',
    205: 'Reset Content',
    206: 'Partial Content',
    207: 'Multi-Status',
    208: 'Already Reported',
    226: 'IM Used',
    300: 'Multiple Choices',
    301: 'Moved Permanently',
    302: 'Found',
    303: 'See Other',
    304: 'Not Modified',
    305: 'Use Proxy',
    307: 'Temporary Redirect',
    308: 'Permanent Redirect',
    400: 'Bad Request',
    401: 'Unauthorized',
    402: 'Payment Required',
    403: 'Forbidden',
    404: 'Not Found',
    405: 'Method Not Allowed',
    406: 'Not Acceptable',
    407: 'Proxy Authentication Required',
    408: 'Request Timeout',
    409: 'Conflict',
    410: 'Gone',
    411: 'Length Required',
    412: 'Precondition Failed',
    413: 'Payload Too Large',
    414: 'URI Too Long',
    415: 'Unsupported Media Type',
    416: 'Range Not Satisfiable',
    417: 'Expectation Failed',
    418: "I'm a Teapot",
    421: 'Misdirected Request',
    422: 'Unprocessable Entity',
    423: 'Locked',
    424: 'Failed Dependency',
    425: 'Too Early',
    426: 'Upgrade Required',
    428: 'Precondition Required',
    429: 'Too Many Requests',
    431: 'Request Header Fields Too Large',
    451: 'Unavailable For Legal Reasons',
    500: 'Internal Server Error',
    501: 'Not Implemented',
    502: 'Bad Gateway',
    503: 'Service Unavailable',
    504: 'Gateway Timeout',
    505: 'HTTP Version Not Supported',
    506: 'Variant Also Negotiates',
    507: 'Insufficient Storage',
    508: 'Loop Detected',
    509: 'Bandwidth Limit Exceeded',
    510: 'Not Extended',
    511: 'Network Authentication Required',
};

export const METHODS = [
    'ACL', 'BIND', 'CHECKOUT', 'CONNECT', 'COPY', 'DELETE', 'GET', 'HEAD',
    'LINK', 'LOCK', 'M-SEARCH', 'MERGE', 'MKACTIVITY', 'MKCALENDAR', 'MKCOL',
    'MOVE', 'NOTIFY', 'OPTIONS', 'PATCH', 'POST', 'PROPFIND', 'PROPPATCH',
    'PURGE', 'PUT', 'REBIND', 'REPORT', 'SEARCH', 'SOURCE', 'SUBSCRIBE',
    'TRACE', 'UNBIND', 'UNLINK', 'UNLOCK', 'UNSUBSCRIBE'
];

/**
 * node 的 `http.maxHeaderSize`。
 *
 * node v22.22.2 实测为 `16384`，且它是**进程级**的值（可被 `--max-http-header-size`
 * 覆盖）。本包不模拟那个开关，导出默认值即可 —— 与 `Server.maxHeaderSize` 的默认
 * 保持一致，两者不会互相打架。
 */
export const maxHeaderSize: number = 16384;

// ========== 服务端 socket 错误 → `clientError`（对齐 node） ==========
//
// ⚠️ 对齐 node `lib/_http_server.js` 的 `socketOnError`（**逐字对照 v22.22.2**）：
//    服务端 socket 的错误走 **`clientError`**，**从不**走 `server.emit('error')`。
//
//    本包此前是 `if (req) req.emit('error', err); else this.emit('error', err)`
//    ⇒ Server 没有 `'error'` 监听器时 EventEmitter **直接抛出** ⇒ 冒成未捕获异常。
//    实测（同一份 `soak_server.js` + `wrk -t2 -c10 -d10s`）：
//      node      stderr **0 字节**，8 条 `clientError`（code=ECONNRESET）
//      无头宿主  stderr **2666 字节**，两类未捕获异常
//                （`Connection reset by peer` 与自造的 `Socket destroyed`）
//    给 Server 挂上 `server.on('error')` 后无头宿主侧 stderr 归 0、收到 8 条
//    ⇒ 两个异常**都**从 `server.emit('error')` 这一个漏斗冒出。
//
// node 的默认块（`emit` 返回 false，即**没有** clientError 监听器时）写的就是这个报文。
const CLIENT_ERROR_BAD_REQUEST = Buffer.from(
    `HTTP/1.1 400 ${STATUS_CODES[400]}\r\nConnection: close\r\n\r\n`, 'ascii')

// node 的默认块**按错误码选报文**：`HPE_HEADER_OVERFLOW` 回 431，其余回 400。
// 实测（node v22.12.0，同一份 raw socket 探针）：head 超过 `maxHeaderSize` 时
// 线上就是这 67 字节，且 `clientError` 的 `err.code` 是 `HPE_HEADER_OVERFLOW`。
const CLIENT_ERROR_HEADER_TOO_LARGE = Buffer.from(
    `HTTP/1.1 431 ${STATUS_CODES[431]}\r\nConnection: close\r\n\r\n`, 'ascii')

/** node `socketOnError` 用它吞掉销毁后残余的 `'error'`（"Ignore further errors"）。 */
const noop = () => {}

// ========== 解析器错误串 → Error（带 node 的 `err.code`） ==========
//
// Rust 侧把解析失败以 `ERROR:<文本>` 透出（C++ 只做转发，见 HybridHttpParser.hpp）。
// 对齐 node 时**只有 `err.message` 不够**：`socketOnError` 的默认块按 `err.code` 选报文
// （`HPE_HEADER_OVERFLOW` ⇒ 431），用户也会按码分支。
//
// 约定：`ERROR:` 之后形如 **`<HPE 码>: <node 的 message 原文>`** 的才当带码错误。
// 码与 message 都在 Rust 侧定（`http_parser.rs::node_parse_error`）——
// message 文本要与 node 逐字比对，放在离判据最近的地方。
// 其余（`ERROR: Parser not found` 这类 C++ 侧文本）原样透传，不制造新差异。
const HPE_CODE_RE = /^(HPE_[A-Z0-9_]+):[ ]?([\s\S]*)$/

/**
 * 把 `ERROR:` 前缀的 metadata 还原成 Error。
 *
 * 认得出码就给出 `err.code` + node 的 `message`；认不出就保持本包既有行为
 * （`message` 就是整条 metadata），不制造新的差异。
 */
function parserError(metadata: string): Error {
    const payload = metadata.slice('ERROR:'.length).trim()
    const m = HPE_CODE_RE.exec(payload)
    if (m) {
        const err = new Error(m[2] || m[1])
        ;(err as any).code = m[1]
        return err
    }
    return new Error(metadata)
}

// ========== 注入校验（TS-M14） ==========
//
// 报文是**拼字符串**拼出来的（请求行/状态行 + 每行 `name: value`），因此任何含 CRLF
// 的名字或取值都能凭空插入新的一行 —— 最典型的是
// `res.setHeader('x', 'a\r\nSet-Cookie: evil=1')`，名字里塞 `\r\n` 更可以直接伪造
// 后续整段报文（响应拆分 / 请求走私）。取值里混进裸 CR/LF 同样致命。
//
// 三个正则与错误码都对齐 Node：
// - 名字必须是 RFC 9110 的 `token`（`ERR_INVALID_HTTP_TOKEN`）；
// - 取值只允许 `\t` 与可见字符，含 0x80-0xff（`ERR_INVALID_CHAR`）；
// - 请求行里的 path 只允许 `\u0021-\u00ff`，即空格与控制字符非法（`ERR_UNESCAPED_CHARACTERS`）。

/** RFC 9110 `token`。 */
const HTTP_TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/** 对齐 Node `checkInvalidHeaderChar`：除 `\t` 与可见字符外都非法（含 `\r`/`\n`）。 */
const INVALID_HEADER_VALUE_RE = /[^\t\x20-\x7e\x80-\xff]/;
/** 对齐 Node `checkInvalidPathChars`。 */
const INVALID_PATH_CHAR_RE = /[^\u0021-\u00ff]/;
/** 对齐 Node `chunkExpression`: 检测 Transfer-Encoding 中是否包含 chunked。 */
const RE_TE_CHUNKED = /(?:^|\W)chunked(?:$|\W)/i;

function errWithCode(message: string, code: string): TypeError {
    const err = new TypeError(message);
    (err as any).code = code;
    return err;
}

/**
 * node 的 `ERR_HTTP_HEADERS_SENT` —— **普通 `Error`**（不是 `TypeError`），文案里带**动作名**。
 *
 * node v22.22.2 实测五个入口各自的文案（`code` 相同，只有动词不同）：
 *   writeHead      -> Cannot write  headers after they are sent to the client
 *   setHeader      -> Cannot set    headers after they are sent to the client
 *   appendHeader   -> Cannot append headers after they are sent to the client
 *   setHeaders     -> Cannot set    headers after they are sent to the client
 *   removeHeader   -> Cannot remove headers after they are sent to the client
 * 所以动作名做成参数。原先本类抛的是无 `code` 的裸 `Error`，靠文案判断的调用方
 * （以及 `err.code === 'ERR_HTTP_HEADERS_SENT'` 这种标准写法）都会失手。
 */
function headersSentError(action: string): Error {
    const err = new Error(`Cannot ${action} headers after they are sent to the client`);
    (err as any).code = 'ERR_HTTP_HEADERS_SENT';
    return err;
}

/**
 * `Date` 响应头的**每秒缓存**。
 *
 * node 的 `internal/http.js` 也是这么做的：同一秒内所有响应共用同一个字符串，
 * 免得每个响应都 `new Date().toUTCString()` 一次（在解释器上这不是免费操作）。
 * 格式由 ECMA-262 规定（`Www, dd Mmm yyyy HH:mm:ss GMT`），与 node 实测输出同形。
 */
let _cachedDateSecond = -1;
let _cachedDateString = '';

function utcDate(): string {
    const now = Date.now();
    const second = (now / 1000) | 0;
    if (second !== _cachedDateSecond) {
        _cachedDateSecond = second;
        _cachedDateString = new Date(now).toUTCString();
    }
    return _cachedDateString;
}

/**
 * node 的 `http.validateHeaderName`（公开 API，Express 等框架直接调）。
 *
 * ⚠️ 判据是**两半**，缺一不可：node v22.22.2 实测 `validateHeaderName(123)` 也抛
 * `ERR_INVALID_HTTP_TOKEN`（消息里的 `["123"]` 是 `String()` 之后的展示，不代表放行）。
 * 只留正则那一半的话，`123` 会被 `RegExp.test` 的隐式 `String()` 变成 `"123"`
 * 而**静默通过** —— 这正是「非字符串入参」这一类差异藏身的地方。
 */
export function validateHeaderName(name: string): void {
    if (typeof name !== 'string' || !HTTP_TOKEN_RE.test(name)) {
        throw errWithCode(
            `Header name must be a valid HTTP token ["${name}"]`,
            'ERR_INVALID_HTTP_TOKEN'
        );
    }
}

/**
 * node 的 `http.validateHeaderValue`（公开 API）。
 *
 * ⚠️ 判据也是两半：node v22.22.2 实测
 *   `validateHeaderValue('x', undefined)` → 抛 `ERR_HTTP_INVALID_HEADER_VALUE`（**单独一条**）
 *   `validateHeaderValue('x', 123)`        → **放行**（node 内部 `checkInvalidHeaderChar` 会 String()）
 * 少了 `undefined` 那一半，`.test(undefined)` 会去测字符串 `"undefined"` 而静默通过。
 */
export function validateHeaderValue(name: string, value: string): void {
    if (value === undefined) {
        throw errWithCode(
            `Invalid value "undefined" for header "${name}"`,
            'ERR_HTTP_INVALID_HEADER_VALUE'
        );
    }
    if (INVALID_HEADER_VALUE_RE.test(String(value))) {
        throw errWithCode(`Invalid character in header content ["${name}"]`, 'ERR_INVALID_CHAR');
    }
}

/** 请求状态行里的 status message。 */
function validateStatusMessage(message: string): void {
    if (INVALID_HEADER_VALUE_RE.test(message)) {
        throw errWithCode('Invalid character in statusMessage', 'ERR_INVALID_CHAR');
    }
}

/**
 * node 的 `validateString(name, 'name')` —— `getHeader` / `hasHeader` / `removeHeader`
 * 三个按名字查头的方法都会先过这一关。
 *
 * 缺了它，`res.getHeader(123)` 会走到 `123..toLowerCase()` 上抛一个**没有 `code`**
 * 的 `TypeError: name.toLowerCase is not a function`（在无头宿主上表现为
 * `uncaught exception: not a function`，
 * 连是哪个 API 都看不出来），而 node 抛的是带 `ERR_INVALID_ARG_TYPE` 的。
 */
function validateHeaderNameArg(name: any): void {
    if (typeof name !== 'string') {
        throw errWithCode(
            `The "name" argument must be of type string. Received ${name === null ? 'null' : typeof name}`,
            'ERR_INVALID_ARG_TYPE'
        );
    }
}

/** 请求行的 path。 */
function validateRequestPath(path: string): void {
    if (INVALID_PATH_CHAR_RE.test(path)) {
        throw errWithCode(
            `Request path contains unescaped characters ["${path}"]`,
            'ERR_UNESCAPED_CHARACTERS'
        );
    }
}

/** 请求行的 method（必须是 HTTP token，与 header 名同一字符集）。 */
function validateRequestMethod(method: string): void {
    if (!HTTP_TOKEN_RE.test(method)) {
        throw errWithCode(
            `Method must be a valid HTTP token ["${method}"]`,
            'ERR_INVALID_HTTP_TOKEN'
        );
    }
}

/**
 * RFC 9110 §7.8：升级请求必须**同时**带 `Upgrade` 头和 `Connection: upgrade`。
 *
 * Node v22.22.2 实测就是这个判定（缺任一个都走普通请求）：
 *   Upgrade + Connection: Upgrade      → 'upgrade' 事件
 *   Upgrade + Connection: keep-alive   → 普通请求
 *   只有 Upgrade 头 / 只有 Connection  → 普通请求
 *
 * ⚠️ 必须与 rust 侧 `http_parser.rs::try_parse_request_headers` 的 `is_upgrade`
 * 判定**保持一致**：那边靠这个标记决定是否把切分点之后的字节交出来当 head，
 * 这边靠它决定走不走 upgrade 分支。两边判定不一致会出现「发了 upgrade 事件但
 * head 是空的」。
 */
function isUpgradeRequest(headers: Record<string, any> | undefined | null): boolean {
    if (!headers || !headers['upgrade']) return false;
    const conn = headers['connection'];
    const connStr = Array.isArray(conn) ? conn.join(',') : (typeof conn === 'string' ? conn : '');
    return connStr.toLowerCase().includes('upgrade');
}

/**
 * 请求是否允许复用连接 —— node 的 `ServerResponse.shouldKeepAlive` 初始值。
 *
 * 判定（对齐 node v22.22.2 实测）：
 *   HTTP/1.1 + `Connection: close`      → 不复用
 *   HTTP/1.1 + 其它 / 无 `Connection`    → 复用（1.1 的默认）
 *   HTTP/1.0 + `Connection: keep-alive` → 复用
 *   HTTP/1.0 + 其它 / 无 `Connection`    → 不复用（1.0 的默认）
 */
function requestAllowsKeepAlive(parsed: { version?: number; headers?: Record<string, any> }): boolean {
    const conn = parsed.headers && parsed.headers['connection'];
    const connStr = Array.isArray(conn) ? conn.join(',') : (typeof conn === 'string' ? conn : '');
    const lower = connStr.toLowerCase();
    if (lower.includes('close')) return false;
    if (parsed.version === 1) return true;
    return lower.includes('keep-alive');
}

/**
 * 把 `{[name]: string | string[]}` 统一成 `{[name]: string[]}` —— node 的
 * `headersDistinct` / `trailersDistinct` 形态。
 */
function distinctOf(src: Record<string, any>): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const name of Object.keys(src)) {
        const v = src[name];
        out[name] = Array.isArray(v) ? v.slice() : [v];
    }
    return out;
}

// ========== IncomingMessage ==========

export class IncomingMessage extends Readable {
    public httpVersion: string = '1.1';
    public httpVersionMajor: number = 1;
    public httpVersionMinor: number = 1;
    public method?: string;
    public url?: string;
    public statusCode?: number;
    public statusMessage?: string;
    public headers: Record<string, string | string[]> = {};
    public socket: Socket;
    public aborted: boolean = false;
    public complete: boolean = false;
    public trailers: Record<string, string> = {};

    /**
     * node 的 `req.client` —— 实测**就是 `req.socket` 本身**
     * （`req.client === req.socket` 为 true，两侧都是）。
     */
    public client: Socket;

    /**
     * node 的 `req.rawHeaders`：原始大小写、原始顺序、重复项各占一项的扁平数组。
     * Rust parser 在 headers 消息里通过 `raw_headers` 提供。
     */
    public rawHeaders: string[] = [];

    /**
     * node 的 `req.rawTrailers`（own data，实测初始 `[]`）。
     * Rust parser 在 chunked trailers 消息里通过 `raw_trailers` 提供。
     */
    public rawTrailers: string[] = [];

    /**
     * node 的 `req.joinDuplicateHeaders`（own data）。
     * ⚠️ 实测两侧**初值不同**：服务端 `null`、客户端 `undefined`。
     * 客户端那条路径会显式把它置回 `undefined`（见 `ClientRequest`），别一刀切。
     */
    public joinDuplicateHeaders: boolean | null = null;

    /** node 的 `req.upgrade`（own data，实测默认 `false`）。 */
    public upgrade: boolean = false;

    /**
     * 客户端响应上的 `res.req` —— 指向发起这次请求的 `ClientRequest`
     * （实测 `res.req.constructor.name === 'ClientRequest'`）。
     *
     * ⚠️ 刻意**不给初始值**：target ES2020 下「声明但不赋值」的字段不发射，
     * 所以服务端的 `req` 上不会有这个属性 —— 与 node 一致（node 的服务端 `req.req`
     * 实测 `'req' in req === false`）。
     */
    public req?: any;

    private _headersDistinctOverride?: Record<string, string[]>;
    private _trailersDistinctOverride?: Record<string, string[]>;

    constructor(socket: Socket) {
        // `autoDestroy` 用 readable-stream 的默认值（true），因为 node 的 `IncomingMessage`
        // 就是 autoDestroy 的 Readable —— 实测读完 body 后 `destroyed === true` 且 'close'
        // 恰好一次，**客户端 res 与服务端 req 同形**（两个形态都在实测生命周期时量过）。
        // 这里原先写死 `{autoDestroy: false}`，唯一的理由是「流一销毁就会把 socket 带走」——
        // 那个理由已经在 #53 里消掉了：`destroy()` 现在只在 `aborted` 时才销毁 socket。
        super();
        this.socket = socket;
        this.client = socket;
    }

    /**
     * node 的 `req.connection` —— `socket` 的废弃别名。
     * node 侧是**原型上的 get+set 访问器**（实测），所以这里也必须给 setter。
     */
    public get connection(): Socket {
        return this.socket;
    }

    public set connection(s: Socket) {
        this.socket = s;
    }

    /**
     * node 的 `req.headersDistinct` —— 每个头的**多值数组**形态。
     * 实测 node：`{"x-dup":["1","2"], "host":["…"], …}`（键小写）。
     *
     * ⚠️ **已知限制：重复的非 `set-cookie` 头拿不到「多个值」，只拿到拼接后的一个值。**
     * 实测同一个 `X-Dup: 1` + `X-Dup: 2` 的请求：
     *   node  `req.headersDistinct['x-dup'] === ["1","2"]`
     *   本包  `req.headersDistinct['x-dup'] === ["1, 2"]`
     *
     * 根因在**解析器边界**：Rust 的 `insert_header()`（`rust_c_net/src/http_parser.rs`）
     * 按 RFC 7230 把同名头的值用 `", "` 拼成单个字符串之后才交给 JS —— 原始的
     * 多值结构从没跨过边界。`set-cookie` 是唯一例外（解析器特判成数组），所以
     * 那一类的 `headersDistinct` 是**准确**的。
     *
     * ⚠️ **不要用「按 `", "` 切开」来还原** —— node 自己在 `setHeaders()` 里就写了
     * 这个理由（`We also cannot safely split by comma`）：值本身可以合法地含 `", "`。
     * 真要做对得让 `ParsedMessage` 多带一份原始头列表（见 `rawTrailers` 的注释）。
     *
     * 键序也与 node 可能不同：node 从 `rawHeaders` 推，本包从 `headers` 推。
     */
    public get headersDistinct(): Record<string, string[]> {
        return this._headersDistinctOverride ?? distinctOf(this.headers);
    }

    public set headersDistinct(value: Record<string, string[]>) {
        this._headersDistinctOverride = value;
    }

    /** node 的 `req.trailersDistinct`（同上，从 `trailers` 推）。 */
    public get trailersDistinct(): Record<string, string[]> {
        return this._trailersDistinctOverride ?? distinctOf(this.trailers);
    }

    public set trailersDistinct(value: Record<string, string[]>) {
        this._trailersDistinctOverride = value;
    }

    _read() {
        // Server-side: socket is kept flowing by _setupHttpConnection.
        // Calling socket.resume() here is the correct Node.js backpressure pattern
        // but only when socket is the actual data source (client-side IncomingMessage).
        // For server-side req, body bytes come via parser→push(), not socket directly.
        // Still call resume() to unblock if paused by backpressure, but guard it.
        if (this.socket && !(this.socket as any)._destroyed) {
            this.socket.resume();
        }
    }

    public setTimeout(msecs: number, callback?: () => void): this {
        this.socket.setTimeout(msecs, callback);
        return this;
    }

    /**
     * socket 已经交回 agent 池 ⇒ 在 `'end'` 发出**之前**把 `this.socket` 摘掉。
     * 由 `ClientRequest._finishResponse()` 在 `releaseSocket()` 之后调 `markSocketFreed()` 置位。
     *
     * 为什么不就地（在回池那一刻）置 null：node 是在自己那条 `res.on('end', responseOnEnd)`
     * 里摘的（`responseKeepAlive()` → `req.res.socket = null`），而它注册得比用户的 'end' 监听早。
     * 实测 node 的形状是 **`'data'` 里还有 socket、`'end'` 起就是 null**。本包在「解析完成」
     * 时就回池（比 node 早一大截，正文还在 res 的缓冲里），直接置 null 会让用户的 `'data'`
     * 也拿不到 socket —— 而 `res.socket.getPeerCertificate()` 这类读取正发生在 'data' 期间。
     * 所以用一个 emit 钩子把时机对齐到同一刻，而不是把回池时机改掉。
     */
    private _detachSocketOnEnd = false;

    /** 见 `_detachSocketOnEnd`。名字按调用方（ClientRequest）的动作命名，便于对照 node。 */
    public markSocketFreed(): void {
        this._detachSocketOnEnd = true;
    }

    public emit(event: any, ...args: any[]): boolean {
        if (event === 'end' && this._detachSocketOnEnd) {
            // 放在 super.emit 之前 ⇒ 本包的摘除先于**所有**用户 'end' 监听器，与 node 同序。
            this._detachSocketOnEnd = false;
            (this as any).socket = null;
        }
        return super.emit(event, ...args);
    }

    public destroy(error?: Error): this {
        // node 的 `IncomingMessage._destroy` 有两半，而且它们是**同一个属权判断**（#53）：
        //   ① 没读完就被销毁 ⇒ `aborted = true` 并补发 `'aborted'`；
        //   ② **只有 aborted 才销毁底层 socket**。
        // 少了 ②，消费者收尾时的一句 `res.destroy()` 会把**已经回池**的 keep-alive 连接
        // 一起带走（实测原判据探针：服务端连接数 1→2，复用整体失效；node 那边照样复用）。
        // 判定要在 `super.destroy()` 之前取：基类会改 destroyed/发 close，但不动
        // readableEnded 与 complete。
        const incomplete = !this.readableEnded || !this.complete;
        super.destroy(error);
        if (incomplete) {
            this.aborted = true;
            this.emit('aborted');
        }
        if (this.aborted && this.socket && !this.socket.destroyed) {
            this.socket.destroy(error);
        }
        return this;
    }

    public setNoDelay(noDelay: boolean = true): void {
        this.socket.setNoDelay(noDelay);
    }

    public setKeepAlive(enable: boolean = false, initialDelay: number = 0): void {
        this.socket.setKeepAlive(enable, initialDelay);
    }
}

// ========== OutgoingMessage ==========

export class OutgoingMessage extends Writable {
    public headersSent: boolean = false;
    protected _headers: Record<string, any> = {};
    protected _headerNames: Record<string, string> = {};
    /** ClientRequest 为 true：Host 固定在第一行；ServerResponse 保持插入顺序。 */
    protected _hostFirst: boolean = false;
    /** impersonate 的浏览器控制头策略（仅 ClientRequest 会设置）。 */
    protected _profileHeaderPolicy?: ProfileHeaderPolicy;
    public socket: Socket | null = null;

    public chunkedEncoding: boolean = false;
    protected _hasBody: boolean = true;
    protected _sendHeadersSent: boolean = false;
    /**
     * node 的 `OutgoingMessage._last`：这条报文写完是否必须关闭连接（`Connection: close`
     * 以及「以关闭定界」的几种帧形态都靠它）。node 里它**在 OutgoingMessage 上**，
     * 所以 `ClientRequest` 也能写 —— 「无 agent + 自定义 createConnection」那条路就写它
     * （`_http_client.js:343`，实测 `res.headers.connection === 'close'`），本包现在同形（#60）。
     * 服务端侧的 `_shouldCloseConnection`（getter）继续读同一份状态。
     */
    protected _last: boolean = false;
    public aborted: boolean = false;
    protected _trailers: Record<string, string> | null = null;

    /**
     * 连接是否可复用。node 的 `OutgoingMessage` 构造期就写死成 own data（默认 `true`），
     * 服务端随后由 `Server._setupHttpConnection` 按**请求的** `Connection` 头覆盖
     * （HTTP/1.1 默认复用、HTTP/1.0 默认不复用）。
     *
     * ⚠️ 它**真的会进线字节**（`_connectionLines()`）：`false` ⇒ 发 `Connection: close`
     * 且收尾后发 FIN。这是「接线」而不是「看起来支持」的判据 —— 只加字段不改线字节
     * 属于 §2.2 反对的那类。
     */
    public shouldKeepAlive: boolean = true;

    /**
     * 是否自动补 `Date` 头。
     *
     * node 的 `OutgoingMessage` 构造期把它置 `false`，由 `ServerResponse` 覆写成 `true`
     * —— 所以实测 `req.sendDate === false` 而 `res.sendDate === true`。两边默认值**不同**，
     * 别一刀切。
     */
    public sendDate: boolean = false;

    /**
     * 没有 `Content-Length` 时是否自动用 `Transfer-Encoding: chunked`。
     *
     * node 的 `OutgoingMessage` 默认 `true`。置 `false` 时**既不补 CL 也不补 TE**
     * （实测矩阵见 `_framingLines()`），响应变成以连接关闭定界、并带 `Connection: close`。
     */
    public useChunkedEncodingByDefault: boolean = true;

    /**
     * `Content-Length` 越界时是否按 node 的 strict 语义抛错（node 构造期默认 `false`）。
     *
     * ⚠️ **本宿主的默认行为与 node 不同，这是有意偏离**：
     *   - node `false`（默认）⇒ **照发**越界的字节。实测线缆：
     *     `Content-Length: 3` 却写了 `hello` ⇒ 线上是 `…\r\n\r\nhello`，
     *     keep-alive 下多出的 `lo` 会成为**下一条响应**的开头（线缆错位）。
     *   - node `true` ⇒ `write()` **同步抛** `ERR_HTTP_CONTENT_LENGTH_MISMATCH`，
     *     溢出的字节被丢弃、线缆保持自洽（`Content-Length: 3` + `hel`），且**不断开连接**。
     *   - 本宿主 ⇒ **默认即拒绝**（取 node strict 的粒度：同步抛、丢弃溢出、不断开），
     *     因为「把错位报文发出去」在 keep-alive 下会毒害下一条响应（R19 的验收要求）。
     *     也就是说本宿主等价于 node 的 `strictContentLength = true`。
     *
     * 这个字段因此**是被读的**：`true` 时错误消息用 node 原文，`false` 时在 node 原文后
     * 追加一段说明，避免使用者误以为 node 也会抛（见 `_contentLengthMismatchError`）。
     */
    public strictContentLength: boolean = false;

    /**
     * node 的 `maxRequestsPerSocket` 用尽时会把它置 `true`（own data，默认 `false`）。
     *
     * 本宿主**不会**置 `true` —— `Server` 侧的 `maxRequestsPerSocket` 已被明确删除
     * （见 `Server` 字段区的注释），所以这里恒为 `false`。留着是为了**表层对齐**：
     * node 上它就是个恒 `false` 的 own data（实测），写 `false` 不会「静默答错」，
     * 与 `shouldKeepAlive` 那种「可读但不生效」不同。
     */
    public maxRequestsOnConnectionReached: boolean = false;

    /**
     * 用户是否**删过**这三个头（node 的 `_removedConnection` / `_removedContLen` / `_removedTE`）。
     *
     * 只影响**隐式头**的补写：删过 `Connection` ⇒ 不再补 `Connection: keep-alive/close`；
     * 删过 `Content-Length`/`Transfer-Encoding` ⇒ 不再自动补对应那条。
     * 不记的话，`removeHeader('Content-Length')` 之后隐式逻辑会把它**加回来** —— 而
     * node 的语义恰恰是「删掉就真的没有」。
     */
    protected _removedConnection: boolean = false;
    protected _removedContLen: boolean = false;
    protected _removedTE: boolean = false;

    /**
     * 库自己算出来、准备写进响应头的 `Content-Length` 值
     * （node 的 `OutgoingMessage._contentLength`）。
     *
     * ⚠️ 与 `_headers['content-length']` 是**两回事**：
     *   - `_headers['content-length']` = 用户**显式**设的头，渲染在「用户头」那一段；
     *   - `_autoContentLength`        = 库算出来的，渲染在 `Date`/`Connection` **之后**。
     * node 的 `_storeHeader` 就是这么分的，实测渲染顺序是
     * `状态行 → 用户头 → Date → Connection[/Keep-Alive] → 隐式 CL|TE`。
     * 把自动 CL 塞进 `_headers` 会让它在用户头那一段、`Date` 之前 —— 字节级分歧。
     */
    protected _autoContentLength: number | null = null;

    /**
     * `Keep-Alive: timeout=N` 的秒数来源（node 的 `res._keepAliveTimeout`，
     * 由 `Server.keepAliveTimeout` 注入）。`0` ⇒ 不发 `Keep-Alive`。
     */
    public _keepAliveTimeout: number = 0;
    /** node 的 `res._defaultKeepAlive`：为假时不发 `Keep-Alive`。 */
    public _defaultKeepAlive: boolean = true;

    /**
     * 尚未写出的响应头（已渲染成字符串）。**只在与首段 body 合并写时短暂存在**：
     * `_sendHeaders` 把渲染结果挂在这里，`ServerResponse._write` 取出后与首段 body
     * 拼成一份字节一次写出；若响应压根没有 body，由 `_final` 兜底写出。
     *
     * 为什么值得这么做（M9 后续 · B2 追查）：原来 header 与 body 各走一次
     * `socket.write`，于是每个响应要付**两次**跨 FFI 的原生写 + 两次
     * `Buffer.from`。实测单次原生写约 3.1 µs、
     * `Buffer.from` 约 1.1 µs —— 合并后每响应少一次原生写、少一次字符串→Buffer 转换。
     */
    protected _pendingHeader: string | null = null;

    /**
     * `setHeader('Content-Length', v)` 的解析结果缓存（`-1` = 未设置/不可解析）。
     * 每个响应会问它两次（`_write` 的越界检查 + `_final` 的欠写检查），而每次
     * `getHeader` 都要 `toLowerCase()` + `String()` + `parseInt()` —— 在解释器上
     * 合计约 0.33 µs/请求，缓存后为 0。
     */
    protected _contentLengthNum: number = -1;

    constructor() {
        // @ts-ignore - disable autoDestroy to prevent socket from being destroyed when stream ends
        //
        // `decodeStrings: false` 是 B2 的第三处优化（2026-09-24）：默认值 true 会让
        // Writable 在调用 `_write` **之前**把字符串转成 Buffer，于是响应头与 body 的
        // 合并只能走 `Buffer.concat([Buffer.from(pending), chunk])` —— 实测
        // `Buffer.from(hdr)` 1096 ns + `Buffer.concat` 513 ns = **1638 ns**。
        // 关掉之后 `_write` 拿到原始字符串，合并变成一次字符串拼接（32 ns），
        // 再由 `socket.write` 统一做**一次** `Buffer.from(合并结果)`（1129 ns）
        // ⇒ 每响应省约 **1.5 µs**（≈2.5%），顺带少一次 Buffer 分配。
        // 实测确认过 `_write` 的入参类型：开启前 47272 次全是 `Buffer`、0 次字符串。
        // chunked 分支本来就写了 `chunk instanceof Uint8Array ? chunk : Buffer.from(chunk, encoding)`，
        // 非 chunked 分支把 `chunk`＋`encoding` 原样交给 `socket.write`（它自己做转换），
        // 所以两种入参都已覆盖。
        super({ autoDestroy: false, decodeStrings: false });
    }

    /**
     * `destroy()` 是否顺手销毁 `this.socket`。
     *
     * 默认 true（`ServerResponse` 与「连接还在自己手上」的请求都该这样）。唯一该关掉的是
     * **socket 已经交还给 agent 池** 的那一刻：node 实测响应走完后 `req.destroyed === true`
     * 而 `req.socket.destroyed === false`（那条连接还活着，等着被复用）—— 本包的
     * `destroy()` 把「销毁请求流」与「销毁 socket」绑在一起，直接补 `this.destroy()`
     * 会当场掐掉刚回池的 keep-alive 连接（#53 的实测现象：`freeSockets` 里那条
     * `destroyed=true`，复用整体失效）。所以由持有 socket 归属权的一侧来翻这个开关。
     */
    protected destroySocketOnDestroy: boolean = true;

    public destroy(error?: Error): this {
        super.destroy(error);
        if (this.destroySocketOnDestroy && this.socket) {
            this.socket.destroy();
        }
        return this;
    }

    setHeader(name: string, value: any): this {
        if (this.headersSent) throw headersSentError('set');
        // 注入校验放在这里：`_headers` 只由本方法写入，所以这是唯一的收口点
        // （`_renderHeaders` 不需要再校验一遍）。数组值（如 Set-Cookie）逐项校验。
        validateHeaderName(name);
        if (Array.isArray(value)) {
            for (const v of value) validateHeaderValue(name, String(v));
        } else {
            validateHeaderValue(name, String(value));
        }
        const key = name.toLowerCase();
        this._headers[key] = value;
        this._headerNames[key] = name;
        if (key === 'content-length') {
            // 顺手把解析结果缓存起来（`_declaredContentLength` 每次响应问两遍）
            const n = typeof value === 'number' ? value : parseInt(String(value), 10);
            this._contentLengthNum = Number.isFinite(n) && n >= 0 ? n : -1;
        } else if (key === 'transfer-encoding') {
            this._removedTE = false;
            const teVal = Array.isArray(value) ? value.join('; ') : String(value);
            this.chunkedEncoding = RE_TE_CHUNKED.test(teVal);
        }
        return this;
    }

    getHeader(name: string): any {
        validateHeaderNameArg(name);
        return this._headers[name.toLowerCase()];
    }

    removeHeader(name: string): void {
        if (this.headersSent) throw headersSentError('remove');
        validateHeaderNameArg(name);
        const key = name.toLowerCase();
        // node 的 `removeHeader` 用四个 `_removed*` 标志记住「用户删过这个头」，
        // 因为隐式头补写逻辑会**把它们加回来**（见 `_connectionLines()` / `_framingLines()`）。
        switch (key) {
            case 'connection':
                this._removedConnection = true;
                break;
            case 'content-length':
                this._removedContLen = true;
                break;
            case 'transfer-encoding':
                this._removedTE = true;
                this.chunkedEncoding = false;
                break;
            case 'date':
                // node 就是这么写的：删 `Date` ⇒ 关掉自动补 Date。
                this.sendDate = false;
                break;
        }
        delete this._headers[key];
        delete this._headerNames[key];
        if (key === 'content-length') this._contentLengthNum = -1;
    }

    hasHeader(name: string): boolean {
        validateHeaderNameArg(name);
        return name.toLowerCase() in this._headers;
    }

    /**
     * node 的 `OutgoingMessage.getHeaderNames()` —— 返回**小写**头名。
     *
     * ⚠️ 与 `getRawHeaderNames()`（原始大小写）是两回事。旧实现写的是
     * `Object.values(this._headerNames)`，那是**原始大小写**，等于把
     * `getRawHeaderNames()` 的内容又返回了一遍 ⇒ 实测 node `["x-one"]` vs
     * 本包 `["X-One"]`。`_headers` 的键本来就全是小写（`setHeader` 里
     * `toLowerCase()` 过），所以直接取它的键就是对的。
     */
    getHeaderNames(): string[] {
        return Object.keys(this._headers);
    }

    public setTimeout(ms: number, callback?: () => void): this {
        if (this.socket) {
            this.socket.setTimeout(ms, () => {
                this.emit('timeout');
                if (callback) callback();
            });
        } else {
            this.once('socket', (s: Socket) => {
                s.setTimeout(ms, () => {
                    this.emit('timeout');
                    if (callback) callback();
                });
            });
        }
        return this;
    }

    /**
     * 隐式响应头（`Date` / `Connection` / `Keep-Alive` / 隐式 `Content-Length`|`Transfer-Encoding`）。
     *
     * ⚠️ **渲染在用户头之后**，不是之前。node 的 `_storeHeader` 实测顺序是
     * `状态行 → 用户头（按首次设置顺序）→ Date → Connection[/Keep-Alive] → 隐式 CL|TE → CRLF`：
     *
     * ```
     * res.setHeader('X-A','1'); res.setHeader('X-B','2'); res.end('x')
     *   -> HTTP/1.1 200 OK\r\nX-A: 1\r\nX-B: 2\r\nDate: …\r\nConnection: keep-alive\r\n
     *      Keep-Alive: timeout=5\r\nContent-Length: 1\r\n\r\nx
     * res.setHeader('Content-Length','1'); res.end('x')      // 用户设的 CL 走用户头那一段
     *   -> HTTP/1.1 200 OK\r\nContent-Length: 1\r\nDate: …\r\nConnection: keep-alive\r\n…
     * ```
     *
     * ⚠️ 本方法可能有**副作用**：`ServerResponse` 的帧选择会在这里定 `chunkedEncoding`，
     * 所以 `_sendHeaders` 必须先 `_renderHeaders()` 再读它（顺序反了永远走非 chunked 分支）。
     *
     * 默认空实现：`ClientRequest` 不补任何隐式头。做成**返回字符串**而不是返回数组，
     * 是为了不给热路径（每个响应一次）多一次数组分配。
     */
    protected _implicitHeaderLines(): string {
        return '';
    }

    protected _renderHeaders(firstLine: string): string {
        let headerStr = firstLine + '\r\n';
        // 隐式头在**用户头之后** —— 见 `_implicitHeaderLines()` 的注释（node `_storeHeader` 顺序）。
        headerStr += renderHeaderLines(
            this._headers,
            this._headerNames,
            this._implicitHeaderLines(),
            (teVal) => {
                this.chunkedEncoding = RE_TE_CHUNKED.test(teVal);
            },
            this._hostFirst,
            this._profileHeaderPolicy
        );
        if (!this._hasBody) {
            this.chunkedEncoding = false;
        }
        headerStr += '\r\n';
        return headerStr;
    }

    protected _sendHeaders(firstLine: string) {
        if (this.headersSent) return;

        this.headersSent = true;
        // ⚠️ 帧选择（是否 `Transfer-Encoding: chunked`）现在发生在 `_implicitHeaderLines()` 里，
        // 所以必须先渲染、再问 `this.chunkedEncoding`。以前是渲染**之前**用 `setHeader` 补 TE，
        // 那条路径有两个毛病：① TE 会落在「用户头」那一段（node 放在 `Connection` 之后）；
        // ② `getHeader('Transfer-Encoding')` 在响应开始后能读到 'chunked'（node 读不到，
        //    因为它只拼进头字符串、不进 `kOutHeaders`）。
        const headerStr = this._renderHeaders(firstLine);
        debugLog(`OutgoingMessage._sendHeaders: writing ${headerStr.length} bytes to socket (socket=${!!this.socket})`);
        if (this.chunkedEncoding) {
            // chunked 分帧下响应头**不能**并进 body：body 要各自套 `len\r\n…\r\n` 外壳，
            // 把响应头并进第一段会被对端当成 body 字节。照旧单独写。
            this.socket!.write(Buffer.from(headerStr));
        } else {
            // 挂起，等首段 body 一起写（见 `_pendingHeader` 的注释）。
            // 没有 body 的响应（204/304/HEAD、`end()` 不带 chunk）由 `_final` 兜底写出。
            this._pendingHeader = headerStr;
        }
    }

    /** 取出挂起的响应头（一次性）。 */
    protected _takePendingHeader(): string | null {
        const h = this._pendingHeader;
        this._pendingHeader = null;
        return h;
    }

    _write(chunk: any, encoding: string, callback: (error?: Error | null) => void) {
        if (!this.socket) {
            callback(new Error('Socket not assigned'));
            return;
        }

        // 把挂起的响应头并进**首段** body，一次写出。字符串 body（最常见）下这一步
        // 让「响应头 + body」共用**一次**字符串→Buffer 转换与**一次**原生写：
        // 实测 `Buffer.from(h+b)` 1.16 µs ≈ `Buffer.from(h)` 1.19 µs（长度不敏感），
        // 而分开写要 1.19 + 1.09 µs 再加一次原生写。chunked 下 `_pendingHeader`
        // 恒为 null（`_sendHeaders` 已直接写出）。
        const pending = this._takePendingHeader();
        if (pending !== null) {
            chunk = (typeof chunk === 'string')
                ? pending + chunk
                : Buffer.concat([Buffer.from(pending),
                                 (chunk instanceof Uint8Array) ? chunk : Buffer.from(chunk, encoding as any)]);
        }

        if (this.chunkedEncoding) {
            // chunked 分帧原本要写三次：长度头 / 数据 / 结尾 CRLF。而**每次**
            // `socket.write` 都是一次 JSI 往返 + 一次背压裁决（`Socket._write` 要等
            // WRITTEN/BUSY 才 callback），于是每块 3 次往返（TS-L5）。
            // 拼成一个 buffer 一次写出：**线字节与之前逐字节相同**
            // （`len\r\n` + 数据 + `\r\n`），只是把三次往返合并成一次。
            //
            // 长度改由「转换后的字节」取而不是原来的 `Buffer.byteLength(chunk, encoding)`：
            // 字符串按 encoding 转成 Buffer 后 `.length` 就是真实字节数，两者等价；
            // 但对 **ArrayBuffer** 这类没有 `.length` 的入参，原写法会算出
            // `undefined` 再 `.toString(16)` 抛错 —— 现在顺带修掉。
            const data: Uint8Array = (chunk instanceof Uint8Array)
                ? chunk
                : Buffer.from(chunk, encoding as any);
            // 零字节 chunk 在 chunked 流里**不产出任何线字节**。
            // 照写会变成 `0\r\n` + 空 + `\r\n` = `0\r\n\r\n`，而这正是 chunked 的
            // **结束块（terminator）**——写在响应中间会提前终结 body，后续块被对端
            // 当成响应之后的垃圾字节（keep-alive 下更是直接错位）。
            // 对齐 Node v22.22.2 实测：`write('A')→write('')→write(Buf0)→write('B')→end()`
            // 的线字节是 `1\r\nA\r\n1\r\nB\r\n0\r\n\r\n`，空块零字节、结束块只在 end 出现一次。
            //
            // ⚠️ 但 **callback 必须照常触发**：上层 Writable 靠它推进内部缓冲与 drain，
            // 漏调会让后续写卡死。所以这里是 `callback(); return;` 而不是直接 `return`。
            if (data.length === 0) {
                callback();
                return;
            }
            const header = Buffer.from(data.length.toString(16) + '\r\n');
            const tail = Buffer.from('\r\n');
            this.socket.write(Buffer.concat([header, data, tail]), undefined, callback);
        } else {
            this.socket.write(chunk, encoding as any, callback);
        }
    }

    public write(chunk: any, encoding?: any, callback?: any): boolean {
        // 对齐 Node 的 `OutgoingMessage.write`：**对端已断开时 write 是静默 no-op**
        // —— 返回 false，只经 `nextTick` 给回调一个 `ERR_STREAM_DESTROYED`，
        // **不发 'error'**（没有监听器时那会变成未捕获异常）。
        //
        // Node v22.22.2 实测（客户端在响应写完前断开）：
        //   res.destroyed === true；res.write('a', cb) → 返回 false，cb 收到
        //   ERR_STREAM_DESTROYED；res.end('b') → 不抛、不崩。
        //
        // 少了这条早退的后果（实测）：字节一路走到已销毁的 socket，拿回
        // `ERR_STREAM_DESTROYED`，再经 readable-stream 的 onwriteError 冒成
        // **未捕获异常**，服务端整个进程崩。触发场景很常见：
        // 客户端中途断开（超时 / 用户取消 / fetch 的 AbortController）。
        //
        // 判据用 `socket.destroyed` 而不是 `this.destroyed`：本类的 `destroyed`
        // 来自 readable-stream 的 Writable（只有 getter），而 `_handleSocketClose()`
        // 只发 'close' 不置它 —— 见 docs 里登记的「`res.destroyed` 恒为 false」。
        if (this.destroyed || this._peerGone) {
            if (typeof encoding === 'function') {
                callback = encoding;
            }
            if (typeof callback === 'function') {
                nextTick(callback, errWithCode(
                    'Cannot call write after a stream was destroyed',
                    'ERR_STREAM_DESTROYED'));
            }
            return false;
        }
        const ret = super.write(chunk, encoding, callback);
        // If writableLength is too high, return false
        // But since we are proxying to socket, we should also check socket backpressure
        if (this.socket && (this.socket as any)._writableState) {
            // This is a bit hacky but if we have a real Node-like socket, we respect its state
            return ret && !(this.socket as any)._writableState.needDrain;
        }
        return ret;
    }

    /**
     * 对端是否已经不在（socket 已销毁）。
     *
     * 此时**一切 wire 层的校验都要让路**：没有 wire 可以弄错，Node 对已断开的
     * 连接一律静默丢弃（它本身也没有 Content-Length 校验）。少了这条，
     * 「客户端中途断开 + 显式 Content-Length」会变成未捕获的
     * `ERR_HTTP_CONTENT_LENGTH_MISMATCH` —— 那是「因为对端走了所以拒绝发」，
     * 逻辑上说不通，还会把服务端整个进程带走。
     */
    protected get _peerGone(): boolean {
        return !!(this.socket && (this.socket as any).destroyed);
    }

    // _final is called by the stream when all writes are complete before 'finish' event
    _final(callback: (error?: Error | null) => void) {
        // 对端已断开：结尾块 / 挂起的响应头都没有去处，直接收尾。
        // 照写会让 `Socket.write` 的 destroyed 早退把 `ERR_STREAM_DESTROYED`
        // 交回这里的 callback → 经 Writable 的 final 路径冒成**未捕获异常**
        // （实测：客户端中途断开 + chunked 响应 = 服务端进程崩）。
        if (this._peerGone) {
            callback();
            return;
        }
        if (this.chunkedEncoding && this.socket) {
            let terminator = '0\r\n';
            if (this._trailers) {
                for (const [key, value] of Object.entries(this._trailers)) {
                    terminator += `${key}: ${value}\r\n`;
                }
            }
            terminator += '\r\n';
            this.socket.write(Buffer.from(terminator), undefined, (err) => {
                callback(err);
            });
        } else {
            // 没有 body 的响应/请求：响应头一直挂在 `_pendingHeader` 上，这里兜底写出。
            // 缺这一步，`res.writeHead(204); res.end()` 这种会一个字都不发。
            const pending = this._takePendingHeader();
            if (pending !== null && this.socket) {
                this.socket.write(Buffer.from(pending), undefined, (err) => {
                    callback(err);
                });
            } else {
                callback();
            }
        }
    }

    public addTrailers(headers: Record<string, string>) {
        if (this.headersSent && !this.chunkedEncoding) {
            throw new Error('Trailers can only be used with chunked encoding');
        }
        this._trailers = headers;
    }

    end(chunk?: any, encoding?: any, callback?: any): this {
        if (typeof chunk === 'function') {
            callback = chunk;
            chunk = null;
            encoding = null;
        } else if (typeof encoding === 'function') {
            callback = encoding;
            encoding = null;
        }

        if (chunk != null) {
            this.write(chunk, encoding);
        }
        super.end(callback);
        return this;
    }

    public setNoDelay(noDelay: boolean = true): void {
        this.socket?.setNoDelay(noDelay);
    }

    public setSocketKeepAlive(enable: boolean = false, initialDelay: number = 0): void {
        this.socket?.setKeepAlive(enable, initialDelay);
    }

    /**
     * node 的 `OutgoingMessage.prototype.finished`（已废弃，文档指向 `writableEnded`）。
     *
     * node v22.22.2 实测三格：`end()` 前 `false` / `end()` 后 `true` / 对端硬断开 `false`
     * —— 三格都等价于 `writableEnded`（**不是** `destroyed`：对端断开那格
     * `destroyed=true` 而 `finished=false`）。
     *
     * ⚠️ 做成只读 getter 是安全的：`Writable.prototype.finished` **不存在**
     * （实测 `undefined`），不会撞名；而 `writableEnded` 是访问器、赋值会被静默忽略
     * （实测），所以也不该给它配 setter。
     */
    public get finished(): boolean {
        return this.writableEnded;
    }

    /**
     * node 的 `OutgoingMessage.prototype.connection`（`socket` 的废弃别名）。
     *
     * node 侧是 **get+set 访问器**（实测 `Object.getOwnPropertyDescriptor` 有 getter 和
     * setter），所以这里也必须给 setter —— 否则 `this.connection = s` 在严格模式下抛。
     */
    public get connection(): Socket | null {
        return this.socket;
    }

    public set connection(s: Socket | null) {
        this.socket = s;
    }
}

// ========== ServerResponse ==========

export class ServerResponse extends OutgoingMessage {
    public statusCode: number = 200;
    /** `statusMessage` 的存储；对外经访问器暴露（node 侧该名字在原型链上可解析）。 */
    private _statusMessage?: string;
    /**
     * 本次请求（node 的 `res.req`，实测是 own data property）。
     * 由 `Server._setupHttpConnection` 在 `new` 之后立刻注入 —— 大量中间件靠它反查请求。
     */
    public req: IncomingMessage | null = null;

    /**
     * 是否自动补 `Date` 头。**覆写基类的 `false`** —— node 就是这么分的：
     * `OutgoingMessage` 构造期置 `false`（所以 `req.sendDate === false`），
     * `ServerResponse` 构造期置 `true`（所以 `res.sendDate === true`）。
     * 置 `false` 或用户自己设过 `Date` 时都不补。
     */
    public sendDate: boolean = true;

    /** 已写出的 body 字节数，用于校验 `Content-Length`（TS-M13）。 */
    private _bodyBytesWritten: number = 0;
    /** 'close' 是否已发出（'finish' 与 socket 'close' 只允许发一次）。 */
    private _closeEmitted: boolean = false;
    /** 挂在自身 'finish' 上的 close 触发器；socket 先关时要把它摘掉。 */
    private _onFinishClose: (() => void) | null = null;
    /**
     * `assignSocket()` 挂到 socket 上的 `'close'` 转发器（node 的
     * `onServerResponseClose`）。`detachSocket()` 要按**同一个函数引用**摘掉它，
     * 所以必须存下来 —— 现造一个闭包去 `removeListener` 是摘不掉的。
     */
    private _socketCloseForwarder: (() => void) | null = null;

    /**
     * node 的 `res.statusMessage`。
     *
     * node 侧该名字在 `ServerResponse.prototype` 上（实测 depth 1），这里做成
     * 访问器而不是实例字段：target ES2020 下 `useDefineForClassFields` 为 false，
     * **声明但不赋值**的字段根本不发射 ⇒ 名字在原型链上就消失了（这就是它
     * 之前被判为「缺失」的原因）。
     */
    public get statusMessage(): string | undefined {
        return this._statusMessage;
    }

    public set statusMessage(value: string | undefined) {
        this._statusMessage = value;
    }

    /**
     * 本响应写完之后是否要**关闭连接**（node 的 `OutgoingMessage._last`）。
     *
     * node 在三处置 `_last = true`，本类逐处对应（都在 `_connectionLines()` /
     * `_framingLines()` 里，即 `_storeHeader` 的等价逻辑）：
     *   1. keep-alive 判定为假 ⇒ 发 `Connection: close`；
     *   2. `useChunkedEncodingByDefault === false` ⇒ 既不补 CL 也不补 TE（以关闭定界）；
     *   3. CL 与 TE 都被用户 `removeHeader` 掉 ⇒ 同样以关闭定界。
     *
     * ⚠️ 读它的时机必须在 `_sendResponseHeaders()` **之后**（`Server` 的响应 `'finish'`
     * 分支满足这一点）。`|| !this.shouldKeepAlive` 是渲染前的兜底 —— 正常路径下
     * `_connectionLines()` 已经把它置位了。
     */
    public get _shouldCloseConnection(): boolean {
        return this._last || !this.shouldKeepAlive;
    }

    /**
     * node 的 `res.outputSize` —— **当前**内部缓冲里的字节数。
     *
     * node 侧是 own data（实测 `write()` 之后仍为 0，因为它同步写进 socket）。
     * 本包的 `_write` 把字节交给 socket 后**异步**才回调，所以缓冲会短暂非空
     * ⇒ 这里如实取 `writableLength`，而不是硬编码 0（硬编码会在背压场景**答错**）。
     *
     * ⚠️ **`outputData` 有意不做**（档案 §6.3 组 D）：node 返回的是
     * `Array<{ data, encoding, callback }>`，而 readable-stream 的 `writableBuffer`
     * 返回的是 **`BufferList` 实例**（`Array.isArray` 为 `false`，元素是 `{ data, next }`
     * —— 实测 `buffer_list.js`，**没有 `encoding`/`callback`**）。返回它形状就是错的，
     * 硬编码 `[]` 又会在背压场景静默答错 ⇒ 宁可缺。
     */
    public get outputSize(): number {
        return this.writableLength;
    }

    constructor(socket: Socket, requestMethod: string = 'GET') {
        super();
        this.socket = socket;
        // HEAD 响应不允许带 body（RFC 9110 §9.3.2），但解析器不知道请求方法 —— 只有 server
        // 侧知道，所以由构造参数传进来。关掉 `_hasBody` 后：不会自动补
        // Content-Length/Transfer-Encoding（与 Node 实测行为一致），写进来的 body 也会被丢弃。
        if (String(requestMethod).toUpperCase() === 'HEAD') {
            this._hasBody = false;
        }

        // 'close' 有两个触发源：自身 'finish'（正常路径）与 socket 'close'（对端提前断开）。
        // 这里只挂**自身**的 'finish' —— 那是纯 JS EventEmitter，很便宜。
        //
        // ⚠️ socket 那一侧**不在这里挂**：原来是对 socket 做 `once('close')` +
        //    在回调里 `removeListener('close')`，即每请求两次 streams 层的
        //    `on`/`removeListener` 调用。实测这两次合计 **3.3 µs**，占单请求
        //    预算的 5%（`Socket.prototype.on`/`removeListener` 都被 net.ts 与 streams
        //    覆盖过，走的是解释器路径而非原生）。而且它会让**长连接的 socket** 一直持有
        //    每个响应创建出来的闭包。
        //    现在改为**每连接注册一次**：`Server._setupHttpConnection` 里已有的
        //    `socket.on('close', …)` 顺带把事件转发给当时的 `res`（见那里）。
        const onFinishClose = () => {
            this._onFinishClose = null;
            this._emitCloseOnce();
        };
        this._onFinishClose = onFinishClose;
        this.once('finish', onFinishClose);
    }

    /** 只发一次 'close'（'finish' 与 socket 'close' 谁先到谁负责）。 */
    private _emitCloseOnce(): void {
        if (this._closeEmitted) return;
        this._closeEmitted = true;
        this.emit('close');
    }

    /**
     * 由连接级 `socket.on('close')` 转发进来 —— 对端在响应写完之前断开了。
     * 与 'finish' 路径互斥：先到者负责发 'close'，另一个变成 no-op。
     */
    public _handleSocketClose(): void {
        const f = this._onFinishClose;
        if (f) {
            this._onFinishClose = null;
            this.removeListener('finish', f);
        }
        // 对端断开 ⇒ 本响应不可能再写出任何字节。node 的 `res.destroyed` 此时为 `true`
        // （实测；正常 `end()` 之后是 `false`）—— 缺这一行，用 `destroyed` 做状态判断的
        // 代码（连接池回收 / 写超时 / 双写检测）会**一直以为对端还在**。
        //
        // 走 readable-stream 自己的 setter：它只置 `_writableState.destroyed`，
        // **不触发 destroy 机制** ⇒ 不重复发 'close'、不让后续 `end()` 抛
        // （两条都是实测过的：`destroyed = true` 后 `end()` 不抛、`writableEnded` 停在 false，
        //  与 node 「对端硬断开」那一格一致）。
        this.destroyed = true;
        this._emitCloseOnce();
    }

    /**
     * 隐式响应头，逐段对应 node `_storeHeader` 在**用户头之后**追加的那几段：
     * `Date` → `Connection`[/`Keep-Alive`] → 隐式 `Content-Length`|`Transfer-Encoding`。
     *
     * ⚠️ 旧注释写的「实测顺序是 `Date` → `Connection` → 用户头」是**错的**
     * （当时量的是一个没有用户头的响应，两种顺序看起来一样）。node 的
     * `_storeHeader` 源码与带用户头的实测都表明：用户头在前。
     */
    protected _implicitHeaderLines(): string {
        // 三个「用户设过没有」的判据只算一次再传下去：`hasHeader` 每次都要
        // `toLowerCase()`，而这一段每响应只跑一次、却要用到 4~6 次
        // （实测 `toLowerCase` + `in` 约 60 ns/次 ⇒ 合并后省约 0.2 µs/响应）。
        const contLen = this.hasHeader('Content-Length');
        const te = this.hasHeader('Transfer-Encoding');
        let out = '';
        // ── Date ── node: `if (this.sendDate && !state.date) header += 'Date: …'`
        if (this.sendDate && !this.hasHeader('Date')) {
            out += 'Date: ' + utcDate() + '\r\n';
        }
        // ── Connection / Keep-Alive ──
        out += this._connectionLines(contLen);
        // ── 隐式 CL | TE ──
        out += this._framingLines(contLen, te);
        return out;
    }

    /**
     * node `_storeHeader` 的 keep-alive 段，逐分支对齐：
     *
     * ```
     * if (this._removedConnection)          -> 什么都不发（用户删过 Connection）
     * else if (!state.connection) {         -> 用户没自己设 Connection
     *   shouldSendKeepAlive = shouldKeepAlive && (state.contLen || useChunkedEncodingByDefault)
     *   if (shouldSendKeepAlive)  -> 'Connection: keep-alive' [+ 'Keep-Alive: timeout=N']
     *   else                      -> 'Connection: close'  (并且 _last = true)
     * }
     * ```
     *
     * 实测（node v22.22.2，请求不带 `Connection: close`）：
     *   `res.end('x')`                        -> `Connection: keep-alive` + `Keep-Alive: timeout=5`
     *   `res.shouldKeepAlive = false`         -> `Connection: close`
     *   `res.setHeader('Connection','close')` -> 用户那条（库不再补）
     *   `setHeader('Connection','x')` 后 `removeHeader('Connection')` -> 两条都不发
     *   `res.sendDate = false`                -> 无 Date，其余不变
     *
     * ⚠️ `Keep-Alive: timeout=N` 的 N 是**秒**（`Math.floor(ms/1000)`），来自
     * `Server.keepAliveTimeout`（node 实测 `timeout=5` ⇒ 5000ms）。
     */
    private _connectionLines(contLen: boolean): string {
        if (this._removedConnection) return '';
        if (this.hasHeader('Connection')) return '';
        const shouldSendKeepAlive = this.shouldKeepAlive
            && (contLen || this.useChunkedEncodingByDefault);
        if (!shouldSendKeepAlive) {
            this._last = true;
            return 'Connection: close\r\n';
        }
        let out = 'Connection: keep-alive\r\n';
        if (this._keepAliveTimeout && this._defaultKeepAlive) {
            out += `Keep-Alive: timeout=${Math.floor(this._keepAliveTimeout / 1000)}\r\n`;
        }
        return out;
    }

    /**
     * node `_storeHeader` 里 `if (!state.contLen && !state.te)` 那一段，逐分支对齐：
     *
     * ```
     * if (!this._hasBody)                  -> chunkedEncoding = false（不发任何帧头）
     * else if (!useChunkedEncodingByDefault) -> 什么都不发，且 _last = true（以关闭定界）
     * else if (!state.trailer && !_removedContLen && _contentLength !== null)
     *                                      -> 'Content-Length: <_contentLength>'
     * else if (!_removedTE)                -> 'Transfer-Encoding: chunked'（并置 chunkedEncoding）
     * else                                 -> 什么都不发，_last = true
     * ```
     *
     * ⚠️ **`useChunkedEncodingByDefault === false` 的分支在 CL 分支之前** —— 这就是
     * 「`res.useChunkedEncodingByDefault = false` 时 node 连 `Content-Length` 都不补」的原因。
     * 实测矩阵（node v22.22.2，uc = `useChunkedEncodingByDefault`）：
     *
     * | 处理器 | uc=true | uc=false |
     * | :--- | :--- | :--- |
     * | `res.end('h')` | `Content-Length: 1` | **无 CL、无 TE** |
     * | `res.write('h'); res.end()` | `Transfer-Encoding: chunked` + `1\r\nh\r\n0\r\n\r\n` | **无 CL、无 TE**，body 裸写 |
     * | `res.end()` | `Content-Length: 0` | **无 CL、无 TE** |
     * | 用户显式设 CL | 用户那条 | 用户那条 |
     * | `204` + `end()` | 无 | 无 |
     *
     * ⚠️ 自动 CL 走的是 `_autoContentLength`（库自己算的），**不是** `setHeader` ——
     * 后者会把它放到「用户头」那一段、`Date` 之前，与 node 的字节序不符。
     */
    private _framingLines(contLen: boolean, te: boolean): string {
        // `state.contLen` / `state.te`：用户显式设过就整段跳过。
        if (contLen || te) return '';
        if (!this._hasBody) {
            this.chunkedEncoding = false;
            return '';
        }
        if (!this.useChunkedEncodingByDefault) {
            this._last = true;
            return '';
        }
        if (!this.hasHeader('Trailer') && !this._removedContLen && this._autoContentLength !== null) {
            return 'Content-Length: ' + this._autoContentLength + '\r\n';
        }
        if (!this._removedTE) {
            this.chunkedEncoding = true;
            return 'Transfer-Encoding: chunked\r\n';
        }
        this._last = true;
        return '';
    }

    // ---------- node 公开方法面（档案 §1.6 记的「缺的成员」） ----------

    /** node 的 `res.getHeaders()`：返回**副本**（改它不影响已设的头），键为小写。 */
    public getHeaders(): Record<string, any> {
        return { ...this._headers };
    }

    /**
     * node 的 `res.getRawHeaderNames()`：返回**原始大小写**的头名，按首次设置顺序。
     * 与 `getHeaderNames()`（小写）是两回事 —— 两个都要有。
     */
    public getRawHeaderNames(): string[] {
        return Object.values(this._headerNames);
    }

    /**
     * node 的 `res.appendHeader(name, value)`：**追加**而不是改写。
     * 已有值时并成数组（实测 node：`setHeader('X','a')` + `appendHeader('X','b')`
     * ⇒ `getHeader('X') === ['a','b']`）。
     */
    public appendHeader(name: string, value: any): this {
        if (this.headersSent) throw headersSentError('append');
        const existing = this.getHeader(name);
        if (existing === undefined) {
            return this.setHeader(name, value);
        }
        const merged = Array.isArray(existing) ? existing.slice() : [existing];
        if (Array.isArray(value)) {
            for (const v of value) merged.push(v);
        } else {
            merged.push(value);
        }
        return this.setHeader(name, merged);
    }

    /**
     * node 的 `res.setHeaders(headers)` —— **只收 `Headers` 与 `Map`**，逐项走
     * `setHeader`（**改写**，不是追加）。
     *
     * ⚠️ 档案 §6.3 组 C 原写的「支持 `Headers`/`Map`/数组/对象四形态 → 逐个 `appendHeader`」
     * 是**错的**，两处都错。node v22.22.2 实测 + 源码（`ServerResponse.prototype.setHeaders`）：
     *
     * ```
     * setHeaders({ 'X-Two': '2' })   -> 抛 ERR_INVALID_ARG_TYPE | The "headers" argument must be
     *                                   an instance of Headers or Map.   ← 普通对象不收
     * setHeaders([['X','1']])        -> 抛 ERR_INVALID_ARG_TYPE（同上）  ← 数组也不收
     * setHeaders(null / undefined)   -> 抛 ERR_INVALID_ARG_TYPE（同上）
     * setHeaders(new Map([…]))       -> ok
     * setHeaders(new Headers([…]))   -> ok
     * headersSent 之后                -> 抛 ERR_HTTP_HEADERS_SENT
     * setHeader('X','a') 后 setHeaders(Map([['X','b']]))  -> getHeader('X') === 'b'  ← **改写**
     * ```
     *
     * 判据是 `typeof headers.keys === 'function' && typeof headers.get === 'function'`
     * （node 源码就是这四个条件：`!headers || ArrayIsArray(headers) || typeof keys !== 'function'
     * || typeof get !== 'function'`）。`Headers` 与 `Map` 都满足，普通对象/数组都不满足。
     *
     * `set-cookie` 是**唯一**特例：node 把它收集成数组、循环结束后一次性 `setHeader`，
     * 因为 `Headers` 的 getter 会把多条 cookie 用逗号拼起来（拆不回去）。
     * 注意判据是 `key === 'set-cookie'` **全小写**比较 —— `Map` 里写成 `'Set-Cookie'`
     * 不会走特例（node 亦然）。
     */
    public setHeaders(headers: any): this {
        if (this.headersSent) throw headersSentError('set');
        if (!headers || Array.isArray(headers)
            || typeof headers.keys !== 'function' || typeof headers.get !== 'function') {
            throw errWithCode(
                'The "headers" argument must be an instance of Headers or Map.',
                'ERR_INVALID_ARG_TYPE'
            );
        }
        let cookies: any[] | null = null;
        for (const [name, value] of headers) {
            if (name === 'set-cookie') {
                if (cookies === null) cookies = [];
                if (Array.isArray(value)) {
                    for (const v of value) cookies.push(v);
                } else {
                    cookies.push(value);
                }
                continue;
            }
            this.setHeader(name, value);
        }
        if (cookies !== null) this.setHeader('set-cookie', cookies);
        return this;
    }

    /**
     * node 的 `res.writeHeader(...)` —— 与 `writeHead` **是同一个函数对象**
     * （实测 `res.writeHeader === res.writeHead` 为 `true`）。类体里写不成转发函数
     * （那会得到两个不同的函数对象），所以在本文件 `ServerResponse` 定义之后用一条
     * 原型赋值做真别名；这里只留类型声明（`!` ⇒ ES2020 下**不发射任何东西**，
     * 不会造出 node 没有的 own 属性）。
     */
    public writeHeader!: (
        statusCode: number,
        statusMessage?: string | Record<string, any>,
        headers?: Record<string, any>
    ) => this;

    /**
     * node 的 `res.flushHeaders()`：立刻把响应头推出去，不等首段 body。
     *
     * ⚠️ 不能只调 `_sendResponseHeaders()`：非 chunked 形态下它会把响应头**挂起**
     * （等首段 body 合并成一次写，见 `_pendingHeader` 的注释），那正好与
     * 「现在就要出去」相反。所以这里把挂起的那份取出来单独写。
     */
    public flushHeaders(): void {
        this._sendResponseHeaders();
        this._flushPendingHeader();
    }

    /** node 的 `_flush()`：把已挂起的响应头立刻写出（`assignSocket()` 之后要用）。 */
    private _flushPendingHeader(): void {
        const pending = this._takePendingHeader();
        if (pending !== null) {
            this.socket?.write(Buffer.from(pending));
        }
    }

    /** node 的 `res.writeContinue()`：实测线字节 `HTTP/1.1 100 Continue\r\n\r\n`。 */
    public writeContinue(): void {
        this.socket?.write(Buffer.from('HTTP/1.1 100 Continue\r\n\r\n'));
    }

    /** node 的 `res.writeProcessing()`：实测线字节 `HTTP/1.1 102 Processing\r\n\r\n`。 */
    public writeProcessing(): void {
        this.socket?.write(Buffer.from('HTTP/1.1 102 Processing\r\n\r\n'));
    }

    /**
     * node 的 `res.writeEarlyHints(hints, cb)` —— 逐条对齐 node 的
     * `ServerResponse.prototype.writeEarlyHints` 源码（v22.22.2）：
     *
     * ```js
     * let head = 'HTTP/1.1 103 Early Hints\r\n';
     * validateObject(hints, 'hints');                       // 非对象 ⇒ ERR_INVALID_ARG_TYPE
     * if (hints.link === null || hints.link === undefined) return;   // 早退：一个字都不发
     * const link = validateLinkHeaderValue(hints.link);     // 非 string/string[] 或含非法字符 ⇒
     *                                                       //   ERR_INVALID_ARG_VALUE；空数组 ⇒ ''
     * if (link.length === 0) return;                        // 早退
     * head += 'Link: ' + link + '\r\n';
     * for (key of ObjectKeys(hints)) if (key !== 'link') head += key + ': ' + hints[key] + '\r\n';
     * head += '\r\n';
     * this._writeRaw(head, 'ascii', cb);
     * ```
     *
     * 实测（node v22.22.2）：
     * ```
     * writeEarlyHints({})                    -> 什么都不发（无 link 键 ⇒ 早退，回调也不调）
     * writeEarlyHints({ link: '</a>' })      -> 'HTTP/1.1 103 Early Hints\r\nLink: </a>\r\n\r\n'
     * writeEarlyHints({ Link: '</a>' })      -> 什么都不发（只认**全小写** link 键）
     * writeEarlyHints({ link: ['</a>','</b>'] }) -> 'Link: </a>, </b>'      ← ', ' 连接
     * writeEarlyHints({ link: [] })          -> 什么都不发（空数组 ⇒ length 0 ⇒ 早退）
     * writeEarlyHints({ link: null })        -> 什么都不发
     * writeEarlyHints({ link: '</a>', 'x-foo': 'bar' }) -> 'Link: </a>\r\nx-foo: bar\r\n'
     * writeEarlyHints({ link: '</a>', 'x-multi': ['1','2'] }) -> 'x-multi: 1,2'  ← String() 强转
     * writeEarlyHints({ link: 123 })         -> 抛 ERR_INVALID_ARG_VALUE
     * writeEarlyHints({ link: '</a>\n' })    -> 抛 ERR_INVALID_ARG_VALUE（非法字符）
     * writeEarlyHints(null / undefined)      -> 抛 ERR_INVALID_ARG_TYPE
     * ```
     *
     * ⚠️ 三条最容易写错的：① `Link` 输出名是**大写首字母**，判据键却是小写 `link`；
     * ② 非 `link` 键**照原样输出**（含数组走 `String()` ⇒ `1,2` 无空格，与 `Link` 的 `, ` 不同）；
     * ③ 没有 `link` 时是**早退**，不是「发一个只有状态行的 103」。
     */
    public writeEarlyHints(hints: Record<string, any>, callback?: () => void): void {
        if (hints === null || hints === undefined || typeof hints !== 'object') {
            throw errWithCode(
                `The "hints" argument must be of type object. Received ${hints === null ? 'null' : typeof hints}`,
                'ERR_INVALID_ARG_TYPE'
            );
        }
        const raw = hints.link;
        if (raw === null || raw === undefined) return;
        let link: string;
        if (typeof raw === 'string') {
            link = raw;
        } else if (Array.isArray(raw)) {
            for (const item of raw) {
                if (typeof item !== 'string') {
                    throw errWithCode(
                        'The argument \'hints\' must be an array or string of format ' +
                            '"/styles.css>; rel=preload; as=style". Received ' + String(item),
                        'ERR_INVALID_ARG_VALUE'
                    );
                }
            }
            link = raw.join(', ');
        } else {
            throw errWithCode(
                'The argument \'hints\' must be an array or string of format ' +
                    '"/styles.css>; rel=preload; as=style". Received ' + String(raw),
                'ERR_INVALID_ARG_VALUE'
            );
        }
        // node 的 `validateLinkHeaderValue` 顺带校验字符集（`\r`/`\n` 等一律拒）。
        if (INVALID_HEADER_VALUE_RE.test(link)) {
            throw errWithCode(
                'The argument \'hints\' must be an array or string of format ' +
                    '"/styles.css>; rel=preload; as=style". Received ' + JSON.stringify(link),
                'ERR_INVALID_ARG_VALUE'
            );
        }
        if (link.length === 0) return;
        let out = 'HTTP/1.1 103 Early Hints\r\nLink: ' + link + '\r\n';
        for (const name of Object.keys(hints)) {
            if (name === 'link') continue;
            out += name + ': ' + hints[name] + '\r\n';
        }
        out += '\r\n';
        this.socket?.write(Buffer.from(out), undefined, callback);
    }

    /**
     * node 的 `res.assignSocket(socket)`（源码逐行对齐）：
     * ```js
     * if (socket._httpMessage) throw new ERR_HTTP_SOCKET_ASSIGNED();
     * socket._httpMessage = this;
     * socket.on('close', onServerResponseClose);   // 转发成 res 的 'close'
     * this.socket = socket;
     * this.emit('socket', socket);
     * this._flush();
     * ```
     * `detachSocket` 是它的反操作（`assert(socket._httpMessage === this)`、
     * 摘监听、`_httpMessage = null`、`socket = null`）。
     *
     * ⚠️ 档案 §6.3 组 C 的提醒是对的：**只设字段、不搬事件接线**就是错行为
     * —— 用户把响应挂到别的 socket 上之后，对端断开就再也通知不到这个 `res` 了。
     */
    public assignSocket(socket: Socket): void {
        if ((socket as any)._httpMessage) {
            throw errWithCode('Socket already assigned to another message', 'ERR_HTTP_SOCKET_ASSIGNED');
        }
        (socket as any)._httpMessage = this;
        const onClose = () => {
            if ((socket as any)._httpMessage === this) {
                this._emitCloseOnce();
            }
        };
        (socket as any).on('close', onClose);
        this._socketCloseForwarder = onClose;
        this.socket = socket;
        this.emit('socket', socket);
        this._flushPendingHeader();
    }

    public detachSocket(socket: Socket): void {
        const fwd = this._socketCloseForwarder;
        if (fwd) {
            (socket as any).removeListener('close', fwd);
            this._socketCloseForwarder = null;
        }
        (socket as any)._httpMessage = null;
        this.socket = null;
    }

    writeHead(statusCode: number, statusMessage?: string | Record<string, any>, headers?: Record<string, any>): this {
        if (this.headersSent) throw headersSentError('write');
        this.statusCode = statusCode;
        this._applyNoBodyStatus();
        if (typeof statusMessage === 'object') {
            headers = statusMessage;
            statusMessage = undefined;
        }
        if (statusMessage) {
            // 在调用点就抛（对齐 Node 的 writeHead），而不是等到真正发送时。
            // `_sendResponseHeaders` 里还有一道兜底，覆盖 `res.statusMessage = '...'` 这种直接赋值。
            validateStatusMessage(statusMessage);
            this.statusMessage = statusMessage;
        }
        if (headers) {
            for (const key in headers) {
                this.setHeader(key, headers[key]);
            }
        }
        // node 的 `writeHead` **结尾就调 `_storeHeader`** —— 也就是「调用 writeHead
        // 就等于把头定下来」。本包原来刻意不发（注释写的是「等首段 body 一起发，
        // 好把 Content-Length 算出来」），代价是两处可观测差异：
        //
        //   ① 帧选择时机不同：`writeHead(200, {...}); res.end('h')` 在 node 上是
        //      `Transfer-Encoding: chunked`（`_storeHeader` 跑的时候 `_contentLength`
        //      还是 null），本包原来会补 `Content-Length: 1`（`end()` 先算了长度）。
        //   ② `headersSent` 时机不同：node 在 `writeHead` 之后就是 `true`
        //      （`res.writeHead(200); res.setHeader('a','b')` 抛 `ERR_HTTP_HEADERS_SENT`），
        //      本包原来要到 `end()`/首段 `write()` 才置位。
        //
        // 改成在这里调 `_sendResponseHeaders()`（**只渲染、不额外 flush**）：
        //   - 帧选择与 `headersSent` 都与 node 对齐；
        //   - 非 chunked 形态下响应头仍然挂在 `_pendingHeader` 上，由首段 body 合并
        //     成**一次**写出 ⇒ `_pendingHeader` 那套合并优化**完全保留**。
        //     基准 `bench/http_server.js` 走的就是这条路（它显式设了 Content-Length，
        //     `_framingLines()` 整段跳过 ⇒ 非 chunked ⇒ 仍然合并），所以没有回归。
        this._sendResponseHeaders();
        return this;
    }

    /**
     * 204/304/1xx（RFC 9110）不允许带 body：把 `_hasBody` 关掉，于是不会自动补
     * Content-Length/Transfer-Encoding，写进来的 body 也会被丢弃。用户**显式**设过的
     * Content-Length 保持原样（304 的 CL 描述的是被省略的表示，是合法用法；Node 亦然）。
     */
    private _applyNoBodyStatus(): void {
        const status = this.statusCode;
        if (status === 204 || status === 304 || (status >= 100 && status < 200)) {
            this._hasBody = false;
            this.chunkedEncoding = false;
        }
    }

    /**
     * 已声明的 `Content-Length`（没有或不是数字则为 null）。
     *
     * 值在 `setHeader` 时就解析并缓存进 `_contentLengthNum`，这里不再重做
     * `getHeader` → `toLowerCase` → `String` → `parseInt` 那一路 —— 每个响应会问两次
     * （`_write` 的越界检查 + `_final` 的欠写检查），解释器上合计约 0.33 µs/响应。
     */
    private _declaredContentLength(): number | null {
        return this._contentLengthNum >= 0 ? this._contentLengthNum : null;
    }

    /**
     * `ERR_HTTP_CONTENT_LENGTH_MISMATCH`。
     *
     * 消息用 **node 的原文**（实测 v22.22.2）：
     * `Response body's content-length of 5 byte(s) does not match the content-length of 3 byte(s) set in header`
     * —— 照抄的理由是有些库会 `err.message.includes(...)`。
     *
     * `strictContentLength === false`（默认）时在原文后**追加**一句说明：node 在这个档位
     * 是**放行**的，本宿主仍然拒绝（加固，见字段注释）。不加这句的话，使用者会以为
     * node 也会抛，从而找错方向。
     */
    private _contentLengthMismatchError(declared: number, actual: number): TypeError {
        let msg =
            `Response body's content-length of ${actual} byte(s) does not match ` +
            `the content-length of ${declared} byte(s) set in header`;
        if (!this.strictContentLength) {
            msg +=
                ` (host hardening: strictContentLength is false, but this host still refuses to put a` +
                ` desynchronised body on the wire; set res.strictContentLength = true for node's exact wording)`;
        }
        return errWithCode(msg, 'ERR_HTTP_CONTENT_LENGTH_MISMATCH');
    }

    /**
     * 越界检查（node 在 `write()` 里做的**同步**检查）。
     *
     * 返回 `Error` 表示「再加 `extra` 字节就会超出声明的 CL」，**不改任何状态**
     * —— 调用方负责抛（`write()`）或抛+断开（`end()` 时头已经出去的情形）。
     */
    private _overflowError(extra: number): TypeError | null {
        // 对端已断开时 wire 层校验一律让路（见 `_peerGone` 的注释）—— 字节根本没有去处，
        // 「越界」也就无从谈起。原来的检查在 `_write` 的 `_peerGone` 早退**之后**，
        // 语义等价；挪到 `write()` 里必须显式带上这一条。
        if (!this._hasBody || this._peerGone) return null;
        // 用户显式设过 CL 时 `_framingLines()` 会整段跳过 ⇒ 一定不是 chunked，
        // 所以这里不用再问 `chunkedEncoding`。
        const declared = this._declaredContentLength();
        if (declared === null) return null;
        const total = this._bodyBytesWritten + extra;
        if (total <= declared) return null;
        return this._contentLengthMismatchError(declared, total);
    }

    /**
     * 欠写检查（node 在 `end()` 里做的同步检查）。
     *
     * node 的判据是 `_bodyBytesWritten + len(chunk) !== declared`（**不是** `>`）——
     * 实测：`Content-Length: 5` 却只 `end('he')` 会抛，而 `write('he'); end('l')`
     * 在 CL=3 时**不抛**。
     */
    private _underflowError(extra: number): TypeError | null {
        if (!this._hasBody || this.chunkedEncoding || this._peerGone) return null;
        const declared = this._declaredContentLength();
        if (declared === null) return null;
        const total = this._bodyBytesWritten + extra;
        if (total === declared) return null;
        return this._contentLengthMismatchError(declared, total);
    }

    private _sendResponseHeaders() {
        if (this.headersSent) return;
        // 覆盖 `res.statusCode = 204` 这种绕过 writeHead 的直接赋值
        this._applyNoBodyStatus();
        // statusMessage 直接拼进状态行（且 `res.statusMessage = '...'` 可绕过 writeHead），
        // 所以在这里收口校验，否则一样能注入出假的响应头（TS-M14）。
        //
        // 只有**用户自己传的**才需要校验：`STATUS_CODES` 表与 'OK' 兜底都是库内常量，
        // 不可能含非法字符。省掉一次正则 `.test`（解释器上约 0.07 µs/响应）。
        const statusMessage = this.statusMessage || STATUS_CODES[this.statusCode] || 'OK';
        if (this.statusMessage) validateStatusMessage(statusMessage);
        const firstLine = `HTTP/1.1 ${this.statusCode} ${statusMessage}`;
        this._sendHeaders(firstLine);
    }

    _write(chunk: any, encoding: string, callback: (error?: Error | null) => void) {
        if (!this.headersSent) this._sendResponseHeaders();

        // HEAD / 204 / 304：body 一律丢弃、且不参与 Content-Length 校验（Node 同样静默丢弃）。
        if (!this._hasBody) {
            debugLog(`ServerResponse: dropping ${chunk?.length ?? 0} bytes of body (status=${this.statusCode}, no-body response)`);
            callback();
            return;
        }

        // 对端已断开：字节没有去处，Content-Length 也无从弄错（见 _peerGone 注释）。
        if (this._peerGone) {
            debugLog(`ServerResponse: dropping ${chunk?.length ?? 0} bytes of body (peer gone)`);
            callback();
            return;
        }

        const len = typeof chunk === 'string' ? Buffer.byteLength(chunk, encoding as any) : chunk.length;
        // ⚠️ 这里**不再**做越界检查、也**不再**累加 `_bodyBytesWritten`（2026-09-25 挪走）：
        //   ① 越界必须在 `write()` 里**同步**抛（node 的粒度）。`_write` 是流机制回调的、
        //      背压下会被推迟 —— 到那时溢出的字节**已经进了缓冲**，抛了也来不及，
        //      线缆仍会错位；而在 `write()` 里抛，溢出的字节根本不进缓冲（实测 node 亦然）。
        //   ② 计数若两处都加会双重累加，`_underflowError()` 的判据随即失效。
        // 见 `write()` / `end()` 里的同步检查。
        super._write(chunk, encoding, callback);
    }

    _final(callback: (error?: Error | null) => void) {
        // 欠写的**兜底**收口。正常路径上 `end()` 已经同步检查过（`_underflowError`）；
        // 留在这里是因为 `end()` 之外还有别的收敛路径（例如 `write()` 之后直接
        // `destroy()`、或 `_final` 由流机制在 `end()` 之后再次驱动）。
        //
        // 但对端**已经不在**时这条校验必须让路：没有对端会去等那些字节，
        // 而 `write()` 的静默丢弃（Node 语义）会让 `_bodyBytesWritten` 停在 0，
        // 于是这条校验会把「对端走了」误报成「服务端少写了」并抛未捕获异常。
        const err = this._peerGone ? null : this._underflowError(0);
        if (err) {
            // ⚠️ 顺序**必须**是「先 callback(err)，再 destroy socket」。
            // 反过来的话错误会被**静默吞掉**（2026-09-25 实测定位）：`socket.destroy()`
            // 会让连接级 `socket.on('close')` 走到 `_handleSocketClose()`，那里把
            // `res.destroyed` 置为 `true`；而 readable-stream 的 `errorOrDestroy()` 开头就是
            // `if (w.destroyed) return stream;` ⇒ 随后 `callback(err)` 引发的 'error'
            // **到不了任何监听器**。现象是：守卫确实触发了，但 `res.on('error')` 一条都收不到
            // —— R19 的「服务端抛出了 ERR_HTTP_CONTENT_LENGTH_MISMATCH」就是被这条吃掉的。
            callback(err);
            this.socket?.destroy();
            return;
        }
        super._final(callback);
    }

    write(chunk: any, encoding?: any, callback?: any): boolean {
        // node 在 `write()` 里做**同步**越界检查（实测：`write('ll')` 立刻抛，
        // 且抛了之后 `_bodyBytesWritten` **不增长** —— 后续 `write('o')` 不再抛）。
        // 这里对齐，好处是溢出的字节根本不进缓冲 ⇒ 线缆保持自洽、**不需要断开连接**。
        if (chunk != null) {
            const len = typeof chunk === 'string'
                ? Buffer.byteLength(chunk, (encoding as string) || undefined)
                : chunk.length;
            const err = this._overflowError(len);
            if (err) throw err;
            if (this._hasBody) this._bodyBytesWritten += len;
        }
        return super.write(chunk, encoding, callback);
    }

    end(chunk?: any, encoding?: any, callback?: any): this {
        if (typeof chunk === 'function') {
            callback = chunk;
            chunk = null;
            encoding = null;
        } else if (typeof encoding === 'function') {
            callback = encoding;
            encoding = null;
        }

        const chunkLen = chunk == null
            ? 0
            : (typeof chunk === 'string'
                ? Buffer.byteLength(chunk, (encoding as string) || undefined)
                : chunk.length);

        if (!this.headersSent) {
            // node 的 `end(chunk)` 判据是 `已写字节 + len(chunk) !== 声明值`（实测）：
            //   · `Content-Length: 5` + `end('he')` → **同步抛**，且线缆上**一个字节都没有**
            //     （检查发生在写头之前）；
            //   · `Content-Length: 3` + `write('he'); end('l')` → 3 === 3，**不抛**。
            // 本宿主在**写头之前**检查，所以此刻还没发出任何字节 ⇒ 只抛、**不断开**
            // （与 node 实测一致：连接保持 keep-alive）。
            const underflow = this._underflowError(chunkLen);
            if (underflow) throw underflow;

            // 单段 `end(chunk)` 时先把长度记进 `_autoContentLength`，让 `_framingLines()`
            // 有机会补 `Content-Length`（从而避开 chunked 分帧）。
            //
            // ⚠️ 这里**不能**用 `setHeader('Content-Length', …)`：
            //   ① 它会落进「用户头」那一段（渲染在 `Date` **之前**），而 node 的隐式 CL
            //      在 `Date`/`Connection` **之后**；
            //   ② 它会让 `res.getHeader('Content-Length')` 在响应开始后能读到库自己填的值，
            //      而 node 的 `_contentLength` 与 `kOutHeaders` 是两份东西（读不到）；
            //   ③ 它会让 `_declaredContentLength()` 非空 ⇒ `_final` 的欠写校验被激活，
            //      而这条 CL 本来就是**从 body 推出来的**，不可能欠写（白跑一遍校验）。
            //
            // 无 body 的响应（HEAD / 204 / 304）不补：node 实测也不补（用户显式设过的则保留）。
            // `useChunkedEncodingByDefault === false` 时也不补 —— 那个分支在
            // `_framingLines()` 里**先于** CL 分支，实测 node 连 CL 都不发。
            if (!this._hasBody) {
                debugLog(`ServerResponse.end: no-body response (status=${this.statusCode}), skipping Content-Length`);
            } else if (chunk != null) {
                this._autoContentLength = chunkLen;
            } else {
                // node: `this._contentLength = 0; this._implicitHeader();`
                // （TE 若已被用户设过，`_framingLines()` 会整段跳过，不会真的发这条 CL）
                this._autoContentLength = 0;
            }
            this._sendResponseHeaders();
        } else {
            // 响应头（可能还有一部分 body）**已经出去了**。此刻才发现长度不符，
            // 线缆上已经是一条不自洽的响应：keep-alive 下多写/少写的字节会被对端
            // 当成下一条响应的开头 ⇒ 这条连接必须废弃（这是本宿主相对 node 的加固：
            // node 实测**不**断开，`Content-Length: 5` + 只发 `he` 时对端会一直等）。
            const underflow = this._underflowError(chunkLen);
            if (underflow) {
                // ⚠️ 用 `this.destroy()`（不带 error）而**不是** `this.socket.destroy()`：
                // `super.destroy()` 会**同步**把 `destroyed` 置为 `true`，于是 socket 上
                // 那条在途原生写的回调（`Socket._destroy` 给的 `Error('Socket destroyed')`）
                // 会被 readable-stream 的 `errorOrDestroy()` 开头那句
                // `if (w.destroyed) return stream;` 吃掉。直接 destroy socket 的话，
                // 那个 `Socket destroyed` 会冒成 `res.on('error')` —— 而 node 在这种情况下
                // **一个 'error' 都不发**（实测 `/under-strict` 只有同步抛）。
                this.destroy();
                throw underflow;
            }
        }

        if (chunk != null) {
            this.write(chunk, encoding);
        }
        super.end(callback);
        return this;
    }
}

// node 里 `ServerResponse.prototype.writeHeader` 与 `writeHead` 是**同一个函数对象**
// （实测 `res.writeHeader === res.writeHead` 为 `true`）。类体里只能写成转发函数，
// 那会得到两个不同的函数对象 ⇒ 身份比较会失手（有些库用 `res.writeHeader ===
// res.writeHead` 判断"是不是原生响应"）。所以这里做一条真正的原型别名。
// ⚠️ 顺序要求：必须在类定义**之后** —— 类体里 `ServerResponse` 这个名字还不存在。
(ServerResponse.prototype as any).writeHeader = ServerResponse.prototype.writeHead;

// ========== Server ==========

export interface ServerOptions {
    /**
     * Optionally overrides all net.Server options.
     */
    IncomingMessage?: typeof IncomingMessage;
    ServerResponse?: typeof ServerResponse;
    /**
     * 空闲 keep-alive 超时（毫秒）：一次响应结束后连接回到空闲，超过这个时间没有下一条
     * 请求就关闭它。
     */
    keepAliveTimeout?: number;
    /**
     * 等待请求头的超时（毫秒）：连接建立后、以及空闲连接上来新数据后开始计时，
     * 超过这个时间还没收到完整请求头就断开。
     */
    headersTimeout?: number;
    /**
     * Max header size in bytes.
     */
    maxHeaderSize?: number;
}

/**
 * `http.Server` —— **真继承 `net.Server`**（2026-09-25 改，档案 §6.6 #7）。
 *
 * 原先是「组合」：持有一个 `_netServer` 并把 `listening`/`close`/`error`/`timeout`
 * 四个事件转发出来，`listen`/`close`/`address`/`listening`/`setTimeout` 五个方法
 * 逐个人工转发。后果是 node 里**有**的东西这里没有：
 *   · `http.Server.prototype instanceof net.Server` 为 `false`（node 为 `true`）；
 *   · 原型链少一层（node 是 `Server -> Server -> EventEmitter -> Object`）；
 *   · `closeAllConnections` 被挂在 `net.Server.prototype` 上而不是 `http.Server.prototype`；
 *   · `listen`/`address`/`listening` 是 `http.Server.prototype` 的**自有**成员
 *     （node 从 `net.Server` 继承）。
 *
 * 改成真继承后前三条自动成立。⚠️ **必须同时删掉自有的 `listen`/`address`/`listening`**
 * —— 留着它们会**遮蔽**基类同名成员：`instanceof` 变真了、行为却还是原来那份转发，
 * 那就是「看起来对了、实际坏了」。所以下面只保留 node 也在 `http.Server.prototype`
 * 上自有的那几个（`close` / `setTimeout`），且都改成 `super.*` 转发。
 *
 * ⚠️ **`closeAllConnections` 有意留在 `net.Server.prototype`**（不搬到 http）：
 * 业务代码可以直接在 **`net.Server`** 上调用它。
 * node 的 `net.Server` 没有这个方法 ⇒ 这属于「本包扩展」，与 `net` 模块那 5 个扩展
 * 同类：**可见地登记，而不是悄悄搬走**。真继承后 `http.Server` 自然继承到它。
 * ⚠️ **`closeIdleConnections` 仍然没有**：node 把它放在 `http.Server.prototype`，
 * 本包没有任何「空闲连接」的追踪 ⇒ 补一个「关掉全部」的同名方法会是**静默错行为**，
 * 按本仓口径宁缺勿假。已登记。
 */
export class Server extends NetServer {
    protected _httpConnections = new Set<Socket>();
    public maxHeaderSize: number = 16384;
    public headersTimeout: number = 60000;
    public keepAliveTimeout: number = 5000;
    // 注：原先这里还有 requestTimeout / maxRequestsPerSocket 两个字段（以及同名 option），
    // 但它们从未被任何代码读过 —— 只是"看起来支持"。Task 26 删掉，避免误以为已经生效。
    // （Node 有这两个概念；将来要实现 requestTimeout 应覆盖"从收到请求到读完 body"这段。）

    constructor(options?: ServerOptions | ((req: IncomingMessage, res: ServerResponse) => void), requestListener?: (req: IncomingMessage, res: ServerResponse) => void) {
        // net.Server 走**顶层 import**（见文件头），不再用函数内 `require('./net')`：
        // 那条惰性 require 在 ESM-only 宿主（全局无 `require`，如无头 JS 宿主）
        // 里会让 http.createServer() 一调就 ReferenceError。net.ts 不 import http.ts，
        // 循环依赖不存在；顶层 import 对 RN 无行为差异（tls.ts 早就这么写了）。
        //
        // ⚠️ **不带参数**调 super()：net.Server 的构造签名是 `(options, connectionListener)`，
        // 而这里第一个形参可能是**用户传的 requestListener 函数** —— 传下去会被 net 当成
        // 连接监听器挂到 `'connection'` 上，于是每个 TCP 连接都会被当成请求回调调一次。
        // http 侧的选项（keepAliveTimeout 等）由下面自己读。
        super();

        let listener: ((req: IncomingMessage, res: ServerResponse) => void) | undefined;
        if (typeof options === 'function') {
            listener = options;
        } else if (options) {
            if (options.keepAliveTimeout !== undefined) this.keepAliveTimeout = options.keepAliveTimeout;
            if (options.headersTimeout !== undefined) this.headersTimeout = options.headersTimeout;
            if (options.maxHeaderSize !== undefined) this.maxHeaderSize = options.maxHeaderSize;
            listener = requestListener;
        }

        if (listener) {
            this.on('request', listener);
        }

        // ⚠️ 这里**不再**转发 `listening`/`close`/`error`/`timeout` 四个事件 ——
        // 真继承之后 net.Server 的 `this.emit(...)` 就是自己的 emit，转发等于自环。
        // 唯一需要接的是 `'connection'`：http 侧要接管每个 socket（装解析器）。
        this.on('connection', (socket: Socket) => {
            this._setupHttpConnection(socket);
        });
    }

    protected _setupHttpConnection(socket: Socket) {
        this._httpConnections.add(socket);
        let req: IncomingMessage | null = null;
        let res: ServerResponse | null = null;
        const parser = Driver.createHttpParser(0); // 0 = Request mode
        // @ts-ignore
        let bodyBytesRead = 0;
        // @ts-ignore
        let contentLength = -1;

        // ---- 连接级超时（R-M7 / TS-M19）----
        //
        // 以前这里只在**建连接时**武装一次 headersTimeout，首个请求头到达就清除、之后再无
        // 计时 —— keep-alive 上的后续请求与空闲连接完全没有保护（TS-M19）。
        // 现在按 Node 的语义分成两个互斥的空闲计时器：
        //   - headersTimer：等请求头（连接刚建立、或空闲后新数据到来）；
        //   - keepAliveTimer：一次响应已结束、连接空闲、等下一条请求。
        // 任何新的入站数据都会把状态切回"等请求头"。
        //
        // ⚠️ 两者的**实现手段不同**，这是有意的，不是疏漏（M9 Task 9.8）：
        //
        //   **keepAliveTimeout → 用原生的 `socket.setTimeout(ms)`。**
        //   它是不活动超时（实测：每 150 ms 有 I/O 时，400 ms 的超时不会触发），
        //   与「空闲等下一请求」语义**完全吻合**；由原生层维护，**不消耗 JS 定时器**。
        //   Node 自己也是这么做的（`_http_server.js` 的 `resOnFinish` 里
        //   `socket.setTimeout(server.keepAliveTimeout)`）。
        //   此前这里用 JS 定时器，于是**每请求**要 setTimeout + clearTimeout 各一次
        //   （实测 `setTimeout` 与 `clearTimeout` 1:1、每请求各 2 次）。
        //
        //   ⚠️ 但「原生」不等于「免费」：每次 `socket.setTimeout` 都是一次跨 FFI 调用，
        //   实测约 1.6 µs。所以现在**只在响应结束时武装，不主动解除**
        //   （详见下面 `clearTimers` 的注释）—— 每请求由 2 次降为 1 次。
        //
        //   **headersTimeout → 必须用 JS 的截止定时器。**
        //   它是「从请求开始到收完请求头」的**总时限**，不是不活动超时 ——
        //   换成不活动超时会放过 slow-loris（每 59 s 滴一个字节就永远不超时）。
        //   Node 对 headersTimeout 也是另用一套机制（`connectionsCheckingInterval`
        //   扫描全部连接），而不是 `socket.setTimeout`。JS 定时器在这里反而更便宜
        //   （setTimeout+clearTimeout 合计 0.69 µs，无 FFI）。
        let headersTimer: any = null;
        // 连接是否**空闲**（上一条响应已结束、等下一条请求）。新连接也算空闲 ——
        // 它正等着第一条请求头。两个用途：
        //   ① 新数据到来时判断要不要（重新）武装 headersTimeout；
        //   ② 原生不活动超时触发时判断该不该真的断开。
        let idle = true;
        // 已武装的原生不活动超时值（仅用于诊断日志）。
        let keepAliveArmedMs = 0;

        // ⚠️ 这里**不再解除**原生不活动超时。改造前 `clearTimers()` 会在「空闲连接上
        //    来了新数据」时调 `socket.setTimeout(0)` 把它关掉、响应结束再重新武装，
        //    于是**每请求两次跨 FFI 的原生调用**。实测单次约 1.6 µs、
        //    两次合计 3.25 µs（占单请求预算 4.7%）；对照 JS 的
        //    setTimeout+clearTimeout 只要 0.69 µs —— 贵的是 FFI 往返，不是定时器本身。
        //    现在只保留「响应结束时武装」，由下面 `'timeout'` 里的「空闲才断」保证
        //    请求处理期间不会被误砍。
        //    语义等价性：改造前 headers 一收齐就解除了，所以处理期间本来就没有不活动
        //    超时在跑（requestTimeout 尚未实现）—— 现在它会在处理期间到期并被忽略。
        const clearTimers = () => {
            if (headersTimer) { clearTimeout(headersTimer); headersTimer = null; }
        };

        /** 等请求头；超时即断开（半开的连接不能一直占着）。 */
        const armHeadersTimer = () => {
            clearTimers();
            if (this.headersTimeout > 0) {
                headersTimer = setTimeout(() => {
                    debugLog(`Server: headersTimeout (${this.headersTimeout}ms) reached, destroying connection`);
                    socket.destroy();
                }, this.headersTimeout);
            }
        };

        /** 连接空闲、等下一条请求；超时即回收（"空闲回池/关闭"）。 */
        const armKeepAliveTimer = () => {
            clearTimers();
            idle = true;
            if (this.keepAliveTimeout > 0) {
                socket.setTimeout(this.keepAliveTimeout);
                keepAliveArmedMs = this.keepAliveTimeout;
            }
        };

        // 原生 `'timeout'` 的落点。**只有 keep-alive 不活动超时会走到这里**
        // （headersTimeout 用的是上面的 JS 截止定时器，不经过原生超时）。
        // Node 语义：`'timeout'` 只是通知、不自动关连接；http.Server 的默认处理是销毁。
        //
        // ⚠️ 必须判「空闲」：不活动超时不再随请求生命周期解除武装（见 `clearTimers`），
        //    所以它也可能在响应处理期间到期 —— 那时**不能**断连接。
        //    与改造前等价：那时处理期间压根没有不活动超时在跑。
        socket.on('timeout', () => {
            if (!idle) return;
            debugLog(`Server: keepAliveTimeout (${keepAliveArmedMs}ms) reached, closing idle connection`);
            socket.destroy();
        });

        armHeadersTimer();

        const onData = (data: Buffer) => {
            // 空闲连接上来了数据（下一条请求）→ 从"空闲"切回"等请求头"。
            // 判据是 `idle`（原来用「原生不活动超时还武装着」—— 那个标志已经随
            // 「不再解除武装」的改动一起去掉了，见 `clearTimers`）。
            if (idle) { idle = false; armHeadersTimer(); }

            const handleParsedResult = (result: any) => {
                const metadata = result.metadata;
                if (metadata.startsWith('ERROR:')) {
                    clearTimers();
                    // ⚠️ 发到 **socket** 的 `'error'`（不是 Server 的）—— 交给上面的
                    // `socketOnError` 接管：转 `clientError`；无监听器时按 node 默认块
                    // 「按错误码回 400 / 431 再销毁」。
                    //
                    // 改之前这里是 `this.emit('error')`(**Server**) + 裸 `socket.destroy()`：
                    //   ① Server 没有 `'error'` 监听器时 EventEmitter **直接抛**（未捕获）；
                    //   ② **永远不回 400**，而 node 回（实测 node 侧状态行
                    //      `HTTP/1.1 400 Bad Request`，本侧一个字节都没有）。
                    // parity 用例 `http_client_error.js` 锁住这两条。
                    //
                    // 注意：有 `clientError` 监听器时 node 的契约是「监听器自己负责销毁」，
                    // 所以这里**不再**额外 `socket.destroy()` —— 交给默认块去做。
                    //
                    // `parserError` 会把 `HPE_*` 那几条还原出 node 的 `err.code`
                    // （默认块按码选报文，见 `CLIENT_ERROR_HEADER_TOO_LARGE`）。
                    socket.emit('error', parserError(metadata));
                    return;
                }
                const parsed = JSON.parse(metadata);
                if (result.body) {
                    parsed.body = Buffer.from(result.body);
                }

                if (parsed.is_headers) {
                    // 请求头到齐：两个空闲计时器都不再适用（响应期间的保护是 requestTimeout
                    // 的职责，本库尚未实现，见 Server 类上的注释）。
                    clearTimers();

                    // Handle CONNECT method (HTTP Tunneling)
                    if (parsed.is_connect) {
                        const req = new IncomingMessage(socket);
                        req.method = parsed.method;
                        req.url = parsed.path;
                        req.httpVersion = '1.' + parsed.version;
                        req.headers = parsed.headers;
                        req.rawHeaders = parsed.raw_headers || [];

                        // Remove our data listener to stop feeding the parser
                        // The user is responsible for handling the socket data stream from now on
                        socket.removeListener('data', onData);

                        debugLog(`Server: CONNECT request received, emitting 'connect' event`);

                        // 切分点之后的字节由解析器经 `body` 通道带出来（见
                        // `http_parser.rs::try_parse_request_headers`）：CONNECT 之后是
                        // 不透明隧道流，那批字节在 Node 里就是 `'connect'` 的 head 参数。
                        // 客户端把隧道协议的初始字节与 CONNECT 请求打进**同一个 TCP 包**
                        // 时，没有它用户就永远拿不到（此前恒为空 Buffer，R5）。
                        const head = parsed.body ?? Buffer.alloc(0);

                        if (this.listenerCount('connect') > 0) {
                            this.emit('connect', req, socket, head);
                        } else {
                            // Default behavior: close connection if no listener
                            socket.destroy();
                        }
                        return;
                    }

                    const currentReq = new IncomingMessage(socket);
                    currentReq.method = parsed.method;
                    currentReq.url = parsed.path;
                    currentReq.httpVersion = '1.' + parsed.version;
                    currentReq.headers = parsed.headers;
                    currentReq.rawHeaders = parsed.raw_headers || [];
                    // node 侧服务端请求的 `statusCode` / `statusMessage` 是 **own data 且为 null**
                    // （实测；客户端那份 `res` 才带真实状态码，见 ClientRequest 那边）。
                    // 放在这里而不是类里统一初始化：客户端路径会被真实值覆盖，一刀切会冲掉它。
                    currentReq.statusCode = null as any;
                    currentReq.statusMessage = null as any;
                    req = currentReq;

                    const currentRes = new ServerResponse(socket, parsed.method ?? 'GET');
                    // node 的 `res.req`（中间件靠它反查请求）。
                    currentRes.req = currentReq;
                    // 连接复用与否由**请求头**决定（HTTP/1.1 默认复用、HTTP/1.0 默认不复用），
                    // 用户随后可以改 `res.shouldKeepAlive`。node 实测：为 false 时响应带
                    // `Connection: close`，并在收尾后关连接。
                    currentRes.shouldKeepAlive = requestAllowsKeepAlive(parsed);
                    // node 的 `res._keepAliveTimeout`（实测 5000，来自 `server.keepAliveTimeout`）：
                    // keep-alive 响应会据此发 `Keep-Alive: timeout=<秒>`。
                    // 不注入的话那一行永远不发 —— 又是「字段在、线字节不对」。
                    currentRes._keepAliveTimeout = this.keepAliveTimeout;
                    // node 的 `_http_server.js` 是走 `res.assignSocket(socket)` 接线的，
                    // 于是 `socket._httpMessage === res`。本类在构造函数里直接接 socket，
                    // 所以这**一条**要显式补：缺了它
                    //   ① `res.assignSocket(自己的 socket)` 不会抛 `ERR_HTTP_SOCKET_ASSIGNED`
                    //      （node 会抛，实测）—— 「重复接线」这个错误就静默过去了；
                    //   ② `OutgoingMessage._writeRaw` 那种「只有 `_httpMessage === this`
                    //      才直写」的判据在别处会取到假。
                    (socket as any)._httpMessage = currentRes;
                    res = currentRes;

                    // Support Keep-Alive: reset state once response is done
                    currentRes.on('finish', () => {
                        req = null;
                        res = null;
                        if (socket.destroyed) return;
                        if (currentRes._shouldCloseConnection) {
                            // 优雅收尾：`end()` 会把已排队的字节冲出去再发 FIN。
                            // ⚠️ 这里**不能**用 `destroy()` —— 它可能把还没落到内核的
                            // 用户态缓冲丢掉，表现为响应被截断。
                            socket.end();
                        } else {
                            // 响应结束、连接回到空闲：起 keepAliveTimeout，闲置太久就回收。
                            armKeepAliveTimer();
                        }
                        // The parser should already be reset in Rust
                    });

                    if (isUpgradeRequest(req.headers) && this.listenerCount('upgrade') > 0) {
                        debugLog(`Server: Upgrade request received, emitting 'upgrade' event`);
                        // node 的 `req.upgrade`（own data，实测默认 false）：连接被交出去
                        // 之后就置 true。缺它的话，靠 `req.upgrade` 判别「这是升级请求还是
                        // 普通请求」的代码会拿到 false。
                        req.upgrade = true;
                        // **必须摘掉 data 监听**（与上面的 CONNECT 同一条规则）：升级之后
                        // 连接里是不透明字节流（WebSocket 帧等），parser 再喂进去会把帧
                        // 当 HTTP 请求解析并往隧道里写错误响应 —— 表现为 ws 客户端报
                        // `WS_ERR_UNEXPECTED_RSV_1`（T4 实测：帧后面的 "HTTP/1.1 ..." 被当成
                        // 帧头，'H'=0x48 带 RSV1）。node 在 'upgrade' 之后也不再解析。
                        socket.removeListener('data', onData);
                        // 与 CONNECT 同理（R7）：升级请求之后连接被交出去、后面是不透明
                        // 字节流，切分点之后的字节由 parser 经 `body` 通道带出来，在 Node
                        // 里就是 `'upgrade'` 的 head 参数（此前恒为空 Buffer）。
                        const head = parsed.body ?? Buffer.alloc(0);
                        this.emit('upgrade', req, socket, head);
                        return;
                    }

                    const expect = req.headers['expect'];
                    if (expect && (typeof expect === 'string' && expect.toLowerCase() === '100-continue')) {
                        if (this.listenerCount('checkContinue') > 0) {
                            this.emit('checkContinue', req, res);
                        } else {
                            // 与公开 API `res.writeContinue()` 同一份线字节（同一个方法，
                            // 不再内联字符串 —— 两处各写一遍迟早会漂）。
                            res.writeContinue();
                            this.emit('request', req, res);
                        }
                    } else {
                        debugLog(`Server: Emitting 'request' for ${req.method} ${req.url}`);
                        this.emit('request', req, res);
                    }
                }

                // Push body/EOF into IncomingMessage.
                // CRITICAL: When headers and body arrive in the same TCP packet
                // (parsed.is_headers && body present), the user's 'request' handler
                // has just been called synchronously above. The readable-stream
                // library schedules its internal resume/flow via process.nextTick.
                // If we push() synchronously here, the data lands in the buffer
                // *before* the Readable enters flowing mode, and since no further
                // socket data events will arrive, the flow() loop never drains it.
                // Solution: always defer body/EOF push via process.nextTick so the
                // Readable has a chance to enter flowing mode first.
                // 带 `Upgrade` 头但**没有** upgrade 监听器时（Node 也是走普通请求）：
                // headers 消息里那批字节是**隧道流的开头**，不是本请求的 body → 丢弃，
                // 不能 push 进 IncomingMessage（会被误当成请求体）。
                // 只在 headers 消息上判定：带 Content-Length 的升级请求走的是 body 消息
                // （is_headers=false），那里的字节是**真 body**，必须照常 push。
                const _upgradeHeadDropped = !!(parsed.is_headers && req && isUpgradeRequest(req.headers));
                const _bodyToPush = req && !_upgradeHeadDropped && parsed.body && parsed.body.length > 0
                    ? Buffer.from(parsed.body) : null;
                const _isComplete = !!(req && parsed.complete);
                const _trailers = parsed.trailers;
                const _rawTrailers = parsed.raw_trailers;
                const _reqRef = req;

                // Diagnostic: log body delivery state (requires debug mode)
                // 每个数据包都会走到这里 → thunk，避免 verbose 关闭时白拼 3 段字符串
                debugLog(() => `[Server] handleParsedResult: is_headers=${parsed.is_headers}, ` +
                    `bodyLen=${_bodyToPush?.length ?? 0}, complete=${_isComplete}, ` +
                    `req.readableFlowing=${(_reqRef as any)?._readableState?.flowing}`);

                if (_bodyToPush !== null || _isComplete) {
                    if (parsed.is_headers && _bodyToPush !== null) {
                        // Same-packet case: defer to give Readable time to enter flowing mode
                        debugLog(`[Server] Deferring body/EOF push via setImmediate (same-packet)`);
                        setImmediate(() => {
                            if (!_reqRef) return;
                            debugLog(() => `[Server] setImmediate: pushing body=${_bodyToPush?.length ?? 0}, EOF=${_isComplete}`);
                            if (_bodyToPush) _reqRef.push(_bodyToPush);
                            if (_isComplete) {
                                _reqRef.complete = true;
                                if (_trailers) _reqRef.trailers = _trailers;
                                if (_rawTrailers) _reqRef.rawTrailers = _rawTrailers;
                                _reqRef.push(null);
                            }
                        });
                    } else {
                        // Subsequent-packet case: push immediately
                        //
                        // 也覆盖「同一包里只有 EOF、没有 body」这一形态（GET 无 body 的常见
                        // 情形，实测占 B2 负载的 100%）：`push(null)` **不携带数据**，不存在
                        // 上面那个「数据先于 flowing 模式落进缓冲就再也排不空」的隐患，
                        // 所以不必绕 `setImmediate`。省掉每请求一次任务投递 + 一次回调
                        // （实测约 1.2–2 µs）。
                        // 有 body 的同包情形仍然走上面的延迟分支 —— 那条不能动。
                        debugLog(`[Server] Pushing body/EOF immediately (same-packet EOF-only or subsequent-packet)`);
                        if (_bodyToPush) _reqRef!.push(_bodyToPush);
                        if (_isComplete) {
                            _reqRef!.complete = true;
                            if (_trailers) _reqRef!.trailers = _trailers;
                            if (_rawTrailers) _reqRef!.rawTrailers = _rawTrailers;
                            _reqRef!.push(null);
                        }
                    }
                }

                // For Keep-Alive, try to parse remaining buffer in case of pipelining
                if (parsed.complete && !req) {
                    // This case is handled by the feed loop if multiple messages in data
                }
            };

            let input: ArrayBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
            let iterations = 0;
            const maxIterations = 2000; // Safety limit
            while (iterations < maxIterations) {
                iterations++;
                const result = parser.feed(input);
                const metadata = result.metadata;
                if (!metadata || metadata === '') {
                    // 空 metadata = 数据不足，等下一包
                    break;
                }
                if (metadata.startsWith('ERROR:')) {
                    // 解析失败：交给 handleParsedResult 的错误分支（emit error + destroy socket）。
                    // 此前这里直接 break，于是坏数据留在 Rust 侧缓冲里反复失败、连接既不报错
                    // 也不断开（TS-H6）。
                    debugLog(`[HTTP] Server: Parser error: ${metadata}`);
                    handleParsedResult(result);
                    break;
                }
                handleParsedResult(result);
                input = new ArrayBuffer(0); // Continue with empty input to drain Rust buffer
            }
        };
        socket.on('data', onData);

        // CRITICAL: Ensure server-side socket starts flowing!
        socket.resume();

        socket.on('close', () => {
            clearTimers();
            this._httpConnections.delete(socket);
            if (req && !req.readableEnded) {
                req.push(null);
            }
            // 转发给**当前**在飞的响应：对端在响应写完前断开时，ServerResponse
            // 必须照常发 'close'（Node 语义）。放在末尾是为了保持原有的监听器顺序
            // （原来的每请求 `socket.once('close')` 注册在连接级监听之后，所以它
            // 也是在 clearTimers / push(null) 之后才跑的）。
            // 响应已结束时 `res` 已被置 null → 这里什么都不做，与原语义一致。
            const r = res;
            if (r) r._handleSocketClose();
        });

        // ⚠️ 对齐 node 的 `socketOnError`（逐字对照 `lib/_http_server.js` v22.22.2；
        //    背景与实测数据见文件头 `clientError` 那节）。三步一步都不能少。
        const socketOnError = (err: Error) => {
            // ① "Ignore further errors" —— 少了这步，下面的 `destroy(err)` 会让 socket
            //    再发一次 `'error'` 又回到这里 ⇒ 递归 / 冒成未捕获异常。
            socket.removeListener('error', socketOnError);
            if (socket.listenerCount('error') === 0) {
                socket.on('error', noop);
            }

            // ② 服务端 socket 的错误归 **`clientError`**（node 从不走 `server.emit('error')`）。
            if (!this.emit('clientError', err, socket)) {
                // ③ 默认块：**没有** `clientError` 监听器时（`emit` 返回 false）才走。
                //    只在「仍可写 且 没有在途响应 / 在途响应还没发头」时回报文 ——
                //    ECONNRESET 时 socket 通常已不可写 ⇒ 自然不写（与 node 同）。
                //    ⚠️ node 判的是内部 `_headerSent`；本包只暴露 `headersSent`，语义等价。
                //
                //    报文**按错误码选**：`HPE_HEADER_OVERFLOW` ⇒ 431，其余 ⇒ 400
                //    （node `socketOnError` 的默认块就是这个规则，实测见文件头）。
                const inFlight = (socket as any)._httpMessage;
                if (socket.writable && (!inFlight || !inFlight.headersSent)) {
                    // ⚠️ **必须在写落地之后**才 `destroy()`。
                    //
                    // 本包的 `Socket._write` 走的是**异步**原生写（等 WRITTEN/BUSY 裁决，
                    // 见 net.ts 的 `_pendingNativeWrite`），`write()` 返回时字节**还没交给
                    // 内核**；紧接着 `destroy()` 会把它们直接丢掉。
                    // 实测（head=20000/40000 连跑 20 次）：
                    //   · 丢的时候客户端收到 **0 字节 + 优雅 FIN**（`[connect,sent,end,close]`），
                    //     **不是** RST —— 所以不能靠"等 RST"来解释；
                    //   · 而 `socketOnError` 里的守卫**是通过的**（诊断打印过
                    //     `writable=true destroyed=false hasInFlight=false`），`write()` 确实被调了。
                    // node 不丢，是因为它的 `_write` **同步**落到内核，`destroy()` 之后
                    // 内核仍会把发送缓冲冲出去。
                    //
                    // 把 `destroy` 挂到写回调上即可（写完成 → 字节已在内核 → FIN 会把它们带走）。
                    // 回调一定会被调用：原生写完成、失败、或 socket 被销毁时 readable-stream
                    // 都会回调，所以不会因此漏掉销毁。
                    socket.write((err as any).code === 'HPE_HEADER_OVERFLOW'
                        ? CLIENT_ERROR_HEADER_TOO_LARGE
                        : CLIENT_ERROR_BAD_REQUEST, () => socket.destroy(err));
                    return;
                }
                socket.destroy(err);
            }
        };
        socket.on('error', socketOnError);
    }

    /**
     * ⚠️ node 的 `http.Server.prototype` **自有** `close`（它比 net 的多做一件事：
     * 顺带关掉空闲连接）。本包保留这个自有成员并转发给 `super.close()`。
     *
     * ⚠️ `listen` / `address` / `listening` **不在这里重写** —— 直接继承 `net.Server`。
     * 重写会遮蔽基类同名成员，`instanceof` 变真而行为还是旧的那份转发（假象）。
     */
    close(callback?: (err?: Error) => void): this {
        super.close(callback);
        return this;
    }

    // @ts-ignore
    async[Symbol.asyncDispose]() {
        return new Promise<void>((resolve) => {
            this.close(() => resolve());
        });
    }

    /**
     * node 的 `http.Server.prototype` **自有** `setTimeout`。转发给 `super.setTimeout()`
     * —— 后者会把 callback 挂到自己的 `'timeout'` 事件上，并给每条新连接套用超时。
     *
     * ⚠️ 原来这里转发给 `this._netServer.setTimeout(...)`，而 `_netServer` 的
     * `'timeout'` 事件是**再转发**回 http.Server 的 —— 真继承后这一跳省掉了。
     */
    setTimeout(ms: number, callback?: () => void): this {
        super.setTimeout(ms, callback);
        return this;
    }
}

// ========== Agent ==========

/**
 * H2 池键 = H1 池键 + 这个后缀。
 * M5-2 收编已握手流时要把它反推回 H1 桶（`freeSockets` 的键是 H1 键）。
 */
const H2_POOL_SUFFIX = ':h2';

export interface AgentOptions {
    keepAlive?: boolean;
    keepAliveMsecs?: number;
    maxSockets?: number;
    maxTotalSockets?: number;
    maxFreeSockets?: number;
    scheduling?: 'fifo' | 'lifo';
    timeout?: number;
    maxCachedSessions?: number;
    proxy?: string;
    /** `https://` 代理这一跳的 TLS 配置（仅对 https 代理生效）。 */
    proxyTls?: ProxyTlsOptions;
    /** Chrome 指纹（impersonate）；缺省读全局 configure()。 */
    impersonate?: boolean | 'chrome';
    profile?: string;
    forceHttp1?: boolean;
    /** 同一池键最多几个 H2 session（默认 1）。 */
    h2MaxSessions?: number;
    /** H2 session 空闲多久后关闭（默认 60s；0 = 不自动关闭）。 */
    h2SessionIdleTimeout?: number;
    /** 额外收紧的并发流上限（0 = 使用服务端宣告值）。 */
    maxConcurrentStreams?: number;
    /** session 排队等待的上限（默认 30s；0 = 不超时）。 */
    h2QueueTimeout?: number;
}

export class Agent extends EventEmitter {
    public maxSockets: number = Infinity;
    public maxTotalSockets: number = Infinity;
    public maxFreeSockets: number = 256;
    public keepAlive: boolean = false;
    public keepAliveMsecs: number = 1000;
    public maxCachedSessions: number = 100;
    public scheduling: 'fifo' | 'lifo' = 'lifo';
    /**
     * `AgentOptions.timeout`：agent 新建的每条 socket 都会套上这个空闲超时，超时到点
     * 且 socket 正空闲（没在途请求）时才销毁。完整语义与实测基线见 `agentTimeout.ts`。
     *
     * ⚠️ 做成访问器而不是裸字段：校验要在**赋值期**发生。裸字段的话坏值要等到
     * `createConnection` 里的 `socket.setTimeout` 才抛，而那是在 `nextTick`
     * （`agent.addRequest`）里跑的 ⇒ 变成穿过 native→JS 边界的未捕获异常
     * （无头宿主实测 exit 134，同 ERR_UNESCAPED_CHARACTERS 那次）。
     */
    private _timeout?: number;
    public get timeout(): number | undefined {
        return this._timeout;
    }
    public set timeout(value: number | undefined) {
        this._timeout = validateAgentTimeout(value);
    }

    public requests: Record<string, ClientRequest[]> = {};
    public sockets: Record<string, Socket[]> = {};
    public freeSockets: Record<string, Socket[]> = {};
    /**
     * Node 的公开字段：构造器传进来的**原样**选项集合（含 TLS 材料）。本包此前没存，
     * 于是 `new https.Agent({ ca })` 上的 `ca` 在构造器读完池元数据之后就掉了，
     * 建连与池键都只能看见请求级字段（#50 / F10）。
     */
    public options: AgentOptions & Record<string, any> = {};
    private _totalSockets: number = 0;
    /** `getEffectiveConnectOptions` 的记忆化表（键 = 请求 options 对象身份）。 */
    private _effectiveOptionsCache = new WeakMap<object, Record<string, any>>();
    public proxy: string | null = null;
    public proxyTls?: ProxyTlsOptions;
    public impersonate?: boolean | 'chrome';
    public profile?: string;
    public h2MaxSessions: number = 1;
    public h2SessionIdleTimeout: number = 60_000;
    public maxConcurrentStreams: number = 0;
    public h2QueueTimeout: number = 30_000;
    private _h2Sessions: Record<string, Http2Session[]> = {};
    private _h2Requests: Record<string, ClientRequest[]> = {};
    private _h2H1Only = new Set<string>();

    /**
     * Gets the proxy URL for the given request options.
     * Checks HTTP_PROXY, HTTPS_PROXY, and NO_PROXY environment variables.
     * 
     * @param options Request options to determine if proxy should be used
     * @returns Proxy URL or null if no proxy should be used
     */
    protected getProxy(options: RequestOptions): string | null {
        // Per-request proxy wins, then agent-level proxy, then env.
        if (options.proxy) return options.proxy;
        if (this.proxy) return this.proxy;

        // Check environment variables (React Native may not have process.env)
        const env = typeof process !== 'undefined' && process.env ? process.env : {};
        const isHttps = options.protocol === 'https:';
        const host = options.hostname || options.host || 'localhost';

        // Check NO_PROXY first
        const noProxy = env.NO_PROXY || env.no_proxy;
        if (noProxy) {
            const noProxyList = noProxy.split(',').map(s => s.trim().toLowerCase());
            const hostLower = host.toLowerCase();
            for (const pattern of noProxyList) {
                if (pattern === '*') return null;
                if (pattern.startsWith('.') && hostLower.endsWith(pattern)) return null;
                if (hostLower === pattern) return null;
                if (hostLower.endsWith('.' + pattern)) return null;
            }
        }

        // Get proxy URL based on protocol
        const proxyUrl = isHttps
            ? (env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy)
            : (env.HTTP_PROXY || env.http_proxy);

        return proxyUrl || null;
    }

    constructor(options?: AgentOptions) {
        super();
        this.options = { ...(options as Record<string, any> | undefined) };
        if (options?.maxSockets) this.maxSockets = options.maxSockets;
        if (options?.maxTotalSockets) this.maxTotalSockets = options.maxTotalSockets;
        if (options?.maxFreeSockets) this.maxFreeSockets = options.maxFreeSockets;
        if (options?.keepAlive) this.keepAlive = options.keepAlive;
        if (options?.keepAliveMsecs) this.keepAliveMsecs = options.keepAliveMsecs;
        if (options?.scheduling) this.scheduling = options.scheduling;
        // setter 里校验并归一（0 ⇒ 不武装）。
        this.timeout = options?.timeout;
        if (options?.maxCachedSessions !== undefined) this.maxCachedSessions = options.maxCachedSessions;
        if (options?.proxy) this.proxy = options.proxy;
        if (options?.proxyTls) this.proxyTls = options.proxyTls;
        if (options?.impersonate !== undefined) this.impersonate = options.impersonate;
        if (options?.profile) this.profile = options.profile;
        if (options?.h2MaxSessions !== undefined) {
            if (!Number.isFinite(options.h2MaxSessions) || options.h2MaxSessions < 1) {
                throw new RangeError('h2MaxSessions must be a positive number');
            }
            this.h2MaxSessions = Math.floor(options.h2MaxSessions);
        }
        if (options?.h2SessionIdleTimeout !== undefined) {
            if (!Number.isFinite(options.h2SessionIdleTimeout) || options.h2SessionIdleTimeout < 0) {
                throw new RangeError('h2SessionIdleTimeout must be >= 0');
            }
            this.h2SessionIdleTimeout = options.h2SessionIdleTimeout;
        }
        if (options?.maxConcurrentStreams !== undefined) {
            this.maxConcurrentStreams = Math.max(0, Math.floor(options.maxConcurrentStreams));
        }
        if (options?.h2QueueTimeout !== undefined) {
            if (!Number.isFinite(options.h2QueueTimeout) || options.h2QueueTimeout < 0) {
                throw new RangeError('h2QueueTimeout must be >= 0');
            }
            this.h2QueueTimeout = options.h2QueueTimeout;
        }
    }

    /**
     * 参与「agent 级覆盖请求级」合并的字段名单。`https.Agent` 会追加 TLS 材料。
     * 名单之外的一律不进建连参数（`agent.options` 里那些池元数据不是 connect 选项）。
     */
    protected connectOptionFields(): readonly string[] {
        return HTTP_CONNECT_FIELDS;
    }

    /**
     * 有效建连参数 = 请求级 ⊕ agent 级（agent 胜出，Node 语义）。
     * 按**请求 options 对象身份**记忆化：`getName` 一个请求要算 3–4 次，池键里还要读
     * PEM（见 tlsPoolKey.ts 的缓存说明），每次都新建一份合并对象会让那层的 WeakMap 全落空。
     * ⚠️ 因此请求发出后**改动同一 options 对象上的这些字段不会被察觉**（现有调用链不这么用；
     *    ClientRequest 只在自己的字段上补 `path`/`headers`，那些都不是名单内字段）。
     */
    protected getEffectiveConnectOptions(options: RequestOptions): Record<string, any> {
        const key = options as unknown as object;
        const hit = this._effectiveOptionsCache.get(key);
        if (hit !== undefined) return hit;
        const merged = applyAgentConnectOverrides(options, this.options, this.connectOptionFields());
        this._effectiveOptionsCache.set(key, merged);
        return merged;
    }

    public getName(options: RequestOptions): string {
        const eff = this.getEffectiveConnectOptions(options);
        let name = `${eff.host || eff.hostname || 'localhost'}:${eff.port || (options.protocol === 'https:' ? 443 : 80)}:`;
        if (eff.localAddress) name += `${eff.localAddress}:`;
        if (eff.family) name += `${eff.family}:`;
        const proxy = this.getProxy(options);
        if (proxy) name += `proxy:${proxy}:`;
        return name;
    }

    public addRequest(req: ClientRequest, options: RequestOptions) {
        const name = this.getName(options);
        debugLog(`Agent.addRequest: name=${name}, totalSockets=${this._totalSockets}`);

        // 1. Check if there's an idle socket in freeSockets
        if (this.freeSockets[name] && this.freeSockets[name].length > 0) {
            const socket = this.scheduling === 'lifo'
                ? this.freeSockets[name].pop()!
                : this.freeSockets[name].shift()!;

            if (this.freeSockets[name].length === 0) delete this.freeSockets[name];

            // 取出即取消空闲销毁定时器（回池时设的，见 releaseSocket）
            if ((socket as any)._agentIdleTimer) {
                clearTimeout((socket as any)._agentIdleTimer);
                delete (socket as any)._agentIdleTimer;
            }

            // Re-use socket
            if (!this.sockets[name]) this.sockets[name] = [];
            this.sockets[name].push(socket);

            // 必须走 reuseSocket()：它会先摘掉 releaseSocket 留下的 _agentOnClose 监听。
            // 否则那条陈旧监听会在 socket 之后关闭时再 _removeSocket 一次，把计数改坏（TS-M2）。
            this.reuseSocket(socket, req);
            return;
        }

        // 2. Check if we can create a new connection
        const currentSockets = (this.sockets[name]?.length || 0);
        if (currentSockets < this.maxSockets && this._totalSockets < this.maxTotalSockets) {
            if (!this.sockets[name]) this.sockets[name] = [];

            // Increment total sockets early
            this._totalSockets++;

            // ClientRequest handles connection but we signal it to proceed
            req.onSocket(null as any);
            return;
        }

        // 3. Queue the request
        if (!this.requests[name]) this.requests[name] = [];
        this.requests[name].push(req);
    }

    /**
     * H2 分支入口：按池键复用 session；没有就新建。ALPN 只选 h1 时回退 H1
     * （同一 Agent 生命周期内记住该池键，避免每条请求都多一次握手）。
     */
    public addH2Request(req: ClientRequest, options: RequestOptions): void {
        const name = `${this.getName(options)}${H2_POOL_SUFFIX}`;
        if (this._h2H1Only.has(name)) {
            req.onHttp2Fallback();
            return;
        }
        const sessions = this._h2Sessions[name] ?? [];
        const ready = sessions.find(
            (session) => !session.destroyed && !session.draining && session.ready
        );
        if (ready) {
            if (this.maxConcurrentStreams > 0 && ready.pendingRequests >= this.maxConcurrentStreams) {
                this._queueH2(name, req);
            } else {
                req.onH2Session(ready);
            }
            return;
        }
        const connecting = sessions.find((session) => !session.destroyed && !session.draining);
        this._queueH2(name, req);
        if (!connecting && (this._h2Sessions[name]?.length ?? 0) < this.h2MaxSessions) {
            this._createH2Session(name, options);
        }
    }

    private _queueH2(name: string, req: ClientRequest): void {
        if (!this._h2Requests[name]) this._h2Requests[name] = [];
        this._h2Requests[name].push(req);
        if (this.h2QueueTimeout > 0) {
            const timer = setTimeout(() => {
                const queue = this._h2Requests[name];
                if (!queue) return;
                const index = queue.indexOf(req);
                if (index === -1) return;
                queue.splice(index, 1);
                if (queue.length === 0) delete this._h2Requests[name];
                delete (req as any)._h2QueueTimer;
                req.emit('error', errWithCode(
                    'timed out waiting for an http2 session slot',
                    'ERR_HTTP2_QUEUE_TIMEOUT'
                ));
            }, this.h2QueueTimeout);
            (req as any)._h2QueueTimer = timer;
        }
    }

    private _takeH2Queue(name: string): ClientRequest[] {
        const queue = this._h2Requests[name] ?? [];
        delete this._h2Requests[name];
        for (const req of queue) {
            if ((req as any)._h2QueueTimer) {
                clearTimeout((req as any)._h2QueueTimer);
                delete (req as any)._h2QueueTimer;
            }
        }
        return queue;
    }

    /** 在并发上限内把排队的请求分配到一个已就绪的 session。 */
    private _pumpH2(name: string, session: Http2Session): void {
        if (session.destroyed || session.draining || !session.ready) return;
        const queue = this._h2Requests[name];
        if (!queue || queue.length === 0) return;
        const limit = this.maxConcurrentStreams;
        while (queue.length > 0 && (limit === 0 || session.pendingRequests < limit)) {
            const req = queue.shift()!;
            if ((req as any)._h2QueueTimer) {
                clearTimeout((req as any)._h2QueueTimer);
                delete (req as any)._h2QueueTimer;
            }
            if (req.destroyed) continue;
            req.onH2Session(session);
        }
        if (queue.length === 0) delete this._h2Requests[name];
    }

    private _createH2Session(name: string, options: RequestOptions): void {
        const session = new Http2Session();
        if (session.destroyed) {
            this._h2H1Only.add(name);
            this._fallbackH2Queue(name);
            return;
        }
        const idle = this.h2SessionIdleTimeout;
        const agentTimeout = this.timeout;
        session.idleTimeout =
            idle > 0
                ? agentTimeout !== undefined && agentTimeout > 0
                    ? Math.min(idle, agentTimeout)
                    : idle
                : agentTimeout !== undefined && agentTimeout > 0
                  ? agentTimeout
                  : 0;
        if (!this._h2Sessions[name]) this._h2Sessions[name] = [];
        this._h2Sessions[name].push(session);

        session.once('ready', () => {
            debugLog(`Agent: h2 session ready for ${name}`);
            this._pumpH2(name, session);
        });
        session.on('error', (err: Error) => this._onH2SessionError(name, session, err));
        session.on('goaway', () => this._onH2SessionGoaway(name, session));
        session.on('stream-end', () => this._pumpH2(name, session));
        session.once('close', () => this._onH2SessionClose(name, session));
        // keylog 的落点与 H1 保持**同一个形状**：由 Agent 发 'keylog'，第二参数是连接本身
        // （H1 那半在 `Agent.createConnection` 里转发 socket 的事件；
        // `docs/compatibility_audit_https.md` 记的也是这一面）。链路其余几段本来都是通的 ——
        // `serializeProfileTlsOptions` 透传 `keylog` 位、原生 `build_ssl` 装了 callback、
        // `Http2Session` 收到 KEYLOG 也 emit —— 但**没人订阅 session 的 'keylog'**，
        // 而且原生把行发成了 socket 通道的号（详见 rust_c_net/src/impersonate.rs 的 `KeylogSink`）。
        // 两处补齐后实测 H2 与 H1 同形（各 5 行 `CLIENT_HANDSHAKE_TRAFFIC_SECRET …`，#58/#61）。
        session.on('keylog', (line: Buffer) => this.emit('keylog', line, session));

        const first = (this._h2Requests[name] ?? [])[0];
        const impersonation = first
            ? ((first as any)._impersonation as ImpersonationConnectOptions | null)
            : null;
        if (!impersonation) {
            this._h2H1Only.add(name);
            this._fallbackH2Queue(name);
            session.destroy();
            return;
        }

        // H2 这一支同样只读请求级字段过（#50 的同一类缺陷）：agent 上的 TLS 材料必须与
        // H1 的 createConnection、以及**池键**看到的内容一致，否则会出现「键里有 agent.ca、
        // 建连却不用它」的自相矛盾。
        // ⚠️ 矩阵夹具是普通 node https 服务、不提供 h2 ALPN，所以这一支**没有被矩阵覆盖**
        //    （请求会落回 H1）。见 FINDINGS.md #50 的「未验」条目。
        const eff = this.getEffectiveConnectOptions(options);
        const host = eff.hostname || eff.host || 'localhost';
        // 端口必须是数字：native h2 建连与 H1 的 driver 一样只收 number（见 socketPort.ts）。
        const port = normalizeSocketPort(eff.port || 443);
        const serverName = eff.servername || host;
        let proxy: ParsedProxy | undefined;
        const proxyUrl = this.getProxy(options);
        if (proxyUrl) {
            try {
                proxy = parseProxy(proxyUrl);
            } catch (err) {
                this._failH2Queue(name, err as Error);
                session.destroy();
                return;
            }
        }

        const proxyTls = (options as any).proxyTls ?? this.proxyTls;
        // M5-2：ALPN 回退时要把已握手流收编成 **H1** 连接 —— 池键与 SNI 在创建 session
        // 时就记下来，错误回调里只拿得到 H2 池名。
        session.h1PoolName = name.endsWith(H2_POOL_SUFFIX)
            ? name.slice(0, -H2_POOL_SUFFIX.length)
            : undefined;
        session.servername = serverName;
        // 带 `session` 的请求要求「用这份会话握手」；收编一条已握手的连接会把它吞掉，
        // 只能走重连（node 在「新建连接」的形态下同样会用它完成握手）。
        session.requiresHandshake = (eff as any).session !== undefined;
        try {
            session.connect({
                host,
                port,
                serverName,
                profileJson: JSON.stringify(impersonation.profileData),
                optionsJson: serializeProfileTlsOptions(eff, impersonation),
                proxyJson: serializeProfileProxy(proxy, proxyTls),
            });
        } catch (err) {
            this._onH2SessionError(name, session, err as Error);
        }
    }

    private _fallbackH2Queue(name: string): void {
        for (const req of this._takeH2Queue(name)) {
            req.onHttp2Fallback();
        }
    }

    private _failH2Queue(name: string, err: Error): void {
        for (const req of this._takeH2Queue(name)) {
            req.emit('error', err);
        }
    }

    private _onH2SessionError(name: string, session: Http2Session, err: Error): void {
        const code = (err as any)?.code;
        if (code === 'ERR_HTTP2_ALPN_H1') {
            // M5-2：原生在 ALPN 不选 h2 时把**已握手**的 TLS 流留了下来（`close_once`
            // 之后仍可按 session id 取回）。收编成 H1 连接并登记进池子，第一条回退请求
            // 直接复用它 —— 判据「任何 H1 结局只握手一次」靠的就是这一句。
            const adopted = this._adoptH2Stream(session);
            debugLog(
                `Agent: ${name} only supports http/1.1; ${
                    adopted ? 'adopted the established stream' : 'reconnecting'
                } for H1`
            );
            this._h2H1Only.add(name);
            this._fallbackH2Queue(name);
        } else {
            this._failH2Queue(name, err);
        }
        session.destroy();
    }

    /**
     * M5-2：把原生保留的那条已握手流收编成一条普通 TLS socket，并**登记进 `freeSockets`**。
     *
     * ⚠️ 只把它交给触发回退的那条请求是不够的：下一条请求会重新建连，多出来的握手只是
     * 挪到第 2 条请求上（200 条请求 ⇒ 200 次握手）。所以这里走 `_poolSocket`，之后的
     * `addRequest` 与一条正常 keep-alive 连接完全同路。
     *
     * 驱动本身已经完成握手（原生侧 `net_h2_take_stream` 用 `spawn_socket_tasks_with_channels`
     * 建好了读写任务），这里**不**调用 `connect()`，不会再发 ClientHello。
     *
     * @returns 是否收编成功；false ⇒ 调用方维持旧的「销毁后重连」回退。
     */
    private _adoptH2Stream(session: Http2Session): boolean {
        const h1Name = session.h1PoolName;
        if (!h1Name || session.requiresHandshake || !session.canTakeStream()) return false;

        let driver: NetSocketDriver;
        try {
            driver = session.takeStream();
        } catch (error) {
            debugLog(() => `Agent: takeStream failed: ${String((error as Error)?.message)}`);
            return false;
        }
        if (!driver || Number((driver as any).id) === 0) return false;

        // 与 Server accept 出来的一条连接同一条构造路径：`Socket` 只接管驱动、不建连，
        // `TLSSocket` 再包一层（server 侧的 `new TLSSocket(socket)` 同款）。
        const raw = new Socket({ socketDriver: driver });
        // TLSSocket 构造器只会从**本包 Socket** 身上抄 `_servername`。
        (raw as any)._servername = session.servername;
        const socket = new TLSSocket(raw);
        // H2 只可能在 impersonate 下建立 ⇒ 这条流是 btls，能交出 node 那样的 session 字节
        // （原生 ctx 已带握手时那份 DER，见 `apply_btls_metadata`）。
        (socket as any)._sessionBytesSupported = true;
        // 驱动还活着 ⇒ 立刻把握手观测值快照下来（#80），否则驱动销毁后 getter 全空。
        socket._captureTlsSnapshot();
        // taken socket 的 loop token 由持有者取（与 accepted socket 相同），
        // 释放走 `_destroy`；不取的话进程可以在池里还留着连接时退出。
        socket._acquireLoopRef();
        // 这条连接没有「连接阶段」：不设这个旗标的话 `Socket.setTimeout` 会顺手武装一条
        // JS connect 计时器，5s 后往一条空闲池化连接上发一个假的 'timeout'。
        (socket as any)._connectSettled = true;
        // 与 `createConnection` 里的 agent.timeout 同款：空闲到点才销毁（Node 语义）。
        armAgentSocketTimeout(
            socket,
            this.timeout,
            () => (this.freeSockets[h1Name] || []).includes(socket)
        );

        // 池位计数：`createConnection` 每建一条就 +1，收编的这条也占一个名额；
        // 归还（回池/关闭）走 `_removeSocket` 的同一套 -1。
        this._totalSockets++;
        this._poolSocket(socket, h1Name);
        return true;
    }

    private _onH2SessionGoaway(name: string, session: Http2Session): void {
        // 从池里摘掉（不 destroy：在途流继续），后续请求走新 session
        const sessions = this._h2Sessions[name];
        if (sessions) {
            const index = sessions.indexOf(session);
            if (index !== -1) sessions.splice(index, 1);
            if (sessions.length === 0) delete this._h2Sessions[name];
        }
        if (
            (this._h2Requests[name]?.length ?? 0) > 0 &&
            (this._h2Sessions[name]?.length ?? 0) < this.h2MaxSessions
        ) {
            const next = this._h2Requests[name][0];
            this._createH2Session(name, (next as any)._options as RequestOptions);
        }
    }

    private _onH2SessionClose(name: string, session: Http2Session): void {
        const sessions = this._h2Sessions[name];
        if (sessions) {
            const index = sessions.indexOf(session);
            if (index !== -1) {
                sessions.splice(index, 1);
            }
            if (sessions.length === 0) delete this._h2Sessions[name];
        }
        if (this._h2H1Only.has(name)) return;
        if (
            (this._h2Requests[name]?.length ?? 0) > 0 &&
            (this._h2Sessions[name]?.length ?? 0) < this.h2MaxSessions
        ) {
            const next = this._h2Requests[name][0];
            this._createH2Session(name, (next as any)._options as RequestOptions);
        }
    }

    public createConnection(options: RequestOptions, callback: (err: Error | null, socket: Socket) => void): Socket {
        const name = this.getName(options);
        const isHttps = options.protocol === 'https:';
        // 有效建连参数：agent 级字段覆盖请求级（Node 的 createSocket 语义，见
        // agentConnectOptions.ts）。`proxy`/`impersonate`/`profile` 刻意**不**走名单，
        // 维持本包既有的「请求级整体覆盖 agent 级」优先级（有测试与文档锚定）。
        const eff = this.getEffectiveConnectOptions(options);
        const port = eff.port || (isHttps ? 443 : 80);
        const host = eff.hostname || eff.host || 'localhost';
        // 请求级 `lookup` 的产物（`ClientRequest._withCustomLookup` 写进来的）：
        // **连接目标**用它，但 `servername`/池键/Host 头仍是原始主机名 ——
        // node 的 `net.createConnection` 也是这么分工的（TLS 的 SNI 不跟着解析结果走）。
        const connectHost = (eff as any).__resolvedAddress || host;

        debugLog(`Agent.createConnection: name=${name}, isHttps=${isHttps}, host=${host}, port=${port}`);

        // Build clean connection options - DO NOT pass HTTP path as it will be confused with Unix socket path
        const connectOptions: any = {
            host: connectHost,
            port: port,
        };
        if (isHttps) {
            connectOptions.servername = eff.servername || host;
            connectOptions.rejectUnauthorized = eff.rejectUnauthorized !== false;
            if (eff.ca) connectOptions.ca = eff.ca;
            if (eff.cert) connectOptions.cert = eff.cert;
            if (eff.key) connectOptions.key = eff.key;
            // TLSSocket 自己会读这三项（tls.ts 的 secureContext / checkServerIdentity 分支），
            // 以前只转发了 ca/cert/key ⇒ `pfx`/`passphrase`/自定义 `checkServerIdentity` 无论是
            // 请求级还是 agent 级都会被这层丢掉。一并接上。
            if (eff.pfx) connectOptions.pfx = eff.pfx;
            if (eff.passphrase) connectOptions.passphrase = eff.passphrase;
            if (eff.checkServerIdentity) connectOptions.checkServerIdentity = eff.checkServerIdentity;
            // `keylog` 以前也在这张表的遗漏里（#58 实测对照：`tls.connect({keylog:true})` 能拿到
            // 5 行 NSS 密钥日志，`https.request({keylog:true})` 一行都没有 —— 断点就在这层转发，
            // **不在原生侧**，所以两份 compatibility audit 里「keylog ✅ Supported」对 https 而言
            // 当时是假的。原生两个发出点见 `rust_c_net/src/tls.rs:32`（rustls）与
            // `src/impersonate.rs:502`（btls）。
            if (eff.keylog) connectOptions.keylog = true;
            // 请求级/agent 级的 session 也要过这张表（node 的 https 选项直接透传给 tls.connect）
            if (eff.session) connectOptions.session = eff.session;
            const proxy = this.getProxy(options);
            if (proxy) {
                connectOptions.proxy = proxy;
                // 请求级整体覆盖 agent 级；两者的 URL 都由 getProxy 决定
                const proxyTls = (options as any).proxyTls ?? this.proxyTls;
                if (proxyTls) connectOptions.proxyTls = proxyTls;
            }
            // impersonate 选项（请求级优先，其次 Agent 级）；TLSSocket 再按全局配置解析
            const impersonate = (options as any).impersonate ?? this.impersonate;
            if (impersonate !== undefined) connectOptions.impersonate = impersonate;
            const profile = (options as any).profile ?? this.profile;
            if (profile !== undefined) connectOptions.profile = profile;
            if ((options as any).forceHttp1 !== undefined) {
                connectOptions.forceHttp1 = (options as any).forceHttp1;
            }
            if ((options as any).ALPNProtocols !== undefined) {
                connectOptions.ALPNProtocols = (options as any).ALPNProtocols;
            }
            if ((options as any).headers !== undefined) {
                connectOptions.headers = (options as any).headers;
            }
        }

        const socket = isHttps ? new TLSSocket(connectOptions) : new Socket();

        // `AgentOptions.timeout` 落到 agent 新建的**每条** socket 上（Node 的 createSocket
        // 同款动作）。放在 connect 之前：`_driver` 在 Socket 构造里就已创建，setTimeout 会
        // 同时记下 `socket.timeout` 和原生侧的计时器。
        // 「只在空闲时销毁」用「在不在这个 name 的 freeSockets 桶里」判定 —— 在途请求的
        // socket 已被摘出桶，于是它只收到 'timeout' 事件、连接不会被掐（Node 语义）。
        // socket 只会待在自己 name 的桶里，所以 name 可以在这里闭包捕获。
        armAgentSocketTimeout(socket, this.timeout, () => (this.freeSockets[name] || []).includes(socket));

        // Re-emit keylog events from TLSSockets
        if (isHttps) {
            socket.on('keylog', (line: Buffer) => {
                // @ts-ignore - Agent is an EventEmitter via Node-like inheritance or internal use
                this.emit('keylog', line, socket);
            });
        }

        let called = false;
        const onConnected = () => {
            if (called) return;
            called = true;
            debugLog(`Agent.createConnection: socket ${isHttps ? 'SECURE_CONNECTED' : 'CONNECTED'} for ${name}`);
            callback(null, socket);
        };

        if (isHttps) {
            (socket as TLSSocket).on('secureConnect', onConnected);
        } else {
            socket.on('connect', onConnected);
        }

        socket.on('error', (err) => {
            debugLog(`Agent.createConnection: socket ERROR for ${name}: ${err.message}`);
            if (called) {
                // 连接已经成功过、socket 已交给请求：仍必须把它的池位还回去 ——
                // 否则这些 socket 会永久占着 maxSockets 名额，之后所有请求都只能排在
                // requests 队列里（TS-M1）。_removeSocket 幂等，重复调用不会多减。
                this._removeSocket(socket, name);
                return;
            }
            called = true;
            this._totalSockets--;
            if (this.sockets[name]) {
                const idx = this.sockets[name].indexOf(socket);
                if (idx !== -1) this.sockets[name].splice(idx, 1);
            }
            callback(err, null as any);
        });

        socket.connect(connectOptions);

        if (!this.sockets[name]) this.sockets[name] = [];
        this.sockets[name].push(socket);

        return socket;
    }

    public releaseSocket(socket: Socket, options: RequestOptions) {
        this._poolSocket(socket, this.getName(options));
    }

    /**
     * 按**池键**把一条已经空出来的 socket 交回池子。
     *
     * 拆出来是因为 ALPN 回退收编（`_adoptH2Stream`）手上没有请求 options，只有池键；
     * 两条路径的入池语义必须完全一致（空闲定时器、`maxFreeSockets`、池位计数）。
     */
    private _poolSocket(socket: Socket, name: string) {
        // 防御：若这条 socket 还挂着空闲销毁定时器（理论上取出时已清），先清掉，
        // 否则定时器晚到会去销毁一条已经在用的 socket。
        if ((socket as any)._agentIdleTimer) {
            clearTimeout((socket as any)._agentIdleTimer);
            delete (socket as any)._agentIdleTimer;
        }

        // Remove from active sockets
        if (this.sockets[name]) {
            const idx = this.sockets[name].indexOf(socket);
            if (idx !== -1) this.sockets[name].splice(idx, 1);
            if (this.sockets[name].length === 0) delete this.sockets[name];
        }

        const onClose = () => {
            debugLog(`Agent: socket closed while in pool, removing from ${name}`);
            this._removeSocket(socket, name);
        };
        socket.once('close', onClose);
        socket.once('error', onClose);
        (socket as any)._agentOnClose = onClose;

        // Check if there are pending requests - ALWAYS reuse if something is waiting
        if (this.requests[name] && this.requests[name].length > 0) {
            const req = this.requests[name].shift()!;
            if (this.requests[name].length === 0) delete this.requests[name];

            if (!this.sockets[name]) this.sockets[name] = [];
            this.sockets[name].push(socket);
            this.reuseSocket(socket, req);
            return;
        }

        if (this.keepAlive && this.keepSocketAlive(socket)) {
            // Return to free pool
            if (!this.freeSockets[name]) this.freeSockets[name] = [];
            if (this.freeSockets[name].length < this.maxFreeSockets) {
                // 空闲上限两套来源，**只装一套**：
                //  · `agent.timeout` 已武装 ⇒ 交给 socket 自带的原生空闲超时
                //    （见 createConnection 里的 armAgentSocketTimeout，到点销毁并经由
                //    'close' 归还池位）。这才是 Node 的池寿命：`https.globalAgent` 的
                //    5000ms，而不是被下面那个 JS 定时器统一掐成 1s。
                //  · 没武装 ⇒ 退回 keepAliveMsecs 的 JS 定时器（TS-M3 原方案）。
                //    注：Node 里 keepAliveMsecs 本是 TCP keep-alive 探测间隔，这里按计划
                //    兼作空闲上限。默认 1s 偏保守 —— 池化收益变小，但不会长期占着空闲 fd。
                if (this.timeout === undefined) {
                    const idleTimer = setTimeout(() => {
                        delete (socket as any)._agentIdleTimer;
                        this._removeSocket(socket, name);
                        socket.destroy();
                    }, this.keepAliveMsecs);
                    (socket as any)._agentIdleTimer = idleTimer;
                }
                this.freeSockets[name].push(socket);
            } else {
                this._totalSockets--;
                socket.end();
            }
        } else {
            this._totalSockets--;
            socket.destroy();
        }
    }

    public keepSocketAlive(_socket: Socket): boolean {
        return true;
    }

    public reuseSocket(socket: Socket, req: ClientRequest): void {
        debugLog(`Agent.reuseSocket: reusing socket for ${req.method} ${req.path}`);
        // Remove agent listeners before reusing
        if ((socket as any)._agentOnClose) {
            socket.removeListener('close', (socket as any)._agentOnClose);
            socket.removeListener('error', (socket as any)._agentOnClose);
            delete (socket as any)._agentOnClose;
        }
        req.onSocket(socket);
    }

    /**
     * 把一条已经断开的 socket 从池子里摘除并归还池位计数（幂等）。
     *
     * ClientRequest 在 error/close 路径上调用它（TS-M1）。不做的话 sockets[name] 会
     * 永久残留、_totalSockets 只增不减，一旦触顶所有新请求都只能排队。
     */
    public removeSocket(socket: Socket, options: RequestOptions): void {
        this._removeSocket(socket, this.getName(options));
    }

    private _removeSocket(socket: Socket, name: string) {
        if (this.sockets[name]) {
            const idx = this.sockets[name].indexOf(socket);
            if (idx !== -1) {
                this.sockets[name].splice(idx, 1);
                this._totalSockets--;
            }
        }
        if (this.freeSockets[name]) {
            const idx = this.freeSockets[name].indexOf(socket);
            if (idx !== -1) {
                this.freeSockets[name].splice(idx, 1);
                this._totalSockets--;
            }
        }
    }

    destroy() {
        for (const name in this._h2Sessions) {
            for (const session of this._h2Sessions[name]) {
                session.destroy();
            }
        }
        this._h2Sessions = {};
        this._h2Requests = {};
        for (const name in this.sockets) {
            for (const socket of this.sockets[name]) {
                socket.destroy();
            }
        }
        for (const name in this.freeSockets) {
            for (const socket of this.freeSockets[name]) {
                socket.destroy();
            }
        }
    }
}

// node v24 实测 `http.globalAgent.options`：`{keepAlive:true, scheduling:'lifo', timeout:5000}`
// （https 侧同值，见 https.ts）。此前这里是裸 `new Agent()` ⇒ keepAlive 为 false，
// 明文 HTTP 的**连接复用默认就与 node 相反**：每条请求新建一条连接，池化与
// `maxFreeSockets` 全部形同虚设（矩阵 #52 的 ④ 格量到的正是这个）。
export const globalAgent = new Agent({ keepAlive: true, scheduling: 'lifo', timeout: 5000 });

const globalAgents = new GlobalAgentRegistry<Agent>();
globalAgents.setFallback(globalAgent);

/**
 * 注册协议对应的全局 Agent。https.ts 在创建自己的 globalAgent 后调用。
 * @internal
 */
export function registerGlobalAgent(protocol: string, agent: Agent): void {
    globalAgents.set(protocol, agent);
}

function resolveAgent(protocol: string | undefined, agentOption: Agent | boolean | undefined): Agent {
    return globalAgents.resolve(
        protocol,
        agentOption === true ? undefined : agentOption,
        (value): value is Agent => value instanceof Agent,
        () => new Agent()
    );
}

// ========== ClientRequest ==========

export interface RequestOptions {
    protocol?: string;
    host?: string;
    hostname?: string;
    family?: number;
    port?: number;
    localAddress?: string;
    socketPath?: string;
    method?: string;
    path?: string;
    headers?: Record<string, any>;
    auth?: string;
    agent?: Agent | boolean;
    proxy?: string;
    proxyTls?: ProxyTlsOptions;
    impersonate?: boolean | 'chrome';
    profile?: string;
    forceHttp1?: boolean;
    ALPNProtocols?: string[];
    timeout?: number;
    rejectUnauthorized?: boolean;
    // ...
}

function headersFromPairs(pairs: Array<[string, string]>): {
    values: Record<string, string | string[]>;
    raw: string[];
} {
    const values: Record<string, string | string[]> = {};
    const raw: string[] = [];
    for (const [name, value] of pairs) {
        raw.push(name, value);
        if (name === 'set-cookie') {
            const existing = values[name];
            values[name] = Array.isArray(existing)
                ? [...existing, value]
                : existing === undefined
                  ? [value]
                  : [existing, value];
        } else if (values[name] === undefined) {
            values[name] = value;
        } else {
            const existing = values[name];
            values[name] = Array.isArray(existing)
                ? [...existing, value]
                : `${existing}, ${value}`;
        }
    }
    return { values, raw };
}

export class ClientRequest extends OutgoingMessage {
    public method: string;
    public path: string;
    public host: string;
    private _res?: IncomingMessage;
    /**
     * node 的 `request.res`：已到达的响应对象。follow-redirects / axios 用它
     * （`response.request.res`）判断重定向是否已经拿到响应，缺它就是 `undefined`。
     */
    public get res(): IncomingMessage | undefined {
        return this._res;
    }
    private _options: RequestOptions;
    private _connected: boolean = false;
    /**
     * `'error'` 只发一次。
     *
     * 装上 socket 监听之后，连接阶段的失败有**两条**通路同时看到：socket 的 `'error'`
     * 监听（`onError`）与 `agent.createConnection` 的 connect 回调。node 一次请求只发
     * 一个 'error'；重复发会让调用方（尤其是把回调直接挂在 'error' 上的工具/探针）
     * 把后续步骤跑两遍 —— 实测 https_proxy 探针的负向用例就是这样翻倍的。
     */
    private _errorEmitted: boolean = false;
    private _lookupCalled: boolean = false;
    private _pendingWrites: Array<{ chunk: any; encoding?: any; callback?: any }> = [];
    private _ended: boolean = false;
    private _expectContinue: boolean = false;
    private _continueReceived: boolean = false;
    /** @internal 构造期解析出的 impersonation（Agent 建 H2 session 时复用）。 */
    public _impersonation: ImpersonationConnectOptions | null = null;
    private _h2Eligible: boolean = false;
    private _h2Session?: Http2Session;
    private _h2RequestId?: number;
    private _h2Socket?: Http2SessionSocket;
    /** `Http2SessionSocket.pause()` 的闸门：暂停期间攒 chunk，resume 时按序 push。 */
    private _h2Paused: boolean = false;
    private _h2HeldChunks: Buffer[] = [];
    private _h2Trailers?: Record<string, string>;
    private _h2Retries: number = 0;
    private _h2BodySent: boolean = false;
    private _h2PendingWrite?: {
        data: Buffer;
        callback?: (error?: Error | null) => void;
    };
    private _closeEmitted: boolean = false;
    /**
     * 本次请求**曾经**拿到过 socket。`_cleanupSocket()` 会把 `this.socket` 置 null，
     * 所以「终止时到底连上过没有」必须另记 —— node 的 `socket hang up` 判据要用它
     * （`abort()` 发生在拿到 socket 之前 ⇒ 不报错；之后 ⇒ 报）。
     */
    private _hadSocket: boolean = false;
    /** 'socket hang up' 只报一次（destroy 可能被重复调用）。 */
    private _hangUpEmitted: boolean = false;

    private _getChunkByteLength(chunk: any, encoding?: string | null): number {
        if (chunk == null) return 0;
        const normalizedEncoding = typeof encoding === 'string' ? encoding : undefined;
        if (typeof chunk === 'string') {
            return Buffer.byteLength(chunk, normalizedEncoding as BufferEncoding | undefined);
        }
        if (typeof chunk.length === 'number') {
            return chunk.length;
        }
        const buffer = Buffer.from(chunk, normalizedEncoding as BufferEncoding | undefined);
        return buffer.length;
    }

    private _getPendingBodyLength(): number {
        return this._pendingWrites.reduce((total, pending) => {
            return total + this._getChunkByteLength(pending.chunk, pending.encoding);
        }, 0);
    }

    constructor(options: RequestOptions, callback?: (res: IncomingMessage) => void) {
        super();
        this._hostFirst = true;
        this._options = options;
        // `{ signal }`（node 的 AbortSignal 支持）：以前整条链路都不读它 —— 传了也不生效，
        // 请求照常跑完（got@11 的「AbortController 取消」判据就是这么红的）。
        // node 的语义：abort 时以 `AbortError`（code ABORT_ERR）销毁请求；已经 abort 过
        // 的 signal 在下一个 tick 报错。
        const signal = (options as any).signal as AbortSignal | undefined;
        if (signal) {
            const onAbort = () => {
                const error: any = new Error('The operation was aborted');
                error.name = 'AbortError';
                error.code = 'ABORT_ERR';
                this.destroy(error);
            };
            if (signal.aborted) {
                nextTick(onAbort);
            } else {
                signal.addEventListener('abort', onAbort, { once: true });
                this.once('close', () => {
                    try {
                        signal.removeEventListener('abort', onAbort);
                    } catch {
                        // signal 已失效
                    }
                });
            }
        }
        this.method = options.method || 'GET';
        this.path = options.path || '/';
        this.host = options.hostname || options.host || 'localhost';

        // 请求行的校验放在**构造期**（= http.request() 的调用点），对齐 Node。
        // 实测 Node v22：`http.request({ path: '/a b' })` 同步抛
        // `TypeError [ERR_UNESCAPED_CHARACTERS]`（不是异步 error 事件）。
        // 旧实现只在 `_sendRequest`（连上之后）校验，于是同一个错误在
        // ESM/原生宿主里表现为「从原生回调里抛出」——异常会穿过 native→JS 边界
        // 直接终止进程（无头宿主上实测 exit 134，`std::terminate`），
        // 用户既 catch 不到也拿不到 error 事件。`_sendRequest` 里那一道**保留**
        // 作纵深防御（覆盖构造后被直接改 `req.path` 的情况）。
        validateRequestMethod(this.method);
        validateRequestPath(this.path);

        if (['GET', 'HEAD'].includes(this.method.toUpperCase())) {
            this._hasBody = false;
        }

        if (options.headers) {
            for (const key in options.headers) {
                this.setHeader(key, options.headers[key]);
            }
        }

        // `options.auth` ⇒ `Authorization: Basic …`（Node 在构造期就做，实测 v22/v24）。
        // 三条边界都是量出来的，不是猜的：
        //   · 已经有 `authorization` 头（无论来自 options.headers 还是 setHeader）就**不覆盖**；
        //   · `auth: ''` 什么都不发；
        //   · base64 取 **UTF-8** 字节（`'ünï:cöde'` → `w7xuw686Y8O2ZGU=`），不是 latin1，
        //     且用户名/密码里的额外冒号**原样进 base64**（`'a:b:c'` 不切分）。
        if (options.auth && !this.hasHeader('authorization')) {
            this.setHeader('Authorization', `Basic ${Buffer.from(String(options.auth)).toString('base64')}`);
        }

        if (callback) {
            this.once('response', callback);
        }

        const expect = this.getHeader('expect');
        if (expect && typeof expect === 'string' && expect.toLowerCase() === '100-continue') {
            this._expectContinue = true;
        }

        if (options.timeout) {
            this.setTimeout(options.timeout);
        }

        const agent = resolveAgent(this._options.protocol, this._options.agent);

        // impersonate 的头策略：在构造期解析（profile 数据用于头层）。解析失败不在这里
        // 中断请求 —— 真正建连时 TLSSocket 会走同一条解析并给出明确错误。
        if (this._options.protocol === 'https:') {
            try {
                const resolved = buildImpersonationConnectOptions(
                    {
                        impersonate: (agent as any).impersonate,
                        profile: (agent as any).profile,
                    },
                    {
                        impersonate: (this._options as any).impersonate,
                        profile: (this._options as any).profile,
                        forceHttp1: (this._options as any).forceHttp1,
                        alpnProtocols: (this._options as any).ALPNProtocols,
                        headers: this._options.headers,
                    },
                    this.host,
                    getImpersonationConfig(),
                    lookupProfile,
                    isImpersonationAvailable()
                );
                if (resolved) {
                    this._impersonation = resolved;
                    this._profileHeaderPolicy = {
                        headers: resolved.profileData.headers,
                        overrideHeaders: resolved.overrideHeaders,
                    };
                }
            } catch {
                // 头层静默回退；连接阶段会报错
            }
        }

        this._h2Eligible = canUseHttp2(
            this.method,
            this._impersonation,
            this._options as any,
            isHttp2Available()
        );

        // Use setImmediate or setTimeout for React Native compatibility
        // （局部名不要叫 nextTick：它会遮蔽模块顶部的同名 shim，构造器里那几处用法
        //   会被 TS 判成「使用早于声明」。）
        const scheduleConnect = typeof setImmediate !== 'undefined' ? setImmediate : (fn: () => void) => setTimeout(fn, 0);
        scheduleConnect(() => {
            debugLog(`ClientRequest: nextTick fired for ${this.method} ${this.host}${this.path}`);
            // 排队期间请求可能已经被 abort()/destroy()（实测：`http.get(url)` 之后
            // **同一个同步块里** `req.abort()` 是 node-fetch 中断请求的形状）。不挡住就会
            // 照样建连：socket 挂到已销毁的请求上、它的 LoopRef 永不释放（宿主 trace：
            // `keepAlive=1 handles=1 handleList=[1:net.Socket]`，进程打完字不退出），
            // 而且一个已 abort 的请求还能收到 response。
            // node v24 实测同形：`after-abort destroyed=true socket=null`，之后只有
            // 'close'，400ms 后 socket 仍是 null —— 即**根本不发起连接**，也不报错。
            if (this.destroyed || this.aborted) {
                debugLog(`ClientRequest: nextTick skipped (destroyed/aborted) for ${this.method} ${this.host}${this.path}`);
                return;
            }
            // #60：node 在「没给 agent + createConnection 是函数」时**根本不进 Agent**
            // （`_http_client.js:158-173`）⇒ 也就不可能命中它的 `freeSockets` 复用。
            // 这条判断必须先于 agent 的任何动作：否则池里恰好有一条空闲连接时，
            // 钩子会被静默绕过（矩阵里实测：Connection 仍是 keep-alive、
            // `req.shouldKeepAlive === true`，与 node 不同）。
            const connectOptions = this._options as any;
            const useCreateConnectionHook = typeof connectOptions.createConnection === 'function' &&
                (connectOptions.agent === undefined || connectOptions.agent === null);
            if (useCreateConnectionHook) {
                this._last = true;
                this.shouldKeepAlive = false;
                this._connectViaCreateConnection(connectOptions.createConnection);
                return;
            }
            if (this._h2Eligible) {
                agent.addH2Request(this, this._options);
            } else {
                // 自定义 lookup 必须在**任何**读 options 的路径（getName 会缓存合并结果）之前
                // 完成，否则解析结果写不进那份快照（实测：连接仍然发往原始主机名，#60）。
                this._withCustomLookup(() => agent.addRequest(this, this._options));
            }
        });
    }

    /** @internal Agent 分配到一个已就绪的 H2 session。 */
    public onH2Session(session: Http2Session): void {
        // 同 onSocket：请求在 agent 队列里被销毁后，晚到的 session 不能再接管它 ——
        // 否则 session 的保活没人放。就地丢弃，让 session 走自己的销毁路径。
        if (this.destroyed || this.aborted) {
            session.destroy();
            return;
        }
        this._h2Session = session;
        const socket = new Http2SessionSocket(session, 0);
        this._h2Socket = socket;
        this.socket = socket as unknown as Socket;
        this._hadSocket = true;
        this._connected = true;
        socket.on('timeout', () => this.emit('timeout'));
        // `res.socket.pause()/resume()`（H2 门面）→ 本流的数据闸门
        socket.setFlowControl({
            pause: () => { this._h2Paused = true; },
            resume: () => {
                if (!this._h2Paused) return;
                this._h2Paused = false;
                const held = this._h2HeldChunks;
                this._h2HeldChunks = [];
                for (const chunk of held) this._res?.push(chunk);
            },
        });
        this.emit('socket', this.socket);
        this._flushPendingWrites();
    }

    /** @internal H2 协商失败：改走 H1（forceHttp1，避免再次握手到 h2）。 */
    public onHttp2Fallback(): void {
        this._h2Eligible = false;
        this._h2Session = undefined;
        (this._options as any).forceHttp1 = true;
        if (this._h2Trailers) {
            const trailers = this._h2Trailers;
            this._h2Trailers = undefined;
            try {
                super.addTrailers(trailers);
            } catch {
                // H1 只支持 chunked trailers；不能表达时静默丢弃（已在 H2 侧声明）
            }
        }
        this._getAgent().addRequest(this, this._options);
    }

    /** @internal */
    public onSocket(socket: Socket | null) {
        // 请求在 agent 的等待队列里被 abort()/destroy() 之后，晚到的 socket **不能**再接上它：
        // 接上就没有人负责销毁它，它的 LoopRef 永不释放（与构造期 nextTick 那条同一类，
        // 见那里的实测注记）。这里显式把 socket 销毁掉，而不是悄悄丢掉引用。
        if (this.destroyed || this.aborted) {
            socket?.destroy();
            return;
        }
        if (socket) {
            this.socket = socket;
            this._hadSocket = true;
            this._connected = true;
            this.emit('socket', this.socket);
            // IMPORTANT: attach response listeners BEFORE flushing writes.
            // If we flush first, the server may respond before we have a data listener.
            this._attachSocketListeners();
            this._flushPendingWrites();
        } else {
            this._connect();
        }
    }

    /**
     * `req.setTimeout(msecs[, callback])` —— ⚠️ **不能**沿用基类
     * `OutgoingMessage.setTimeout`（它自己 `this.emit('timeout')`）。
     *
     * `'timeout'` 现在由 `_attachSocketListeners` 里的 socket→req 转发统一发一次（对齐
     * Node：实测 `agent.timeout` 与 `req.setTimeout` 同时存在时 req 也只发**一次**）。
     * 基类那套留下来就会发两次，还把 callback 变成了 socket 级 once 监听。
     * 这里只做两件事：给 socket 设时延、把 callback 挂到 **req** 的 `'timeout'` 上。
     * （服务端 `res.setTimeout` 仍走基类，那边没有这条转发。）
     */
    public setTimeout(msecs: number, callback?: () => void): this {
        const arm = (s: Socket) => {
            s.setTimeout(msecs);
            if (callback) this.once('timeout', callback);
        };
        if (this.socket) arm(this.socket);
        else this.once('socket', arm);
        return this;
    }

    /**
     * 请求级 `lookup` 的接线（node 语义实测：`net` 用
     * `lookup(host, { hints: 1024, all: true }, cb)`，回调给**数组** `[{address, family}]`，
     * 连接目标是 `addresses[0].address`，而 Host 头 / TLS SNI 仍是原始主机名）。
     *
     * 本包的解析发生在原生里（Rust 侧 getaddrinfo），所以要用用户的解析器就得在 JS 先解析、
     * 把 IP 作为连接目标传下去（见 `Agent.createConnection` 里对 `__resolvedAddress` 的读取）。
     * 以前这个选项**只参与 H2 资格判定、从不被调用**（#60）——静默失效比报错更危险。
     */
    private _withCustomLookup(then: () => void): void {
        const options = this._options as any;
        const lookup = options.lookup;
        if (typeof lookup !== 'function' || this._lookupCalled) {
            then();
            return;
        }
        this._lookupCalled = true;
        const host = options.hostname || options.host || 'localhost';
        let called = false;
        const done = (err: any, addresses: any) => {
            if (called) return;
            called = true;
            if (err) {
                this.emit('error', err);
                return;
            }
            const first = Array.isArray(addresses) ? addresses[0] : addresses;
            const address = first && typeof first === 'object' ? first.address : first;
            if (typeof address !== 'string' || address.length === 0) {
                // node 在拿不到地址时报的是这个码（实测：回调不给数组/地址时
                // `ERR_INVALID_IP_ADDRESS: Invalid IP address: undefined`）
                const bad: any = new Error('Invalid IP address: ' + address);
                bad.code = 'ERR_INVALID_IP_ADDRESS';
                this.emit('error', bad);
                return;
            }
            options.__resolvedAddress = address;
            then();
        };
        try {
            // hints 1024 = dns.ADDRCONFIG，与 node 的 net 内部一致（实测）
            lookup(host, { hints: 1024, all: true }, done);
        } catch (error) {
            done(error, null);
        }
    }

    private _connect() {
        const options = this._options as any;
        // node 的 agent 规则（`_http_client.js:158-173 / 340-375`，实测核对过）：
        //   · 显式给了 agent（含 `agent:false` ⇒ 临时 Agent）⇒ 只用 **agent 的**
        //     createConnection，请求级那个**不调用**（实测 hookCalls=0）；
        //   · 只有「没给 agent + createConnection 是函数」才绕过池子：不建 Agent、
        //     `Connection: close`（`_last=true` / `shouldKeepAlive=false`），由用户钩子建连
        //     （`req.agent === undefined`，实测）。
        // 这两条以前都没实现：钩子被静默忽略、请求照常成功（#60）。
        const useHook = typeof options.createConnection === 'function' &&
            (options.agent === undefined || options.agent === null);
        if (useHook) {
            this._last = true;
            this.shouldKeepAlive = false;
            this._connectViaCreateConnection(options.createConnection);
            return;
        }
        // 自定义解析必须在真正建连之前完成；钩子路径不预解析（node 把带 lookup 的 opts
        // 原样交给钩子，解析是钩子自己的事）。
        this._withCustomLookup(() => this._connectWithAgent());
    }

    /** 用户自带 createConnection 时的直连路径（node：无 agent、连接不可复用）。 */
    private _connectViaCreateConnection(createConnection: Function): void {
        const options = this._options as any;
        // node 会在这条路上把 HTTP 专属的 path/socketPath **值**抹掉再交给钩子
        // （`_http_client.js:346-353`；实测钩子拿到的 `opts.path === undefined`，键还在）
        let hookOptions: any = options;
        if (options.path || options.socketPath) {
            hookOptions = { ...options };
            if (options.socketPath) hookOptions.path = options.socketPath;
            else hookOptions.path = undefined;
        }
        let settled = false;
        const oncreate = (err: Error | null, socket?: any) => {
            if (settled) return;
            settled = true;
            if (err) {
                nextTick(() => {
                    if (!this.destroyed) this.emit('error', err);
                });
                return;
            }
            if (socket) this.onSocket(socket);
        };
        try {
            const created = createConnection(hookOptions, oncreate);
            if (created) oncreate(null, created);
        } catch (error) {
            oncreate(error as Error);
        }
    }

    private _connectWithAgent() {
        const agent = resolveAgent(this._options.protocol, this._options.agent);
        // node `_http_client.js:273-285`（逐字）：
        //   有 agent 时，只有「keepAlive=false **且** maxSockets 无限」才降级成
        //   `_last=true / shouldKeepAlive=false`；否则一律 keep-alive（默认 Agent 的
        //   `maxSockets: Infinity` 正是前一种，而 `new Agent({maxSockets: 5})` 会复用连接）。
        // 实测 node 的线上头：globalAgent ⇒ keep-alive；`new Agent()` ⇒ close；
        // `new Agent({keepAlive:true})` ⇒ keep-alive；`agent:false`（临时 Agent）⇒ close。
        if (!agent.keepAlive && !Number.isFinite(agent.maxSockets)) {
            this._last = true;
            this.shouldKeepAlive = false;
        } else {
            this._last = false;
            this.shouldKeepAlive = true;
        }

        const connectCallback = (err: Error | null, socket: Socket) => {
            if (err) {
                debugLog(`ClientRequest._connect: ERROR: ${err.message}`);
                if (!this._errorEmitted) {
                    this._errorEmitted = true;
                    this.emit('error', err);
                }
                return;
            }
            debugLog(`ClientRequest._connect: Socket connected!`);
            // 正常情况下 socket 在 `createConnection()` 返回时就已赋值/发过 'socket'、
            // 装过监听；只有同步回调这种罕见形态才会走到这里补齐。
            if (this.socket !== socket) {
                this.socket = socket;
                this._hadSocket = true;
                this.emit('socket', this.socket);
                // IMPORTANT: attach response listeners BEFORE flushing writes.
                // If we flush first, the server may respond before we have a data listener.
                this._attachSocketListeners();
            }
            this._connected = true;
            // _flushPendingWrites() internally calls _sendRequest() if headers not sent yet.
            // Do NOT call _sendRequest() separately here — _flushPendingWrites() needs to
            // inspect headersSent and _pendingWrites together so it can set Content-Length
            // before sending headers (to avoid chunked encoding when body is already known).
            this._flushPendingWrites();
        };

        const socket = agent.createConnection(this._options, connectCallback);
        this.socket = socket;
        this._hadSocket = true;
        // node 在 socket **被分配**时就发 'socket'（`onSocket` 的 nextTick），不是连上之后
        // —— 这决定了 `req.setTimeout()` / `socket.setTimeout()` 的武装时刻：
        // `https.request({ timeout })` 的文档原话是 "set the timeout before the socket is
        // connected"，实测 node v22 对「accept 后一个字节都不发」的服务端，300ms 的超时在
        // TLS 握手期间就会触发（#13）。晚发 'socket' 会让连接/握手阶段完全没有超时。
        this.emit('socket', socket);
        this._attachSocketListeners();
        if (this._connected) this._flushPendingWrites();
    }

    private _attachSocketListeners() {
        if (!this.socket) return;

        const parser = Driver.createHttpParser(1); // 1 = Response mode

        const onData = (data: Buffer) => {
            // 101 / CONNECT 2xx 之后连接被交出去，后面是不透明字节流。同一 TCP 包里
            // 跟在响应头后面的那批字节，parser 会按「indefinite body」以**后续 body
            // 消息**的形式吐出来（这类响应没有 Content-Length → expected_body_len =
            // None，见 http_parser.rs::try_parse_body）—— 也就是说字节**已经在通道里**，
            // 只是没人接。在 Node 里它就是 'upgrade' / 'connect' 的 head 参数（R7）。
            //
            // ⚠️ 只能在这两种情形下抽：普通响应后面的字节是真 body，抽了就没了。
            const drainTunnelHead = (): Buffer => {
                const chunks: Buffer[] = [];
                for (let i = 0; i < 2000; i++) { // 上限，防御 parser 异常自激
                    const r = parser.feed(new ArrayBuffer(0));
                    const md = r.metadata;
                    if (!md || md === '') break;        // 没有更多消息
                    if (md.startsWith('ERROR:')) break; // 解析失败：不吞，留给外层处理
                    const p = JSON.parse(md);
                    if (r.body && r.body.byteLength > 0) chunks.push(Buffer.from(r.body));
                    if (p.is_headers) break;            // 隧道里不该再出现 HTTP 报文头
                }
                return chunks.length > 0 ? Buffer.concat(chunks) : Buffer.alloc(0);
            };

            const handleParsedResult = (result: any) => {
                const metadata = result.metadata;
                if (metadata.startsWith('ERROR:')) {
                    this.emit('error', new Error(metadata));
                    // `this.socket` 在这里**可以已经是 null**：错误晚于拆除到达时（实测 TLS
                    // 校验失败 + 紧随其后的 destroy 路径），旧的 `this.socket!` 断言会在
                    // 宿主派发的任务里抛 TypeError —— 它被事件循环吞成
                    // `[EventLoop] uncaught exception in posted task … cannot read property
                    // 'destroy' of null` 打到 stderr，既掩盖真实错误又破坏输出比对。
                    this.socket?.destroy();
                    return;
                }
                const parsed = JSON.parse(metadata);
                if (result.body) {
                    parsed.body = Buffer.from(result.body);
                }
                // 每个数据包一条 → thunk
                debugLog(() => `[HTTP] _connect: Parser result: ${parsed.is_headers ? 'HEADERS' : 'DATA'}${parsed.complete ? ' (COMPLETE)' : ''}`);

                if (parsed.is_headers) {
                    const status = parsed.status || 0;
                    if (status >= 100 && status < 200 && status !== 101) {
                        const info = {
                            httpVersion: '1.' + parsed.version,
                            httpVersionMajor: 1,
                            httpVersionMinor: parsed.version,
                            statusCode: status,
                            statusMessage: STATUS_CODES[status] || '',
                            headers: parsed.headers,
                            rawHeaders: parsed.raw_headers || []
                        };
                        if (status === 100) {
                            this._continueReceived = true;
                            this.emit('continue');
                            this._flushPendingWrites();
                        } else {
                            this.emit('information', info);
                        }
                        return;
                    }

                    this._res = new IncomingMessage(this.socket!);
                    this._res.statusCode = status;
                    this._res.statusMessage = STATUS_CODES[status] || '';
                    this._res.httpVersion = '1.' + parsed.version;
                    this._res.headers = parsed.headers;
                    this._res.rawHeaders = parsed.raw_headers || [];
                    // 客户端 `res` 上 node 还挂着三样（实测初值）：
                    //   `method = null`、`url = ''`、`req` = 发起这次请求的 ClientRequest。
                    // ⚠️ 这里的 `req` 指向 **ClientRequest**，与服务端 `res.req` 指向
                    //    `IncomingMessage` 是两回事，别混。
                    this._res.method = null as any;
                    this._res.url = '';
                    this._res.req = this;
                    // 服务端 `joinDuplicateHeaders` 是 `null`、客户端是 `undefined`（实测）
                    // ⇒ 这里显式置回 undefined，别让基类构造期的 `null` 留下来。
                    this._res.joinDuplicateHeaders = undefined as any;

                    if (status === 101) {
                        debugLog(`ClientRequest: 101 Switching Protocols received, detaching parser`);
                        this.socket!.removeListener('data', onData);
                        this.socket!.removeListener('error', onError);
                        this.emit('upgrade', this._res, this.socket!, drainTunnelHead());
                        return;
                    }

                    // Handle CONNECT method response (HTTP Tunneling)
                    if (this.method.toUpperCase() === 'CONNECT' && status >= 200 && status < 300) {
                        debugLog(`ClientRequest: CONNECT tunnel established (status=${status}), emitting 'connect' event`);
                        this.socket!.removeListener('data', onData);
                        this.socket!.removeListener('error', onError);
                        this.emit('connect', this._res, this.socket!, drainTunnelHead());
                        return;
                    }

                    this.emit('response', this._res);

                    // HEAD 响应没有 body（RFC 9110），但解析器**不知道请求方法** —— 只有这里知道。
                    // 服务器通常仍会带上 Content-Length/Transfer-Encoding（描述的是"本应发送"的
                    // 表示），解析器于是会一直等一个永不到来的 body：响应既不 complete 也不 close，
                    // 请求永久悬挂（R-M8）。这里按方法直接收尾。
                    //
                    // 204/304 由解析器按状态码处理（不需要方法，见 http_parser.rs）；
                    // 1xx 在上面就 return 了。这里只管 HEAD。
                    //
                    // 不需要复位解析器：它是**每个请求**新建的（见 _attachSocketListeners），
                    // 这个请求结束后会被丢弃，残留状态不会带到下一个请求。
                    if (this.method.toUpperCase() === 'HEAD') {
                        debugLog(`[HTTP] ClientRequest: HEAD response ends at headers (status=${status})`);
                        parsed.complete = true;
                    }
                }

                if (this._res && parsed.body && parsed.body.length > 0) {
                    this._res.push(Buffer.from(parsed.body));
                }

                if (this._res && parsed.complete) {
                    this._res.complete = true;
                    if (parsed.trailers) {
                        this._res.trailers = parsed.trailers;
                    }
                    if (parsed.raw_trailers) {
                        this._res.rawTrailers = parsed.raw_trailers;
                    }
                    this._res.push(null);
                    this._finishResponse();
                }
            };

            let input: ArrayBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
            let iterations = 0;
            const maxIterations = 2000; // Safety limit
            while (iterations < maxIterations) {
                iterations++;
                const result = parser.feed(input);
                const metadata = result.metadata;
                if (!metadata || metadata === '') {
                    // 空 metadata = 数据不足，等下一包
                    break;
                }
                if (metadata.startsWith('ERROR:')) {
                    // 解析失败：交给 handleParsedResult 的错误分支（emit error + destroy socket），
                    // 不再静默 break（TS-H6）
                    debugLog(`[HTTP] ClientRequest: Parser error: ${metadata}`);
                    handleParsedResult(result);
                    break;
                }
                handleParsedResult(result);
                input = new ArrayBuffer(0); // Continue with empty input to drain Rust buffer
            }
        };

        const onError = (err: Error) => {
            debugLog(`[HTTP] _connect: Socket error: ${err.message}`);
            if (!this._errorEmitted) {
                this._errorEmitted = true;
                this.emit('error', err);
            }
            this._discardSocket();
            this._cleanupSocket();
        };

        const onClose = () => {
            debugLog(`[HTTP] _connect: Socket closed`);
            if (this._res && !this._res.readableEnded) this._res.push(null);
            // node 的 `socketCloseListener` 第一件事是 `req.destroyed = true`，然后才
            // `req.emit('close')`（实测：半路 `res.destroy()` ⇒ 连接关闭 ⇒ `req.destroyed===true`，
            // 本包原先停在 false）。走**基类**的 destroy 而不是 `ClientRequest` 那份覆写：
            // 覆写里的 `socket hang up` 规则归上游错误分支管，在这里再发一次会变成两条 'error'。
            // 顺序也不能反 —— 基类会在下一个 tick 自己补一次 'close'，靠 `emit()` 里的去重兜住。
            super.destroy();
            this.emit('close');
            this._discardSocket();
            this._cleanupSocket();
        };

        // socket 的 `'timeout'` ⇒ 请求的 `'timeout'`（Node 实测：只设 `agent.timeout`、
        // 没调 `req.setTimeout` 也会转，一次空闲期只转一次）。缺了这一跳，本包刚生效的
        // `https.globalAgent.timeout = 5000` 对在途请求完全不可见 —— 而 Node 用户代码里
        // `.on('timeout', () => req.destroy())` 正是靠它兜住挂死的请求。
        const onTimeout = () => {
            this.emit('timeout');
        };

        this.socket.on('data', onData);
        this.socket.on('error', onError);
        this.socket.on('close', onClose);
        this.socket.on('timeout', onTimeout);

        this._socketCleanup = () => {
            this.socket?.removeListener('data', onData);
            this.socket?.removeListener('error', onError);
            this.socket?.removeListener('close', onClose);
            this.socket?.removeListener('timeout', onTimeout);
        };
    }

    private _socketCleanup?: () => void;

    /** 取得本次请求实际使用的 agent（与 _finishResponse 的选择逻辑保持一致）。 */
    private _getAgent(): Agent {
        return resolveAgent(this._options.protocol, this._options.agent);
    }

    /**
     * 连接以失败/异常方式结束：把 socket 从 agent 池子里摘除并归还池位计数。
     *
     * 不做的后果：`sockets[name]` 永久残留、`_totalSockets` 只增不减 —— 一旦达到
     * `maxSockets`/`maxTotalSockets`，之后所有请求都会永远排在 `requests` 队列里（TS-M1）。
     */
    private _discardSocket() {
        const socket = this.socket;
        if (!socket) return;
        this._getAgent().removeSocket(socket, this._options);
    }

    private _cleanupSocket() {
        if (this._socketCleanup) this._socketCleanup();
        this._socketCleanup = undefined;
        // ⚠️ 刻意**不**把 `this.socket` 置 null。node 在请求结束后仍然保留这个引用
        // （矩阵 #52 语料实测：③ `abort()` 于 socket 之后 → `req.socket.destroyed === true`；
        //  ④ 正常读完 → `req.socket` 还是那条活着的池化连接）。置 null 会让
        //  「拿 `request.socket` 做收尾判断」的库（follow-redirects / axios 的 http 适配器）
        // 看不见连接，也与 node 不同形。
        // 「还能不能往这条连接写」不再用 null 表达：正常结束路径会 `destroy()` 请求，
        // 后续 `write()` 由流基类以 ERR_STREAM_DESTROYED 拒掉（node 同形）；
        // 失败/关闭路径同理（socket 本身已销毁）。
        this._connected = false;
    }

    private _finishResponse() {
        const agent = this._getAgent();
        const socket = this.socket;

        // 服务端在响应头里声明了 Connection: close（解析器把 header 名转成小写），
        // 这条连接不能回池复用，否则下次请求会写到一个已经要关闭的 socket 上（TS-M3）。
        const connHeader = this._res?.headers?.['connection'];
        const connValue = Array.isArray(connHeader) ? connHeader.join(',') : connHeader;
        const connLower = typeof connValue === 'string' ? connValue.toLowerCase() : '';
        const explicitClose = connLower.includes('close');
        const explicitKeepAlive = connLower.includes('keep-alive');

        // HTTP/1.0 的**默认**语义是非 keep-alive：只有显式带 `Connection: keep-alive`
        // 才能复用（RFC 9112 §19.7.1；并对齐 Node v22.22.2 实测：1.0 无 Connection
        // → 新连接；1.0 + keep-alive → 复用）。
        // 少了这条，Agent 会把一条服务端随时会按 1.0 语义关掉的连接发还复用，
        // 下一次请求就写进死连接（Task 15 边界① / R3）。
        const isHttp10 = this._res?.httpVersion === '1.0';

        // 响应**没有声明任何长度信息**（既无 `Content-Length` 也无 `Transfer-Encoding`）⇒
        // 按 RFC 9112 §6.1，body 的边界是「连接关闭」，这条连接用完就不能再复用。
        // node 用**解析器给的** `shouldKeepAlive` 参数表达这件事
        // （`_http_client.js`：`if (req.shouldKeepAlive && !shouldKeepAlive && !req.upgradeOrConnect)
        //   req.shouldKeepAlive = false;`），本包的 rust parser 不透出这一位 ⇒ 在 JS 侧按同一判据补。
        // 204/304/1xx 是**按状态码定义**就没有 body，不属于这一类（node 照样复用）；
        // HEAD 要看响应有没有声明长度 —— 分腿配对实测（`head_pairing.js`）：
        // 带 `Content-Length` 的 HEAD 两侧都复用；没带的 **node 直接关连接**，本包原先留着复用。
        const status = this._res?.statusCode ?? 0;
        const bodylessByStatus = status === 204 || status === 304 ||
            (status >= 100 && status < 200 && status !== 101);
        const noLengthInfo = !bodylessByStatus &&
            this._res?.headers?.['content-length'] === undefined &&
            this._res?.headers?.['transfer-encoding'] === undefined;

        const serverWantsClose = explicitClose || (isHttp10 && !explicitKeepAlive) || noLengthInfo;

        // node 在同一处把请求侧的 `shouldKeepAlive` **降级**（`req.shouldKeepAlive &&
        // !parserShouldKeepAlive ⇒ req.shouldKeepAlive = false`），所以响应走完之后再读
        // `req.shouldKeepAlive` 是这条连接的真实去向，不是发送前的意愿
        // （#54 实测：无长度信息的 HEAD 响应后 node 给 false，本包停在 true）。
        if (serverWantsClose) this.shouldKeepAlive = false;

        this._cleanupSocket();
        if (socket) {
            // node 在 `responseKeepAlive()` 里把请求级超时从 socket 上摘掉（`setTimeout(0)`）。
            // 不摘的话：连接回池后计时器仍在替**上一个请求**倒计时，到点就发 'timeout'
            // 并把这条空闲连接弄死（探针实测：响应完成 8s 后冒出一个 'timeout'）。
            try {
                socket.setTimeout(0);
            } catch {
                // 连接已经关了
            }
            if (serverWantsClose) {
                agent.removeSocket(socket, this._options); // 归还池位
                socket.destroy();
            } else {
                agent.releaseSocket(socket, this._options);
                // socket 的所有权已经交给池了：本请求随后的 `destroy()` 不能再碰它。
                this.destroySocketOnDestroy = false;
                if (this._res) {
                    // node 的 `responseKeepAlive()` 紧接着那句 `req.res.socket = null`，
                    // 注释写明是为了让 `IncomingMessage.destroy()` 拿不到这条已 free 的连接。
                    // 属权判断的第二份保险，也是 node 的可观测形态（#54 实测：'end' 之后
                    // `res.socket === null`、`res.connection === null`，而 `res.client` 仍是
                    // 那条活连接 —— `client` 是 own data，node 不动它；本包的 `client` 也是
                    // 独立字段，天然同形）。**时机**由 res 的 emit 钩子对齐到 'end' 之前，
                    // 不在这里直接置 null（那样用户的 'data' 就看不到 socket 了）。
                    this._res.markSocketFreed();
                }
            }
        }
        this.emit('close');
        // node 在 keep-alive 收尾处（`_http_client.js` 的 `responseKeepAlive()`）把
        // `req.destroyed` 置成 true，响应走完后实测就是 true（`res.destroyed` 才是 false）。
        // node 那里是直接赋字段，本包的 `destroyed` 是 readable-stream 原型上的**只读
        // getter**，赋值会在严格模式里抛 —— 所以只能走 `destroy()`，由上面那句
        // `destroySocketOnDestroy = false` 保证它不会掐掉刚回池的连接（#53）。
        // socket 不复用的分支（`serverWantsClose`）保持 true：那条连接本来就要销毁。
        this.destroy();
    }

    private _isFlushing = false;
    private _flushPendingWrites() {
        if (!this.socket || this._isFlushing) return;

        this._isFlushing = true;
        try {
            if (!this.headersSent) {
                // KEY FIX: When all body data is already queued AND the request is ending,
                // we can calculate the exact Content-Length and avoid chunked encoding.
                //
                // Why this matters: without Content-Length, the request is sent with
                // Transfer-Encoding: chunked. The Rust HTTP parser on the server side
                // stores chunked body bytes in its internal buffer after parsing headers,
                // but calling parser.feed(empty_buffer) to drain those bytes does NOT work
                // — the drain call returns empty metadata and the body is permanently lost.
                //
                // By setting Content-Length here (when we have all the data), the body is
                // sent as raw bytes. The server parser simply reads N bytes and marks the
                // request complete — no chunked framing, no drain issues.
                if (this._ended
                    && !this.hasHeader('Content-Length')
                    && !this.hasHeader('Transfer-Encoding')
                    && this._pendingWrites.length > 0) {
                    const totalLen = this._getPendingBodyLength();
                    this.setHeader('Content-Length', totalLen);
                }
                this._sendRequest();
            }

            // If we are waiting for 100-continue, don't flush yet.
            // H2 没有 100-continue 语义（引擎只回最终响应），必须直接发 body。
            if (!this._h2Session && this._expectContinue && !this._continueReceived) {
                return;
            }

            if (this._h2Session) {
                // H2：native 返回 false 时停在这里，等 DRAIN 再继续。
                // 不能把队列丢给 Writable 内部缓冲，否则会和 end() 的时序打架。
                while (this._pendingWrites.length > 0 && !this._h2PendingWrite) {
                    const pending = this._pendingWrites.shift()!;
                    this._write(pending.chunk, pending.encoding, pending.callback);
                }
            } else {
                // H1：保持既有行为（super._write 直接写 socket）
                while (this._pendingWrites.length > 0) {
                    const writes = this._pendingWrites;
                    this._pendingWrites = [];
                    for (const pending of writes) {
                        super._write(pending.chunk, pending.encoding, pending.callback);
                    }
                }
            }

            // 队列里还有 body（或 native 仍压着一块）时不能结束流，
            // 否则会把剩余数据全部丢掉、只发一个提前的 END_STREAM。
            if (this._ended && this._pendingWrites.length === 0 && !this._h2PendingWrite) {
                super.end();
            }
        } finally {
            this._isFlushing = false;
        }
    }

    // Simplified _finishRequest - not needed as much if we call super.end() directly
    private _finishRequest() {
        if (this._connected && this._pendingWrites.length === 0) {
            super.end();
        }
    }

    /**
     * Host 头对齐 Node（期望值来自 node -e 实测）：
     *   非默认端口要带上 —— `{hostname:'example.com', port:8080}` → `example.com:8080`
     *   默认端口不带     —— http 的 80 / https 的 443 → `example.com`
     *   IPv6 加方括号   —— `{hostname:'::1', port:8080}` → `[::1]:8080`
     * 之前恒为 `this.host`（丢端口），非 80/443 端口上发的 Host 是错的。
     */
    private _hostHeader(): string {
        const hostname = this.host;
        const needsBrackets = hostname.includes(':') && isIPv6(hostname) && !hostname.startsWith('[');
        let hostHeader = needsBrackets ? `[${hostname}]` : hostname;
        const defaultPort = this._options.protocol === 'https:' ? 443 : 80;
        const port = this._options.port;
        if (port !== undefined && port !== null && Number(port) !== defaultPort) {
            hostHeader += `:${port}`;
        }
        return hostHeader;
    }

    /**
     * 请求侧的隐式头。
     *
     * node 的 `ClientRequest` 走同一个 `_storeHeader`，隐式段是 `Host`
     * （本包在 `_sendRequest()` 里显式设了）与 `Transfer-Encoding: chunked`；
     * `Date`/`Connection` 归 Agent 管，不在这里补。
     *
     * ⚠️ 这里**刻意保留 `_sendHeaders` 改造之前的那条兜底**（判据一字不改）：
     * 没有 `Content-Length` 就用 chunked 分帧请求体。少了它，「socket 还没连上就先
     * `write()`」这条路径（`_pendingWrites` 非空但 `_ended` 为假 ⇒
     * `_flushPendingWrites()` 不会补 CL）会发出**既无 CL 也无 TE** 的请求，
     * 服务端无从知道 body 到哪结束 —— 那是比原来更糟的行为。
     * 改造前它是写在 `_sendHeaders()` 里的、对所有 `OutgoingMessage` 生效；
     * 现在帧选择下沉到 `_implicitHeaderLines()`，所以必须在这里显式补回来。
     */
    protected _implicitHeaderLines(): string {
        // `Connection` 归 Agent/ClientRequest 管（服务端那份在 `_connectionLines()`）。
        // node：请求报文头里没有 Connection 时，`_last`（无 agent、用户自带 createConnection、
        // 或 `shouldKeepAlive === false`）就补 `Connection: close`，否则什么都不补
        // （HTTP/1.1 默认就是 keep-alive）。实测 node：无 agent + createConnection ⇒
        // `res.headers.connection === 'close'`；本包此前一直不发这条头（#60 的 A 格）。
        let out = '';
        if (!this.hasHeader('Connection')) {
            // node `_http_outgoing.js:529-546`（逐字）：
            //   shouldSendKeepAlive = shouldKeepAlive && (contLen || useChunkedEncodingByDefault || hasBody)
            //   true  -> 'Connection: keep-alive'（[Keep-Alive: timeout=N] 由 Agent 决定，本包暂不发）
            //   false -> 'Connection: close' 且 `_last = true`
            // 实测 node：globalAgent ⇒ keep-alive；`new Agent()` ⇒ close；
            // `new Agent({keepAlive:true})` ⇒ keep-alive；`agent:false` ⇒ close。
            const contLen = this.hasHeader('Content-Length');
            const shouldSendKeepAlive = this.shouldKeepAlive
                && (contLen || this.useChunkedEncodingByDefault || this._hasBody);
            if (shouldSendKeepAlive) {
                out += 'Connection: keep-alive\r\n';
            } else {
                this._last = true;
                out += 'Connection: close\r\n';
            }
        }
        if (!this.hasHeader('Content-Length') && this._hasBody) {
            this.chunkedEncoding = true;
            out += 'Transfer-Encoding: chunked\r\n';
        }
        return out;
    }

    private _sendH2Headers(): void {
        if (this.headersSent) return;
        this.headersSent = true;
        const session = this._h2Session;
        const impersonation = this._impersonation;
        if (!session || !impersonation) {
            this.emit('error', new Error('ERR_HTTP2_SESSION_CLOSED: session is not assigned'));
            return;
        }
        const endStream =
            this._ended && this._pendingWrites.length === 0 && !this._h2Trailers;
        const json = buildH2RequestJson(
            {
                method: this.method,
                authority: this._hostHeader(),
                path: this.path,
                profile: impersonation.profileData,
                userHeaders: this._headers,
                overrideHeaders: impersonation.overrideHeaders,
                headerPolicy: impersonation.headerPolicy,
            },
            endStream
        );
        this._h2RequestId = session.request(json, {
            onHeaders: (headers) => this._onH2ResponseHeaders(headers),
            onData: (chunk) => {
                this._res?.push(chunk);
            },
            onTrailers: (headers) => this._onH2Trailers(headers),
            onEnd: () => this._finishH2Response(),
            onError: (error) => this._onH2Error(error),
            onDrain: () => this._onH2Drain(),
        });
        this._h2Socket?.setRequestId(this._h2RequestId);
    }

    private _onH2ResponseHeaders(headers: Http2ResponseHeaders): void {
        const { values, raw } = headersFromPairs(headers.headers);
        const res = new IncomingMessage(this.socket!);
        res.statusCode = headers.status;
        res.statusMessage = STATUS_CODES[headers.status] || '';
        res.httpVersion = '2.0';
        res.httpVersionMajor = 2;
        res.httpVersionMinor = 0;
        res.headers = values;
        res.rawHeaders = raw;
        res.method = null as any;
        res.url = '';
        res.req = this;
        res.joinDuplicateHeaders = undefined as any;
        this._res = res;
        this.emit('response', res);
    }

    private _onH2Trailers(headers: Array<[string, string]>): void {
        if (!this._res) return;
        const { values, raw } = headersFromPairs(headers);
        this._res.trailers = values as Record<string, string>;
        this._res.rawTrailers = raw;
    }

    private _onH2Drain(): void {
        const pending = this._h2PendingWrite;
        this._h2PendingWrite = undefined;
        if (pending) {
            try {
                if (
                    !this._h2Session ||
                    this._h2RequestId === undefined ||
                    !this._h2Session.write(this._h2RequestId, pending.data)
                ) {
                    this._h2PendingWrite = pending;
                    return;
                }
                pending.callback?.();
            } catch (error) {
                pending.callback?.(error as Error);
            }
        }
        if (this._pendingWrites.length > 0 || (this._ended && !this._h2PendingWrite)) {
            this._flushPendingWrites();
        }
    }

    private _flushPendingH2Write(error?: Error | null): void {
        const pending = this._h2PendingWrite;
        this._h2PendingWrite = undefined;
        pending?.callback?.(error);
    }

    private _finishH2Response(): void {
        this._flushPendingH2Write();
        if (this._res && !this._res.complete) {
            this._res.complete = true;
            this._res.push(null);
        }
        this._emitCloseOnce();
    }

    private _onH2Error(error: Error): void {
        if (
            canRetryH2Request(
                this.method,
                (error as any)?.code,
                this._h2Retries,
                this._h2BodySent
            )
        ) {
            this._h2Retries++;
            debugLog(`ClientRequest: retrying after REFUSED_STREAM (${this.method} ${this.host}${this.path})`);
            this._resetH2RequestForRetry();
            this._getAgent().addH2Request(this, this._options);
            return;
        }
        this._flushPendingH2Write(error);
        if (this._res && !this._res.complete) {
            this._res.push(null);
        }
        this.emit('error', error);
        this._emitCloseOnce();
    }

    private _resetH2RequestForRetry(): void {
        // 重试会换一条流/一个 facade：旧 facade 上的请求级计时器必须在这里清掉，
        // 否则它 8s 后照样发 'timeout'（回调闭包里还是**这个请求**）—— 设备/探针实测：
        // REFUSED 重试的请求在 8ms 就 200 了，8s 后却又被自己的超时打成错误。
        this._h2Socket?.clearTimeout();
        this._h2Session = undefined;
        this._h2RequestId = undefined;
        this._h2Socket = undefined;
        this._h2BodySent = false;
        this.socket = null;
        this._connected = false;
        this.headersSent = false;
        this._closeEmitted = false;
        this._res = undefined;
    }

    private _emitCloseOnce(): void {
        if (this._closeEmitted) return;
        this._closeEmitted = true;
        this._h2Socket?.clearTimeout();
        this.emit('close');
    }

    private _sendRequest() {
        if (this._h2Session) {
            this._sendH2Headers();
            return;
        }
        debugLog(`ClientRequest._sendRequest: headersSent=${this.headersSent}, socket=${!!this.socket}`);
        if (this.headersSent) return;

        if (!this.hasHeader('host')) {
            this.setHeader('Host', this._hostHeader());
        }

        // 请求行同样是拼出来的：method 与 path 里若带空格/控制字符（尤其是 CRLF），
        // 可以直接改写这一行的结构、甚至插入整段伪造报文（TS-M14）。
        validateRequestMethod(this.method);
        validateRequestPath(this.path);

        const firstLine = `${this.method} ${this.path} HTTP/1.1`;
        debugLog(`ClientRequest._sendRequest: sending firstLine=${firstLine}`);
        this._sendHeaders(firstLine);
    }

    _write(chunk: any, encoding: string, callback: (error?: Error | null) => void) {
        this._hasBody = true;
        if (this._h2Session) {
            try {
                if (!this.headersSent) this._sendH2Headers();
                if (this._h2RequestId === undefined) {
                    throw new Error('ERR_HTTP2_SESSION_CLOSED: request was not opened');
                }
                const data =
                    typeof chunk === 'string'
                        ? Buffer.from(chunk, encoding as any)
                        : Buffer.from(chunk);
                if (data.length > 0) this._h2BodySent = true;
                const accepted = this._h2Session.write(this._h2RequestId, data);
                if (!accepted) {
                    // native 缓冲满：保留这份数据，等 DRAIN 后重试；不能丢。
                    this._h2PendingWrite = { data, callback };
                    return;
                }
                callback?.();
            } catch (error) {
                callback?.(error as Error);
            }
            return;
        }
        if (!this._connected || this._isFlushing) {
            this._pendingWrites.push({ chunk, encoding, callback });
            return;
        }
        if (!this.headersSent) this._sendRequest();
        super._write(chunk, encoding, callback);
    }

    _final(callback: (error?: Error | null) => void) {
        if (this._h2Session) {
            try {
                if (!this.headersSent) this._sendH2Headers();
                if (this._h2RequestId !== undefined) {
                    if (this._h2Trailers) {
                        this._h2Session.trailers(this._h2RequestId, this._h2Trailers);
                    } else {
                        this._h2Session.end(this._h2RequestId);
                    }
                }
                callback();
            } catch (error) {
                callback(error as Error);
            }
            return;
        }
        super._final(callback);
    }

    public addTrailers(headers: Record<string, string>): void {
        if (this._h2Eligible || this._h2Session) {
            if (this.headersSent) {
                throw new Error('ERR_HTTP2_TRAILERS_LATE: trailers must be set before end()');
            }
            this._h2Trailers = headers;
            return;
        }
        super.addTrailers(headers);
    }

    public destroy(error?: Error): this {
        // 「没拿到响应就终止」要报 `ECONNRESET / socket hang up`（node v24 实测，四格语料
        // 见 tests/matrix/cases/case_core_lifecycle.js）：
        //   abort()  先于连接     → **不报**（唯一例外：aborted 且从未拿到 socket）
        //   destroy() 先于连接    → 报
        //   abort()  在 socket 之后 → 报
        //   **已经报过错**再 destroy() → **不报**（got@11 在 once('error') 里 destroy；
        //                                第二个 'error' 没有监听者就会变成未捕获抛出）
        // 顺序也对齐 node：'error' 先于 'close'。调用方自带 error 时不覆盖它。
        if (!error && !this._hangUpEmitted && !this._errorEmitted && !this._res && !(this.aborted && !this._hadSocket)) {
            this._hangUpEmitted = true;
            const hangUp: any = new Error('socket hang up');
            hangUp.code = 'ECONNRESET';
            this.emit('error', hangUp);
        }
        this._flushPendingH2Write(error ?? null);
        if (this._h2Session && this._h2RequestId !== undefined) {
            this._h2Session.abort(this._h2RequestId);
        }
        this._h2Socket?.clearTimeout();
        return super.destroy(error);
    }

    /**
     * 'close' 的**唯一**出口。
     *
     * 请求的终止有多个来源会想发 'close'：socket 的 'close'（`onClose`）、响应正常结束
     * （`_finishResponse`）、readable-stream 基类在 destroy 之后自己排的 `emitCloseNT`、
     * H2 的错误路径。node 的实测行为是**恰好一次**，而这里各发各的会发两次（实测
     * `abort 于 socket 之后` 那格测试 close=2 / node close=1）。
     * 与其在每个来源各加一遍守卫，不如在 emit 处收口 —— 基类那份也管得住。
     */
    public emit(event: string | symbol, ...args: any[]): boolean {
        if (event === 'error') {
            // node：一条请求只报**一个**终止错（实测 `error 之后 destroy()` 仍是 errorCount=1）。
            // 记在这里而不是各 emit 点，是为了让「谁报了错」只有一个真源：调用方在
            // `once('error')` 里调 `destroy()`（got@11 就这么写）时，destroy 不能再补一个
            // 无人监听的 'error' —— 那会变成 EventEmitter 抛出的未捕获异常。
            this._errorEmitted = true;
        }
        if (event === 'close') {
            if (this._closeEmitted) return false;
            this._closeEmitted = true;
            this._h2Socket?.clearTimeout();
        }
        return super.emit(event, ...args);
    }

    write(chunk: any, encoding?: any, callback?: any): boolean {
        this._hasBody = true;
        // If not connected OR currently flushing, enqueue to preserve order
        if (!this._connected || this._isFlushing) {
            this._pendingWrites.push({ chunk, encoding, callback });
            return true;
        }
        return super.write(chunk, encoding, callback);
    }

    end(chunk?: any, encoding?: any, callback?: any): this {
        if (typeof chunk === 'function') {
            callback = chunk;
            chunk = null;
            encoding = null;
        } else if (typeof encoding === 'function') {
            callback = encoding;
            encoding = null;
        }

        debugLog(`ClientRequest.end() called, connected=${this._connected}, chunk=${!!chunk}`);

        if (chunk != null) {
            this._hasBody = true;
            if (!this.headersSent && !this.hasHeader('Content-Length')) {
                const len = this._getPendingBodyLength() + this._getChunkByteLength(chunk, encoding as string | undefined);
                this.setHeader('Content-Length', len);
            }
            // Use this.write to handle pending queue if not connected
            this.write(chunk, encoding);
        }

        this._ended = true;

        if (this._connected) {
            // Only end if the queue is empty. _flushPendingWrites will handle it otherwise.
            if (this._pendingWrites.length === 0) {
                super.end(callback);
            } else if (callback) {
                this.once('finish', callback);
            }
        } else {
            if (callback) this.once('finish', callback);
        }
        return this;
    }

    public abort(): void {
        if (this.aborted) return;
        this.aborted = true;
        this.emit('abort');
        this.destroy();
    }

    public flushHeaders(): void {
        if (this._connected && !this.headersSent) {
            this._sendRequest();
        }
    }
}

// Overloaded signatures for createServer (matching Node.js)
export function createServer(requestListener?: (req: IncomingMessage, res: ServerResponse) => void): Server;
export function createServer(options: ServerOptions, requestListener?: (req: IncomingMessage, res: ServerResponse) => void): Server;
export function createServer(
    optionsOrListener?: ServerOptions | ((req: IncomingMessage, res: ServerResponse) => void),
    requestListener?: (req: IncomingMessage, res: ServerResponse) => void
): Server {
    return new Server(optionsOrListener as any, requestListener);
}

export function request(
    urlOrOptions: string | URL | RequestOptions,
    optionsOrCallback?: RequestOptions | ((res: IncomingMessage) => void),
    callback?: (res: IncomingMessage) => void
): ClientRequest {
    let opts: RequestOptions = {};
    let cb: ((res: IncomingMessage) => void) | undefined = callback;

    if (typeof urlOrOptions === 'string') {
        const URLCtor = requireGlobalURL('http.request()');
        const url = new URLCtor(urlOrOptions);
        opts = {
            protocol: url.protocol,
            hostname: url.hostname,
            path: url.pathname + url.search,
            port: url.port ? parseInt(url.port) : undefined,
            auth: urlBasicAuth(url),
        };
    } else if (isURLLike(urlOrOptions)) {
        opts = {
            protocol: urlOrOptions.protocol,
            hostname: urlOrOptions.hostname,
            path: urlOrOptions.pathname + urlOrOptions.search,
            port: urlOrOptions.port ? parseInt(urlOrOptions.port) : undefined,
            auth: urlBasicAuth(urlOrOptions),
        };
    } else {
        opts = urlOrOptions;
    }

    // Handle (url, options, callback) or (url, callback) signatures
    if (typeof optionsOrCallback === 'function') {
        cb = optionsOrCallback;
    } else if (optionsOrCallback) {
        // Merge options
        opts = { ...opts, ...optionsOrCallback };
    }

    return new ClientRequest(opts, cb);
}

export function get(
    urlOrOptions: string | URL | RequestOptions,
    optionsOrCallback?: RequestOptions | ((res: IncomingMessage) => void),
    callback?: (res: IncomingMessage) => void
): ClientRequest {
    const req = request(urlOrOptions, optionsOrCallback, callback);
    req.end();
    return req;
}

// node 的这些内建有 ESM default（= 模块对象）；got@16 按 `import https from 'node:https'` 取。
// 全部写成 **getter**：本文件与 tls/http 之间有循环依赖，对象字面量的简写属性会在
// 求值时触碰尚未初始化的绑定（某些宿主报成 `Agent is not initialized`，实测）。
export default {
    get STATUS_CODES() { return STATUS_CODES },
    get METHODS() { return METHODS },
    get maxHeaderSize() { return maxHeaderSize },
    get validateHeaderName() { return validateHeaderName },
    get validateHeaderValue() { return validateHeaderValue },
    get IncomingMessage() { return IncomingMessage },
    get OutgoingMessage() { return OutgoingMessage },
    get ServerResponse() { return ServerResponse },
    get Server() { return Server },
    get Agent() { return Agent },
    get globalAgent() { return globalAgent },
    get ClientRequest() { return ClientRequest },
    get createServer() { return createServer },
    get request() { return request },
    get get() { return get },
};
