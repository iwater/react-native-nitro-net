import type { ChromeTlsProfile } from './profiles/types'

/**
 * H2 请求头构造（纯函数，无内部 value import —— node 单测可直接加载）。
 *
 * 规则见 docs/m2_implementation_plan.md §4.4：
 * - 控制头按 profile.http2.headerOrder 排列，值来自 profile.headers；
 *   `overrideHeaders` 时用户值优先；`accept-encoding` 始终用户优先（M1 语义）。
 * - 业务头保持用户插入顺序；`headerPolicy` 只决定它排在控制头之前还是之后。
 * - Host 由 native 映射成 :authority；连接级头一律丢弃（H2 禁止）。
 */

export type H2HeaderPolicy = 'profile-first' | 'user-first'

export interface H2HeaderInput {
    method: string
    authority: string
    path: string
    profile: ChromeTlsProfile
    userHeaders?: Record<string, any>
    overrideHeaders?: boolean
    headerPolicy?: H2HeaderPolicy
}

const CONTROL_HEADERS = new Set([
    'user-agent',
    'sec-ch-ua',
    'sec-ch-ua-mobile',
    'sec-ch-ua-platform',
    'accept',
    'accept-encoding',
    'accept-language',
    'sec-fetch-site',
    'sec-fetch-mode',
    'sec-fetch-user',
    'sec-fetch-dest',
    'priority',
    'upgrade-insecure-requests',
])

const FORBIDDEN_HEADERS = new Set([
    'connection',
    'host',
    'keep-alive',
    'proxy-connection',
    'transfer-encoding',
    'upgrade',
    'te',
    'expect',
])

function invalid(message: string): never {
    const error = new Error(`Invalid HTTP/2 header: ${message}`) as Error & { code?: string }
    error.code = 'ERR_INVALID_HEADER_VALUE'
    throw error
}

function toValues(value: any): string[] {
    if (Array.isArray(value)) return value.map((item) => String(item))
    if (value === undefined || value === null) return []
    return [String(value)]
}

function assertValue(name: string, value: string): void {
    if (/[\r\n]/.test(name) || /[\r\n]/.test(value)) {
        invalid(`header ${name} contains CRLF`)
    }
}

/** 返回线缆顺序的 [name, value]（名称为小写，不含伪头）。 */
export function buildH2RequestHeaders(input: H2HeaderInput): Array<[string, string]> {
    const user = input.userHeaders ?? {}
    const userLower = new Map<string, any>()
    for (const name of Object.keys(user)) {
        userLower.set(name.toLowerCase(), user[name])
    }

    const profileValues = new Map<string, string>()
    for (const [name, value] of input.profile.headers) {
        profileValues.set(name.toLowerCase(), value)
    }

    const controls: Array<[string, string]> = []
    for (const name of input.profile.http2.headerOrder) {
        const lower = name.toLowerCase()
        if (!CONTROL_HEADERS.has(lower)) continue
        const userValue = userLower.get(lower)
        const useUser =
            userValue !== undefined && (lower === 'accept-encoding' || !!input.overrideHeaders)
        const profileValue = profileValues.get(lower)
        let value: string | undefined
        if (useUser && userValue !== undefined) {
            const values = toValues(userValue)
            value = values.length > 0 ? values.join(', ') : undefined
        } else {
            value = profileValue
        }
        if (value === undefined) continue
        assertValue(lower, value)
        controls.push([lower, value])
    }

    const business: Array<[string, string]> = []
    for (const [rawName, rawValue] of Object.entries(user)) {
        const name = rawName.toLowerCase()
        if (CONTROL_HEADERS.has(name) || FORBIDDEN_HEADERS.has(name) || name.startsWith(':')) {
            continue
        }
        for (const value of toValues(rawValue)) {
            assertValue(name, value)
            business.push([name, value])
        }
    }

    return (input.headerPolicy ?? 'profile-first') === 'user-first'
        ? [...business, ...controls]
        : [...controls, ...business]
}

/**
 * `node:http2` 门面的请求头校验（`session.request(headers)`）。
 *
 * 实测 node v22.12 的边界：名字大小写不敏感（下行小写）；`connection`/`keep-alive`/
 * `proxy-connection`/`transfer-encoding`/`upgrade` 一律禁；`te` 只允许 `trailers`；
 * 伪头只接受 method/scheme/authority/path，且只允许单值（数组长度 > 1 抛
 * `ERR_HTTP2_HEADER_SINGLE_VALUE`）；非字符串值按 String() 处理；`set-cookie` 这类
 * 重复项在后面按 node 的形状合并（见 http2.ts 的 headersToObject）。
 *
 * 有意比 node 更严（已登记）：空名字/CRLF 值在 node 里会原样发出去，这里直接拒绝 ——
 * 不把请求头拼接当传输层的事。
 */
