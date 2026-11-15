// `stream` 指向的是同一份实现：宿主侧由内建表提供，RN 侧由本包依赖
// `"stream": "npm:readable-stream@^4.7.0"`（node 里 core `stream` 恒优先，该依赖对 node 惰性）。
// ⚠️ 别改回裸 `readable-stream`：那样 RN 上每个包会各自解析到自己那份 ⇒ 跨包 `instanceof` 分叉。
import { Duplex, DuplexOptions } from 'stream'
// EventEmitter 基类在运行期选定：宿主有 `events` 用它，没有才回退 `eventemitter3`。
// 必须是 CJS 垫片（不能用 ESM import），理由见 eventEmitterCompat.js 顶部注释。
import { EventEmitter } from './eventEmitterCompat'
import { Buffer } from 'react-native-nitro-buffer'

import { Driver } from './Driver'
import type { NetSocketDriver, NetServerDriver, NetConfig } from './Net.nitro'
import { NetSocketEvent, NetServerEvent } from './Net.nitro'
import { isVerbose, setVerbose, debugLog as loggerDebugLog } from './Logger'
import { LoopRef } from './loopRef'
import {
    alreadyListeningError,
    assertConnectTarget,
    isPipeName,
    normalizeSocketPort,
    resolveListenTarget,
    type ListenTarget,
} from './socketPort'
import { nextTick } from './nextTick'

// -----------------------------------------------------------------------------
// Utils
// -----------------------------------------------------------------------------

// 严格校验，逐条对齐 Node（期望值来自 node -e 实测，见提交说明）：
//   IPv4：4 段十进制 0-255，**不允许前导零**（'01.2.3.4' → 0）。
//   IPv6：1-4 位十六进制组，最多一个 '::'；可带 zone id（'%eth0'）；
//         结尾可嵌点分四段（占后 32 位，算 2 组，自身也按 IPv4 规则校验）。
//   组数：无 '::' 必须正好 8 组；有 '::' 必须 < 8 组（否则压缩没有任何意义）。
function isIPv4Literal(input: string): boolean {
    if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(input)) return false;
    const parts = input.split('.');
    for (const p of parts) {
        if (p.length > 1 && p[0] === '0') return false; // 前导零：Node 判 0
        const n = Number(p);
        if (!(n >= 0 && n <= 255)) return false;
    }
    return true;
}

function isIP(input: string): number {
    if (typeof input !== 'string' || input.length === 0) return 0;
    if (isIPv4Literal(input)) return 4;
    if (!input.includes(':')) return 0;

    // 去掉 zone id（'fe80::1%eth0' → 6，Node 接受）
    const zoneIdx = input.indexOf('%');
    const body = zoneIdx === -1 ? input : input.slice(0, zoneIdx);
    if (body.length === 0) return 0;

    // 按 '::' 切：多于一个即非法（'::::1.2.3.4' → 0）
    const halves = body.split('::');
    if (halves.length > 2) return 0;
    const compressed = halves.length === 2;

    let total = 0;
    for (let hi = 0; hi < halves.length; hi++) {
        const half = halves[hi];
        if (half === '') continue;
        const gs = half.split(':');
        for (let gi = 0; gi < gs.length; gi++) {
            const g = gs[gi];
            if (g.includes('.')) {
                // 内嵌的点分四段只可能出现在整串的最后一个 token
                const isTail = (hi === halves.length - 1) && (gi === gs.length - 1);
                if (!isTail || !isIPv4Literal(g)) return 0;
                total += 2;
            } else {
                // 空组只在 '::' 处合法（已被切掉），这里出现就是形如 '1:2:3:4:5:6:7:8:'
                if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return 0;
                total++;
            }
        }
    }
    if (compressed) {
        // '::' 至少要压缩掉一组；'1:2:3:4:5:6::7:8'（8 组）Node 判 0
        if (total >= 8) return 0;
    } else {
        if (total !== 8) return 0;
    }
    return 6;
}

/**
 * 造一个带 `code` 的错误。Node 的参数校验错误都带 code（调用方靠它分支），
 * 裸 `new TypeError(msg)` 会让 `err.code` 恒为 undefined。
 * 期望值来自 node -e 实测（见提交说明）。
 */
function errWithCode(Ctor: any, code: string, message: string): Error {
    const err: any = new Ctor(message);
    err.code = code;
    return err as Error;
}

function isIPv4(input: string): boolean {
    return isIP(input) === 4;
}

function isIPv6(input: string): boolean {
    return isIP(input) === 6;
}

/**
 * Decodes an ArrayBuffer to a string.
 * Prioritizes TextDecoder if available, otherwise falls back to Buffer.
 */
function decodeArrayBuffer(data: ArrayBuffer | undefined): string {
    if (!data || data.byteLength === 0) return '';
    if (typeof TextDecoder !== 'undefined') {
        return new TextDecoder().decode(data);
    }
    return Buffer.from(data).toString();
}

/**
 * 解析 Rust 侧的 Node 风格错误消息（`connect ECONNREFUSED 127.0.0.1:1 (os error 61)`），
 * 把 Node 系统错误契约挂到 Error 上：code / errno（负值平台 errno）/ syscall，
 * 以及 connect、listen 类错误的 address / port。
 * 不匹配该格式的消息（TLS、DNS、主动 abort 等）原样返回，不附加任何属性。
 */
const NODE_ERROR_RE = /^(\w+) (E[A-Z0-9]+) (\S+) \(os error (\d+)\)$/;
function enrichSystemError<T extends Error>(error: T): T {
    const m = NODE_ERROR_RE.exec(error.message);
    if (!m) return error;
    const [, syscall, code, target, errno] = m;
    const e = error as any;
    e.syscall = syscall;
    e.code = code;
    e.errno = -parseInt(errno, 10);
    if (syscall === 'connect' || syscall === 'listen') {
        // target 形如 "127.0.0.1:1" 或 "[::1]:80"
        const idx = target.lastIndexOf(':');
        if (idx > 0) {
            e.address = target.slice(0, idx).replace(/^\[|\]$/g, '');
            const p = parseInt(target.slice(idx + 1), 10);
            if (!isNaN(p)) e.port = p;
        }
    }
    return error;
}
// -----------------------------------------------------------------------------
// Global Configuration
// -----------------------------------------------------------------------------

let _autoSelectFamilyDefault = 4; // Node default is usually 4/6 independent, but we mock it.
let _isInitialized = false;



function debugLog(message: string | (() => string)) {
    loggerDebugLog('NET', message)
}

function getDefaultAutoSelectFamily(): number {
    return _autoSelectFamilyDefault;
}

function setDefaultAutoSelectFamily(family: number): void {
    if (family !== 4 && family !== 6) throw new Error('Family must be 4 or 6');
    _autoSelectFamilyDefault = family;
}

/**
 * `net.getDefaultAutoSelectFamilyAttemptTimeout()` —— node 默认 `250`。
 *
 * ⚠️ 本宿主**没有实现 Happy Eyeballs**（不做双栈竞速），所以这个值只被存下来
 * 供读写、**不影响连接行为**。留着是为了**表层对齐**：node 上它是公开 API，
 * 用户/库的 `typeof net.getDefaultAutoSelectFamilyAttemptTimeout === 'function'`
 * 特征检测会命中（档案 §6.7 的「缺 3」之一）。
 *
 * ⚠️ 与相邻的 `getDefaultAutoSelectFamily()` 不同：**那个是宿主有意 mock 的**
 * （返回 4/6，node 返回 boolean），且有既有测试锁着，
 * 所以本文件不顺手改它 —— 差异已记入档案，别把它当成本函数的先例。
 */
let _autoSelectFamilyAttemptTimeout = 250;

function getDefaultAutoSelectFamilyAttemptTimeout(): number {
    return _autoSelectFamilyAttemptTimeout;
}

/**
 * 校验**照 node 原文的判据**（实测 v22.22.2）：
 *   · 非 number ⇒ `ERR_INVALID_ARG_TYPE`
 *     （`'250'` / `null` / `undefined` / `true` 全部走这条）；
 *   · number 但非整数（`1.5` / `NaN` / `Infinity`）⇒ `ERR_OUT_OF_RANGE`「must be an integer」；
 *   · 越界（`0` / `-1` / `2**31`）⇒ `ERR_OUT_OF_RANGE`「must be >= 1 && <= 2147483647」。
 *
 * ⚠️ **校验之后还有一道下限夹取**（2026-09-25 实测，原先漏了）：有效值域是
 * `[10, 2147483647]` 而不是 `[1, …]` —— `setTAT(1|2|9|10)` 之后 `get()` 全部返回 `10`，
 * `11` 才原样存下。但**校验用的下界仍是 `1`**（`setTAT(0)` 抛 `ERR_OUT_OF_RANGE`）。
 * 两者顺序不能颠倒：先夹取的话 `0` 会被夹成 `10` 而不抛了。
 * （实测表：1→10, 2→10, 9→10, 10→10, 11→11, 99→99, 100→100, 2147483647→2147483647。）
 *
 * ⚠️ **消息文本不逐字对齐 node**：node 的 `ERR_INVALID_ARG_TYPE` 会拼出
 * `Received type string ('250')` / `Received null` / `Received type boolean (true)`
 * 这类**按类型分叉**的后缀，复刻它得把 node 的 `inspect` 逻辑搬过来，收益不成比例。
 * 这里只保证 **`code` 一致**（parity 用例也只断言 code）。要逐字对齐请另开一条。
 */
