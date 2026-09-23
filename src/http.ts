import { Writable, Readable } from 'readable-stream'
import { EventEmitter } from 'eventemitter3'
import { Buffer } from 'react-native-nitro-buffer'

import { Driver } from './Driver'
import { Socket, Server as NetServer, isIPv6 } from './net'
import { TLSSocket } from './tls'
import { debugLog as loggerDebugLog } from './Logger'
// 全局 `URL` 的存在性守卫抽到 urlCompat.ts：http 与 https **两处**都要用
// （只修 http 一侧时 `https.request({...})` 会以 `URL is not defined` 失败，实测过）。
import { isURLLike, requireGlobalURL } from './urlCompat'

function debugLog(message: string | (() => string)) {
    loggerDebugLog('HTTP', message)
}

// ========== STATUS_CODES ==========

export const STATUS_CODES: Record<number, string> = {
    100: 'Continue',
    101: 'Switching Protocols',
    102: 'Processing',
    200: 'OK',
    201: 'Created',
    202: 'Accepted',
    203: 'Non-Authoritative Information',
    204: 'No Content',
    205: 'Reset Content',
    206: 'Partial Content',
    300: 'Multiple Choices',
    301: 'Moved Permanently',
    302: 'Found',
    303: 'See Other',
    304: 'Not Modified',
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
    418: "I'm a teapot",
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

function errWithCode(message: string, code: string): TypeError {
    const err = new TypeError(message);
    (err as any).code = code;
    return err;
}

function validateHeaderName(name: string): void {
    if (!HTTP_TOKEN_RE.test(name)) {
        throw errWithCode(
            `Header name must be a valid HTTP token ["${name}"]`,
            'ERR_INVALID_HTTP_TOKEN'
        );
    }
}

function validateHeaderValue(name: string, value: string): void {
    if (INVALID_HEADER_VALUE_RE.test(value)) {
        throw errWithCode(`Invalid character in header content ["${name}"]`, 'ERR_INVALID_CHAR');
    }
}

/** 响应状态行里的 status message。 */
function validateStatusMessage(message: string): void {
    if (INVALID_HEADER_VALUE_RE.test(message)) {
        throw errWithCode('Invalid character in statusMessage', 'ERR_INVALID_CHAR');
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
    public rawHeaders: string[] = [];
    public socket: Socket;
    public aborted: boolean = false;
    public complete: boolean = false;
    public trailers: Record<string, string> = {};

    constructor(socket: Socket) {
        // @ts-ignore
        super({ autoDestroy: false });
        this.socket = socket;
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

    public destroy(error?: Error): this {
        super.destroy(error);
        this.socket.destroy();
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
    public socket: Socket | null = null;

    public chunkedEncoding: boolean = false;
    protected _hasBody: boolean = true;
    protected _sendHeadersSent: boolean = false;
    public aborted: boolean = false;
    protected _trailers: Record<string, string> | null = null;

    constructor() {
        // @ts-ignore - disable autoDestroy to prevent socket from being destroyed when stream ends
        super({ autoDestroy: false });
    }

    public destroy(error?: Error): this {
        super.destroy(error);
        if (this.socket) {
            this.socket.destroy();
        }
        return this;
    }

    setHeader(name: string, value: any): this {
        if (this.headersSent) throw new Error('Cannot set headers after they are sent');
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
        return this;
    }

    getHeader(name: string): any {
        return this._headers[name.toLowerCase()];
    }

    removeHeader(name: string): void {
        if (this.headersSent) throw new Error('Cannot remove headers after they are sent');
        const key = name.toLowerCase();
        delete this._headers[key];
        delete this._headerNames[key];
    }

    hasHeader(name: string): boolean {
        return name.toLowerCase() in this._headers;
    }

    getHeaderNames(): string[] {
        return Object.values(this._headerNames);
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

    protected _renderHeaders(firstLine: string): string {
        let headerStr = firstLine + '\r\n';
        for (const key in this._headers) {
            const name = this._headerNames[key];
            const value = this._headers[key];
            if (Array.isArray(value)) {
                for (const v of value) {
                    headerStr += `${name}: ${v}\r\n`;
                }
            } else {
                headerStr += `${name}: ${value}\r\n`;
            }
        }
        headerStr += '\r\n';
        return headerStr;
    }

    protected _sendHeaders(firstLine: string) {
        if (this.headersSent) return;

        // Check for Chunked Encoding
        if (!this.hasHeader('Content-Length') && this._hasBody) {
            this.setHeader('Transfer-Encoding', 'chunked');
            this.chunkedEncoding = true;
        }

        this.headersSent = true;
        const headerStr = this._renderHeaders(firstLine);
        debugLog(`OutgoingMessage._sendHeaders: writing ${headerStr.length} bytes to socket (socket=${!!this.socket})`);
        this.socket!.write(Buffer.from(headerStr));
    }

    _write(chunk: any, encoding: string, callback: (error?: Error | null) => void) {
        if (!this.socket) {
            callback(new Error('Socket not assigned'));
            return;
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
        const ret = super.write(chunk, encoding, callback);
        // If writableLength is too high, return false
        // But since we are proxying to socket, we should also check socket backpressure
        if (this.socket && (this.socket as any)._writableState) {
            // This is a bit hacky but if we have a real Node-like socket, we respect its state
            return ret && !(this.socket as any)._writableState.needDrain;
        }
        return ret;
    }

    // _final is called by the stream when all writes are complete before 'finish' event
    _final(callback: (error?: Error | null) => void) {
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
            callback();
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
}

// ========== ServerResponse ==========

export class ServerResponse extends OutgoingMessage {
    public statusCode: number = 200;
    public statusMessage?: string;
    public socket: Socket;
    /** 已写出的 body 字节数，用于校验 `Content-Length`（TS-M13）。 */
    private _bodyBytesWritten: number = 0;

    constructor(socket: Socket, requestMethod: string = 'GET') {
        super();
        this.socket = socket;
        // HEAD 响应不允许带 body（RFC 9110 §9.3.2），但解析器不知道请求方法 —— 只有 server
        // 侧知道，所以由构造参数传进来。关掉 `_hasBody` 后：不会自动补
        // Content-Length/Transfer-Encoding（与 Node 实测行为一致），写进来的 body 也会被丢弃。
        if (String(requestMethod).toUpperCase() === 'HEAD') {
            this._hasBody = false;
        }

        const onClose = () => {
            if (this.socket) {
                this.socket.removeListener('close', onClose);
            }
            this.removeListener('finish', onClose);
            this.emit('close');
        };
        this.once('finish', onClose);
        this.socket.once('close', onClose);
    }

    writeHead(statusCode: number, statusMessage?: string | Record<string, any>, headers?: Record<string, any>): this {
        if (this.headersSent) throw new Error('Cannot write headers after they are sent');
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
        // Note: Do NOT send headers here. They will be sent on first write/end
        // when Content-Length can be determined.
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
        }
    }

    /** 已声明的 `Content-Length`（没有或不是数字则为 null）。 */
    private _declaredContentLength(): number | null {
        const raw = this.getHeader('Content-Length');
        if (raw === undefined || raw === null) return null;
        const n = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
        return Number.isFinite(n) && n >= 0 ? n : null;
    }

    private _contentLengthMismatchError(declared: number, actual: number, kind: string): TypeError {
        return errWithCode(
            `Response body's length (${actual}) ${kind} the declared Content-Length (${declared}); ` +
                `refusing to put a desynchronised body on the wire`,
            'ERR_HTTP_CONTENT_LENGTH_MISMATCH'
        );
    }

    private _sendResponseHeaders() {
        if (this.headersSent) return;
        // 覆盖 `res.statusCode = 204` 这种绕过 writeHead 的直接赋值
        this._applyNoBodyStatus();
        // statusMessage 直接拼进状态行（且 `res.statusMessage = '...'` 可绕过 writeHead），
        // 所以在这里收口校验，否则一样能注入出假的响应头（TS-M14）。
        const statusMessage = this.statusMessage || STATUS_CODES[this.statusCode] || 'OK';
        validateStatusMessage(statusMessage);
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

        const len = typeof chunk === 'string' ? Buffer.byteLength(chunk, encoding as any) : chunk.length;
        const declared = this._declaredContentLength();
        if (declared !== null && this._bodyBytesWritten + len > declared) {
            // 多写的字节会被对端当成**下一个响应**的开头（keep-alive 下直接错位/走私）。
            // Node 的 HTTP/1 默认会照发（实测如此），这里选择拒绝：已经发出去的部分无法撤回，
            // 所以这条连接必须废弃，客户端会从截断的响应里发现异常。
            const err = this._contentLengthMismatchError(
                declared,
                this._bodyBytesWritten + len,
                'exceeds'
            );
            this.socket?.destroy();
            callback(err);
            return;
        }
        this._bodyBytesWritten += len;

        super._write(chunk, encoding, callback);
    }

    _final(callback: (error?: Error | null) => void) {
        // 少写同样致命：声明了 N 字节却只发了 M<N，对端会一直等剩下的字节（连接挂死）。
        const declared = this._hasBody && !this.chunkedEncoding ? this._declaredContentLength() : null;
        if (declared !== null && this._bodyBytesWritten < declared) {
            const err = this._contentLengthMismatchError(declared, this._bodyBytesWritten, 'is less than');
            this.socket?.destroy();
            callback(err);
            return;
        }
        super._final(callback);
    }

    write(chunk: any, encoding?: any, callback?: any): boolean {
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

        if (!this.headersSent) {
            // If we have a single chunk and no headers sent yet, we can add Content-Length
            // to avoid chunked encoding for simple responses.
            //
            // 无 body 的响应（HEAD / 204 / 304）不补：Node 实测也不会自动补（用户显式设过的
            // 则保留），补了反而会给对端一个"还有 N 字节"的错误信号。
            if (!this._hasBody) {
                debugLog(`ServerResponse.end: no-body response (status=${this.statusCode}), skipping Content-Length`);
            } else if (chunk != null) {
                const len = typeof chunk === 'string' ? Buffer.byteLength(chunk, (encoding as string) || undefined) : chunk.length;
                this.setHeader('Content-Length', len);
            } else if (!this.hasHeader('Transfer-Encoding')) {
                this.setHeader('Content-Length', 0);
            }
            this._sendResponseHeaders();
        }

        if (chunk != null) {
            this.write(chunk, encoding);
        }
        super.end(callback);
        return this;
    }
}

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

export class Server extends EventEmitter {
    protected _netServer: any;
    protected _httpConnections = new Set<Socket>();
    public maxHeaderSize: number = 16384;
    public headersTimeout: number = 60000;
    public keepAliveTimeout: number = 5000;
    // 注：原先这里还有 requestTimeout / maxRequestsPerSocket 两个字段（以及同名 option），
    // 但它们从未被任何代码读过 —— 只是"看起来支持"。Task 26 删掉，避免误以为已经生效。
    // （Node 有这两个概念；将来要实现 requestTimeout 应覆盖"从收到请求到读完 body"这段。）

    constructor(options?: ServerOptions | ((req: IncomingMessage, res: ServerResponse) => void), requestListener?: (req: IncomingMessage, res: ServerResponse) => void) {
        super();
        // net.Server 走**顶层 import**（见文件头），不再用函数内 `require('./net')`：
        // 那条惰性 require 在 ESM-only 宿主（全局无 `require`，如无头 JS 宿主）
        // 里会让 http.createServer() 一调就 ReferenceError。net.ts 不 import http.ts，
        // 循环依赖不存在；顶层 import 对 RN 无行为差异（tls.ts 早就这么写了）。
        this._netServer = new NetServer();

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

        // Forward net.Server events
        this._netServer.on('listening', () => this.emit('listening'));
        this._netServer.on('close', () => this.emit('close'));
        this._netServer.on('error', (err: any) => this.emit('error', err));
        // setTimeout() 会把回调挂到 netServer 的 'timeout' 事件上；这里转发给 http.Server，
        // 否则 `server.setTimeout(ms, cb)` 传入的 cb 永远不会被调用（TS-H7 修复的一部分）
        this._netServer.on('timeout', (socket: any) => this.emit('timeout', socket));

        this._netServer.on('connection', (socket: Socket) => {
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
        let headersTimer: any = null;
        let keepAliveTimer: any = null;

        const clearTimers = () => {
            if (headersTimer) { clearTimeout(headersTimer); headersTimer = null; }
            if (keepAliveTimer) { clearTimeout(keepAliveTimer); keepAliveTimer = null; }
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
            if (this.keepAliveTimeout > 0) {
                keepAliveTimer = setTimeout(() => {
                    debugLog(`Server: keepAliveTimeout (${this.keepAliveTimeout}ms) reached, closing idle connection`);
                    socket.destroy();
                }, this.keepAliveTimeout);
            }
        };

        armHeadersTimer();

        const onData = (data: Buffer) => {
            // 空闲连接上来了数据（下一条请求）→ 从"空闲"切回"等请求头"
            if (keepAliveTimer) armHeadersTimer();

            const handleParsedResult = (result: any) => {
                const metadata = result.metadata;
                if (metadata.startsWith('ERROR:')) {
                    clearTimers();
                    this.emit('error', new Error(metadata));
                    socket.destroy();
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
                    req = currentReq;

                    const currentRes = new ServerResponse(socket, parsed.method ?? 'GET');
                    res = currentRes;

                    // Support Keep-Alive: reset state once response is done
                    currentRes.on('finish', () => {
                        req = null;
                        res = null;
                        // 响应结束、连接回到空闲：起 keepAliveTimeout，闲置太久就回收
                        // （若响应本身要求关连接，socket 随后会被销毁，这个计时器随 'close' 清掉）
                        if (!socket.destroyed) armKeepAliveTimer();
                        // The parser should already be reset in Rust
                    });

                    if (isUpgradeRequest(req.headers) && this.listenerCount('upgrade') > 0) {
                        debugLog(`Server: Upgrade request received, emitting 'upgrade' event`);
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
                            socket.write(Buffer.from('HTTP/1.1 100 Continue\r\n\r\n'));
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
                const _reqRef = req;

                // Diagnostic: log body delivery state (requires debug mode)
                // 每个数据包都会走到这里 → thunk，避免 verbose 关闭时白拼 3 段字符串
                debugLog(() => `[Server] handleParsedResult: is_headers=${parsed.is_headers}, ` +
                    `bodyLen=${_bodyToPush?.length ?? 0}, complete=${_isComplete}, ` +
                    `req.readableFlowing=${(_reqRef as any)?._readableState?.flowing}`);

                if (_bodyToPush !== null || _isComplete) {
                    if (parsed.is_headers) {
                        // Same-packet case: defer to give Readable time to enter flowing mode
                        debugLog(`[Server] Deferring body/EOF push via setImmediate (same-packet)`);
                        setImmediate(() => {
                            if (!_reqRef) return;
                            debugLog(() => `[Server] setImmediate: pushing body=${_bodyToPush?.length ?? 0}, EOF=${_isComplete}`);
                            if (_bodyToPush) _reqRef.push(_bodyToPush);
                            if (_isComplete) {
                                _reqRef.complete = true;
                                if (_trailers) _reqRef.trailers = _trailers;
                                _reqRef.push(null);
                            }
                        });
                    } else {
                        // Subsequent-packet case: push immediately
                        debugLog(`[Server] Pushing body/EOF immediately (subsequent-packet)`);
                        if (_bodyToPush) _reqRef!.push(_bodyToPush);
                        if (_isComplete) {
                            _reqRef!.complete = true;
                            if (_trailers) _reqRef!.trailers = _trailers;
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
        });

        socket.on('error', (err: Error) => {
            if (req) req.emit('error', err);
            else this.emit('error', err);
        });
    }

    listen(...args: any[]): this {
        this._netServer.listen(...args);
        return this;
    }

    close(callback?: (err?: Error) => void): this {
        this._netServer.close(callback);
        return this;
    }

    // @ts-ignore
    async[Symbol.asyncDispose]() {
        return new Promise<void>((resolve) => {
            this.close(() => resolve());
        });
    }

    address(): { port: number; family: string; address: string } | null {
        return this._netServer.address();
    }

    get listening(): boolean {
        return this._netServer.listening;
    }

    setTimeout(ms: number, callback?: () => void): this {
        this._netServer.setTimeout(ms, callback);
        return this;
    }
}

// ========== Agent ==========

export interface AgentOptions {
    keepAlive?: boolean;
    keepAliveMsecs?: number;
    maxSockets?: number;
    maxTotalSockets?: number;
    maxFreeSockets?: number;
    scheduling?: 'fifo' | 'lifo';
    timeout?: number;
    maxCachedSessions?: number;
}

export class Agent extends EventEmitter {
    public maxSockets: number = Infinity;
    public maxTotalSockets: number = Infinity;
    public maxFreeSockets: number = 256;
    public keepAlive: boolean = false;
    public keepAliveMsecs: number = 1000;
    public maxCachedSessions: number = 100;
    public scheduling: 'fifo' | 'lifo' = 'lifo';

    public requests: Record<string, ClientRequest[]> = {};
    public sockets: Record<string, Socket[]> = {};
    public freeSockets: Record<string, Socket[]> = {};
    private _totalSockets: number = 0;
    public proxy: string | null = null;

    /**
     * Gets the proxy URL for the given request options.
     * Checks HTTP_PROXY, HTTPS_PROXY, and NO_PROXY environment variables.
     * 
     * @param options Request options to determine if proxy should be used
     * @returns Proxy URL or null if no proxy should be used
     */
    protected getProxy(options: RequestOptions): string | null {
        // If explicitly set on agent, use that
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
        if (options?.maxSockets) this.maxSockets = options.maxSockets;
        if (options?.maxTotalSockets) this.maxTotalSockets = options.maxTotalSockets;
        if (options?.maxFreeSockets) this.maxFreeSockets = options.maxFreeSockets;
        if (options?.keepAlive) this.keepAlive = options.keepAlive;
        if (options?.keepAliveMsecs) this.keepAliveMsecs = options.keepAliveMsecs;
        if (options?.scheduling) this.scheduling = options.scheduling;
        if (options?.maxCachedSessions !== undefined) this.maxCachedSessions = options.maxCachedSessions;
    }

    public getName(options: RequestOptions): string {
        let name = `${options.host || options.hostname || 'localhost'}:${options.port || (options.protocol === 'https:' ? 443 : 80)}:`;
        if (options.localAddress) name += `${options.localAddress}:`;
        if (options.family) name += `${options.family}:`;
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

    public createConnection(options: RequestOptions, callback: (err: Error | null, socket: Socket) => void): Socket {
        const name = this.getName(options);
        const isHttps = options.protocol === 'https:';
        const port = options.port || (isHttps ? 443 : 80);
        const host = options.hostname || options.host || 'localhost';

        debugLog(`Agent.createConnection: name=${name}, isHttps=${isHttps}, host=${host}, port=${port}`);

        // Build clean connection options - DO NOT pass HTTP path as it will be confused with Unix socket path
        const connectOptions: any = {
            host: host,
            port: port,
        };
        if (isHttps) {
            connectOptions.servername = (options as any).servername || host;
            connectOptions.rejectUnauthorized = options.rejectUnauthorized !== false;
            if ((options as any).ca) connectOptions.ca = (options as any).ca;
            if ((options as any).cert) connectOptions.cert = (options as any).cert;
            if ((options as any).key) connectOptions.key = (options as any).key;
        }

        const socket = isHttps ? new TLSSocket(connectOptions) : new Socket();

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
        const name = this.getName(options);

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
                // 空闲超时：keepAliveMsecs 内没被复用就销毁并归还池位（TS-M3）。
                // 注：Node 里 keepAliveMsecs 本是 TCP keep-alive 探测间隔，这里按计划
                // 兼作空闲上限。默认 1s 偏保守 —— 池化收益变小，但不会长期占着空闲 fd。
                const idleTimer = setTimeout(() => {
                    delete (socket as any)._agentIdleTimer;
                    this._removeSocket(socket, name);
                    socket.destroy();
                }, this.keepAliveMsecs);
                (socket as any)._agentIdleTimer = idleTimer;
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

export const globalAgent = new Agent();

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
    timeout?: number;
    rejectUnauthorized?: boolean;
    // ...
}

export class ClientRequest extends OutgoingMessage {
    public method: string;
    public path: string;
    public host: string;
    private _res?: IncomingMessage;
    private _options: RequestOptions;
    private _connected: boolean = false;
    private _pendingWrites: Array<{ chunk: any; encoding?: any; callback?: any }> = [];
    private _ended: boolean = false;
    private _expectContinue: boolean = false;
    private _continueReceived: boolean = false;

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
        this._options = options;
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

        const agent = options.agent === false ? new Agent() : (options.agent instanceof Agent ? options.agent : globalAgent);

        // Use setImmediate or setTimeout for React Native compatibility
        const nextTick = typeof setImmediate !== 'undefined' ? setImmediate : (fn: () => void) => setTimeout(fn, 0);
        nextTick(() => {
            debugLog(`ClientRequest: nextTick fired for ${this.method} ${this.host}${this.path}`);
            agent.addRequest(this, this._options)
        });
    }

    /** @internal */
    public onSocket(socket: Socket | null) {
        if (socket) {
            this.socket = socket;
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

    private _connect() {
        const agent = this._options.agent === false ? new Agent() : (this._options.agent instanceof Agent ? this._options.agent : globalAgent);

        const connectCallback = (err: Error | null, socket: Socket) => {
            if (err) {
                debugLog(`ClientRequest._connect: ERROR: ${err.message}`);
                this.emit('error', err);
                return;
            }
            debugLog(`ClientRequest._connect: Socket connected!`);
            this.socket = socket;
            this._connected = true;
            this.emit('socket', this.socket);
            // IMPORTANT: attach response listeners BEFORE flushing writes.
            // If we flush first, the server may respond before we have a data listener.
            this._attachSocketListeners();
            // _flushPendingWrites() internally calls _sendRequest() if headers not sent yet.
            // Do NOT call _sendRequest() separately here — _flushPendingWrites() needs to
            // inspect headersSent and _pendingWrites together so it can set Content-Length
            // before sending headers (to avoid chunked encoding when body is already known).
            this._flushPendingWrites();
        };

        this.socket = agent.createConnection(this._options, connectCallback);
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
                    this.socket!.destroy();
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
                            rawHeaders: []
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
                    this._res.httpVersion = '1.' + parsed.version;
                    this._res.headers = parsed.headers;

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
            this.emit('error', err);
            this._discardSocket();
            this._cleanupSocket();
        };

        const onClose = () => {
            debugLog(`[HTTP] _connect: Socket closed`);
            if (this._res && !this._res.readableEnded) this._res.push(null);
            this.emit('close');
            this._discardSocket();
            this._cleanupSocket();
        };

        this.socket.on('data', onData);
        this.socket.on('error', onError);
        this.socket.on('close', onClose);

        this._socketCleanup = () => {
            this.socket?.removeListener('data', onData);
            this.socket?.removeListener('error', onError);
            this.socket?.removeListener('close', onClose);
        };
    }

    private _socketCleanup?: () => void;

    /** 取得本次请求实际使用的 agent（与 _finishResponse 的选择逻辑保持一致）。 */
    private _getAgent(): Agent {
        return this._options.agent === false
            ? new Agent()
            : (this._options.agent instanceof Agent ? this._options.agent : globalAgent);
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
        this.socket = null;
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

        const serverWantsClose = explicitClose || (isHttp10 && !explicitKeepAlive);

        this._cleanupSocket();
        if (socket) {
            if (serverWantsClose) {
                agent.removeSocket(socket, this._options); // 归还池位
                socket.destroy();
            } else {
                agent.releaseSocket(socket, this._options);
            }
        }
        this.emit('close');
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

            // If we are waiting for 100-continue, don't flush yet
            if (this._expectContinue && !this._continueReceived) {
                return;
            }

            // Keep draining the queue as long as it has items
            // This handles writes that might happen while we are flushing (e.g. from callbacks)
            while (this._pendingWrites.length > 0) {
                const writes = this._pendingWrites;
                this._pendingWrites = [];
                for (const pending of writes) {
                    // Call super._write (OutgoingMessage._write) directly
                    super._write(pending.chunk, pending.encoding, pending.callback);
                }
            }

            if (this._ended) {
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

    private _sendRequest() {
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
        if (!this._connected || this._isFlushing) {
            this._pendingWrites.push({ chunk, encoding, callback });
            return;
        }
        if (!this.headersSent) this._sendRequest();
        super._write(chunk, encoding, callback);
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
            port: url.port ? parseInt(url.port) : undefined
        };
    } else if (isURLLike(urlOrOptions)) {
        opts = {
            protocol: urlOrOptions.protocol,
            hostname: urlOrOptions.hostname,
            path: urlOrOptions.pathname + urlOrOptions.search,
            port: urlOrOptions.port ? parseInt(urlOrOptions.port) : undefined
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