export interface FacadeRequestHeaders {
    method: string
    scheme: string
    authority: string
    path: string
    headers: Array<[string, string]>
}

const PSEUDO_ALLOWED = new Set([':method', ':scheme', ':authority', ':path'])
// 门面的禁用集合是 RFC 9113 §8.2.2 的那几个；`te` 只允许 trailers，`host` 走 :authority，
// `expect` 是普通头（node 实测三种都放行）。
const FACADE_FORBIDDEN = new Set([
    'connection',
    'keep-alive',
    'proxy-connection',
    'transfer-encoding',
    'upgrade',
])
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

function headerError(code: string, message: string): never {
    const error = new Error(message) as Error & { code?: string }
    error.code = code
    throw error
}

export function prepareFacadeHeaders(
    headers: any,
    defaults: { authority: string }
): FacadeRequestHeaders {
    if (headers === null || typeof headers !== 'object' || Array.isArray(headers)) {
        const received = headers === null
            ? 'null'
            : Array.isArray(headers)
              ? 'an instance of Array'
              : `type ${typeof headers} (${typeof headers === 'string' ? `'${headers}'` : String(headers)})`
        headerError(
            'ERR_INVALID_ARG_TYPE',
            `The "headers" argument must be of type object. Received ${received}`
        )
    }

    const pseudo = new Map<string, string>()
    const pairs: Array<[string, string]> = []
    let hostHeader: string | undefined

    for (const rawName of Object.keys(headers)) {
        const name = rawName.toLowerCase()
        const rawValue = headers[rawName]
        const values = Array.isArray(rawValue)
            ? rawValue.map((value) => String(value))
            : [String(rawValue)]

        if (name.startsWith(':')) {
            if (!PSEUDO_ALLOWED.has(name)) {
                headerError(
                    'ERR_HTTP2_INVALID_PSEUDOHEADER',
                    `"${name}" is an invalid pseudoheader or is used incorrectly`
                )
            }
            if (values.length !== 1) {
                headerError(
                    'ERR_HTTP2_HEADER_SINGLE_VALUE',
                    `Header field "${name}" must only have a single value`
                )
            }
            pseudo.set(name, values[0])
            continue
        }

        if (!TOKEN.test(name)) {
            headerError(
                'ERR_INVALID_HTTP_TOKEN',
                `Header name must be a valid HTTP token ["${name}"]`
            )
        }
        if (FACADE_FORBIDDEN.has(name)) {
            headerError(
                'ERR_HTTP2_INVALID_CONNECTION_HEADERS',
                `HTTP/1 Connection specific headers are forbidden: "${name}"`
            )
        }
        if (name === 'te' && values.some((value) => value.toLowerCase() !== 'trailers')) {
            headerError(
                'ERR_HTTP2_INVALID_CONNECTION_HEADERS',
                'HTTP/1 Connection specific headers are forbidden: "te"'
            )
        }
        if (name === 'host') {
            // node 把 host 当普通头发出去、且**不**再补 :authority；我们的原生侧永远用
            // `:authority` 表达路由，所以这里收成 authority（语义等价，形状已登记）。
            hostHeader = values[0]
            continue
        }
        for (const value of values) {
            if (/[\r\n]/.test(value)) {
                headerError(
                    'ERR_HTTP2_INVALID_HEADER_VALUE',
                    `Invalid value for header "${name}": CR/LF is not allowed`
                )
            }
            pairs.push([name, value])
        }
    }

    const method = pseudo.get(':method') ?? 'GET'
    const scheme = pseudo.get(':scheme') ?? 'https'
    const authority = pseudo.get(':authority') ?? hostHeader ?? defaults.authority
    const path = pseudo.get(':path') ?? '/'
    if (method.length === 0) {
        headerError('ERR_HTTP2_INVALID_PSEUDOHEADER', 'The ":method" header cannot be empty')
    }

    return { method, scheme, authority, path, headers: pairs }
}

export function buildH2RequestJson(input: H2HeaderInput, endStream: boolean): string {
    return JSON.stringify({
        method: input.method,
        scheme: 'https',
        authority: input.authority,
        path: input.path,
        headers: buildH2RequestHeaders(input),
        endStream: !!endStream,
    })
}