function setDefaultAutoSelectFamilyAttemptTimeout(value: number): void {
    if (typeof value !== 'number') {
        throw errWithCode(TypeError, 'ERR_INVALID_ARG_TYPE',
            `The "value" argument must be of type number. Received ${value === null ? 'null' : typeof value}`);
    }
    if (!Number.isInteger(value)) {
        throw errWithCode(RangeError, 'ERR_OUT_OF_RANGE',
            `The value of "value" is out of range. It must be an integer. Received ${value}`);
    }
    if (value < 1 || value > 2147483647) {
        throw errWithCode(RangeError, 'ERR_OUT_OF_RANGE',
            `The value of "value" is out of range. It must be >= 1 && <= 2147483647. Received ${value}`);
    }
    _autoSelectFamilyAttemptTimeout = Math.max(value, 10);
}

/**
 * Ensures that the network module is initialized.
 * If initWithConfig hasn't been called, it will be called with default options.
 */
function ensureInitialized(): void {
    if (!_isInitialized) {
        initWithConfig({});
    }
}


/**
 * Initialize the network module with custom configuration.
 * Must be called before any socket/server operations, or the config will be ignored.
 * 
 * @param config Configuration options
 * @param config.workerThreads Number of worker threads (0 = use CPU core count)
 * 
 * @example
 * ```ts
 * import { initWithConfig } from 'react-native-nitro-net';
 * 
 * // Initialize with 4 worker threads
 * initWithConfig({ workerThreads: 4 });
 * ```
 */
function initWithConfig(config: NetConfig): void {
    if (config.debug !== undefined) {
        setVerbose(config.debug);
    }
    // 顺序很重要：
    // 1) 先让原生按 workerThreads 初始化 runtime。workerThreads 只在首次生效，
    //    若先装 dispatcher（会兜底触发默认配置初始化），这里的配置就会被忽略。
    Driver.initWithConfig(config);
    // 2) 再装 dispatcher。用 dispatch 把事件投递到 JS 线程；缺失时原生侧会丢事件并告警。
    //    这一步可能 throw——此时不置 _isInitialized，下一次 ensureInitialized() 可重试
    //    （原生初始化是幂等的，重复调用不会重复 net_init）。
    if ((Driver as any).installDispatcher) {
        (Driver as any).installDispatcher();
    }
    _isInitialized = true;
}

// -----------------------------------------------------------------------------
// SocketAddress

// -----------------------------------------------------------------------------
// SocketAddress
// -----------------------------------------------------------------------------

export interface SocketAddressOptions {
    address?: string;
    family?: 'ipv4' | 'ipv6';
    port?: number;
    flowlabel?: number;
}

export class SocketAddress {
    readonly address: string;
    readonly family: 'ipv4' | 'ipv6';
    readonly port: number;
    readonly flowlabel: number;

    constructor(options: SocketAddressOptions = {}) {
        this.address = options.address ?? (options.family === 'ipv6' ? '::' : '127.0.0.1');
        this.family = options.family || (isIPv6(this.address) ? 'ipv6' : 'ipv4');
        this.port = options.port ?? 0;
        this.flowlabel = options.flowlabel ?? 0;
    }

    /**
     * Attempts to parse a string containing a socket address.
     * Returns a SocketAddress if successful, or undefined if not.
     * 
     * Supported formats:
     * - `ip:port` (e.g., `127.0.0.1:8080`, `[::1]:8080`)
     * - `ip` only (port defaults to 0)
     */
    static parse(input: string): SocketAddress | undefined {
        if (!input || typeof input !== 'string') return undefined;
        let address: string;
        let port = 0;

        // Handle IPv6 bracket notation: [::1]:port
        const ipv6Match = input.match(/^\[([^\]]+)\]:?(\d*)$/);
        if (ipv6Match) {
            address = ipv6Match[1];
            port = ipv6Match[2] ? parseInt(ipv6Match[2], 10) : 0;
            if (!isIPv6(address)) return undefined;
            return new SocketAddress({ address, port, family: 'ipv6' });
        }

        // Handle IPv4 or IPv6 without brackets
        const lastColon = input.lastIndexOf(':');
        if (lastColon === -1) {
            // No port, just IP
            address = input;
        } else {
            // Determine if the colon is a port separator or part of IPv6
            const potentialPort = input.slice(lastColon + 1);
            const potentialAddr = input.slice(0, lastColon);
            if (/^\d+$/.test(potentialPort) && (isIPv4(potentialAddr) || isIPv6(potentialAddr))) {
                address = potentialAddr;
                port = parseInt(potentialPort, 10);
            } else {
                // It's an IPv6 address without port
                address = input;
            }
        }

        const family = isIPv6(address) ? 'ipv6' : (isIPv4(address) ? 'ipv4' : undefined);
        if (!family) return undefined;
        return new SocketAddress({ address, port, family });
    }
}

// -----------------------------------------------------------------------------
// BlockList
// -----------------------------------------------------------------------------

export interface BlockListRule {
    type: 'address' | 'range' | 'subnet';
    address?: string;
    start?: string;
    end?: string;
    prefix?: number;
    family: 'ipv4' | 'ipv6';
}

export class BlockList {
    private _rules: Array<{ type: 'address' | 'range' | 'subnet', data: any }> = [];

    /** Returns an array of rules added to the blocklist. */
    get rules(): BlockListRule[] {
        return this._rules.map(r => {
            if (r.type === 'address') {
                return { type: 'address' as const, address: r.data.address, family: r.data.family };
            } else if (r.type === 'range') {
                return { type: 'range' as const, start: r.data.start, end: r.data.end, family: r.data.family };
            } else {
                return { type: 'subnet' as const, address: r.data.net, prefix: r.data.prefix, family: r.data.family };
            }
        });
    }

    addAddress(address: string, family?: 'ipv4' | 'ipv6'): void {
        this._rules.push({ type: 'address', data: { address, family: family || (isIPv6(address) ? 'ipv6' : 'ipv4') } });
    }

    addRange(start: string, end: string, family?: 'ipv4' | 'ipv6'): void {
        this._rules.push({ type: 'range', data: { start, end, family: family || (isIPv6(start) ? 'ipv6' : 'ipv4') } });
    }

    addSubnet(net: string, prefix: number, family?: 'ipv4' | 'ipv6'): void {
        this._rules.push({ type: 'subnet', data: { net, prefix, family: family || (isIPv6(net) ? 'ipv6' : 'ipv4') } });
    }

    check(address: string, family?: 'ipv4' | 'ipv6'): boolean {
        const addrFamily = family || (isIPv6(address) ? 'ipv6' : 'ipv4');
        const addrNum = addrFamily === 'ipv4' ? ipv4ToLong(address) : null;

        for (const rule of this._rules) {
            if (rule.data.family !== addrFamily) continue;

            if (rule.type === 'address') {
                if (rule.data.address === address) return true;
            } else if (rule.type === 'range' && addrNum !== null) {
                const start = ipv4ToLong(rule.data.start);
                const end = ipv4ToLong(rule.data.end);
                if (addrNum >= start && addrNum <= end) return true;
            } else if (rule.type === 'subnet' && addrNum !== null) {
                const net = ipv4ToLong(rule.data.net);
                const mask = ~(Math.pow(2, 32 - rule.data.prefix) - 1);
                if ((addrNum & mask) === (net & mask)) return true;
            }
        }
        return false;
    }

    /**
     * Serializes the BlockList to a JSON-compatible format.
     */
    toJSON(): BlockListRule[] {
        return this.rules;
    }

    /**
     * Creates a BlockList from a JSON array of rules.
     */
    static fromJSON(json: BlockListRule[]): BlockList {
        const list = new BlockList();
        for (const rule of json) {
            if (rule.type === 'address' && rule.address) {
                list.addAddress(rule.address, rule.family);
            } else if (rule.type === 'range' && rule.start && rule.end) {
                list.addRange(rule.start, rule.end, rule.family);
            } else if (rule.type === 'subnet' && rule.address && rule.prefix !== undefined) {
                list.addSubnet(rule.address, rule.prefix, rule.family);
            }
        }
        return list;
    }

    /**
     * Checks if a given value is a BlockList instance.
     */
    static isBlockList(value: unknown): value is BlockList {
        return value instanceof BlockList;
    }
}

function ipv4ToLong(ip: string): number {
    return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
}

// -----------------------------------------------------------------------------
// Socket
// -----------------------------------------------------------------------------

export interface SocketOptions extends DuplexOptions {
    fd?: any;
    allowHalfOpen?: boolean;
    readable?: boolean;
    writable?: boolean;
    path?: string;
    // Extension for internal use
    socketDriver?: NetSocketDriver;
    remoteFamily?: string;
}

