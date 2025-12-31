import { Writable, Readable } from 'readable-stream'
import { EventEmitter } from 'eventemitter3'
import { Driver } from './Driver'
import { Socket, isVerbose } from './net'
import { TLSSocket } from './tls'
import { Buffer } from 'react-native-nitro-buffer'

function debugLog(message: string) {
    if (isVerbose()) {
        const timestamp = new Date().toISOString().split('T')[1].split('Z')[0];
        console.log(`[HTTP DEBUG ${timestamp}] ${message}`);
    }
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
        this.socket.resume();
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
        this.once('finish', () => {
            this.emit('close');
        });
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
            const len = typeof chunk === 'string' ? Buffer.byteLength(chunk, encoding as any) : chunk.length;
            const header = len.toString(16) + '\r\n';
            this.socket.write(Buffer.from(header));
            // Note: We don't return the backpressure status here because we are doing multiple writes
            // The final write determines the callback.
            this.socket.write(chunk, encoding as any, (err) => {
                if (err) return callback(err);
                this.socket!.write(Buffer.from('\r\n'), undefined, callback);
            });
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
        debugLog(`OutgoingMessage.end() called, already ending: ${(this as any)._writableState?.ending}, chunk: ${!!chunk}`);
        if (chunk) {
            this.write(chunk, encoding);
        }
        super.end(undefined, undefined, callback);
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

    constructor(socket: Socket) {
        super();
        this.socket = socket;
    }

    writeHead(statusCode: number, statusMessage?: string | Record<string, any>, headers?: Record<string, any>): this {
        if (this.headersSent) throw new Error('Cannot write headers after they are sent');
        this.statusCode = statusCode;
        if (typeof statusMessage === 'object') {
            headers = statusMessage;
            statusMessage = undefined;
        }
        if (statusMessage) this.statusMessage = statusMessage;
        if (headers) {
            for (const key in headers) {
                this.setHeader(key, headers[key]);
            }
        }
        // Note: Do NOT send headers here. They will be sent on first write/end
        // when Content-Length can be determined.
        return this;
    }

    private _sendResponseHeaders() {
        if (this.headersSent) return;
        const firstLine = `HTTP/1.1 ${this.statusCode} ${this.statusMessage || STATUS_CODES[this.statusCode] || 'OK'}`;
        this._sendHeaders(firstLine);
    }

    _write(chunk: any, encoding: string, callback: (error?: Error | null) => void) {
        if (!this.headersSent) this._sendResponseHeaders();
        super._write(chunk, encoding, callback);
    }

    write(chunk: any, encoding?: any, callback?: any): boolean {
        return super.write(chunk, encoding, callback);
    }

    end(chunk?: any, encoding?: any, callback?: any): this {
        if (!this.headersSent) {
            // If we have a single chunk and no headers sent yet, we can add Content-Length
            // to avoid chunked encoding for simple responses.
            if (chunk) {
                const len = typeof chunk === 'string' ? Buffer.byteLength(chunk, encoding) : chunk.length;
                this.setHeader('Content-Length', len);
            } else {
                this.setHeader('Content-Length', 0);
            }
            this._sendResponseHeaders();
        }
        // super.end will trigger _write if chunk was provided.
        super.end(chunk, encoding, () => {
            if (callback) callback();
        });
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
     * Keep-Alive header timeout in milliseconds.
     */
    keepAliveTimeout?: number;
    /**
     * Request timeout in milliseconds.
     */
    requestTimeout?: number;
    /**
     * Headers timeout in milliseconds.
     */
    headersTimeout?: number;
    /**
     * Max header size in bytes.
     */
    maxHeaderSize?: number;
    /**
     * If defined, sets the maximum number of requests socket can handle.
     */
    maxRequestsPerSocket?: number;
}

export class Server extends EventEmitter {
    protected _netServer: any;
    protected _httpConnections = new Set<Socket>();
    public maxHeaderSize: number = 16384;
    public maxRequestsPerSocket: number = 0;
    public headersTimeout: number = 60000;
    public requestTimeout: number = 300000;
    public keepAliveTimeout: number = 5000;

    constructor(options?: ServerOptions | ((req: IncomingMessage, res: ServerResponse) => void), requestListener?: (req: IncomingMessage, res: ServerResponse) => void) {
        super();
        // Use net.Server from index.ts
        const { Server: NetServer } = require('./net');
        this._netServer = new NetServer();

        let listener: ((req: IncomingMessage, res: ServerResponse) => void) | undefined;
        if (typeof options === 'function') {
            listener = options;
        } else if (options) {
            if (options.keepAliveTimeout !== undefined) this.keepAliveTimeout = options.keepAliveTimeout;
            if (options.requestTimeout !== undefined) this.requestTimeout = options.requestTimeout;
            if (options.headersTimeout !== undefined) this.headersTimeout = options.headersTimeout;
            if (options.maxHeaderSize !== undefined) this.maxHeaderSize = options.maxHeaderSize;
            if (options.maxRequestsPerSocket !== undefined) this.maxRequestsPerSocket = options.maxRequestsPerSocket;
            listener = requestListener;
        }

        if (listener) {
            this.on('request', listener);
        }

        // Forward net.Server events
        this._netServer.on('listening', () => this.emit('listening'));
        this._netServer.on('close', () => this.emit('close'));
        this._netServer.on('error', (err: any) => this.emit('error', err));

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

        // headersTimeout logic
        let headersTimer: any = null;
        if (this.headersTimeout > 0) {
            headersTimer = setTimeout(() => {
                debugLog(`Server: headersTimeout reached for socket, destroying`);
                socket.destroy();
            }, this.headersTimeout);
        }

        const onData = (data: Buffer) => {
            const handleParsedResult = (result: string) => {
                if (result.startsWith('ERROR:')) {
                    if (headersTimer) clearTimeout(headersTimer);
                    this.emit('error', new Error(result));
                    socket.destroy();
                    return;
                }
                const parsed = JSON.parse(result);

                if (parsed.is_headers) {
                    if (headersTimer) {
                        clearTimeout(headersTimer);
                        headersTimer = null;
                    }

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

                        // TODO: retrieve any remaining body from parser as 'head'
                        const head = Buffer.alloc(0);

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

                    const currentRes = new ServerResponse(socket);
                    res = currentRes;

                    // Support Keep-Alive: reset state once response is done
                    currentRes.on('finish', () => {
                        req = null;
                        res = null;
                        // The parser should already be reset in Rust
                    });

                    const upgrade = req.headers['upgrade'];
                    if (upgrade && this.listenerCount('upgrade') > 0) {
                        debugLog(`Server: Upgrade request received, emitting 'upgrade' event`);
                        this.emit('upgrade', req, socket, Buffer.alloc(0));
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

                if (req && parsed.body && parsed.body.length > 0) {
                    req.push(Buffer.from(parsed.body));
                }

                if (req && parsed.complete) {
                    req.complete = true;
                    if (parsed.trailers) {
                        req.trailers = parsed.trailers;
                    }
                    req.push(null);
                }

                // For Keep-Alive, try to parse remaining buffer in case of pipelining
                if (parsed.complete && !req) {
                    // This case is handled by the feed loop if multiple messages in data
                }
            };

            let input: ArrayBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
            let iterations = 0;
            const maxIterations = 100; // Safety limit
            while (iterations < maxIterations) {
                iterations++;
                const result = parser.feed(input);
                if (!result || result === '' || result.startsWith('ERROR:')) {
                    // Empty result (partial) or error - exit loop
                    if (result && result.startsWith('ERROR:')) {
                        console.log(`[HTTP] Server: Parser error: ${result}`);
                    }
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
            if (headersTimer) clearTimeout(headersTimer);
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

            // Re-use socket
            if (!this.sockets[name]) this.sockets[name] = [];
            this.sockets[name].push(socket);

            req.onSocket(socket);
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
            if (called) return;
            called = true;
            debugLog(`Agent.createConnection: socket ERROR for ${name}: ${err.message}`);
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
                this.freeSockets[name].push(socket);
            } else {
                this._totalSockets--;
                socket.end();
            }
        } else {
            this._totalSockets--;
            socket.end();
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

    constructor(options: RequestOptions, callback?: (res: IncomingMessage) => void) {
        super();
        this._options = options;
        this.method = options.method || 'GET';
        this.path = options.path || '/';
        this.host = options.hostname || options.host || 'localhost';

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
            this._sendRequest();
            this._flushPendingWrites();
            this._attachSocketListeners();
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
            debugLog(`ClientRequest._connect: Socket connected! socket=${!!socket}, socket._driver=${!!(socket as any)._driver}`);
            console.log(`[HTTP] _connect: Socket connected!`);
            this.socket = socket;
            this._connected = true;
            this.emit('socket', this.socket);
            debugLog(`ClientRequest._connect: Calling _sendRequest`);
            this._sendRequest();
            this._flushPendingWrites();
            this._attachSocketListeners();
        };

        this.socket = agent.createConnection(this._options, connectCallback);
    }

    private _attachSocketListeners() {
        if (!this.socket) return;

        const parser = Driver.createHttpParser(1); // 1 = Response mode

        const onData = (data: Buffer) => {
            const handleParsedResult = (result: string) => {
                if (result.startsWith('ERROR:')) {
                    this.emit('error', new Error(result));
                    this.socket!.destroy();
                    return;
                }
                const parsed = JSON.parse(result);
                console.log(`[HTTP] _connect: Parser result: ${parsed.is_headers ? 'HEADERS' : 'DATA'}${parsed.complete ? ' (COMPLETE)' : ''}`);

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
                        this.emit('upgrade', this._res, this.socket!, Buffer.alloc(0));
                        return;
                    }

                    // Handle CONNECT method response (HTTP Tunneling)
                    if (this.method.toUpperCase() === 'CONNECT' && status >= 200 && status < 300) {
                        debugLog(`ClientRequest: CONNECT tunnel established (status=${status}), emitting 'connect' event`);
                        this.socket!.removeListener('data', onData);
                        this.socket!.removeListener('error', onError);
                        this.emit('connect', this._res, this.socket!, Buffer.alloc(0));
                        return;
                    }

                    this.emit('response', this._res);
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
            const maxIterations = 100; // Safety limit
            while (iterations < maxIterations) {
                iterations++;
                const result = parser.feed(input);
                if (!result || result === '' || result.startsWith('ERROR:')) {
                    // Empty result (partial) or error - exit loop
                    if (result && result.startsWith('ERROR:')) {
                        console.log(`[HTTP] ClientRequest: Parser error: ${result}`);
                    }
                    break;
                }
                handleParsedResult(result);
                input = new ArrayBuffer(0); // Continue with empty input to drain Rust buffer
            }
        };

        const onError = (err: Error) => {
            console.log(`[HTTP] _connect: Socket error: ${err.message}`);
            this.emit('error', err);
            this._cleanupSocket();
        };

        const onClose = () => {
            console.log(`[HTTP] _connect: Socket closed`);
            if (this._res && !this._res.readableEnded) this._res.push(null);
            this.emit('close');
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
    private _cleanupSocket() {
        if (this._socketCleanup) this._socketCleanup();
        this._socketCleanup = undefined;
        this.socket = null;
        this._connected = false;
    }

    private _finishResponse() {
        // Release socket back to agent
        const agent = this._options.agent === false ? new Agent() : (this._options.agent instanceof Agent ? this._options.agent : globalAgent);
        const socket = this.socket;
        this._cleanupSocket();
        if (socket) agent.releaseSocket(socket, this._options);
    }

    private _flushPendingWrites() {
        if (!this.socket) return;
        if (!this.headersSent) this._sendRequest();

        // If we are waiting for 100-continue, don't flush yet
        if (this._expectContinue && !this._continueReceived) {
            return;
        }

        const writes = this._pendingWrites;
        this._pendingWrites = [];
        for (const pending of writes) {
            this._write(pending.chunk, pending.encoding, pending.callback);
        }
        if (this._ended) {
            this._finishRequest();
        }
    }

    private _finishRequest() {
        if (!this._ended) return;
        super.end();
    }

    private _sendRequest() {
        debugLog(`ClientRequest._sendRequest: headersSent=${this.headersSent}, socket=${!!this.socket}`);
        if (this.headersSent) return;

        if (!this.hasHeader('host')) {
            this.setHeader('Host', this.host);
        }

        const firstLine = `${this.method} ${this.path} HTTP/1.1`;
        debugLog(`ClientRequest._sendRequest: sending firstLine=${firstLine}`);
        this._sendHeaders(firstLine);
    }

    _write(chunk: any, encoding: string, callback: (error?: Error | null) => void) {
        if (!this._connected) {
            this._pendingWrites.push({ chunk, encoding, callback });
            return;
        }
        if (!this.headersSent) this._sendRequest();
        super._write(chunk, encoding, callback);
    }

    write(chunk: any, encoding?: any, callback?: any): boolean {
        if (!this._connected) {
            this._pendingWrites.push({ chunk, encoding, callback });
            return true;
        }
        if (!this.headersSent) this._sendRequest();
        return super.write(chunk, encoding, callback);
    }

    end(chunk?: any, encoding?: any, callback?: any): this {
        debugLog(`ClientRequest.end() called, connected=${this._connected}, headersSent=${this.headersSent}`);
        if (chunk) {
            this.write(chunk, encoding);
        }
        this._ended = true;

        // If connected, we can send request and end immediately
        if (this._connected) {
            if (!this.headersSent) {
                this._sendRequest();
            }
            // Call super.end only when connected
            super.end(undefined, undefined, callback);
        } else {
            // Socket not connected yet - _flushPendingWrites will handle ending
            // Store callback if provided
            if (callback) {
                this.once('finish', callback);
            }
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
        const url = new URL(urlOrOptions);
        opts = {
            protocol: url.protocol,
            hostname: url.hostname,
            path: url.pathname + url.search,
            port: url.port ? parseInt(url.port) : undefined
        };
    } else if (urlOrOptions instanceof URL) {
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
