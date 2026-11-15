/**
 * `node:http2` 的 SETTINGS 打包/解包（纯函数，**零相对 import** —— `yarn test:js` 可直接加载）。
 *
 * 语义按 node v22.12 实测（`docs/m5_http2_module_plan.md` §2/§5）：
 *  · 数值项收 u32；`maxFrameSize` 只收 16384..16777215；两个布尔项只收 boolean；
 *  · 打包顺序按 setting id（customSettings 排在具名项之后，且按 id 升序）；
 *  · 解包只返回**实际出现**的项；未知 id 收进 `customSettings`（键是十进制字符串）；
 *  · `maxHeaderSize` 与 `maxHeaderListSize` 都落到 id 6，同时给时 `maxHeaderSize` 胜。
 *
 * 有意偏差（node 的静默行为不复刻，已登记）：
 *  · `initialWindowSize > 0x7fffffff` 在 node 里让 `getPackedSettings()` 返回 `undefined`，
 *    这里抛 `ERR_HTTP2_INVALID_SETTING_VALUE`；
 *  · `customSettings` 写具名 id（< 8）在 node 里同样返回 `undefined`，这里按「写进具名槽、
 *    后者胜」处理；
 *  · NaN / Infinity 在这里抛错（node 会把 NaN 静默打成 0）。
 */

export interface Http2Settings {
    headerTableSize?: number
    enablePush?: boolean
    initialWindowSize?: number
    maxFrameSize?: number
    maxConcurrentStreams?: number
    maxHeaderSize?: number
    maxHeaderListSize?: number
    enableConnectProtocol?: boolean
    customSettings?: Record<string, number>
}

export interface UnpackedSettings extends Http2Settings {
    customSettings?: Record<string, number>
}

const ID_HEADER_TABLE_SIZE = 1
const ID_ENABLE_PUSH = 2
const ID_MAX_CONCURRENT_STREAMS = 3
const ID_INITIAL_WINDOW_SIZE = 4
const ID_MAX_FRAME_SIZE = 5
const ID_MAX_HEADER_LIST_SIZE = 6
const ID_ENABLE_CONNECT_PROTOCOL = 8

const U32_MAX = 0xffffffff
const MAX_INITIAL_WINDOW_SIZE = 0x7fffffff
const MIN_MAX_FRAME_SIZE = 16384
const MAX_MAX_FRAME_SIZE = 16777215
const MAX_CUSTOM_ID = 0xffff

function fail(Ctor: new (message: string) => Error, code: string, message: string): never {
    const error = new Ctor(message) as Error & { code?: string }
    error.code = code
    throw error
}

/** node 的 `Received ...` 描述（只覆盖门面会遇到的形状；类实例不保证）。 */
function describe(value: unknown): string {
    if (value === null) return 'null'
    if (Array.isArray(value)) return 'an instance of Array'
    return `type ${typeof value} (${typeof value === 'string' ? `'${value}'` : String(value)})`
}

function assertObject(value: unknown, name: string): asserts value is Record<string, any> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        const received = Array.isArray(value)
            ? 'an instance of Array'
            : value === null
              ? 'null'
              : describe(value)
        fail(
            TypeError,
            'ERR_INVALID_ARG_TYPE',
            `The "${name}" argument must be of type object. Received ${received}`
        )
    }
}

function u32(name: string, value: unknown, min = 0, max = U32_MAX): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        fail(
            RangeError,
            'ERR_HTTP2_INVALID_SETTING_VALUE',
            `Invalid value for setting "${name}": ${String(value)}`
        )
    }
    const n = Math.trunc(value)
    if (n < min || n > max) {
        fail(
            RangeError,
            'ERR_HTTP2_INVALID_SETTING_VALUE',
            `Invalid value for setting "${name}": ${String(value)}`
        )
    }
    return n
}

function bool(name: string, value: unknown): boolean {
    if (typeof value !== 'boolean') {
        fail(
            RangeError,
            'ERR_HTTP2_INVALID_SETTING_VALUE',
            `Invalid value for setting "${name}": ${String(value)}`
        )
    }
    return value
}

/** node 的默认 SETTINGS（每次返回新对象）。 */
export function defaultSettings(): Required<Omit<Http2Settings, 'customSettings'>> {
    return {
        headerTableSize: 4096,
        enablePush: true,
        initialWindowSize: 65535,
        maxFrameSize: 16384,
        maxConcurrentStreams: U32_MAX,
        maxHeaderSize: 65535,
        maxHeaderListSize: 65535,
        enableConnectProtocol: false,
    }
}

/**
 * 把 settings 对象打成线缆形态（每条 6 字节：u16 id + u32 value）。
 * 返回 `Uint8Array`；facade 层再包成 Buffer（node 返回 Buffer）。
 */
