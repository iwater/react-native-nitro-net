/**
 * `node:http2` 公共门面（客户端）。
 *
 * TLS 只有一条路：impersonate 的 btls + Chrome profile —— 所以 `connect()` 要求显式
 * `configure({ impersonate })`，未配置抛 `ERR_IMPERSONATION_UNAVAILABLE`（用户 2026-10-27 决定）。
 * 服务端（`createServer`/`createSecureServer`）是独立的原生里程碑，见
 * `docs/m5_http2_module_plan.md`；这里在落地前显式抛错，不做静默降级。
 *
 * 与 node 的已知形状差异都写在 `docs/m5_http2_module_plan.md` §3：
 *  · `stream.id` 是本库的 requestId，不是协议流 id（原生暂不回报）；
 *  · `remoteSettings` 是 `{}`（`http2` crate 不暴露对端 SETTINGS；不臆造）；
 *  · `session.close()` 不会向对端发 GOAWAY（先等流结束再销毁本地会话）；
 *  · 空闲会话不顶住宿主事件循环（本库 LoopRef 的既有语义）。
 */

// `stream` 说明符的选择见 `net.ts` 顶部（#51：宿主内建表与 RN 的 npm 别名同一份实现）
import { Duplex, Readable, Writable } from 'stream'
import { Buffer } from 'react-native-nitro-buffer'

import { EventEmitter } from './eventEmitterCompat'
import { Server as NetServer } from './net'
import { Server as HttpsServer } from './https'
import { Http2SessionEvent, type Http2ServerSessionDriver } from './Net.nitro'
import { Http2Session } from './http2Session'
import { constants } from './http2Constants'
import { defaultSettings, packSettings, unpackSettings, type Http2Settings } from './http2Settings'
import { prepareFacadeHeaders, type FacadeRequestHeaders } from './http2Headers'
import { normalizeProtocolVersion, serializeProfileProxy, serializeProfileTlsOptions } from './tls'
import { buildImpersonationConnectOptions } from './impersonation'
import {
    getImpersonationConfig,
    isHttp2Available,
    isImpersonationAvailable,
    lookupProfile,
} from './profiles/registry'
import { parseProxy, type ParsedProxy } from './proxy'
import { isURLLike } from './urlCompat'
import { decodePeerCertificateChain } from './peerCertificate'

function errWithCode(message: string, code: string): Error {
    const error = new Error(message) as Error & { code?: string }
    error.code = code
    return error
}

const GOAWAY_CODES: Record<string, number> = {
    NO_ERROR: 0,
    PROTOCOL_ERROR: 1,
    INTERNAL_ERROR: 2,
    FLOW_CONTROL_ERROR: 3,
    SETTINGS_TIMEOUT: 4,
    STREAM_CLOSED: 5,
    FRAME_SIZE_ERROR: 6,
    REFUSED_STREAM: 7,
    CANCEL: 8,
    COMPRESSION_ERROR: 9,
    CONNECT_ERROR: 10,
    ENHANCE_YOUR_CALM: 11,
    INADEQUATE_SECURITY: 12,
    HTTP_1_1_REQUIRED: 13,
}

function splitAddress(value: string | undefined): { address?: string; port?: number } {
    if (!value) return {}
    const text = value.trim()
    const colon = text.lastIndexOf(':')
    if (colon < 0) return { address: text }
    const port = Number(text.slice(colon + 1))
    return {
        address: text.slice(0, colon).replace(/^\[(.*)\]$/, '$1'),
        port: Number.isFinite(port) ? port : undefined,
    }
}

/** 响应头线缆对 → node 的对象形状：`set-cookie` 是数组，其余重复项用 ", " 合并。 */
function headersToObject(
    status: number | undefined,
    pairs: Array<[string, string]>
): Record<string, any> {
    const out: Record<string, any> = {}
    if (status !== undefined) out[':status'] = status
    for (const [name, value] of pairs) {
        const lower = name.toLowerCase()
        if (lower === 'set-cookie') {
            if (out[lower] === undefined) out[lower] = [value]
            else out[lower].push(value)
        } else if (out[lower] === undefined) {
            out[lower] = value
        } else {
            out[lower] = `${out[lower]}, ${value}`
        }
    }
    return out
}

interface ParsedAuthority {
    host: string
    port: number
    /** 默认端口省略（与 WHATWG URL 的 `host` 一致）。 */
    authority: string
}

function invalidUrl(value: unknown): never {
    throw errWithCode(`Invalid URL: ${String(value)}`, 'ERR_INVALID_URL')
}

function parseAuthority(input: any): ParsedAuthority {
    let protocol: string
    let hostname: string
    let portText: string | undefined

    if (typeof input === 'string') {
        // authority 只需要 origin 部分；路径/查询按 node 的语义忽略。
        // 允许 userinfo（node 接受带凭据的 authority），但它不参与 HTTP/2 的 :authority。
        const match =
            /^([a-z][a-z0-9+.-]*):\/\/(?:[^/@]*@)?(\[[^\]]+\]|[^/?#:]*)(?::(\d+))?(?:[/?#]|$)/i.exec(
                input
            )
        if (!match || match[2] === '') invalidUrl(input)
        protocol = `${match[1].toLowerCase()}:`
        hostname = match[2]
        portText = match[3]
    } else if (isURLLike(input)) {
        protocol = String((input as URL).protocol)
        hostname = String((input as URL).hostname)
        portText = (input as URL).port || undefined
    } else {
        throw errWithCode(
            'The "authority" argument must be a string or an instance of URL',
            'ERR_INVALID_ARG_TYPE'
        )
    }

    if (protocol !== 'https:' && protocol !== 'http:') {
        throw errWithCode(`protocol "${protocol}" is unsupported.`, 'ERR_HTTP2_UNSUPPORTED_PROTOCOL')
    }
    if (protocol === 'http:') {
        throw errWithCode(
            'node:http2 plaintext (h2c) is not supported: the HTTP/2 engine is TLS-only. ' +
                'Use https:// with configure({ impersonate }).',
            'ERR_HTTP2_PLAINTEXT_UNSUPPORTED'
        )
    }
    if (hostname === '') invalidUrl(input)

    const bracketed = hostname.startsWith('[')
    const host = bracketed ? hostname.slice(1, -1) : hostname
    const port = portText === undefined ? 443 : Number(portText)
    if (!Number.isFinite(port) || port <= 0 || port > 65535) invalidUrl(input)
    const authority = `${hostname}${port === 443 ? '' : `:${port}`}`
    return { host, port, authority }
}

/** `session.socket` 的门面：node 这里是真实 TLSSocket，本库的 TLS 归会话驱动所有。 */
class Http2SessionSocketFacade extends EventEmitter {
    private readonly _owner: ClientHttp2Session