export class Socket extends Duplex {
    protected _driver: NetSocketDriver | undefined;
    public connecting: boolean = false; // Changed from private _connecting
    protected _connected: boolean = false;
    protected _hadError: boolean = false; // Added
    public remoteAddress?: string;
    public remotePort?: number;
    public remoteFamily?: string;
    public localAddress?: string;
    public localPort?: number;
    public bytesRead: number = 0;
    public bytesWritten: number = 0;
    public autoSelectFamilyAttemptedAddresses: string[] = [];
    private _autoSelectFamily: boolean = false;
    private _timeout: number = 0;
    /**
     * 连接/握手阶段的超时兜底（#13）。
     *
     * node 的 `socket.setTimeout(ms)` 从**调用时刻**起算：`https.request({ timeout })` 的文档
     * 原话是 "set the timeout before the socket is connected"；实测 node v22 对「accept 后
     * 一个字节都不发」的服务端，`timeout: 300` 在 TLS 握手期就会发 `'timeout'`。
     * 本包的原生定时器要等 socket 任务装好（TCP + TLS 都完成）才生效 ⇒ 连接阶段由这个
     * **JS 定时器**兜住，握手一结束（'connect'/'secureConnect'）就清掉，交还原生。
     */
    private _connectTimer: ReturnType<typeof setTimeout> | undefined;
    /** 连接/握手是否已收敛（connect / secureConnect / error / close 任一）。 */
    private _connectSettled: boolean = false;
    /**
     * 在途的原生写。readable-stream 保证任意时刻最多一个 `_write` 在途，
     * 因此它与原生的 WRITTEN/BUSY 事件一一对应，无需关联 ID。
     * 写入经 `driver.write()` 交给原生后，等 WRITTEN 才 `callback(null)`；
     * 收到 BUSY 则重试同一份数据。
     */
    private _pendingNativeWrite?: { ab: ArrayBuffer; callback: (e?: Error | null) => void };

    /**
     * Node handle-ref 语义的宿主登记槽：connecting / connected 的 socket 顶住事件循环。
     * 宿主不支持该能力时（React Native）全部方法 no-op，行为与今天一致。
     */
    private _loopRef = new LoopRef('net.Socket');
    /**
     * 这条连接是不是 AF_UNIX（#73）。node 的 `socket.address()` 在 Unix 上返回**空对象**
     * （libuv 的 getsockname 对未绑定管道拿不到名字，实测客户端与服务端两侧都是 `{}`），
     * 而**监听器**的 `address()` 才是路径字符串（#71）。两者形状不同，必须分开判。
     */
    protected _isUnix: boolean = false;
    /**
     * #82：被 `tls.connect({socket})` 收编后指向那个 TLSSocket。
     * 收编时本对象的 loop ref 已交出去、driver 的事件也被改写 ⇒ 之后 `destroy()`
     * 必须**转交**给 TLS socket（node 实测：销毁任一侧都会关掉连接）。
     */
    _adoptedBy?: any;
    /** #82：反向引用 —— 本 socket 收编的原 net.Socket（销毁时连带销毁，node 同行为）。 */
    protected _adoptedRaw?: any;

    /** @internal 供 Server accept / tls.Server 包装路径做 ref 转移；外部勿用。 */
    _acquireLoopRef(): void { this._loopRef.acquire(); }
    /** @internal 供 tls.Server 包装路径释放被接管 socket 的 ref；外部勿用。 */
    _releaseLoopRef(): void { this._loopRef.release(); }

    get localFamily(): string {
        return this.localAddress && this.localAddress.includes(':') ? 'IPv6' : 'IPv4';
    }

    get readyState(): string {
        if (this.connecting) return 'opening';
        if (this._connected) {
            // @ts-ignore
            if (this.writable && this.readable) return 'open';
            // @ts-ignore
            if (this.writable) return 'writeOnly';
            // @ts-ignore
            if (this.readable) return 'readOnly';
        }
        return 'closed';
    }

    get pending(): boolean {
        return this.connecting;
    }
    constructor(options?: SocketOptions) {
        // `readable`/`writable`/`autoDestroy` 是 Duplex 构造函数**运行期**认的开关：
        // readable-stream 的类型里声明了前两个，`@types/node` 的 `DuplexOptions` 三个都没声明，
        // 所以这里整体断言（原先是逐行 `@ts-ignore`），传值不变。
        super({
            allowHalfOpen: options?.allowHalfOpen ?? false,
            readable: options?.readable ?? true,
            writable: options?.writable ?? true,
            autoDestroy: true
        } as DuplexOptions);

        if (options?.socketDriver) {
            // Wrapping existing socket (from Server)
            this._driver = options.socketDriver;
            this._connected = true;
            this._setupEvents();
            // Enable noDelay by default
            this._driver.setNoDelay(true);
            // For accepted server sockets, defer resume until after the server
            // emits 'connection' so user handlers can attach first.
        } else {
            // New client socket
            ensureInitialized();
            this._driver = Driver.createSocket();
            this._setupEvents();
            // 连接阶段超时：握手/连上一律清掉（见 `_connectTimer`）。两类 socket 都挂，
            // 不适用的那个事件永远不来，监听器本身无副作用。
            const clearConnectTimer = () => {
                this._connectSettled = true;
                this._clearConnectTimer();
            };
            this.once('connect', clearConnectTimer);
            this.once('secureConnect', clearConnectTimer);
            this.once('error', clearConnectTimer);
            this.once('close', clearConnectTimer);
            // Enable noDelay by default to match Node.js and reduce latency for small writes
            this._driver.setNoDelay(true);
            // Do NOT resume here - socket is not connected yet!
            // resume() will be called after 'connect' event in _connect()
        }

    }

    on(event: string | symbol, listener: (...args: any[]) => void): this {
        if (event === 'connect' && this._connected) {
            nextTick(listener);
            return this;
        }
        const ret = super.on(event, listener);
        if (event === 'data' && (this as any).readableFlowing !== true) {
            debugLog(`Socket on('data'), flowing: ${(this as any).readableFlowing}, paused: ${this.isPaused()}`);
            this.resume();
        }
        return ret;
    }

    /** @internal 子类在换过 driver 之后要重新挂事件（#82 的就地升级用）。 */
    protected _setupEvents() {
        if (!this._driver) return;
        const id = (this._driver as any).id ?? (this._driver as any)._id;
        this._driver.onEvent = (eventType: number, data: ArrayBuffer) => {
            this.emit('event', eventType, data);
            if (eventType === NetSocketEvent.ERROR) {
                const msg = decodeArrayBuffer(data) || 'Unknown error';
                debugLog(`Socket (id: ${id}) NATIVE ERROR: ${msg}`);
            }
            if (eventType === NetSocketEvent.SESSION) { // SESSION/DEBUG
                debugLog(`Socket (id: ${id}) NATIVE SESSION EVENT RECEIVED`);
                this.emit('session', data);
                return;
            }
            // 热路径：每个原生事件都会走到这里（含每个数据包），用 thunk 避免 verbose 关闭时白拼字符串
            debugLog(() => `Socket (id: ${id}, localPort: ${this.localPort}) Event TYPE: ${eventType}, data len: ${data?.byteLength}`);
            switch (eventType) {
                case NetSocketEvent.CONNECT:
                    this.connecting = false;
                    this._connected = true;
                    this._updateAddresses();
                    // Now that we're connected, start receiving data
                    this.resume();
                    this.emit('connect');
                    this.emit('ready');
                    break;
                case NetSocketEvent.DATA:
                    debugLog(() => `Socket onEvent(DATA), len: ${data?.byteLength}, flowing: ${(this as any).readableFlowing}`);
                    if (data && data.byteLength > 0) {
                        const buffer = Buffer.from(data);
                        this.bytesRead += buffer.length;
                        this.push(buffer);
                        if (this.listenerCount('data') > 0 && (this as any).readableFlowing !== true) {
                            debugLog(`Socket onEvent(DATA) restoring flowing mode for attached 'data' listeners`);
                            this.resume();
                        }
                    }
                    break;
                case NetSocketEvent.ERROR: {
                    this._hadError = true;
                    const errorMsg = decodeArrayBuffer(data) || 'Unknown socket error';
                    const error = enrichSystemError(new Error(errorMsg));

                    if (this.connecting && this._autoSelectFamily) {
                        // If we were connecting, this is a connection attempt failure
                        // We attempt to get the last attempted address if available
                        const lastAttempt = this.autoSelectFamilyAttemptedAddresses[this.autoSelectFamilyAttemptedAddresses.length - 1];
                        if (lastAttempt) {
                            const [ip, port] = lastAttempt.split(':'); // distinct if ipv6?
                            // Simple parsing for event emission
                            const family = ip.includes(':') ? 6 : 4;
                            this.emit('connectionAttemptFailed', ip, parseInt(port || '0', 10), family, error);
                        }
                    }

                    this.emit('error', error);
                    this.destroy();
                    break;
                }
                case NetSocketEvent.CLOSE:
                    this._connected = false;
                    this.connecting = false;
                    this.push(null); // EOF
                    this.destroy();
                    break;
                case NetSocketEvent.BUSY: {
                    // 原生写通道满：重试在途写（readable-stream 保证只有一个在途 _write）
                    const pending = this._pendingNativeWrite;
                    if (pending) {
                        setImmediate(() => {
                            if (this._pendingNativeWrite === pending && this._driver) {
                                this._driver.write(pending.ab);
                            }
                        });
                    }
                    break;
                }
                case NetSocketEvent.DRAIN: { // 5 = WRITTEN，每条被接受的写各来一条
                    const pending = this._pendingNativeWrite;
                    this._pendingNativeWrite = undefined;
                    if (pending) pending.callback(null);
                    this.emit('drain');
                    break;
                }
                case NetSocketEvent.TIMEOUT:
                    if (this.connecting && this._autoSelectFamily) {
                        const lastAttempt = this.autoSelectFamilyAttemptedAddresses[this.autoSelectFamilyAttemptedAddresses.length - 1];
                        if (lastAttempt) {
                            const [ip, port] = lastAttempt.split(':');
                            const family = ip.includes(':') ? 6 : 4;
                            this.emit('connectionAttemptTimeout', ip, parseInt(port || '0', 10), family);
                        }
                    }
                    this.emit('timeout');
                    break;
                case NetSocketEvent.LOOKUP: {
                    if (data) {
                        const lookupStr = decodeArrayBuffer(data);
                        const parts = lookupStr.split(',');
                        if (parts.length >= 2) {
                            const [ip, family] = parts;
                            this.remoteAddress = ip;
                            this.remoteFamily = family === '6' ? 'IPv6' : 'IPv4';

                            // Emit connectionAttempt
                            // We don't have the port in LOOKUP data usually, but we stored it in this.remotePort (dest)
                            // actually remotePort might not be set yet if we used _connect with port arg.
                            // But _connect sets this.remotePort = port.
                            const port = this.remotePort || 0;
                            const fam = family === '6' ? 6 : 4;
                            if (this._autoSelectFamily) {
                                this.emit('connectionAttempt', ip, port, fam);
                            }
                            this.autoSelectFamilyAttemptedAddresses.push(`${ip}:${port}`);
                        }
                        const host = parts.length > 2 ? parts[2] : undefined;
                        this.emit('lookup', null, parts[0], parts[1] ? parseInt(parts[1], 10) : undefined, host);
                    }
                    break;
                }
            }
        };
    }


