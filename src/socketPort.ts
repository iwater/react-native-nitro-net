/**
 * 端口归一（`net.Socket._connect` 与 `tls.TLSSocket.connect` 共用）。
 *
 * Node 的 `net.connect` / `tls.connect` / `http.request` 都接受**字符串**端口 —— 而
 * `url.parse()` / `new URL()` 交出来的正是字符串（实测 node-fetch 传的是 `port:"52061"`）。
 * Nitro 驱动只收数字，直接递字符串会得到内核的
 * `NetSocketDriver.connectTLSWithContext(...): Value is a string, expected a number`，
 * 且它抛在计时器回调里（无人接）⇒ 报完还挂住进程：M3-T0 矩阵里 `nf https + 自定义 ca`
 * 既不报错也不退出的「挂起」就是这么来的（#50；同一坑在 net 侧先现过一次，#44/F2）。
 * 所以两侧必须共用这一份归一，各自实现早晚会长回来 —— net.ts 修了，tls.ts 漏了。
 *
 * 判据取 node v24 实跑（不是推测）：
 *   接受  ' 443 ' / '443.0' / '0x10' / '1e3' / '+443'（即 `Number()` 的接受集）
 *   拒绝  '' / '443abc' / '4_4' / '８０' / -1 / 70000 ⇒ `ERR_SOCKET_BAD_PORT`，
 *         message 形如 `Port should be >= 0 and < 65536. Received type string ('443abc').`
 *         （`''` 虽然 `Number('') === 0`，node 仍然拒 —— 这里跟着拒。）
 *
 * ⚠️ `undefined` / `null` 在 `normalizeSocketPort` 里归 0，**不**照抄 node：本包内部（Unix socket
 * 分支、代理隧道、Server 侧已建连的 handle）会带着「没有端口」走到这里，抛出去会把正常
 * 路径变成崩溃。所以**公开入口的闸门**（`assertConnectTarget`）负责按 node 抛出，
 * 归一函数只对闸门放行的值负责。这条分工登记在 `docs/node_compatibility_deviations.md` §2.1。
 */

/** node 的 `ERR_INVALID_ARG_TYPE` 怎么描述收到的值（实测 node v24，含匿名函数尾随空格）。 */
export function describeReceivedValue(value: unknown): string {
    if (value === null) return 'null';
    switch (typeof value) {
        case 'boolean': return `type boolean (${value})`;
        case 'symbol': return `type symbol (${String(value)})`;
        case 'bigint': return `type bigint (${value}n)`;
        case 'function': return `function ${value.name}`;
        case 'number': return `type number (${value})`;
        case 'string': return `type string ('${value}')`;
        default: {
            const name = (value as any)?.constructor?.name;
            return `an instance of ${name || 'Object'}`;
        }
    }
}

function missingPortArgsError(): TypeError {
    const err = new TypeError(
        'The "options" or "port" or "path" argument must be specified') as TypeError & { code?: string };
    err.code = 'ERR_MISSING_ARGS';
    return err;
}

function invalidPortTypeError(value: unknown): TypeError {
    const err = new TypeError(
        `The "options.port" property must be one of type number or string. Received ${describeReceivedValue(value)}`
    ) as TypeError & { code?: string };
    err.code = 'ERR_INVALID_ARG_TYPE';
    return err;
}

/**
 * `net.connect` / `tls.connect` 的入参闸门 —— node 侧两者是同一套规则（实测 node v24 全表）：
 *   · `undefined`（含 `net.connect()`） ⇒ `ERR_MISSING_ARGS`（TypeError）
 *   · `null` / boolean / symbol / bigint / function ⇒ `ERR_INVALID_ARG_TYPE`
 *     （**裸值**也按 `options.port` 报错，node 就是这么写的）
 *   · number ⇒ 端口；string ⇒ Unix 路径或端口字符串，放行
 *   · object ⇒ `port` 存在则必须是 number/string；否则要求 `path` 是字符串；都没有 ⇒ `ERR_MISSING_ARGS`
 *     （`[]`、`new Date()`、`new Map()` 走「都没有」这一支，与 node 一致）
 * 范围校验（`ERR_SOCKET_BAD_PORT`）仍由 `normalizeSocketPort` 在闸门之后做，两者消息文本都与 node 逐字一致。
 */