    constructor(owner: ClientHttp2Session) {
        super()
        this._owner = owner
    }

    get alpnProtocol(): string | undefined {
        return this._owner.alpnProtocol
    }

    get encrypted(): boolean {
        return true
    }

    get remoteAddress(): string | undefined {
        return splitAddress(this._owner._driverAddress('remote')).address
    }

    get remotePort(): number | undefined {
        return splitAddress(this._owner._driverAddress('remote')).port
    }

    get localAddress(): string | undefined {
        return splitAddress(this._owner._driverAddress('local')).address
    }

    get localPort(): number | undefined {
        return splitAddress(this._owner._driverAddress('local')).port
    }

    getProtocol(): string | undefined {
        return this._owner.getProtocol()
    }

    getCipher(): Record<string, any> | undefined {
        return this._owner.getCipher()
    }

    getPeerCertificate(detailed?: boolean): Record<string, any> | undefined {
        return this._owner.getPeerCertificate(detailed)
    }

    getEphemeralKeyInfo(): Record<string, any> | null {
        return this._owner.getEphemeralKeyInfo()
    }

    getSharedSigalgs(): string[] {
        return this._owner.getSharedSigalgs()
    }

    isSessionReused(): boolean {
        return this._owner.isSessionReused()
    }

    exportKeyingMaterial(length: number, label: string, context?: Buffer): Buffer {
        return this._owner.exportKeyingMaterial(length, label, context)
    }

    setTimeout(msecs: number, callback?: () => void): this {
        this._owner.setTimeout(msecs, callback)
        return this
    }

    ref(): this {
        this._owner.ref()
        return this
    }

    unref(): this {
        this._owner.unref()
        return this
    }

    destroy(): this {
        this._owner.destroy()
        return this
    }
}

export interface Http2ConnectOptions extends Http2Settings {
    ca?: any
    cert?: any
    key?: any
    pfx?: any
    passphrase?: string
    rejectUnauthorized?: boolean
    servername?: string
    impersonate?: boolean | 'chrome'
    profile?: string
    keylog?: boolean
    /** 本库扩展：与 https 的 Agent 同一套代理语义。 */
    proxy?: string
    proxyTls?: any
    session?: any
    createConnection?: any
    lookup?: any
    checkServerIdentity?: any
    settings?: Http2Settings
}

class ClientHttp2Session extends EventEmitter {
    public readonly type = constants.NGHTTP2_SESSION_CLIENT as number
    /** node 在 connect 前是 `{}`；本库没有对端 SETTINGS 暴露，连接后也保持 `{}`（已登记）。 */
    public readonly state: Record<string, any> = {}
    public readonly socket: Http2SessionSocketFacade
    public readonly localSettings: Http2Settings = defaultSettings()
    public remoteSettings: Http2Settings = {}
    public alpnProtocol?: string
    public connecting = true
    public closed = false
    public destroyed = false
    public pendingSettingsAck = false

    public readonly authority: string
    private readonly _session: Http2Session
    private readonly _streams = new Set<ClientHttp2Stream>()
    private _draining = false
    private _closing = false
    private _timeoutMs = 0
    private _timer?: ReturnType<typeof setTimeout>
    private readonly _pings = new Map<number, (error: Error | null, duration: number, payload: Buffer) => void>()
    private _nextPing = 1

    constructor(authority: string | URL, options: Http2ConnectOptions = {}) {
        super()

        if (options.createConnection !== undefined || options.lookup !== undefined) {
            throw errWithCode(
                'http2.connect(): createConnection/lookup cannot be used — the HTTP/2 transport ' +
                    'is owned by the native engine',
                'ERR_NOT_SUPPORTED'
            )
        }
        if (options.checkServerIdentity !== undefined) {
            throw errWithCode(
                'http2.connect(): checkServerIdentity cannot be used in HTTP/2 mode ' +
                    '(the JS callback cannot reach the native handshake)',
                'ERR_NOT_SUPPORTED'
            )
        }
        if (options.settings !== undefined) {
            throw errWithCode(
                'http2.connect(): local SETTINGS are profile-driven in this runtime and cannot ' +
                    'be overridden per session',
                'ERR_NOT_SUPPORTED'
            )
        }
        if (options.session !== undefined) {
            throw errWithCode(
                'http2.connect(): TLS session injection is not supported by the HTTP/2 engine',
                'ERR_NOT_SUPPORTED'
            )
        }

        const target = parseAuthority(authority)
        this.authority = target.authority

        const serverName = options.servername || target.host
        const impersonation = buildImpersonationConnectOptions(
            undefined,
            options as any,
            target.host,
            getImpersonationConfig(),
            lookupProfile,
            isImpersonationAvailable()
        )
        if (!impersonation) {
            throw errWithCode(
                "node:http2 requires configure({ impersonate: 'chrome' }): the HTTP/2 engine is " +
                    'the impersonated BoringSSL transport',
                'ERR_IMPERSONATION_UNAVAILABLE'
            )
        }
        if (impersonation.forceHttp1) {
            throw errWithCode(
                'http2.connect(): forceHttp1 cannot be used with the HTTP/2 module',
                'ERR_INVALID_ARG_VALUE'
            )
        }
        if (!isHttp2Available()) {
            throw errWithCode(
                'the HTTP/2 engine is not available in this native build',
                'ERR_HTTP2_UNAVAILABLE'
            )
        }

        this._session = new Http2Session()
        this.socket = new Http2SessionSocketFacade(this)
        if (this._session.destroyed) {
            this.destroyed = true
            throw errWithCode(
                'the HTTP/2 engine is not available in this native build',
                'ERR_HTTP2_UNAVAILABLE'
            )
        }
        this._wireSession()

        let proxy: ParsedProxy | undefined
        if (options.proxy) {
            proxy = parseProxy(options.proxy)
        }

        try {
            this._session.connect({
                host: target.host,
                port: target.port,
                serverName,
                profileJson: JSON.stringify(impersonation.profileData),
                optionsJson: serializeProfileTlsOptions(options, impersonation),
                proxyJson: serializeProfileProxy(proxy, options.proxyTls),
            })
        } catch (error) {
            this.destroy(error as Error)
        }
    }