    protected _updateAddresses() {
        try {
            const local = this._driver?.getLocalAddress();
            if (local) {
                const parts = local.split(':');
                if (parts.length >= 2) {
                    this.localPort = parseInt(parts[parts.length - 1], 10);
                    this.localAddress = parts.slice(0, parts.length - 1).join(':').replace(/[\[\]]/g, '');
                }
            }
            const remote = this._driver?.getRemoteAddress();
            if (remote) {
                const parts = remote.split(':');
                if (parts.length >= 2) {
                    this.remotePort = parseInt(parts[parts.length - 1], 10);
                    this.remoteAddress = parts.slice(0, parts.length - 1).join(':').replace(/[\[\]]/g, '');
                    this.remoteFamily = this.remoteAddress.includes(':') ? 'IPv6' : 'IPv4';
                }
            }
        } catch (e) {
            // Ignore errors for now
        }
    }

    address(): { port?: number; family?: string; address?: string } | null {
        // node 实测：Unix 连接上 `address()` 是**空对象**（不是 null、也不是 {address,path,family}）。
        // 监听器则返回路径字符串，那是 Server.address() 的事（#71）。
        if (this._isUnix) return {};
        if (!this.localAddress) return null;
        return {
            port: this.localPort || 0,
            family: this.localAddress.includes(':') ? 'IPv6' : 'IPv4',
            address: this.localAddress
        };
    }

    connect(options: any, connectionListener?: () => void): this {
        // 参数校验与 node 逐字对齐（实测 node v24，规则见 socketPort.ts 的 `assertConnectTarget`）。
        // 裸 `options.path` 解引用会抛没有 code 的 TypeError，调用方无法按 code 分支。
        assertConnectTarget(options);

        // 谓词与 listen 侧、与 node 都是同一个 `isPipeName`（实测 node v22.11：
        // `net.connect('-1')` 是**路径**（异步 ENOENT 'connect ENOENT -1'），`('5')` 是**端口**
        // （ECONNREFUSED），`('abc')` 是路径）。原先这里写的是 `isNaN(Number(options))`，
        // 于是 '-1' 落到端口分支并被 normalizeSocketPort 同步抛 ERR_SOCKET_BAD_PORT。
        if (typeof options === 'string' && isPipeName(options)) {
            return this._connectUnix(options, connectionListener);
        }

        if (typeof options === 'number' || typeof options === 'string') {
            // 必须走 `normalizeSocketPort` 而不是 `Number(options)`：后者先把 `''` 归成 0，
            // 于是 node 的 `ERR_SOCKET_BAD_PORT`（实测：`Port should be >= 0 and < 65536.
            // Received type string ('')。`）在我们这里变成"接受并连端口 0"。
            const port = normalizeSocketPort(options);
            const host = (arguments.length > 1 && typeof arguments[1] === 'string') ? arguments[1] : 'localhost';
            // connect(port[, host][, cb]) 的回调位置随参数个数变化，必须在 arguments 上看：
            //   (port, cb)        → arguments[1] 是函数
            //   (port, host, cb)  → arguments[1] 是 host，回调在 arguments[2]
            //   (port, host)      → **没有回调**（真实 Node 接受这个形式）
            // ⚠️ 兜底**不能**用形参 `connectionListener` —— 它就是 `arguments[1]`，
            //    在 `(port, host)` 这个形式下它是 host 字符串，于是
            //    `once('connect', <string>)` 抛
            //      TypeError: The "listener" argument must be of type Function. Received type string
            //    （实测：三参形式与两参带回调形式都正常，只有 `(port, host)` 会抛。）
            const cb = typeof arguments[1] === 'function'
                ? arguments[1]
                : (typeof arguments[2] === 'function' ? arguments[2] : undefined);
            // Default: Node 20 defaults autoSelectFamily to true
            this._autoSelectFamily = true;
            return this._connect(port, host, cb);
        }

        if (options.path) {
            return this._connectUnix(options.path, connectionListener, options.signal);
        }

        const port = options.port;
        const host = options.host || 'localhost';

        // Handle autoSelectFamily option
        if (typeof options.autoSelectFamily === 'boolean') {
            this._autoSelectFamily = options.autoSelectFamily;
        } else {
            this._autoSelectFamily = true;
        }

        debugLog(`Socket.connect: target=${host}:${port}, autoSelectFamily=${this._autoSelectFamily}`);
        return this._connect(port, host, connectionListener, options.signal);
    }

    private _connect(port: number, host: string, listener?: () => void, signal?: AbortSignal): this {
        this.remotePort = port; // Store intended remote port
        if (this.connecting || this._connected) return this;
        if (!this._driver) {
            // destroy() 之后 _driver 被清空。原来这里是 `this._driver?.connect(...)`
            // 静默空操作，但 connecting 已经置起来了 —— 于是 connect 永远既不来
            // 'connect' 也不来 'error'，等它的人挂死。报出来（异步，对齐 Node 的
            // 错误时机），并把 connecting 复位。
            return this._failClosed();
        }
        if (signal?.aborted) {
            nextTick(() => this.emit('error', new Error('The operation was aborted')));
            return this;
        }
        this.connecting = true;
        if (listener) this.once('connect', listener);

        if (signal) {
            const abortHandler = () => {
                this.destroy(new Error('The operation was aborted'));
            };
            signal.addEventListener('abort', abortHandler, { once: true });
            this.once('connect', () => signal.removeEventListener('abort', abortHandler));
            this.once('close', () => signal.removeEventListener('abort', abortHandler));
        }

        // Nitro 驱动只收**数字**端口，且归一必须排在 handle-ref 登记**之前**：端口非法就同步
        // 抛出，不能留下顶着 loop 的 ref。字符串端口（`url.parse()` / `new URL()` 交出来的
        // 就是字符串，node-fetch / follow-redirects 全走这条路）原先会一路走到内核边界，在
        // 计时器回调里抛 `NetSocketDriver.connect(...): Value is a string, expected a number`
        // —— 报完还挂住进程（M3-T0 矩阵 F2 的真实阻塞点）。判据与共用实现见 socketPort.ts。
        const portNumber = normalizeSocketPort(port);

        // 过完全部早退守卫之后才登记 handle-ref：没真的发起连接就不该顶住 loop。
        // 释放出口是 _destroy（'close' 的唯一出口）与 resetAndDestroy。
        this._loopRef.acquire();
        debugLog(`Socket._connect: Calling driver.connect(${host}, ${portNumber})`);
        this._driver?.connect(host, portNumber);
        return this;
    }

