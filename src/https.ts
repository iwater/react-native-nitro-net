import * as http from './http'
import * as tls from './tls'
import { IncomingMessage } from './http'
// 全局 `URL` 守卫与 http.ts 共用同一份（见 urlCompat.ts 文件头）。
// 曾经这里漏改：https 侧裸写 `new URL` / `instanceof URL`，在无全局 URL 的宿主上
// `https.request({...})` 会同步抛 `URL is not defined`（qjs 实测）。
import { isURLLike, requireGlobalURL } from './urlCompat'

// ========== Server ==========

export class Server extends tls.Server {
    private _httpConnections = new Set<any>();
    public maxHeaderSize: number = 16384;
    public headersTimeout: number = 60000;
    public keepAliveTimeout: number = 5000;
    // 同 http.Server：requestTimeout / maxRequestsPerSocket 这两个从未生效的字段已删除（Task 26）

    constructor(options?: any, requestListener?: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
        if (typeof options === 'function') {
            requestListener = options;
            options = {};
        }
        super(options);

        if (requestListener) {
            this.on('request', requestListener);
        }

        // Initialize HTTP connection setup for secure connections
        this.on('secureConnection', (socket: any) => {
            // @ts-ignore - access internal http logic
            (http.Server.prototype as any)._setupHttpConnection.call(this, socket);
        });
    }

    public setTimeout(ms: number, callback?: () => void): this {
        // 走继承链上的 net.Server.setTimeout。
        // 此前这里写的是 `(this as any)._netServer.setTimeout(...)` —— 但 https.Server 的
        // 继承链是 https.Server → tls.Server → net.Server，**没有** _netServer 字段，
        // 于是 undefined.setTimeout 直接 TypeError（TS-H7）。
        // 保留这个显式覆盖（而不是直接删掉）是为了让 tsc 校验基类方法确实存在。
        super.setTimeout(ms, callback);
        return this;
    }
}

export function createServer(options?: any, requestListener?: (req: http.IncomingMessage, res: http.ServerResponse) => void): Server {
    return new Server(options, requestListener);
}

// ========== ClientRequest ==========

export class ClientRequest extends http.ClientRequest {
    constructor(options: any, callback?: (res: http.IncomingMessage) => void) {
        if (typeof options === 'string') {
            options = new (requireGlobalURL('https.ClientRequest'))(options);
        }
        if (isURLLike(options)) {
            options = {
                protocol: options.protocol,
                hostname: options.hostname,
                path: options.pathname + options.search,
                port: options.port ? parseInt(options.port) : 443
            };
        }
        options.protocol = 'https:';
        super(options, callback);
    }
}

export function request(
    urlOrOptions: string | URL | http.RequestOptions,
    optionsOrCallback?: http.RequestOptions | ((res: http.IncomingMessage) => void),
    callback?: (res: http.IncomingMessage) => void
): ClientRequest {
    let opts: http.RequestOptions = {};
    let cb: ((res: http.IncomingMessage) => void) | undefined = callback;

    if (typeof urlOrOptions === 'string') {
        const url = new (requireGlobalURL('https.request()'))(urlOrOptions);
        opts = {
            protocol: url.protocol,
            hostname: url.hostname,
            path: url.pathname + url.search,
            port: url.port ? parseInt(url.port) : 443
        };
    } else if (isURLLike(urlOrOptions)) {
        opts = {
            protocol: urlOrOptions.protocol,
            hostname: urlOrOptions.hostname,
            path: urlOrOptions.pathname + urlOrOptions.search,
            port: urlOrOptions.port ? parseInt(urlOrOptions.port) : 443
        };
    } else {
        opts = { ...urlOrOptions };
    }

    if (typeof optionsOrCallback === 'function') {
        cb = optionsOrCallback;
    } else if (optionsOrCallback) {
        opts = { ...opts, ...optionsOrCallback };
    }

    opts.protocol = 'https:';
    return new ClientRequest(opts, cb);
}

export function get(
    urlOrOptions: string | URL | http.RequestOptions,
    optionsOrCallback?: http.RequestOptions | ((res: http.IncomingMessage) => void),
    callback?: (res: http.IncomingMessage) => void
): ClientRequest {
    const req = request(urlOrOptions, optionsOrCallback, callback);
    req.end();
    return req;
}

// ========== Agent ==========

export class Agent extends http.Agent {
    constructor(options?: any) {
        super(options);
    }
}

export const globalAgent = new Agent({
    keepAlive: true,
    scheduling: 'lifo',
    timeout: 5000,
});

export { IncomingMessage };