    private _wireSession(): void {
        this._session.on('ready', () => {
            this.connecting = false
            this.alpnProtocol = this._session.alpnProtocol
            this._refreshTimeout()
            this.emit('connect')
        })
        this._session.on('error', (error: Error) => {
            // 会话级错误：node 先发 'error'，随后 'close'。
            this.emit('error', error)
        })
        this._session.on('goaway', (payload: any) => {
            this._draining = true
            const code = GOAWAY_CODES[String(payload && payload.code)]
            this.emit(
                'goaway',
                code,
                undefined, // lastStreamID：原生没有透出，登记为 undefined
                Buffer.alloc(0)
            )
        })
        this._session.on('close', () => this._onClosed())
        this._session.on('keylog', (line: Buffer) => this.emit('keylog', line))
        this._session.on('ping', (payload: { id: number; rttMs: number }) => {
            const callback = this._pings.get(Number(payload.id))
            if (!callback) return
            this._pings.delete(Number(payload.id))
            callback(null, Number(payload.rttMs), Buffer.alloc(0))
        })
    }

    private _flushPings(error: Error): void {
        for (const callback of Array.from(this._pings.values())) {
            callback(error, 0, Buffer.alloc(0))
        }
        this._pings.clear()
    }

    private _onClosed(): void {
        if (this.destroyed) return
        this.destroyed = true
        this.closed = true
        this.connecting = false
        this._clearTimeout()
        for (const stream of Array.from(this._streams)) {
            stream._onSessionClosed()
        }
        this._streams.clear()
        this._flushPings(errWithCode('The session has been closed', 'ERR_HTTP2_SESSION_CLOSED'))
        this.socket.emit('close')
        this.emit('close')
    }

    /** @internal 流在本地关闭时回报。 */
    _releaseStream(stream: ClientHttp2Stream): void {
        this._streams.delete(stream)
        if (this._closing && this._streams.size === 0 && !this.destroyed) {
            this.destroy()
        }
    }

    request(headers: Record<string, any>, options: any = {}): ClientHttp2Stream {
        if (this.destroyed) {
            throw errWithCode('The session has been destroyed', 'ERR_HTTP2_INVALID_SESSION')
        }
        if (this._draining) {
            throw errWithCode(
                'New streams cannot be created after receiving a GOAWAY',
                'ERR_HTTP2_GOAWAY_SESSION'
            )
        }
        const prepared = prepareFacadeHeaders(headers, { authority: this.authority })
        const stream = new ClientHttp2Stream(this, prepared, options)
        if (!stream.destroyed) this._streams.add(stream)
        this._refreshTimeout()
        return stream
    }

    /** @internal 原生会话上的 request（流构造时调用）。 */
    _sendRequest(
        json: string,
        handlers: Parameters<Http2Session['request']>[1]
    ): number {
        if (this.destroyed) {
            throw errWithCode('The session has been destroyed', 'ERR_HTTP2_INVALID_SESSION')
        }
        return this._session.request(json, handlers)
    }

    /** @internal */
    _writeRequest(requestId: number, chunk: Uint8Array): boolean {
        return this._session.write(requestId, chunk)
    }

    /** @internal */
    _endRequest(requestId: number): void {
        if (!this.destroyed) this._session.end(requestId)
    }

    /** @internal */
    _abortRequest(requestId: number): void {
        if (!this.destroyed) this._session.abort(requestId)
    }

    /** @internal */
    _driverAddress(kind: 'local' | 'remote'): string {
        try {
            return kind === 'local'
                ? this._session.getLocalAddress()
                : this._session.getRemoteAddress()
        } catch {
            return ''
        }
    }

    public close(callback?: () => void): this {
        if (callback) this.once('close', callback)
        if (this.destroyed) return this
        this._closing = true
        this._draining = true
        // 原生暂不发送 GOAWAY（登记）；等本地流结束再销毁会话。
        if (this._streams.size === 0) this.destroy()
        return this
    }

    public destroy(error?: Error): this {
        if (this.destroyed) return this
        // 先退出 closing 状态：流的 _destroy 会走 _releaseStream，避免它反过来再调
        // 一次 destroy。
        this._closing = false
        this._draining = true
        if (error) this.emit('error', error)
        for (const stream of Array.from(this._streams)) {
            stream._onSessionClosed()
        }
        this._streams.clear()
        // 原生 close 事件会把 destroyed/closed 置位并发出 'close'；若原生会话早已
        // 销毁（不会再发事件），这里兜底。
        this._session.destroy()
        if (!this.destroyed) this._onClosed()
        return this
    }

    public setTimeout(msecs: number, callback?: () => void): this {
        this._timeoutMs = Number.isFinite(msecs) && msecs > 0 ? msecs : 0
        if (callback) this.once('timeout', callback)
        this._refreshTimeout()
        return this
    }

    /** @internal 每次收/发都重置（node 的 session 超时是 socket 级空闲）。 */
    _refreshTimeout(): void {
        this._clearTimeout()
        if (this._timeoutMs <= 0 || this.destroyed) return
        this._timer = setTimeout(() => {
            this._timer = undefined
            if (!this.destroyed) this.emit('timeout')
        }, this._timeoutMs)
    }

    private _clearTimeout(): void {
        if (this._timer !== undefined) {
            clearTimeout(this._timer as any)
            this._timer = undefined
        }
    }

    public ref(): this {
        this._session.ref()
        return this
    }

    public unref(): this {
        this._session.unref()
        return this
    }

    /**
     * P5：PING。node 的语义：最多 10 个在途（`maxOutstandingPings`），超了返回 false；
     * 回调 `(err, duration, payload)`。crate 不暴露对端 payload，payload 恒为空 Buffer。
     */
    public ping(
        callback?: (err: Error | null, duration: number, payload: Buffer) => void
    ): boolean {
        if (this.destroyed) {
            throw errWithCode('The session has been destroyed', 'ERR_HTTP2_INVALID_SESSION')
        }
        if (this._pings.size >= 10) return false
        const id = this._nextPing++
        if (callback) this._pings.set(id, callback)
        let ok = false
        try {
            ok = this._session.ping(id)
        } catch {
            ok = false
        }
        if (!ok) {
            this._pings.delete(id)
            return false
        }
        return true
    }

    public settings(_settings: Http2Settings, _callback?: () => void): void {
        throw errWithCode(
            'http2session.settings() is not supported: local SETTINGS are profile-driven',
            'ERR_NOT_SUPPORTED'
        )
    }

    public getProtocol(): string | undefined {
        try {
            const protocol = this._session.getProtocol()
            return protocol ? normalizeProtocolVersion(protocol) : undefined
        } catch {
            return undefined
        }
    }

    public getCipher(): Record<string, any> | undefined {
        try {
            return this._session.getCipher()
        } catch {
            return undefined
        }
    }

    public getPeerCertificate(detailed?: boolean): Record<string, any> | undefined {
        try {
            return this._session.getPeerCertificate(detailed)
        } catch {
            return undefined
        }
    }