    /**
     * driver 已消失（多是 destroy 之后）时的统一报错路径。
     * 实测 Node：`new net.Socket()` 未连接就写是 `ERR_SOCKET_CLOSED / Socket is closed`
     * （**既**回调 **也** emit 'error'）。这里没有 driver 可用，只能报出来。
     */
    private _failClosed(): this {
        this.connecting = false;
        const err = errWithCode(Error, 'ERR_SOCKET_CLOSED', 'Socket is closed');
        nextTick(() => this.emit('error', err));
        return this;
    }

    private _connectUnix(path: string, listener?: () => void, signal?: AbortSignal): this {
        if (this.connecting || this._connected) return this;
        if (!this._driver) return this._failClosed();
        if (signal?.aborted) {
            nextTick(() => this.emit('error', new Error('The operation was aborted')));
            return this;
        }
        this.connecting = true;
        if (listener) this.once('connect', listener);

        if (signal) {
            const abortHandler = () => {
                this.destroy(new Error('The operation was aborted'));
            };
            signal.addEventListener('abort', abortHandler, { once: true });
            this.once('connect', () => signal.removeEventListener('abort', abortHandler));
            this.once('close', () => signal.removeEventListener('abort', abortHandler));
        }

        this._loopRef.acquire();
        this._isUnix = true;
        this._driver?.connectUnix(path);
        return this;
    }

    end(chunk?: any, encoding?: any, cb?: any): this {
        if (typeof chunk === 'function') {
            cb = chunk;
            chunk = null;
            encoding = null;
        } else if (typeof encoding === 'function') {
            cb = encoding;
            encoding = null;
        }
        debugLog(`Socket (localPort: ${this.localPort}) .end() called`);
        if (chunk != null) {
            this.write(chunk, encoding);
        }
        super.end(cb);
        return this;
    }

    // 显式声明与 readable-stream `Writable.write` 相同的重载：
    // 若压成单签名，调用点（如 http.ts 的 `socket.write(data, enc, (err) => ...)`）
    // 会失去上下文类型推断而报隐式 any。
    write(chunk: any, cb?: (error: Error | null | undefined) => void): boolean;
    write(chunk: any, encoding?: string, cb?: (error: Error | null | undefined) => void): boolean;
    write(chunk: any, encoding?: any, callback?: any): boolean {
        // 对齐 Node：**已销毁的 socket 上 write 是静默 no-op**。
        //
        // Node 的 `Writable.write` 在 `state.destroyed` 时走
        // `errorOrDestroy(stream, ERR_STREAM_DESTROYED, /*sync*/ true)`，而
        // `errorOrDestroy` 的第一句就是 `if (w && w.destroyed) return this;`
        // —— 已销毁 ⇒ 既不发 'error' 也不抛，只是 `nextTick(cb, err)` 后返回 false。
        // 实测（node v22.22.2）：`new net.Socket().destroy()` 之后 `s.write('x')`
        // 返回 false，无异常、无 'error' 事件。
        //
        // ⚠️ readable-stream 里也有同名的 destroyed 分支，但它的 `errorOrDestroy`
        // 语义不同 —— 实测后果是：**客户端中途断开 → 服务端稍后写响应** 会变成
        // 未捕获的 `ERR_STREAM_DESTROYED`（整个进程崩）。Node 下同样的场景静默通过。
        if (this.destroyed) {
            if (typeof encoding === 'function') {
                callback = encoding;
            }
            if (typeof callback === 'function') {
                nextTick(callback, errWithCode(
                    Error, 'ERR_STREAM_DESTROYED',
                    'Cannot call write after a stream was destroyed'));
            }
            return false;
        }
        const ret = super.write(chunk, encoding, callback);
        // 原生写通道仍有在途写（等 WRITTEN/BUSY 裁决）时，如实返回 false 作为背压信号
        return this._pendingNativeWrite ? false : ret;
    }

    _write(chunk: any, encoding: string, callback: (error?: Error | null) => void): void {
        if (!this._driver) {
            return callback(new Error('Socket not connected'));
        }
        if (!this._connected && this.connecting) {
            // 三条退出路径都要摘掉另外两条的监听，否则一次连接会残留监听，
            // 下一次 deferral 时重复触发。
            const cleanup = () => {
                this.removeListener('connect', onConnect);
                this.removeListener('error', onError);
                this.removeListener('close', onClose);
            };
            const onConnect = () => {
                cleanup();
                this._write(chunk, encoding, callback);
            };
            const onError = (err: Error) => {
                cleanup();
                callback(err);
            };
            // 兜底：`destroy()` 不带错误时既不发 'error' 也不发 'connect'（只发 'close'），
            // 于是 callback 永远不被调用 —— 流的 _write 悬挂，'finish' 再也不来。
            // code 用 ERR_SOCKET_CLOSED_BEFORE_CONNECTION：实测 Node 在
            // 「连到一半被 destroy」时给写回调的就是这个（连上之后再 destroy 是
            // ERR_STREAM_DESTROYED；从未 connect 就写是 ERR_SOCKET_CLOSED）。
            const onClose = () => {
                cleanup();
                callback(errWithCode(Error, 'ERR_SOCKET_CLOSED_BEFORE_CONNECTION',
                    'Socket is closed before connection is established'));
            };
            this.once('connect', onConnect);
            this.once('error', onError);
            this.once('close', onClose);
            return;
        }
        try {
            const buffer = (chunk instanceof Buffer) ? chunk : Buffer.from(chunk, encoding as any);
            this.bytesWritten += buffer.length;
            // 视图正好覆盖整个 ArrayBuffer 时（`Buffer.from(...)` 的常见产物：
            // byteOffset=0 且 byteLength 相等）不必再切一份副本。
            // ⚠️ 判据不能省：`chunk` 已经是 Buffer 时它可能只是别人 ArrayBuffer 上的
            // 一个视图，直接把整个 ArrayBuffer 交出去会写出多余的字节。
            const ab = (buffer.byteOffset === 0 && buffer.byteLength === buffer.buffer.byteLength)
                ? buffer.buffer
                : buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
            debugLog(() => `Socket _write, len: ${ab.byteLength}`);
            // 不改回立即 callback(null)：交给原生裁决
            //   WRITTEN(5) → callback(null) 放行下一条
            //   BUSY(12)   → 重试同一份数据
            //   _destroy   → 以错误回调，避免悬挂
            this._pendingNativeWrite = { ab, callback };
            this._driver.write(ab);
        } catch (err: any) {
            this._pendingNativeWrite = undefined;
            callback(err);
        }
    }

    _read(size: number): void {
        if (this._driver) this._driver.resume();
    }

    _final(callback: (error?: Error | null) => void): void {
        if (!this._driver) {
            return callback(null);
        }
        if (!this._connected && this.connecting) {
            // 同 _write：'close' 兜底，否则 destroy() 无错误时 _final 悬挂 → 'finish' 不来
            const cleanup = () => {
                this.removeListener('connect', onConnect);
                this.removeListener('error', onError);
                this.removeListener('close', onClose);
            };
            const onConnect = () => {
                cleanup();
                this._final(callback);
            };
            const onError = () => {
                cleanup();
                callback(null); // Already destroyed/errored
            };
            const onClose = () => {
                cleanup();
                callback(null);
            };
            this.once('connect', onConnect);
            this.once('error', onError);
            this.once('close', onClose);
            return;
        }
        debugLog(`Socket (localPort: ${this.localPort}) ._final() called, shutting down driver`);
        this._driver.shutdown();
        callback(null);
    }

    destroy(reason?: Error): this {
        debugLog(`Socket (localPort: ${this.localPort}) .destroy() called, reason: ${reason?.message}`);
        return super.destroy(reason);
    }

    _destroy(err: Error | null, callback: (error: Error | null) => void) {
        debugLog(`Socket (localPort: ${this.localPort}) ._destroy() called`);
        // #82：已被就地升级收编 ⇒ 连接归 TLS socket 所有，销毁转交（node 同行为）。
        if (this._adoptedBy) {
            const tls = this._adoptedBy
            this._adoptedBy = undefined
            this._connected = false
            this.connecting = false
            this.destroyed = true
            try {
                tls.destroy()
            } catch {
                // 已经销毁过，忽略
            }
            callback(err);
            return;
        }
        // 'close' 的唯一出口 —— handle-ref 在这里归零（Node：handle 销毁即 unref）
        this._loopRef.release();
        this._connected = false;
        this.connecting = false;
        this.destroyed = true;
        // 在途写不可能再等到 WRITTEN/BUSY：就地以错误回调，避免回调悬挂
        const pending = this._pendingNativeWrite;
        this._pendingNativeWrite = undefined;
        if (pending) {
            pending.callback(err ?? new Error('Socket destroyed'));
        }
        if (this._driver) {
            this._driver.destroy();
            this._driver = undefined;
        }
        // #82：就地升级的 TLS socket 销毁时，原 net.Socket 也要销毁（node 实测：raw 会
        // 收到 'close'、`raw.destroyed` 变 true）。先断开转交关系，避免它再回调回来。
        if (this._adoptedRaw) {
            const raw = this._adoptedRaw
            this._adoptedRaw = undefined
            raw._adoptedBy = undefined
            try {
                raw.destroy()
            } catch {
                // 已经销毁过，忽略
            }
        }
        callback(err);
    }