export function packSettings(settings?: Http2Settings | null): Uint8Array {
    if (settings === undefined) return new Uint8Array(0)
    assertObject(settings, 'settings')

    const values = new Map<number, number>()

    if (settings.headerTableSize !== undefined) {
        values.set(ID_HEADER_TABLE_SIZE, u32('headerTableSize', settings.headerTableSize))
    }
    if (settings.enablePush !== undefined) {
        values.set(ID_ENABLE_PUSH, bool('enablePush', settings.enablePush) ? 1 : 0)
    }
    if (settings.maxConcurrentStreams !== undefined) {
        values.set(
            ID_MAX_CONCURRENT_STREAMS,
            u32('maxConcurrentStreams', settings.maxConcurrentStreams)
        )
    }
    if (settings.initialWindowSize !== undefined) {
        values.set(
            ID_INITIAL_WINDOW_SIZE,
            u32('initialWindowSize', settings.initialWindowSize, 0, MAX_INITIAL_WINDOW_SIZE)
        )
    }
    if (settings.maxFrameSize !== undefined) {
        values.set(
            ID_MAX_FRAME_SIZE,
            u32('maxFrameSize', settings.maxFrameSize, MIN_MAX_FRAME_SIZE, MAX_MAX_FRAME_SIZE)
        )
    }
    // node 里两者是同一个 id；同时给时 maxHeaderSize 胜（实测），后写覆盖。
    if (settings.maxHeaderListSize !== undefined) {
        values.set(ID_MAX_HEADER_LIST_SIZE, u32('maxHeaderListSize', settings.maxHeaderListSize))
    }
    if (settings.maxHeaderSize !== undefined) {
        values.set(ID_MAX_HEADER_LIST_SIZE, u32('maxHeaderSize', settings.maxHeaderSize))
    }
    if (settings.enableConnectProtocol !== undefined) {
        values.set(
            ID_ENABLE_CONNECT_PROTOCOL,
            bool('enableConnectProtocol', settings.enableConnectProtocol) ? 1 : 0
        )
    }

    const custom = settings.customSettings
    if (custom !== undefined) {
        assertObject(custom, 'customSettings')
        for (const key of Object.keys(custom)) {
            const value = (custom as Record<string, unknown>)[key]
            // node 忽略非数值的值；这里保持一致（不是静默丢掉**合法**输入）。
            if (typeof value !== 'number') continue
            const id = Number(key)
            if (!Number.isInteger(id) || id < 0 || id > MAX_CUSTOM_ID) {
                fail(
                    RangeError,
                    'ERR_HTTP2_INVALID_SETTING_VALUE',
                    `Invalid value for setting "customSettings:id": ${key}`
                )
            }
            const n = u32(`customSettings:${id}`, value, 0, U32_MAX)
            // id 1..8 是具名项：node 这里会返回 undefined，本实现按后者胜写进具名槽。
            values.set(id, n)
        }
    }

    const ids = Array.from(values.keys()).sort((a, b) => a - b)
    const out = new Uint8Array(ids.length * 6)
    const view = new DataView(out.buffer)
    ids.forEach((id, index) => {
        view.setUint16(index * 6, id, false)
        view.setUint32(index * 6 + 2, values.get(id)!, false)
    })
    return out
}

function assertBuffer(value: unknown): asserts value is ArrayBufferView & { length: number } {
    if (!ArrayBuffer.isView(value) || (value as ArrayBufferView & { length?: number }).length === undefined) {
        fail(
            TypeError,
            'ERR_INVALID_ARG_TYPE',
            `The "buf" argument must be an instance of Buffer or TypedArray. Received ${describe(value)}`
        )
    }
}

/**
 * 解包线缆形态的 SETTINGS。只返回实际出现的项；未知 id 进 `customSettings`。
 * `options.validate === true` 时按 node 的规则再校验一遍（越界值抛错）。
 */
export function unpackSettings(
    buf: ArrayBufferView,
    options?: { validate?: boolean }
): UnpackedSettings {
    assertBuffer(buf)
    if (buf.byteLength % 6 !== 0) {
        fail(
            RangeError,
            'ERR_HTTP2_INVALID_PACKED_SETTINGS_LENGTH',
            'Packed settings length must be a multiple of six'
        )
    }

    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    const out: UnpackedSettings = {}
    const custom: Record<string, number> = {}

    for (let offset = 0; offset < buf.byteLength; offset += 6) {
        const id = view.getUint16(offset, false)
        const value = view.getUint32(offset + 2, false)
        switch (id) {
            case ID_HEADER_TABLE_SIZE:
                out.headerTableSize = value
                break
            case ID_ENABLE_PUSH:
                out.enablePush = value !== 0
                break
            case ID_MAX_CONCURRENT_STREAMS:
                out.maxConcurrentStreams = value
                break
            case ID_INITIAL_WINDOW_SIZE:
                out.initialWindowSize = value
                break
            case ID_MAX_FRAME_SIZE:
                out.maxFrameSize = value
                break
            case ID_MAX_HEADER_LIST_SIZE:
                out.maxHeaderSize = value
                out.maxHeaderListSize = value
                break
            case ID_ENABLE_CONNECT_PROTOCOL:
                out.enableConnectProtocol = value !== 0
                break
            default:
                custom[String(id)] = value
        }
    }

    if (Object.keys(custom).length > 0) out.customSettings = custom

    if (options && options.validate) {
        // 走与打包同一套校验（node 的 unpack(validate) 也是这样）。
        packSettings(out)
    }
    return out
}