    public getEphemeralKeyInfo(): Record<string, any> | null {
        try {
            return this._session.getEphemeralKeyInfo()
        } catch {
            return null
        }
    }

    public getSharedSigalgs(): string[] {
        try {
            return this._session.getSharedSigalgs()
        } catch {
            return []
        }
    }

    public isSessionReused(): boolean {
        try {
            return this._session.isSessionReused()
        } catch {
            return false
        }
    }

    public exportKeyingMaterial(length: number, label: string, context?: Buffer): Buffer {
        return this._session.exportKeyingMaterial(length, label, context)
    }
}

class ClientHttp2Stream extends Duplex {
    public readonly session: ClientHttp2Session
    public readonly state: Record<string, any> = {}
    /** 本库的 requestId；不是协议流 id（已登记）。 */
    public id: number | undefined
    public pending = true
    public rstCode = 0
    // ⚠️ 不要声明/赋值 `closed`：readable-stream 在原型上把它定义成只读 getter
    // （运行时赋值会 "no setter for property"，类型上也与 property 冲突）。
    // 它的语义（销毁/结束时为 true）正好是门面需要的，直接读基类那份。

    public endAfterHeaders = false
    public sentHeaders: Record<string, any>

    private _requestId = 0
    private readonly _endStreamSent: boolean
    private _writeCallback?: (error?: Error | null) => void
    private _finishedNormally = false
    private _closedByUser = false
    private _abortedEmitted = false

    constructor(session: ClientHttp2Session, request: FacadeRequestHeaders, options: any) {
        super({ allowHalfOpen: false })

        this.session = session
        this._endStreamSent = options?.endStream === true
        this.sentHeaders = {
            ':path': request.path,
            ':method': request.method,
            ':authority': request.authority,
            ':scheme': request.scheme,
        }
        for (const [name, value] of request.headers) {
            const current = this.sentHeaders[name]
            if (current === undefined) this.sentHeaders[name] = value
            else if (Array.isArray(current)) current.push(value)
            else this.sentHeaders[name] = [current, value]
        }

        const json = JSON.stringify({
            method: request.method,
            scheme: request.scheme,
            authority: request.authority,
            path: request.path,
            headers: request.headers,
            endStream: this._endStreamSent,
        })

        try {
            this._requestId = session._sendRequest(json, {
                onHeaders: (payload) => {
                    session._refreshTimeout()
                    const headers = headersToObject(payload.status, payload.headers)
                    this.pending = false
                    this.emit('response', headers)
                },
                onData: (chunk) => {
                    session._refreshTimeout()
                    this.push(chunk)
                },
                onTrailers: (pairs) => {
                    this.emit('trailers', headersToObject(undefined, pairs))
                },
                onEnd: () => {
                    this._finishedNormally = true
                    this.pending = false
                    if (!this.writableEnded) this.end()
                    this.push(null)
                },
                onError: (error) => {
                    this.pending = false
                    this.destroy(error as Error)
                },
                onDrain: () => {
                    const callback = this._writeCallback
                    this._writeCallback = undefined
                    if (callback) callback()
                },
            })
            this.id = this._requestId
        } catch (error) {
            this.pending = false
            setTimeout(() => this.destroy(error as Error), 0)
        }

        if (this._endStreamSent) {
            // 请求已带 END_STREAM：本地可写侧直接收尾（_final 会跳过重复的 native end）。
            this.end()
        }
    }

    _read(): void {
        // 数据由原生 session 的 onData push 进来。
    }

    _write(chunk: any, encoding: any, callback: (error?: Error | null) => void): void {
        if (this.closed || this.destroyed) {
            callback(errWithCode('The stream has been destroyed', 'ERR_HTTP2_INVALID_STREAM'))
            return
        }
        const buffer = typeof chunk === 'string' ? Buffer.from(chunk, encoding) : chunk
        this.session._refreshTimeout()
        let ok = true
        try {
            ok = this.session._writeRequest(this._requestId, buffer)
        } catch (error) {
            callback(error as Error)
            return
        }
        this.pending = false
        if (ok) {
            callback()
        } else {
            this._writeCallback = callback
        }
    }

    _final(callback: (error?: Error | null) => void): void {
        if (!this._endStreamSent && !this._finishedNormally && !this.closed && !this.destroyed) {
            try {
                this.session._endRequest(this._requestId)
            } catch (error) {
                callback(error as Error)
                return
            }
        }
        this.pending = false
        callback()
    }

    _destroy(error: Error | null, callback: (error: Error | null) => void): void {
        if (!this._finishedNormally && !this._closedByUser && this._requestId) {
            // 正常结束不额外发 RST；中途销毁才 abort 当前流。
            try {
                this.session._abortRequest(this._requestId)
            } catch {
                // 会话已经没了
            }
        }
        if (!this._finishedNormally && !this._abortedEmitted) {
            this._abortedEmitted = true
            this.emit('aborted')
        }
        this.pending = false
        this.session._releaseStream(this)
        callback(error)
    }

    /** @internal 会话关闭时由门面回调。 */
    _onSessionClosed(): void {
        if (this.destroyed) return
        this.destroy(errWithCode('The session has been closed', 'ERR_HTTP2_SESSION_CLOSED'))
    }

    public close(code: number = 0, callback?: () => void): void {
        if (callback) this.once('close', callback)
        if (this.destroyed) return
        this.rstCode = Number.isFinite(code) ? code : 0
        this._closedByUser = true
        if (this._requestId) {
            try {
                this.session._abortRequest(this._requestId)
            } catch {
                // 会话已经没了
            }
        }
        this.destroy()
    }

    public setTimeout(msecs: number, callback?: () => void): this {
        // 流级超时与 node 一样是空闲语义；直接用会话的空闲计时器。
        this.session.setTimeout(msecs, callback)
        return this
    }

    public priority(): this {
        return this
    }

    public additionalHeaders(): never {
        throw errWithCode(
            'stream.additionalHeaders() is not supported: the engine cannot send a HEADERS ' +
                'block that does not end the stream',
            'ERR_NOT_SUPPORTED'
        )
    }

    public respond(): never {
        throw errWithCode(
            'The ClientHttp2Stream is not writable in the respond() sense',
            'ERR_HTTP2_INVALID_STREAM'
        )
    }

    public pushStream(): never {
        throw errWithCode(
            'stream.pushStream() is not supported by this runtime',
            'ERR_NOT_SUPPORTED'
        )
    }
}


// ========== 服务端（M5-3 P3：h2c；P4 接 createSecureServer） ==========

class Http2ServerSessionSocket extends EventEmitter {
    private readonly _owner: Http2ServerSession

    constructor(owner: Http2ServerSession) {
        super()
        this._owner = owner
    }