    // Standard net.Socket methods
    setTimeout(msecs: number, callback?: () => void): this {
        // 对齐 Node（实测 v22）：负数 / NaN / ±Infinity 抛
        // `ERR_OUT_OF_RANGE: The value of "msecs" is out of range. It must be a non-negative finite number`。
        // 0 是合法的（= 取消超时）。
        // 原生侧另有钳制（HybridNetSocketDriver::clampMillis），但那是**纵深防御**——
        // 负 double 转 uint64_t 是 UB（实测绕成 ~1.8e19 ms）。这里才是给调用方的报错面。
        if (typeof msecs !== 'number' || !isFinite(msecs) || msecs < 0) {
            throw errWithCode(RangeError, 'ERR_OUT_OF_RANGE',
                `The value of "msecs" is out of range. It must be a non-negative finite number. Received ${msecs}`);
        }
        this._timeout = msecs;
        if (this._driver) {
            this._driver.setTimeout(msecs);
        }
        this._armConnectTimer();
        if (callback) this.once('timeout', callback);
        return this;
    }

    /** 见 `_connectTimer`：只在「还在连接、且设了超时」时武装，settle 时清掉。 */
    private _armConnectTimer(): void {
        this._clearConnectTimer();
        // 用「是否已收敛」而不是 `connecting` 判断：https 的 TLSSocket 在 TCP 连上之后、
        // 握手完成之前 `connecting` 可能已经是 false，而那正是要覆盖的阶段。
        if (!(this._timeout > 0) || this._connectSettled) return;
        this._connectTimer = setTimeout(() => {
            this._connectTimer = undefined;
            // node 的 'timeout' **不**销毁 socket（实测 `destroyed === false`），由调用方决定
            this.emit('timeout');
        }, this._timeout);
    }

    private _clearConnectTimer(): void {
        if (this._connectTimer !== undefined) {
            clearTimeout(this._connectTimer as any);
            this._connectTimer = undefined;
        }
    }

    /**
     * Pause the reading of data. That is, 'data' events will not be emitted.
     * Useful to throttle back an upload.
     */
    pause(): this {
        super.pause();
        if (this._driver) {
            this._driver.pause();
        }
        return this;
    }

    /**
     * Resume reading after a call to pause().
     */
    resume(): this {
        const driver = this._driver as any;
        const id = driver?.id;
        debugLog(`Socket.resume() called, id: ${id === undefined ? 'none' : id}, destroyed: ${this.destroyed}`);
        super.resume();
        if (driver) {
            debugLog(`Socket.resume() calling driver.resume(), id: ${id}`);
            driver.resume();
        }
        return this;
    }

    /**
     * Enable/disable the use of Nagle's algorithm.
     */
    setNoDelay(noDelay?: boolean): this {
        this._driver?.setNoDelay(noDelay !== false);
        return this;
    }

    setKeepAlive(enable?: boolean, initialDelay?: number): this {
        this._driver?.setKeepAlive(enable !== false, initialDelay || 0);
        return this;
    }

    /**
     * Node：`ref()` 只对仍活跃的 handle 有意义 —— 对已销毁的 socket 调 ref()
     * 是 no-op（否则会在 close 之后重新顶住 loop，进程挂死）。
     */
    ref(): this {
        if ((this._connected || this.connecting) && !this.destroyed) this._loopRef.acquire();
        return this;
    }
    unref(): this {
        this._loopRef.release();
        return this;
    }

    /**
     * Set the encoding for the socket as a Readable Stream.
     * Use 'utf8', 'hex', etc.
     */
    setEncoding(encoding: BufferEncoding): this {
        super.setEncoding(encoding);
        return this;
    }

    get timeout(): number {
        return this._timeout;
    }

    get bufferSize(): number {
        // 已废弃但常被访问：返回在途原生写的字节数
        return this._pendingNativeWrite ? this._pendingNativeWrite.ab.byteLength : 0;
    }

    resetAndDestroy(): this {
        // 绕过 _destroy 的独立销毁路径（它直接清 driver 并置 destroyed），
        // 必须自己归零 handle-ref，否则进程挂死。
        this._loopRef.release();
        if (this._driver) {
            this._driver.resetAndDestroy();
            this._driver = undefined;
        }
        this._connected = false;
        this.connecting = false;
        this.destroyed = true;
        return this;
    }
}

// -----------------------------------------------------------------------------
// Server
// -----------------------------------------------------------------------------

export class Server extends EventEmitter {
    private _driver: NetServerDriver;
    /** Node handle-ref 语义：listening 的 server 顶住事件循环。RN 上全部 no-op。 */
    private _loopRef = new LoopRef('net.Server');
    private _sockets = new Set<Socket>();
    private _connections: number = 0;

    private _maxConnections: number = 0;
    private _dropMaxConnection: boolean = false;
    /** server 级连接超时（毫秒，0 = 不设）；在 _trackSocket 里套用到每条新连接 */
    private _timeout: number = 0;
    /**
     * Unix socket 监听路径。node 的 `server.address()` 对 pipe 监听返回**路径字符串**，
     * 而 `getLocalAddress()` 只给 host:port 形态（解析不出 ⇒ address() 返回 null ⇒
     * `server.listening` 也是假的）。CLOSE 时清掉，否则关掉的 server 还自称在听。
     */
    protected _listenPath: string | undefined;
    /** 是否收到过 native 的 listen 成功回执（'listening' 已经发过）。ERROR 分支用它判断要不要归零。 */
    protected _sawListening: boolean = false;
    /**
     * #81：node 的 `_handle` 在**一部分** listen 形式里是**同步**创建的 ——
     * 端口（无 host）、pipe 路径、已有 fd 三种；带 host 时 node 走 `dns.lookup`，
     * `_handle` 要等回调，所以**同一 tick 内的第二次 listen 在 node 不抛**（实测 v22.11：
     * `listen(0); listen(0)` 抛，而 `listen(0,'127.0.0.1'); listen(0)` 不抛）。
     * 我们的 native listen 一律异步，只能在 JS 侧模拟那三种"同步拿到 handle"的形态。
     */
    protected _listenHandlePending: boolean = false;
    /**
     * #81：node 的 `close()` **同步**把 `_handle` 置空 ⇒ `listening` 立刻变 false、
     * 且**立刻重听**是受支持路径（R07 变体 A 就是这条契约）。我们的 `close()` 只发
     * native 关闭请求，CLOSE 事件才清状态；这里用一个同步旗标补上"已请求关闭"这一段，
     * 否则重听会被"已在 listening"的闸门误拒。
     */
    private _closeRequested: boolean = false;

    /**
     * 设置入站连接的超时（Node 的 `net.Server.setTimeout` 语义）。
     *
     * 此前 net.Server 没有这个方法，于是 `http.Server.setTimeout` 里的
     * `this._netServer.setTimeout(...)`、以及 `https.Server` 里的
     * `(this as any)._netServer.setTimeout(...)` 一调用就 TypeError（TS-H7）。
     */
    setTimeout(msecs: number, callback?: () => void): this {
        this._timeout = msecs;
        if (callback) this.on('timeout', callback);
        return this;
    }

    get maxConnections(): number {
        return this._maxConnections;
    }

    set maxConnections(value: number) {
        this._maxConnections = value;
        // We handle maxConnections in JS to support 'drop' event.
        // Disable native limit to ensure we receive the connection attempt.
        this._driver.maxConnections = 0;
    }

    get dropMaxConnection(): boolean {
        return this._dropMaxConnection;
    }

    set dropMaxConnection(value: boolean) {
        this._dropMaxConnection = value;
    }

    get listening(): boolean {
        // node 的 `close()` 同步把 `_handle` 置空 ⇒ `listening` 立刻变 false。
        // 我们只发 native 关闭请求（CLOSE 事件才清地址），所以用同步旗标补这一段。
        if (this._closeRequested) return false;
        return !!this.address();
    }

    /**
     * 登记一条被 server 跟踪的连接。子类也用它（tls.ts 包装出 TLSSocket 时）。
     * 幂等：同一个 socket 重复登记不会重复计数。
     */
    protected _trackSocket(socket: Socket): void {
        if (this._sockets.has(socket)) return;
        this._sockets.add(socket);
        this._connections++;
        // server 级超时（setTimeout 设的）套用到每条新连接，并把 socket 的 timeout
        // 转发到 server —— 注意这里用的是 socket.setTimeout(ms)（不带回调），
        // 回调语义由 server 自己的 'timeout' 事件承担。
        if (this._timeout > 0) {
            socket.setTimeout(this._timeout);
            socket.on('timeout', () => this.emit('timeout', socket));
        }
        socket.on('close', () => {
            // 已被 _untrackSocket 摘除的 socket 不再计数，否则会双重递减
            if (!this._sockets.has(socket)) return;
            this._connections--;
            this._sockets.delete(socket);
        });
    }