export function assertConnectTarget(options: unknown, allowSocket = false): void {
    if (options === undefined) throw missingPortArgsError();
    const kind = typeof options;
    if (kind === 'number' || kind === 'string') return;
    if (kind !== 'object') throw invalidPortTypeError(options);
    if (options === null) throw invalidPortTypeError(null);
    const { port, path, socket } = options as { port?: unknown; path?: unknown; socket?: unknown };
    if (port === undefined) {
        if (typeof path === 'string') return;
        // #82：只有 `tls.connect({socket})` 允许没有 port/path —— 就地升级已有连接。
        // node 对 socket 的**取值**几乎不校验（实测：{} / 'x' / 42 都在 TLSSocket 里
        // 报 `stream.pause is not a function`，而 null 走"没给"⇒ ERR_MISSING_ARGS），
        // 所以这里只按 truthy 放行，真正形态由升级路径报错。
        if (allowSocket && socket) return;
        throw missingPortArgsError();
    }
    if (typeof port !== 'number' && typeof port !== 'string') throw invalidPortTypeError(port);
}

/** node 的 `ERR_SERVER_ALREADY_LISTEN`（实测 v22：普通 `Error`，消息逐字如下）。 */
export function alreadyListeningError(): Error {
    const err = new Error('Listen method has been called more than once without closing.') as Error & { code?: string };
    err.code = 'ERR_SERVER_ALREADY_LISTEN';
    return err;
}

/** node 的 `ERR_SOCKET_BAD_PORT` 文案；label 两侧不同：connect 用 `Port`，listen 用 `options.port`。 */
function portRangeError(value: unknown, label: string): RangeError {
    const err = new RangeError(
        `${label} should be >= 0 and < 65536. Received type ${typeof value} (${
            typeof value === 'string' ? `'${value}'` : String(value)
        }).`);
    (err as any).code = 'ERR_SOCKET_BAD_PORT';
    return err;
}

/** 归一并返回数字端口；非法值抛 `ERR_SOCKET_BAD_PORT`（同步，早于任何 handle-ref 登记）。 */
export function normalizeSocketPort(port: unknown): number {
    if (port === undefined || port === null) return 0;
    const portNumber = Number(port);
    if (!Number.isInteger(portNumber) || portNumber < 0 || portNumber > 65535 || port === '') {
        throw portRangeError(port, 'Port');
    }
    return portNumber;
}

/**
 * `server.listen()` 的范围校验（node 的 `validatePort(port, 'options.port')`）。
 * 与 `normalizeSocketPort` 同一套接受集，只差消息前缀 —— node 两处用的正是不同 label。
 */
export function validateListenPort(port: unknown): number {
    const portNumber = Number(port);
    if (!Number.isInteger(portNumber) || portNumber < 0 || portNumber > 65535 || port === '') {
        throw portRangeError(port, 'options.port');
    }
    return portNumber;
}

/**
 * `ERR_INVALID_ARG_VALUE` 的 `Received <值>` 段用的迷你 inspect。
 *
 * ⚠️ **为什么在库里重写一份**：node 的那段文本来自 `util.inspect`，而本包必须能在 RN 上加载
 * ——`require('util')` 在 Metro 侧是静态解析失败，不能为了错误文案引一个宿主内建。
 * 取值语义按 node v22 的 `util.inspect` 实测对齐（基本类型、`bigint` 带 `n`、`Symbol(x)`、
 * `[Function: name]` / `[Function (anonymous)]`、Date 的 ISO 串、RegExp、Error 取栈首行、
 * 容器展开到 depth 2 后 `[Object]` / `[Array]`）。**类实例**（如 AbortSignal）node 会打成
 * `AbortSignal[AbortSignal] {}` 一类的形态，这里不保证一致 —— 可达性见 resolveListenTarget
 * 的两个 fallthrough，登记的差异与判据见 `docs/node_compatibility_deviations.md` §2.1。
 */