    get alpnProtocol(): string | undefined {
        return this._owner.alpnProtocol
    }

    get encrypted(): boolean {
        return this._owner.encrypted
    }

    get remoteAddress(): string | undefined {
        return splitAddress(this._owner._driverAddress('remote')).address
    }

    get remotePort(): number | undefined {
        return splitAddress(this._owner._driverAddress('remote')).port
    }

    get localAddress(): string | undefined {
        return splitAddress(this._owner._driverAddress('local')).address
    }

    get localPort(): number | undefined {
        return splitAddress(this._owner._driverAddress('local')).port
    }

    getProtocol(): string | undefined {
        const protocol = this._owner.getProtocol()
        return protocol ? normalizeProtocolVersion(protocol) : undefined
    }

    getCipher(): Record<string, any> | undefined {
        return this._owner.getCipher()
    }

    getPeerCertificate(detailed?: boolean): Record<string, any> | undefined {
        return this._owner.getPeerCertificate(detailed)
    }

    isSessionReused(): boolean {
        return this._owner.isSessionReused()
    }

    /** node 的 `socket.authorized`：客户端证书是否验过（`requestCert` 未开时恒 false）。 */
    get authorized(): boolean {
        return this._owner.isAuthorized()
    }

    destroy(): this {
        this._owner.destroy()
        return this
    }
}

/** 服务端 session：HEADERS/DATA/END 是请求，respond/write/end 是响应。 */
class Http2ServerSession extends EventEmitter {
    public readonly type = constants.NGHTTP2_SESSION_SERVER as number
    public readonly id: number
    public readonly state: Record<string, any> = {}
    public readonly localSettings: Http2Settings = defaultSettings()
    public readonly remoteSettings: Http2Settings = {}
    public readonly socket: Http2ServerSessionSocket
    public alpnProtocol?: string
    public encrypted = false
    public destroyed = false

    private readonly _driver: Http2ServerSessionDriver
    private readonly _streams = new Map<number, ServerHttp2Stream>()
    private readonly _pings = new Map<number, (error: Error | null, duration: number, payload: Buffer) => void>()
    private _nextPing = 1

    constructor(driver: Http2ServerSessionDriver) {
        super()
        this._driver = driver
        this.id = Number(driver.id)
        // node 实测：h2c 两侧的 alpnProtocol 都是 "h2c"、encrypted 为 false。
        // 原生 meta 对 h2c 没有 ALPN，所以这里补形状；TLS 分支天然是 "h2".
        this.alpnProtocol = driver.getALPN?.() ?? 'h2c'
        this.encrypted = !!driver.getProtocol?.()
        this.socket = new Http2ServerSessionSocket(this)
        driver.onEvent = (event, data) => this._onEvent(event, data)
    }

    private _onEvent(event: number, payload: ArrayBuffer): void {
        try {
            switch (event) {
                case Http2SessionEvent.HEADERS: {
                    const parsed = parseJson(payload)
                    if (!parsed) return
                    const stream = new ServerHttp2Stream(
                        this,
                        Number(parsed.requestId),
                        parsed.endStream === true
                    )
                    this._streams.set(stream._requestId, stream)
                    const headers = headersToObject(undefined, parsed.headers || [])
                    this.emit('stream', stream, headers)
                    if (parsed.endStream === true) stream._endRequest()
                    return
                }
                case Http2SessionEvent.DATA: {
                    const view = new DataView(payload)
                    if (view.byteLength < 4) return
                    const requestId = view.getUint32(0, false)
                    this._streams.get(requestId)?._pushRequestData(new Uint8Array(payload, 4))
                    return
                }
                case Http2SessionEvent.TRAILERS: {
                    const parsed = parseJson(payload)
                    if (!parsed) return
                    const stream = this._streams.get(Number(parsed.requestId))
                    stream?.emit('trailers', headersToObject(undefined, parsed.headers || []))
                    return
                }
                case Http2SessionEvent.END: {
                    const view = new DataView(payload)
                    if (view.byteLength < 4) return
                    this._streams.get(view.getUint32(0, false))?._endRequest()
                    return
                }
                case Http2SessionEvent.ERROR: {
                    const parsed = parseJson(payload)
                    if (!parsed) return
                    const error = errWithCode(String(parsed.message), String(parsed.code))
                    if (parsed.requestId !== undefined && parsed.requestId !== null) {
                        this._streams.get(Number(parsed.requestId))?._onError(error)
                    } else {
                        this.emit('error', error)
                    }
                    return
                }
                case Http2SessionEvent.GOAWAY: {
                    const parsed = parseJson(payload)
                    this.emit(
                        'goaway',
                        GOAWAY_CODES[String(parsed && parsed.code)],
                        undefined,
                        Buffer.alloc(0)
                    )
                    return
                }
                case Http2SessionEvent.PING: {
                    const parsed = parseJson(payload)
                    if (!parsed) return
                    const callback = this._pings.get(Number(parsed.id))
                    if (!callback) return
                    this._pings.delete(Number(parsed.id))
                    callback(null, Number(parsed.rttMs), Buffer.alloc(0))
                    return
                }
                case Http2SessionEvent.DRAIN: {
                    // 服务端 DRAIN 是会话级的（空载荷）：命令队列有空间了，恢复被挡住的写入。
                    for (const stream of this._streams.values()) stream._onDrain()
                    return
                }
                case Http2SessionEvent.CLOSE: {
                    this._onClosed()
                    return
                }
                default:
                    return
            }
        } catch (error) {
            this.emit('error', error as Error)
        }
    }

    /** P5：与客户端同一套 PING 语义（crate 不暴露对端 payload）。 */
    public ping(
        callback?: (err: Error | null, duration: number, payload: Buffer) => void
    ): boolean {
        if (this.destroyed) {
            throw errWithCode('The session has been destroyed', 'ERR_HTTP2_INVALID_SESSION')
        }
        if (this._pings.size >= 10) return false
        const id = this._nextPing++
        if (callback) this._pings.set(id, callback)
        let ok = false
        try {
            ok = this._driver.ping(id)
        } catch {
            ok = false
        }
        if (!ok) {
            this._pings.delete(id)
            return false
        }
        return true
    }

    /** 优雅关闭：向对端发 GOAWAY，在途流继续。 */
    public close(): void {
        if (!this.destroyed) this._driver.close()
    }

    public destroy(error?: Error): void {
        if (this.destroyed) return
        this.destroyed = true
        if (error) this.emit('error', error)
        for (const stream of Array.from(this._streams.values())) stream.destroy(error)
        this._streams.clear()
        this._driver.destroy()
        this._onClosed()
    }