    /**
     * 把一条连接从跟踪里摘除（不再计入 `_connections`）。
     *
     * 用于"连接被接管"的场景：tls.ts 用 `TLSSocket` 包住原 `Socket` 后，原 Socket 的
     * native driver `onEvent` 被覆盖、再也收不到 CLOSE，必须改跟踪包装后的对象，
     * 否则 `_connections` 只增不减（TS-H1）。
     */
    protected _untrackSocket(socket: Socket): void {
        if (!this._sockets.has(socket)) return;
        this._connections--;
        this._sockets.delete(socket);
    }

    constructor(options?: any, connectionListener?: (socket: Socket) => void) {
        super();
        ensureInitialized();
        this._driver = Driver.createServer();

        if (typeof options === 'function') {
            connectionListener = options;
            options = {};
        }

        if (connectionListener) {
            this.on('connection', connectionListener);
        }

        this._driver.onEvent = (eventType: number, data: ArrayBuffer) => {
            switch (eventType) {
                case NetServerEvent.CONNECTION: {
                    const payload = decodeArrayBuffer(data);
                    if (payload === 'success') {
                        this._sawListening = true;
                        this._listenHandlePending = false;
                        this.emit('listening');
                    } else {
                        const clientId = payload;
                        debugLog(`Server connection clientId: '${clientId}', current connections: ${this._connections}, max: ${this._maxConnections}`);
                        if (clientId) {
                            // Check maxConnections
                            if (this._maxConnections > 0 && this._connections >= this._maxConnections) {
                                debugLog(`Server maxConnections reached (${this._connections} >= ${this._maxConnections}). Dropping connection. clientId: ${clientId}`);

                                const socketDriver = Driver.createSocket(clientId);
                                const socket = new Socket({
                                    socketDriver: socketDriver,
                                    readable: true,
                                    writable: true
                                });
                                // @ts-ignore
                                socket._updateAddresses();
                                // accepted socket 持有 handle（Node 语义）。紧接着的
                                // destroy() → _destroy 会归零，天然配对。
                                socket._acquireLoopRef();

                                this.emit('drop', {
                                    localAddress: socket.localAddress,
                                    localPort: socket.localPort,
                                    localFamily: socket.localFamily,
                                    remoteAddress: socket.remoteAddress,
                                    remotePort: socket.remotePort,
                                    remoteFamily: socket.remoteFamily
                                });

                                socket.destroy();
                                return;
                            }

                            const socketDriver = Driver.createSocket(clientId);
                            const socket = new Socket({
                                socketDriver: socketDriver,
                                readable: true,
                                writable: true
                            });

                            // Initialize addresses immediately for server-side socket
                            // @ts-ignore
                            socket._updateAddresses();
                            // @ts-ignore
                            socket._isUnix = this._listenPath !== undefined;
                            debugLog(`Socket initialized addresses: local=${socket.localAddress}:${socket.localPort}, remote=${socket.remoteAddress}:${socket.remotePort}`);

                            // accepted socket 持有 handle（Node 语义）；释放走 _destroy。
                            socket._acquireLoopRef();
                            // Keep reference to prevent GC（统一走 _trackSocket，子类复用同一套计数）
                            this._trackSocket(socket);
                            this.emit('connection', socket);
                            // Start reading only after 'connection' handlers ran.
                            // This prevents dropping data when listeners are attached in the callback.
                            socket.resume();
                        }
                    }
                    break;
                }
                case NetServerEvent.H2_SESSION: {
                    // M5-3：明文/TLS accept 分流到了 h2 引擎。JS 侧取的是**已建好**
                    // 的 session 对象（C++ 在转发本事件前就构造并注册了它，首帧不会丢）。
                    const text = decodeArrayBuffer(data)
                    const sessionId = Number(text)
                    if (sessionId > 0) this.emit('h2session', sessionId)
                    break
                }
                case NetServerEvent.ERROR:
                    // listen 失败（EADDRINUSE 等）时 'close' 不一定来 —— 这条路径必须
                    // 自己归零，否则 server 的 ref 泄漏、进程永不退出。
                    // 用「收到过 listen 成功回执」判定，不能用 `this.listening`：unix 监听的
                    // address() 是 `_listenPath`（本地地址解析不出来），绑定失败时它照样非空。
                    if (!this._sawListening) {
                        this._listenPath = undefined;
                        // 绑定失败 ⇒ handle 没建成，node 允许重试（#81 的 pending 标记要一起清）
                        this._listenHandlePending = false;
                        this._loopRef.release();
                    }
                    this.emit('error', enrichSystemError(new Error(decodeArrayBuffer(data) || 'Unknown server error')));
                    break;
                case NetServerEvent.DEBUG: {
                    debugLog(`Server NATIVE SESSION/DEBUG EVENT RECEIVED`);
                    this.emit('session', data);
                    break;
                }
                case NetServerEvent.CLOSE:
                    // handle 销毁即 unref。必须在 emit 之前：'close' 回调里可能再
                    // 建新 handle，顺序反了会短暂误判为「还有活 handle」。
                    this._sawListening = false;
                    this._listenHandlePending = false;
                    this._closeRequested = false;
                    this._listenPath = undefined;
                    this._loopRef.release();
                    this.emit('close');
                    break;
            }
        };
    }


    /** @internal 供 tls.Server.listen 等子类 override 路径使用；外部勿用。 */
    _acquireLoopRef(): void { this._loopRef.acquire(); }
    /** @internal 供子类 override 路径回退登记用；外部勿用。 */
    _releaseLoopRef(): void { this._loopRef.release(); }

    /**
     * Node：`ref()` 只对仍 listening 的 server 有意义 —— 已 close 的 server
     * 调 ref() 是 no-op（否则会重新顶住 loop，进程挂死）。
     */
    ref(): this {
        if (this.listening) this._loopRef.acquire();
        return this;
    }
    unref(): this {
        this._loopRef.release();
        return this;
    }

    // @ts-ignore
    [Symbol.asyncDispose](): Promise<void> {
        return new Promise((resolve) => {
            this.close(() => resolve());
        });
    }
    listen(port?: any, host?: any, backlog?: any, callback?: any): this {
        // #81：node 在**已经 listening**（`_handle` 存在）时再来一次 listen 会同步抛
        // `ERR_SERVER_ALREADY_LISTEN`（实测 v22.11：普通 Error，消息
        // "Listen method has been called more than once without closing."）。
        // 注意判据：node 对"首次 listen 还没完成"时的再次调用**不抛**（实测同步连调两次
        // `listen(0)` 无异常，第二次顶掉待处理绑定）—— 所以看的是"已经 listening"，
        // 不是"调用过 listen"。我们的等价值是 `_sawListening`（'listening' 时置位、CLOSE 清）。
        // 判据是"已经有 handle"，不是"调用过 listen"；而 close() 在 node 里同步把
        // `_handle` 置空 ⇒ **close 之后立刻重听是受支持路径**（R07 变体 A 的契约），
        // 所以 `_closeRequested` 期间不拦（重听会把旗标清掉）。
        if (!this._closeRequested && (this._sawListening || this._listenHandlePending)) {
            throw alreadyListeningError();
        }
        this._closeRequested = false;

        let _port: unknown = 0;
        let _host: string | undefined;
        let _backlog: number | undefined;
        let _path: string | undefined;
        let _callback: (() => void) | undefined;
        let signal: AbortSignal | undefined;
        let ipv6Only = false;
        let reusePort = false;
        let handle: { fd?: number } | undefined;
        // node 的 normalizeArgs 视角（闸门要用，见 socketPort.ts 的 resolveListenTarget）：
        // `hasPort` 是 `'port' in options`，位置参数形式也算；`omitted` 是「无参或首参是回调」。
        let hasPort = false;
        let hasPath = false;
        const omitted = arguments.length === 0 || typeof port === 'function';
        let normalizedOptions: unknown;

        if (typeof port === 'object' && port !== null) {
            normalizedOptions = port;
            hasPort = 'port' in port;
            hasPath = 'path' in port;
            // Check if it's a handle object with fd property
            if (typeof port.fd === 'number') {
                handle = port;
                _backlog = port.backlog;
                _callback = host; // listen(handle, cb)
            } else {
                _port = port.port;
                _host = port.host;
                _backlog = port.backlog;
                _path = port.path;
                signal = port.signal;
                ipv6Only = port.ipv6Only === true;
                reusePort = port.reusePort === true;
                _callback = host; // listen(options, cb)
            }
        } else {
            // node 的 normalizeArgs：首参是 pipe 名（非空、`Number()` 不是 `>=0` 的字符串）时
            // 进 `options.path`，**不是** `options.port` —— 之前这里把路径当端口归 0 了。
            const isPath = isPipeName(port);
            _port = isPath ? undefined : port;
            _path = isPath ? port : undefined;
            hasPort = !isPath;
            hasPath = isPath;
            normalizedOptions = isPath ? { path: port } : { port };
            // `listen(cb)`：node 的 normalizeArgs 取**末位**函数当回调，同时把首参（那个函数）
            // 归一成 port=0。原来只查 `host`/`backlog`/`callback` 三个位置，回调被整个丢掉
            // ——调用方永远等不到 'listening'。
            if (typeof port === 'function') _callback = port;

            if (typeof host === 'string') {
                _host = host;
                if (hasPort) (normalizedOptions as any).host = host;
            } else if (typeof host === 'function') _callback = host;

            if (typeof backlog === 'number') _backlog = backlog;
            else if (typeof backlog === 'function') _callback = backlog;

            if (typeof callback === 'function') _callback = callback;
        }

        // fd/handle 形式在 node 里同样早退（不做端口校验）。其余一律过闸门：
        // 抛出必须发生在 `_loopRef.acquire()` **之前**，且绝不能把非法端口递到 native。
        const target: ListenTarget = handle ? {} : resolveListenTarget({
            port: _port,
            path: _path,
            hasPort,
            hasPath,
            omitted,
            options: normalizedOptions,
        });
        _port = target.port;
        _path = target.path;
        this._listenPath = target.path;

        if (_callback) this.once('listening', _callback);

        if (signal?.aborted) {
            nextTick(() => this.emit('error', new Error('The operation was aborted')));
            return this;
        }

        if (signal) {
            const abortHandler = () => {
                this.close();
                this.emit('error', new Error('The operation was aborted'));
            };
            signal.addEventListener('abort', abortHandler, { once: true });
            this.once('listening', () => signal.removeEventListener('abort', abortHandler));
            this.once('close', () => signal.removeEventListener('abort', abortHandler));
        }

        // listening 的 server 持有 handle（Node 语义）→ 在调 native 之前登记。
        // 同步抛错则回退登记再重抛：没有 handle 就不该留下 ref。
        this._loopRef.acquire();
        // #81：node 在 fd / pipe / 端口（无 host）三种形态里**同步**建好 `_handle`，
        // 带 host 时它先 `dns.lookup` ⇒ 同一 tick 的第二次 listen **不抛**（实测）。
        this._listenHandlePending = handle !== undefined || !!_path || _host === undefined;
        try {
            if (handle && typeof handle.fd === 'number') {
                // Listen on an existing file descriptor (handle)
                this._driver.listenHandle(handle.fd, _backlog);
            } else if (_path) {
                this._driver.listenUnix(_path, _backlog);
            } else {
                // _host 透传（Node 语义：listen(port, host) 绑定指定地址；undefined 时绑通配）
                // 端口已由 resolveListenTarget 归一成 number（fd/handle 形式除外 → 0）。
                this._driver.listen((_port as number) || 0, _host, _backlog, ipv6Only, reusePort);
            }
        } catch (e) {
            this._listenHandlePending = false;
            this._loopRef.release();
            throw e;
        }

        return this;
    }

