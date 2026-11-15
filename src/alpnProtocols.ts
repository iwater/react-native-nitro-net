// 与 `socketPort.ts` 的 `describeReceivedValue` 同规则，这里是**本地副本**：
// `node --experimental-strip-types` 不能解析无扩展名的相对 import，所以本模块必须
// 零相对依赖，`yarn test:js` 才加载得动（`socketPort.ts` 自己也是零依赖才被这样测试）。
// 改动 node 的 Received 文案时，两处要一起改（判据在 tests/js/{socket_port,alpn_protocols}.test.ts）。
function describeReceivedValueForAlpn(value: unknown): string {
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

/**
 * #84：`ALPNProtocols` → node 的线缆形态（每项 `1 字节长度 + 协议名`）。
 *
 * 单独成模块是因为 `src/tls.ts` 依赖 `react-native-nitro-buffer`，而那份 Buffer 在
 * 纯 node 测试运行器里加载不了（扩展名缺失的 ESM 内部 import）—— 判据要能进
 * `yarn test:js`，这段校验就必须没有原生依赖。
 *
 * 期望值全部来自 node v22.11 实测（`tls.createServer({ALPNProtocols}).ALPNProtocols` 逐型跑），
 * **不是**文档也不是推断：
 *   · 数组项分两种错误：`[Buffer]` / `[ArrayBuffer]` 这类**二进制**项在 `Buffer.byteLength`
 *     那步**过得去**，要到 `buff.write` 才抛 `TypeError: argument must be a string`；
 *     数字 / null / 数组 / 对象则在第一步抛
 *     `The "string" argument must be of type string or an instance of Buffer or ArrayBuffer.
 *     Received …`。所以**先算完所有长度、再逐项写入**，两趟不能合并
 *     （一个 300 字节的 Buffer 项报的是 `ERR_OUT_OF_RANGE`，不是「must be a string」）。
 *   · 整个选项给 Uint8Array/Buffer ⇒ 复制后原样使用（node 注释："Copy new buffer not to be
 *     modified"）；实测 `server.ALPNProtocols` 就是那段字节。
 *   · 给别的（字符串、数字…）⇒ node **完全忽略**：属性实测为 `undefined`、协商结果 `false`。
 */

export function isBinaryLike(value: unknown): boolean {
    if (typeof ArrayBuffer === 'undefined') return false;
    return value instanceof Uint8Array || value instanceof ArrayBuffer || ArrayBuffer.isView(value);
}

function binaryByteLength(value: unknown): number {
    if (value instanceof ArrayBuffer) return value.byteLength;
    if (ArrayBuffer.isView(value)) return (value as ArrayBufferView).byteLength;
    return 0;
}

function invalidArgType(message: string): TypeError {
    const err = new TypeError(message) as TypeError & { code?: string };
    err.code = 'ERR_INVALID_ARG_TYPE';
    return err;
}

/**
 * UTF-8 编码。**不能依赖 `TextEncoder`**：某些无头宿主没有这个全局，
 * 而这段代码在 `https.createServer()` 的构造路径上 —— 一旦抛错，服务端根本起不来。
 * 有 `TextEncoder` 时仍用它（与 node 的 `Buffer.byteLength` 同一套语义）。
 */
function utf8Encode(value: string): Uint8Array {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value);
    const out: number[] = [];
    for (let i = 0; i < value.length; i++) {
        let cp = value.charCodeAt(i);
        if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < value.length) {
            const next = value.charCodeAt(i + 1);
            if (next >= 0xdc00 && next <= 0xdfff) {
                cp = 0x10000 + ((cp - 0xd800) << 10) + (next - 0xdc00);
                i++;
            }
        }
        if (cp < 0x80) out.push(cp);
        else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
        else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
        else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    }
    return Uint8Array.from(out);
}

/** UTF-8 字节数（等价于 node 的 `Buffer.byteLength(str)`）。 */
function utf8ByteLength(value: string): number {
    return utf8Encode(value).byteLength;
}

export function convertALPNProtocols(protocols: unknown): Uint8Array | undefined {
    if (Array.isArray(protocols)) {
        const lens: number[] = [];
        let total = 0;
        for (let i = 0; i < protocols.length; i++) {
            const entry = protocols[i];
            let len: number;
            if (typeof entry === 'string') {
                len = utf8ByteLength(entry);
            } else if (isBinaryLike(entry)) {
                len = binaryByteLength(entry);
            } else {
                throw invalidArgType(
                    'The "string" argument must be of type string or an instance of Buffer or ' +
                    `ArrayBuffer. Received ${describeReceivedValueForAlpn(entry)}`);
            }
            if (len > 255) {
                const err = new RangeError(
                    `The byte length of the protocol at index ${i} exceeds the maximum length. ` +
                    `It must be <= 255. Received ${len}`) as RangeError & { code?: string };
                err.code = 'ERR_OUT_OF_RANGE';
                throw err;
            }
            lens.push(len);
            total += 1 + len;
        }
        const out = new Uint8Array(total);
        let offset = 0;
        for (let i = 0; i < protocols.length; i++) {
            const entry = protocols[i];
            out[offset++] = lens[i];
            if (typeof entry !== 'string') throw invalidArgType('argument must be a string');
            const body = utf8Encode(entry);
            for (let j = 0; j < lens[i]; j++) out[offset++] = body[j];
        }
        return out;
    }
    if (isBinaryLike(protocols)) {
        const bytes = protocols instanceof ArrayBuffer
            ? new Uint8Array(protocols)
            : new Uint8Array((protocols as ArrayBufferView).buffer,
                (protocols as ArrayBufferView).byteOffset,
                (protocols as ArrayBufferView).byteLength);
        // 复制：调用方之后改自己的 buffer，不能改到我们已经交出去的配置。
        const copy = new Uint8Array(bytes.byteLength);
        copy.set(bytes);
        return copy;
    }
    return undefined;
}