    private _onClosed(): void {
        if (!this.destroyed) {
            this.destroyed = true
            for (const stream of Array.from(this._streams.values())) stream.destroy()
            this._streams.clear()
            for (const callback of Array.from(this._pings.values())) {
                callback(errWithCode('The session has been closed', 'ERR_HTTP2_SESSION_CLOSED'), 0, Buffer.alloc(0))
            }
            this._pings.clear()
            this.socket.emit('close')
            this.emit('close')
        }
    }

    /** @internal 流结束时回报（按 requestId 摘除）。 */
    _releaseStream(stream: ServerHttp2Stream): void {
        this._streams.delete(stream._requestId)
    }

    /** @internal */
    _driverAddress(kind: 'local' | 'remote'): string {
        try {
            return kind === 'local'
                ? this._driver.getLocalAddress()
                : this._driver.getRemoteAddress()
        } catch {
            return ''
        }
    }

    getProtocol(): string | undefined {
        try {
            return this._driver.getProtocol()
        } catch {
            return undefined
        }
    }

    getCipher(): Record<string, any> | undefined {
        try {
            const name = this._driver.getCipher()
            if (!name) return undefined
            return {
                name,
                standardName: this._driver.getCipherStandardName() || name,
                version: normalizeProtocolVersion(this._driver.getProtocol()) || 'Unknown',
            }
        } catch {
            return undefined
        }
    }

    getPeerCertificate(detailed?: boolean): Record<string, any> | undefined {
        try {
            const json = this._driver.getPeerCertificateJSON()
            if (!json) return {}
            return decodePeerCertificateChain(
                json,
                (value: string) => Buffer.from(value, 'base64'),
                !!detailed,
                true
            )
        } catch {
            return {}
        }
    }

    isSessionReused(): boolean {
        try {
            return this._driver.isSessionReused()
        } catch {
            return false
        }
    }

    isAuthorized(): boolean {
        try {
            return this._driver.isAuthorized() === true
        } catch {
            return false
        }
    }
}

/**
 * 服务端流：可读侧是**请求体**，可写侧是**响应体**（与 node 的 ServerHttp2Stream 同向）。
 *
 * ⚠️ `allowHalfOpen: true` 是承重的：请求体结束不代表响应结束；false 会让请求 EOF 时
 * 自动结束响应（客户端收到一个空 body）。
 */
class ServerHttp2Stream extends Duplex {
    public readonly session: Http2ServerSession
    public readonly id: number
    public rstCode = 0

    public readonly _requestId: number
    private _responded = false
    private _responseEnded = false
    private _waitForTrailers = false
    private _pendingWrite?: {
        buffer: Uint8Array
        callback: (error?: Error | null) => void
    }
    private _requestEnded = false
    private _abortedEmitted = false

    constructor(session: Http2ServerSession, requestId: number, endStream: boolean) {
        super({ allowHalfOpen: true })
        this.session = session
        this._requestId = requestId
        this.id = requestId
        this._requestEnded = endStream
    }

    _read(): void {}

    _write(chunk: any, encoding: any, callback: (error?: Error | null) => void): void {
        this._ensureResponded()
        const buffer = typeof chunk === 'string' ? Buffer.from(chunk, encoding) : chunk
        this._writeResponse(buffer, callback)
    }

    /**
     * 命令通道是有限队列；`write()` 返回 false 时**不丢字节**，挂起这段写入等会话级的
     * DRAIN 事件（原生命令循环排空后发）再重试。
     */
    private _writeResponse(buffer: any, callback: (error?: Error | null) => void): void {
        // Nitro 的 ArrayBuffer 参数要的是真 ArrayBuffer；Nitro Buffer 是视图/包装对象，
        // 直接传会变成 null（实测 data=0x0 size=0）。与 Http2Session.write 同款：拷一份。
        const view = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
        const copy = new Uint8Array(view.byteLength)
        copy.set(view)
        let ok = false
        try {
            ok = this.session['_driver'].write(this._requestId, copy.buffer as ArrayBuffer)
        } catch (error) {
            callback(error as Error)
            return
        }
        if (ok) {
            this._pendingWrite = undefined
            callback()
        } else {
            this._pendingWrite = { buffer: copy, callback }
        }
    }

    /** @internal 会话 DRAIN：命令队列有空位了，重试被挡住的那段响应体。 */
    _onDrain(): void {
        const pending = this._pendingWrite
        if (!pending) return
        this._pendingWrite = undefined
        this._writeResponse(pending.buffer, pending.callback)
    }

    _final(callback: (error?: Error | null) => void): void {
        this._ensureResponded()
        if (this._waitForTrailers && !this.destroyed) {
            // node 的形态：respond(waitForTrailers) 之后 end() 不结束响应，由
            // 'wantTrailers' 的监听者调用 sendTrailers() 补最后一块 HEADERS + END_STREAM。
            this.emit('wantTrailers')
            callback()
            return
        }
        if (!this._responseEnded && !this.destroyed) {
            this._responseEnded = true
            this.session['_driver'].end(this._requestId)
        }
        callback()
    }

    _destroy(error: Error | null, callback: (error: Error | null) => void): void {
        if (!this._requestEnded && !this._abortedEmitted) {
            this._abortedEmitted = true
            this.emit('aborted')
        }
        if (!this._responseEnded) {
            try {
                // 把 `close(code)` 的码原样交出去（node v22.11 实测：`close()`/`destroy()`
                // 都发 NO_ERROR(0)，`close(REFUSED_STREAM)` 发 7）。以前原生写死 CANCEL。
                this.session['_driver'].abort(this._requestId, this.rstCode)
            } catch {
                // session 已经没了
            }
        }
        if (this._pendingWrite) {
            const pending = this._pendingWrite
            this._pendingWrite = undefined
            pending.callback(error ?? errWithCode('The stream has been destroyed', 'ERR_HTTP2_INVALID_STREAM'))
        }
        this.session._releaseStream(this)
        callback(error)
    }

    /** @internal 请求体数据。 */
    _pushRequestData(chunk: Uint8Array): void {
        this.push(Buffer.from(chunk))
    }

    /** @internal 请求体结束。 */
    _endRequest(): void {
        if (this._requestEnded) return
        this._requestEnded = true
        this.push(null)
    }

    /** @internal */
    _onError(error: Error): void {
        this.destroy(error)
    }

    public respond(headers: Record<string, any>, options: any = {}): void {
        if (this._responded) {
            throw errWithCode('Headers have already been sent', 'ERR_HTTP2_HEADERS_SENT')
        }
        const pairs = responseHeaderPairs(headers)
        this._responded = true
        this._waitForTrailers = options.waitForTrailers === true
        try {
            this.session['_driver'].respond(this._requestId, JSON.stringify(pairs), options.endStream === true)
        } catch (error) {
            this.destroy(error as Error)
            return
        }
        if (options.endStream === true) {
            this._responseEnded = true
            this.end()
        }
    }

