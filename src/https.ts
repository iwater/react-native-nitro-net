import * as http from './http'
import * as tls from './tls'
import { IncomingMessage } from './http'
// 全局 `URL` 守卫与 http.ts 共用同一份（见 urlCompat.ts 文件头）。
// 曾经这里漏改：https 侧裸写 `new URL` / `instanceof URL`，在无全局 URL 的宿主上
// `https.request({...})` 会同步抛 `URL is not defined`（实测）。
import { isURLLike, requireGlobalURL, urlBasicAuth } from './urlCompat'
import { tlsPoolKeySuffix, type PoolKeyOptions } from './tlsPoolKey'
import { TLS_CONNECT_FIELDS } from './agentConnectOptions'
import { getImpersonationConfig } from './profiles/registry'

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
        // #84：node 的 https.Server 默认提供 `ALPNProtocols = ['http/1.1']`，且**只有在**调用方
        // 两者都没给时才生效（源码顺序是 `{ noDelay: true, ALPNProtocols, ...opts }` ⇒ opts
        // 覆盖默认值，连显式 `ALPNProtocols: undefined` 也算覆盖）。此前我们没有这一步，
        // 于是 h1 客户端连上来 `socket.alpnProtocol` 永远是空（登记为 #84 的那条差异）。
        const opts: any = options ?? {};
        const callerChose = !!(opts.ALPNProtocols || opts.ALPNCallback);
        options = { ALPNProtocols: callerChose ? undefined : ['http/1.1'], ...opts };
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
            port: url.port ? parseInt(url.port) : 443,
            auth: urlBasicAuth(url),
        };
    } else if (isURLLike(urlOrOptions)) {
        opts = {
            protocol: urlOrOptions.protocol,
            hostname: urlOrOptions.hostname,
            path: urlOrOptions.pathname + urlOrOptions.search,
            port: urlOrOptions.port ? parseInt(urlOrOptions.port) : 443,
            auth: urlBasicAuth(urlOrOptions),
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
    /** `poolKeyOptions` 的记忆化表（键 = 请求 options 对象身份）。 */
    private _poolKeyOptionsCache = new WeakMap<object, PoolKeyOptions>();

    constructor(options?: any) {
        super(options);
    }

    /**
     * agent 级 TLS 材料要覆盖请求级（Node 的 `{...options, ...this.options}`），名单见
     * agentConnectOptions.ts。`ALPNProtocols` / `forceHttp1` / `impersonate` / `profile`
     * 刻意留在本包既有的「请求级优先」语义里，不随这份名单走。
     */
    protected override connectOptionFields(): readonly string[] {
        return [...super.connectOptionFields(), ...TLS_CONNECT_FIELDS];
    }

    /**
     * Node 的 `https.Agent` **覆写**了 `getName`，把 TLS 材料拼进池键（v22.11 实测：
     * `ca` / `cert` / `key` / `pfx` / `rejectUnauthorized` / `servername` …）。
     * 不覆写的话，同一 host「先按 CA A 建连、再用 CA B 请求」会命中旧连接，第二份
     * 信任配置被静默忽略。本包额外把自己的 `proxyTls` 也纳入（Node 没有这个选项）。
     *
     * ⚠️ 进键的是**有效材料**（agent 级覆盖请求级，见 agentConnectOptions.ts）：Node 在
     * `createSocket` 里先合并、再算 `getName`，所以 agent 上的 `ca` 同样参与池键。
     * 直接用请求级 `{...options}` 的话，「agent A 带 CA1、agent B 带 CA2」会得到同一个键。
     */
    public getName(options: http.RequestOptions): string {
        return super.getName(options) + tlsPoolKeySuffix(this.poolKeyOptions(options));
    }

    /**
     * 给 `tlsPoolKeySuffix` 组一份输入，并按**请求 options 对象身份**记忆化。
     * 记忆化不是微优化：`getName` 一个请求要算 3–4 次，而 PEM（整份 CA 包）每次都要转
     * 字符串 —— tlsPoolKey.ts 内部那张 WeakMap 只有拿到**同一个对象**才会命中。
     */
    private poolKeyOptions(options: http.RequestOptions): PoolKeyOptions {
        const key = options as unknown as object;
        const hit = this._poolKeyOptionsCache.get(key);
        if (hit !== undefined) return hit;
        const eff = this.getEffectiveConnectOptions(options);
        // 全局 configure 开启时，请求上没有显式字段也要把模式/profile 纳入池键，
        // 否则运行中切换配置可能复用旧模式的连接。
        const config = getImpersonationConfig();
        const merged: PoolKeyOptions = {
            ...eff,
            impersonate: eff.impersonate ?? this.impersonate ?? (config.impersonate === 'chrome' ? 'chrome' : undefined),
            profile: eff.profile ?? this.profile ?? config.profile,
            forceHttp1: eff.forceHttp1,
            alpnProtocols: eff.ALPNProtocols,
        };
        this._poolKeyOptionsCache.set(key, merged);
        return merged;
    }
}

export const globalAgent = new Agent({
    keepAlive: true,
    scheduling: 'lifo',
    timeout: 5000,
});

// Node 语义：未显式传 agent 的 HTTPS 请求使用 https.globalAgent。
// 此前 http.ClientRequest 无条件落到 http.globalAgent，这里的配置从未生效。
http.registerGlobalAgent('https:', globalAgent);

export { IncomingMessage };

// node 的这些内建有 ESM default（= 模块对象）；got@16 按 `import https from 'node:https'` 取。
// 全部写成 **getter**：本文件与 tls/http 之间有循环依赖，对象字面量的简写属性会在
// 求值时触碰尚未初始化的绑定（某些宿主报成 `Agent is not initialized`，实测）。
export default {
    get Server() { return Server },
    get createServer() { return createServer },
    get ClientRequest() { return ClientRequest },
    get request() { return request },
    get get() { return get },
    get Agent() { return Agent },
    get globalAgent() { return globalAgent },
};