function inspectReceived(value: unknown, maxDepth: number, depth: number): string {
    if (value === null) return 'null';
    const kind = typeof value;
    if (kind === 'string') {
        return `'${(value as string).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
    }
    if (kind === 'number' || kind === 'boolean') return String(value);
    if (kind === 'bigint') return `${value}n`;
    if (kind === 'symbol' || kind === 'undefined') return String(value);
    if (kind === 'function') {
        const name = (value as { name?: string }).name;
        return name ? `[Function: ${name}]` : '[Function (anonymous)]';
    }
    if (value instanceof Date) return value.toISOString();
    if (value instanceof RegExp) return String(value);
    if (value instanceof Error) {
        return value.stack ? String(value.stack).split('\n')[0] : String(value);
    }
    if (depth > maxDepth) return Array.isArray(value) ? '[Array]' : '[Object]';
    if (Array.isArray(value)) {
        if (value.length === 0) return '[]';
        return `[ ${value.map((item) => inspectReceived(item, maxDepth, depth + 1)).join(', ')} ]`;
    }
    const keys = Object.keys(value as object);
    if (keys.length === 0) return '{}';
    return `{ ${keys
        .map((key) => `${key}: ${inspectReceived((value as Record<string, unknown>)[key], maxDepth, depth + 1)}`)
        .join(', ')} }`;
}

function invalidListenOptionsError(options: unknown, reason: string): TypeError {
    const err = new TypeError(
        `The argument 'options' ${reason || 'is invalid'}. Received ${inspectReceived(options, 2, 0)}`
    ) as TypeError & { code?: string };
    err.code = 'ERR_INVALID_ARG_VALUE';
    return err;
}

/**
 * node 的 `isPipeName`（`net.js` 里就是这一个谓词，listen 与 connect 共用）：
 * 非空、且 `Number()` 不是 `>= 0` 的字符串才算路径（`'-1'`/`'5'` 都是端口）。
 */
export function isPipeName(value: unknown): value is string {
    if (typeof value !== 'string' || value.length === 0) return false;
    return !(Number(value) >= 0);
}

export interface ListenTarget {
    port?: number;
    path?: string;
}

/**
 * `server.listen()` 的入参闸门。规则**逐条**抄 node v22 的 `Server.prototype.listen`
 * （`net.js` 的 normalizeArgs + 三段 fallthrough），实测结果就是下面这五步：
 *   ① `listen()` / `listen(cb)` / `port` 显式为 undefined 或 null ⇒ 任意端口（0）
 *   ② port 是 number/string ⇒ `validatePort`（越界/非数字串 ⇒ `ERR_SOCKET_BAD_PORT`，
 *      消息前缀是 `options.port`，与 connect 的 `Port` 不同）
 *   ③ port 缺失而 path 是 pipe 名 ⇒ Unix socket 分支
 *   ④ options 里既没有 port 键也没有 path 键 ⇒ `ERR_INVALID_ARG_VALUE`
 *      （'must have the property "port" or "path"'）
 *   ⑤ 其余（port 是 `{}`/`[]`/boolean/Symbol/bigint/函数）⇒ `ERR_INVALID_ARG_VALUE`（is invalid）
 *
 * ⚠️ 为什么必须在 JS 侧做：改前这些输入全数**放行到 native**，表现是
 * 「异步的 `Invalid port: 70000`（无 code）」「Nitro 边界的 InternalError」「`NaN`/`''`/`80.5`
 * 归 0 之后绑到一个随机端口」。node 那里是同步抛错，调用方的 try/catch 与 `code` 分流都在等它。
 *
 * @param input.port 归一**前**的端口输入
 * @param input.hasPort node 的 `'port' in options`：位置参数形式（`listen(80)`、`listen(true)`）
 *        也算有，因为 normalizeArgs 会把首参写成 `options.port`
 * @param input.omitted `args.length === 0` 或首参是函数
 */
export function resolveListenTarget(input: {
    port: unknown;
    path: unknown;
    hasPort: boolean;
    hasPath: boolean;
    omitted: boolean;
    options: unknown;
}): ListenTarget {
    const { port, path, hasPort, hasPath, omitted, options } = input;
    if (omitted || (port === undefined && hasPort) || port === null) return { port: 0 };
    if (typeof port === 'number' || typeof port === 'string') {
        return { port: validateListenPort(port) };
    }
    if (isPipeName(path)) return { path };
    if (!hasPort && !hasPath) {
        throw invalidListenOptionsError(options, 'must have the property "port" or "path"');
    }
    throw invalidListenOptionsError(options, '');
}