    public sendTrailers(headers: Record<string, any>): void {
        const pairs = responseHeaderPairs(headers, false)
        this._responseEnded = true
        this.session['_driver'].trailers(this._requestId, JSON.stringify(pairs))
    }

    public additionalHeaders(): never {
        throw errWithCode(
            'stream.additionalHeaders() is not supported: the server engine cannot send a HEADERS ' +
                'block that does not end the stream',
            'ERR_NOT_SUPPORTED'
        )
    }

    public pushStream(): never {
        throw errWithCode('stream.pushStream() is not supported by this runtime', 'ERR_NOT_SUPPORTED')
    }

    public close(code: number = 0, callback?: () => void): void {
        if (callback) this.once('close', callback)
        if (this.destroyed) return
        this.rstCode = Number.isFinite(code) ? code : 0
        this.destroy()
    }

    public setTimeout(msecs: number, callback?: () => void): this {
        if (callback) this.once('timeout', callback)
        // v1：服务端流的空闲超时没有原生计时器；保留 API 形状（登记）。
        return this
    }

    private _ensureResponded(): void {
        if (this._responded) return
        this._responded = true
        this.session['_driver'].respond(this._requestId, JSON.stringify([[':status', '200']]), false)
    }
}

/** `respond()`/`sendTrailers()` 的对象 → 线缆 pairs；`:status` 默认 200。 */
function responseHeaderPairs(headers: Record<string, any>, withStatus = true): Array<[string, string]> {
    const pairs: Array<[string, string]> = []
    let hasStatus = false
    for (const rawName of Object.keys(headers || {})) {
        const name = rawName.toLowerCase()
        const value = headers[rawName]
        if (name === ':status') hasStatus = true
        const values = Array.isArray(value) ? value : [value]
        for (const item of values) {
            if (item === undefined) continue
            pairs.push([name, String(item)])
        }
    }
    if (withStatus && !hasStatus) pairs.unshift([':status', '200'])
    return pairs
}

function parseJson(payload: ArrayBuffer): any {
    try {
        return JSON.parse(Buffer.from(payload).toString())
    } catch {
        return undefined
    }
}

/**
 * `http2.createServer()` —— h2c（明文，prior knowledge）。
 *
 * 监听本身还是 `net.Server`；区别只有一处：`listen()` 之前把驱动切到 h2 模式，
 * accept 循环把连接交给原生 h2 引擎，并回一个 `h2session` 事件。
 */
/**
 * 两个服务端类共用的接线：切换 accept 分流模式、把 `h2session` 变成 session 对象、
 * 转发 'stream'，并在有人监听 'request' 时按 node 的兼容层再发一次（h2 流也发）。
 * 实测 node 的顺序是 **'stream' 先、'request' 后**；两边都 respond 会 ERR_HTTP2_HEADERS_SENT。
 */
function attachHttp2Server(owner: any, mode: number): Set<Http2ServerSession> {
    const driver: any = owner._driver
    if (typeof driver?.setHttp2Mode === 'function') driver.setHttp2Mode(mode)
    const sessions = new Set<Http2ServerSession>()
    owner.on('h2session', () => {
        let sessionDriver: Http2ServerSessionDriver
        try {
            sessionDriver = driver.takeHttp2Session()
        } catch (error) {
            owner.emit('error', error as Error)
            return
        }
        const session = new Http2ServerSession(sessionDriver)
        sessions.add(session)
        session.on('close', () => sessions.delete(session))
        session.on('error', (error: Error) => owner.emit('error', error))
        session.on('stream', (stream: ServerHttp2Stream, headers: Record<string, any>) => {
            owner.emit('stream', stream, headers)
            if (owner.listenerCount('request') > 0) {
                const req = new Http2ServerRequest(stream, headers)
                const res = new Http2ServerResponse(stream)
                owner.emit('request', req, res)
            }
        })
        owner.emit('session', session)
    })
    return sessions
}

function closeHttp2Sessions(sessions: Set<Http2ServerSession>): void {
    for (const session of Array.from(sessions)) {
        try {
            session.close()
        } catch {
            // 已经关闭
        }
    }
}

/** `http2.createServer()` —— h2c（明文，prior knowledge）。 */
class Http2Server extends NetServer {
    private readonly _sessions: Set<Http2ServerSession>

    constructor(options: any = {}, streamListener?: (stream: any, headers: any) => void) {
        super(options as any)
        if (streamListener) this.on('stream', streamListener)
        this._sessions = attachHttp2Server(this, 1)
    }

    public close(callback?: (error?: Error) => void): this {
        closeHttp2Sessions(this._sessions)
        return super.close(callback as any) as this
    }
}

/**
 * `http2.createSecureServer()` —— TLS + ALPN。
 *
 * 直接继承 `https.Server`：**h2 连接在原生 accept 层就被分流走了**，不会产生
 * `secureConnection`，所以继承来的 h1 解析器只会看到 `allowHTTP1` 的 http/1.1 连接 ——
 * 这正是 node 的 `Http2SecureServer` 行为（h1 用 IncomingMessage/ServerResponse，
 * h2 用 Http2ServerRequest/Response 的兼容层）。
 */
class Http2SecureServer extends HttpsServer {
    public readonly allowHTTP1: boolean
    private readonly _sessions: Set<Http2ServerSession>

    constructor(options: any = {}, streamListener?: (stream: any, headers: any) => void) {
        const allowHTTP1 = options.allowHTTP1 === true
        // node 的 Http2SecureServer 自己决定 ALPN；调用方给的不参与（我们只覆盖这一项）。
        super({ ...options, ALPNProtocols: allowHTTP1 ? ['h2', 'http/1.1'] : ['h2'] })
        this.allowHTTP1 = allowHTTP1
        if (streamListener) this.on('stream', streamListener)
        this._sessions = attachHttp2Server(this, allowHTTP1 ? 2 : 1)
    }

    public close(callback?: (error?: Error) => void): this {
        closeHttp2Sessions(this._sessions)
        return super.close(callback as any) as this
    }
}

/**
 * node 的 **h2 兼容层**请求对象（`allowHTTP1` 的 h1 分支用的是 IncomingMessage）。
 * 形状按 node v22.12 实测：`headers` 含伪头、`httpVersion='2.0'`、有 `stream`/`socket`/
 * `authority`/`scheme`。
 */