    /**
     * 停止接受新连接（**对齐 Node**）。
     *
     * ⚠️ 与旧实现的差异：旧实现会 `for (const s of this._sockets) s.destroy()` ——
     * 把所有已建立的连接一起销毁。那与 Node 的 `server.close()` 语义不同，并且会
     * 制造「在途 native write 被销毁」的场景：`Socket._destroy` 会给它的回调一个
     * `Error('Socket destroyed')`，在 RN 上表现为**未捕获错误 / 红屏**
     * （实测来源：示例 App 在响应回调里 `close()`）。
     * Node 下那段代码永远走不到那条路径（`close()` 不碰已建立的连接），
     * 所以这里对齐 Node：**只停止接受新连接，已建立的连接自然结束**。
     *
     * 想立刻掐断所有连接用 [`closeAllConnections()`]（对齐 Node 18.2+）。
     *
     * 已知偏差（保留，未对齐）：Node 的 `close(cb)` 会等**所有连接结束**才回调；
     * 这里 `'close'` 仍随监听器关闭而发射（回调不等连接）。要等连接结束，
     * 自己监听各连接的 `'close'`，或先 `closeAllConnections()`。
     */
    close(callback?: (err?: Error) => void): this {
        // node：`_handle = null` 同步发生 ⇒ listening 立刻 false、可立刻重听。
        this._closeRequested = true;
        this._driver.close();
        if (callback) this.once('close', callback);
        return this;
    }

    /**
     * 立刻销毁所有已建立的连接（对齐 Node 18.2+ 的 `server.closeAllConnections()`）。
     *
     * 这是旧 `close()` 的行为，现在**显式**提供：需要确定性掐断时用它，
     * 但要知道它会打断在途的写（调用方可能因此收到 `Socket destroyed`）。
     */
    closeAllConnections(): void {
        for (const socket of this._sockets) {
            socket.destroy();
        }
        this._sockets.clear();
        this._connections = 0;
    }

    address(): { port: number; family: string; address: string } | string | null {
        // Unix socket 监听：node 的 address() 返回**路径字符串**（`getsockname()` 对 pipe
        // handle 就是这个形态），不是 {port,family,address} 对象。
        if (this._listenPath) return this._listenPath;
        try {
            const addr = this._driver.getLocalAddress();
            if (addr) {
                const parts = addr.split(':');
                if (parts.length >= 2) {
                    const port = parseInt(parts[parts.length - 1], 10);
                    const address = parts.slice(0, parts.length - 1).join(':').replace(/[\[\]]/g, '');
                    const family = address.includes(':') ? 'IPv6' : 'IPv4';
                    return { port, family, address };
                }
            }
        } catch (e) {
            // Ignore
        }
        return null;
    }

    getConnections(cb: (err: Error | null, count: number) => void): void {
        cb(null, this._connections);
    }
}

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

// Node 支持 createConnection(port[, host][, connectListener]) 与
// createConnection(options[, connectListener]) 两种形式。原实现只声明两个形参，
// 三参形式的回调会被整个丢掉、host 被当成回调传下去（实测抛
// `TypeError: The "listener" argument must be of type Function. Received type string`，
// 真实 Node 不抛）。这里原样转发全部参数，由 connect() 归一。
export function createConnection(...args: any[]): Socket {
    const socket = new Socket(args[0]);
    return (socket.connect as any)(...args);
}

export const connect = createConnection;

export function createServer(options?: any, connectionListener?: (socket: Socket) => void): Server {
    return new Server(options, connectionListener);
}

function ipv4NetmaskToPrefix(netmask: string): number {
    return netmask.split('.').reduce((c, o) => {
        let octet = parseInt(o, 10);
        if (isNaN(octet)) return c;
        while (octet > 0) {
            if (octet & 1) c++;
            octet >>= 1;
        }
        return c;
    }, 0);
}

function ipv6NetmaskToPrefix(netmask: string): number {
    return netmask.split(':').reduce((c, part) => {
        if (!part) return c;
        let val = parseInt(part, 16);
        if (isNaN(val)) return c;
        while (val > 0) {
            if (val & 1) c++;
            val >>= 1;
        }
        return c;
    }, 0);
}

export interface NetworkInterfaceInfo {
    address: string;
    netmask: string;
    family: 'IPv4' | 'IPv6';
    mac: string;
    internal: boolean;
    cidr: string | null;
}

export function networkInterfaces(): Record<string, NetworkInterfaceInfo[]> {
    ensureInitialized();
    try {
        const jsonStr = Driver.getNetworkInterfaces();
        const raw = JSON.parse(jsonStr) as Record<string, Omit<NetworkInterfaceInfo, 'cidr'>[]>;
        const result: Record<string, NetworkInterfaceInfo[]> = {};
        
        for (const name of Object.keys(raw)) {
            result[name] = raw[name].map(entry => {
                let cidr: string | null = null;
                if (entry.address && entry.netmask) {
                    const prefix = entry.family === 'IPv4' 
                        ? ipv4NetmaskToPrefix(entry.netmask) 
                        : ipv6NetmaskToPrefix(entry.netmask);
                    cidr = `${entry.address}/${prefix}`;
                }
                return {
                    address: entry.address,
                    netmask: entry.netmask,
                    family: entry.family,
                    mac: entry.mac,
                    internal: entry.internal,
                    cidr
                };
            });
        }
        return result;
    } catch (e) {
        debugLog(`Failed to parse network interfaces: ${e}`);
        return {};
    }
}

export {
    isIP,
    isIPv4,
    isIPv6,
    getDefaultAutoSelectFamily,
    setDefaultAutoSelectFamily,
    getDefaultAutoSelectFamilyAttemptTimeout,
    setDefaultAutoSelectFamilyAttemptTimeout,
    isVerbose,
    setVerbose,
    initWithConfig,
    // ⚠️ `net.Stream` 是 **`Socket` 的别名**（同一个类对象），不是子类 ——
    // node 实测 `net.Stream === net.Socket` 为 `true`，用户拿它做 `instanceof` 检查。
    // 所以这里必须是**同一个引用**的再导出，不能 `class Stream extends Socket`。
    Socket as Stream,
};

export type { NetConfig };

export default {
    Socket,
    Server,
    SocketAddress,
    BlockList,
    createConnection,
    createServer,
    connect,
    isIP,
    isIPv4,
    isIPv6,
    getDefaultAutoSelectFamily,
    setDefaultAutoSelectFamily,
    getDefaultAutoSelectFamilyAttemptTimeout,
    setDefaultAutoSelectFamilyAttemptTimeout,
    setVerbose,
    initWithConfig,
    networkInterfaces,
    Stream: Socket,
};