export class Http2ServerRequest extends Readable {
    public readonly stream: ServerHttp2Stream
    public readonly socket: any
    public readonly headers: Record<string, any>
    public readonly rawHeaders: string[]
    public readonly method: string
    public readonly url: string
    public readonly authority: string | undefined
    public readonly scheme: string | undefined
    public readonly httpVersion = '2.0'
    public readonly httpVersionMajor = 2
    public readonly httpVersionMinor = 0
    public aborted = false

    constructor(stream: ServerHttp2Stream, headers: Record<string, any>) {
        super()
        this.stream = stream
        this.socket = (stream as any).session?.socket
        this.headers = headers
        const raw: string[] = []
        for (const name of Object.keys(headers)) {
            const value = headers[name]
            if (Array.isArray(value)) {
                for (const item of value) raw.push(name, String(item))
            } else {
                raw.push(name, String(value))
            }
        }
        this.rawHeaders = raw
        this.method = String(headers[':method'] ?? 'GET')
        this.url = String(headers[':path'] ?? '/')
        this.authority = headers[':authority']
        this.scheme = headers[':scheme']

        stream.on('data', (chunk: any) => {
            // 兼容层与 'stream' 监听是**扇出**（node 实测同样会读走整个 body）。
            //
            // ⚠️ **不能**在这里 `if (!push) stream.pause()`：`stream` 是**共享**的
            // `ServerHttp2Stream`，pause 会把用户自己的 `'data'` 一起停掉；而 `push`
            // 在本 Readable 的 HWM（默认 16384）处就返回 false ⇒ body 恰好 ≥ 16 KiB 时
            // 原生读者被闸住，`'end'` 永远不来（实测 16383 通、16384 挂；node 客户端不受影响）。
            // 代价是这个包装的缓冲不设上限 —— 与 node 的 compat 层同形（它也会读走整个 body）。
            this.push(chunk)
        })
        stream.on('end', () => this.push(null))
        stream.on('error', (error: Error) => this.destroy(error))
    }

    _read(): void {
        this.stream.resume()
    }
}

/** node 的 **h2 兼容层**响应对象：writeHead/end 映射到 `stream.respond()`/`stream.end()`。 */
export class Http2ServerResponse extends Writable {
    public statusCode = 200
    public statusMessage = ''
    public headersSent = false
    public readonly stream: ServerHttp2Stream
    public readonly socket: any

    private readonly _headers: Record<string, any> = {}

    constructor(stream: ServerHttp2Stream) {
        super()
        this.stream = stream
        this.socket = (stream as any).session?.socket
    }

    setHeader(name: string, value: any): this {
        this._assertHeadersNotSent()
        this._headers[String(name).toLowerCase()] = value
        return this
    }

    getHeader(name: string): any {
        return this._headers[String(name).toLowerCase()]
    }

    getHeaders(): Record<string, any> {
        return { ...this._headers }
    }

    removeHeader(name: string): void {
        this._assertHeadersNotSent()
        delete this._headers[String(name).toLowerCase()]
    }

    writeHead(statusCode: number, statusMessage?: any, headers?: any): this {
        this._assertHeadersNotSent()
        if (statusMessage && typeof statusMessage === 'object') {
            headers = statusMessage
            statusMessage = ''
        }
        this.statusCode = statusCode
        if (typeof statusMessage === 'string' && statusMessage) this.statusMessage = statusMessage
        for (const name of Object.keys(headers || {})) {
            this._headers[name.toLowerCase()] = headers[name]
        }
        return this
    }

    _write(chunk: any, encoding: any, callback: (error?: Error | null) => void): void {
        this._ensureHeaders()
        this.stream.write(chunk, encoding, callback)
    }

    _final(callback: (error?: Error | null) => void): void {
        this._ensureHeaders()
        this.stream.end(callback)
    }

    private _ensureHeaders(): void {
        if (this.headersSent) return
        const headers: Record<string, any> = { ':status': this.statusCode, ...this._headers }
        this.headersSent = true
        this.stream.respond(headers)
    }

    private _assertHeadersNotSent(): void {
        if (this.headersSent) {
            throw errWithCode('Headers have already been sent', 'ERR_HTTP2_HEADERS_SENT')
        }
    }
}

// ========== 纯函数与顶层导出 ==========

export function getDefaultSettings(): Http2Settings {
    return defaultSettings()
}

export function getPackedSettings(settings?: Http2Settings): Buffer {
    return Buffer.from(packSettings(settings))
}

export function getUnpackedSettings(buf: any, options?: { validate?: boolean }): Http2Settings {
    return unpackSettings(buf, options)
}

function serverUnsupported(what: string): never {
    throw errWithCode(
        `${what} is not implemented yet: the native h2 server engine lands in ` +
            'docs/m5_http2_module_plan.md P3/P4',
        'ERR_NOT_SUPPORTED'
    )
}

export function connect(authority: string | URL, options?: Http2ConnectOptions): ClientHttp2Session {
    return new ClientHttp2Session(authority, options)
}

export function createServer(
    options?: any,
    onStream?: (stream: any, headers: any) => void
): NetServer {
    if (typeof options === 'function') {
        onStream = options
        options = {}
    }
    const opts = options || {}
    if (opts.settings !== undefined) {
        throw errWithCode(
            'http2.createServer(): local SETTINGS cannot be overridden in this runtime',
            'ERR_NOT_SUPPORTED'
        )
    }
    if (opts.allowHTTP1) {
        throw errWithCode(
            'http2.createServer(): allowHTTP1 only applies to createSecureServer()',
            'ERR_INVALID_ARG_VALUE'
        )
    }
    if (opts.Http1IncomingMessage || opts.Http1ServerResponse) {
        throw errWithCode(
            'http2.createServer(): custom Http1 message classes are not supported',
            'ERR_INVALID_ARG_VALUE'
        )
    }
    return new Http2Server(opts, onStream)
}

export function createSecureServer(
    options?: any,
    onStream?: (stream: any, headers: any) => void
): NetServer {
    if (typeof options === 'function') {
        onStream = options
        options = {}
    }
    const opts = options || {}
    if (opts.settings !== undefined) {
        throw errWithCode(
            'http2.createSecureServer(): local SETTINGS cannot be overridden in this runtime',
            'ERR_NOT_SUPPORTED'
        )
    }
    if (opts.Http1IncomingMessage || opts.Http1ServerResponse) {
        throw errWithCode(
            'http2.createSecureServer(): custom Http1 message classes are not supported',
            'ERR_INVALID_ARG_VALUE'
        )
    }
    return new Http2SecureServer(opts, onStream)
}

export function performServerHandshake(..._args: any[]): never {
    return serverUnsupported('http2.performServerHandshake()')
}

export const sensitiveHeaders = Symbol('sensitiveHeaders')

export { constants }

