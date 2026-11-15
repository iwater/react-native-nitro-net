import { EventEmitter } from './eventEmitterCompat'
import { Buffer } from 'react-native-nitro-buffer'
import { Driver } from './Driver'
import { Http2SessionEvent, type Http2SessionDriver, type NetSocketDriver } from './Net.nitro'
import { debugLog as loggerDebugLog } from './Logger'
import { setHttp2AvailabilityProbe } from './profiles/registry'
import { LoopRef } from './loopRef'
import { decodePeerCertificateChain } from './peerCertificate'
import { normalizeProtocolVersion } from './tls'

function debugLog(message: string | (() => string)) {
    loggerDebugLog('HTTP2', message)
}

let nativeInitialized = false

/**
 * H2 session 不经过 net.Socket，需要自己安装事件 dispatcher；否则原生事件
 * 没有投递通道会被静默丢弃。原生 runtime/callback 由 setOnEvent 时的
 * NetManager::registerHandler 惰性初始化（幂等），这里不再重复 initWithConfig
 * ——那会在用户已配置 workerThreads 时打出「requested 0 ignored」警告。
 */
function ensureNativeInitialized(): void {
    if (nativeInitialized) return
    nativeInitialized = true
    try {
        ;(Driver as any).installDispatcher?.()
    } catch {
        // 初始化失败会在 connect 时以结构化错误上报
    }
}

// 未编译 feature 或引擎缺失时返回 false（方法不存在也不抛）
setHttp2AvailabilityProbe(() => {
    try {
        return !!(Driver as any).http2Available?.()
    } catch {
        return false
    }
})

export class Http2SessionError extends Error {
    public code: string
    public requestId?: number

    constructor(code: string, message: string, requestId?: number) {
        super(message)
        this.name = 'Http2SessionError'
        this.code = code
        this.requestId = requestId
    }
}

export interface Http2ResponseHeaders {
    status: number
    /** 线缆顺序（含重复项），名称为小写。 */
    headers: Array<[string, string]>
}

export interface Http2RequestHandlers {
    onHeaders(headers: Http2ResponseHeaders): void
    onData(chunk: Buffer): void
    onTrailers(headers: Array<[string, string]>): void
    onEnd(): void
    onError(error: Http2SessionError): void
    /** native body 缓冲恢复可写；配合 `write()` 返回 false 使用。 */
    onDrain?(): void
}

export interface Http2ConnectOptions {
    host: string
    port: number
    serverName?: string
    profileJson: string
    optionsJson: string
    proxyJson?: string
}

interface HeadersEventPayload {
    requestId: number
    status: number
    headers: Array<[string, string]>
}

interface TrailersEventPayload {
    requestId: number
    headers: Array<[string, string]>
}

interface ErrorEventPayload {
    requestId?: number
    code: string
    message: string
}

interface GoawayEventPayload {
    code: string
    reason?: string
    message: string
}

/**
 * 一个 Nitro H2 对象 = 一条 TLS 连接上的多路复用 session。
 *
 * 事件协议见 docs/m2_implementation_plan.md §3.3：
 * HEADERS/TRAILERS/ERROR 是 JSON，DATA/END 前 4 字节是大端 requestId。
 */
export class Http2Session extends EventEmitter {
    public readonly id: number
    public ready = false
    public destroyed = false
    /** 收到 GOAWAY / 平滑关闭后不再接受新流。 */
    public draining = false
    public alpnProtocol?: string
    public authorizationError?: string
    /**
     * @internal M5-2：ALPN 只答 h1 时收编已握手流要用的 H1 池键（不含 `:h2` 后缀）
     * 与 SNI。由 Agent 在 connect 前注入。
     */
    public h1PoolName?: string
    public servername?: string
    /**
     * @internal M5-2：请求带了 `session`（想用注入的会话完成握手）⇒ **不能**收编
     * ALPN 失败时那条已握手流：连接已经建好，注入的 session 会被静默吞掉。
     */
    public requiresHandshake = false
    /** 空闲销毁时间；0 = 不自动销毁。由 Agent 注入。 */
    public idleTimeout = 0
    private _idleTimer?: ReturnType<typeof setTimeout>
    private _driver: Http2SessionDriver
    private _handlers = new Map<number, Http2RequestHandlers>()
    private _nextRequestId = 1
    private _closeEmitted = false
    private _loopRef = new LoopRef('h2-session')
    /**
     * 用户调过 `unref()`（node：调用后「事件循环可以退出」）。除了放掉 LoopRef，
     * 还必须**停掉空闲销毁定时器** —— 那是普通 JS 定时器，同样顶住无头宿主的事件循环；
     * 不清掉的话 unref 等于白调（实测：`handles=0` 但 `liveTimers=1`，进程照样不退）。
     * `ref()` 时恢复：重新拿 LoopRef 并按需重新武装空闲定时器。
     */
    private _userUnref = false

    constructor(driver?: Http2SessionDriver) {
        super()
        ensureNativeInitialized()
        this._driver = driver ?? Driver.createHttp2Session()
        this.id = this._driver ? Number((this._driver as any).id) : 0
        if (!this._driver || this.id === 0) {
            this.destroyed = true
            return
        }
        this._driver.onEvent = (event: number, data: ArrayBuffer) => {
            this._onEvent(event, data)
        }
    }

    public connect(options: Http2ConnectOptions): void {
        if (this.destroyed) {
            throw new Http2SessionError(
                'ERR_HTTP2_SESSION_CLOSED',
                'http2 session is not available'
            )
        }
        this._loopRef.acquire()
        debugLog(
            () => `connect ${options.host}:${options.port} (sni=${options.serverName ?? options.host})`
        )
        this._driver.connect(
            options.host,
            options.port,
            options.serverName,
            options.profileJson,
            options.optionsJson,
            options.proxyJson
        )
    }

    /** 分配 requestId 并发起请求；返回 id 供 write/end/abort 使用。 */
    public request(requestJson: string, handlers: Http2RequestHandlers): number {
        debugLog(() => `request ${requestJson}`)
        if (this.destroyed || this.draining) {
            throw new Http2SessionError(
                this.draining ? 'ERR_HTTP2_GOAWAY_SESSION' : 'ERR_HTTP2_SESSION_CLOSED',
                this.draining ? 'http2 session is draining after GOAWAY' : 'http2 session is closed'
            )
        }
        const requestId = this._nextRequestId++
        this._loopRef.acquire()
        this._clearIdleTimer()
        this._handlers.set(requestId, handlers)
        this._driver.request(requestId, requestJson)
        return requestId
    }

    public write(requestId: number, data: Uint8Array): boolean {
        const copy = new Uint8Array(data.byteLength)
        copy.set(data)
        return this._driver.write(requestId, copy.buffer)
    }

    public end(requestId: number): void {
        this._driver.end(requestId)
    }

    /**
     * M5-2：ALPN 只答 h1 时，原生是否留下了一条**已握手**的 TLS 流可交还。
     * 只读探针；`takeStream()` 才会把它领走（一次性的，第二条 H1 连接不会重复出现）。
     */
    public canTakeStream(): boolean {
        if (this.destroyed || this.id === 0) return false
        try {
            return !!this._driver.canTakeStream()
        } catch {
            return false
        }
    }

    /**
     * M5-2：领走那条已握手流并包成普通 socket 驱动。不可用时原生抛
     * `ERR_INVALID_STATE`（调用方先问 `canTakeStream()`，抛只是兜底）。
     */
    public takeStream(): NetSocketDriver {
        return this._driver.takeStream()
    }

    /** P5：发 PING；回执走 `'ping'` 事件（`{ id, rttMs }`）。 */
    public ping(pingId: number): boolean {
        if (this.destroyed) return false
        try {
            return this._driver.ping(pingId)
        } catch {
            return false
        }
    }

    /** 发送 trailers 并结束流（请求必须带 streaming body）。 */
    public trailers(requestId: number, headers: Array<[string, string]> | Record<string, string>): void {
        const pairs = Array.isArray(headers) ? headers : Object.entries(headers)
        this._driver.trailers(requestId, JSON.stringify(pairs))
    }

    public abort(requestId: number): void {
        this._handlers.delete(requestId)
        if (!this.destroyed) {
            this._driver.abort(requestId)
        }
        this._maybeIdle()
    }

    /**
     * node `Http2Session.ref()/unref()`：控制这条 session 是否顶住事件循环。
     * 本包的 LoopRef 是单 token 模型（acquire/release 幂等），所以语义正好对得上：
     * `unref()` 放掉 token（即便还有在途流 —— node 的 session.unref() 也是这样，
     * 「不保活」不等于「取消请求」），`ref()` 拿回来。
     */
    public ref(): void {
        if (this.destroyed) return
        this._userUnref = false
        this._loopRef.acquire()
        // 空闲中 ⇒ 恢复空闲销毁定时器。注意不能调 `_maybeIdle()`：它开头就会 release
        // 刚拿到的 token（实测把 ref() 变成无效操作）。
        if (this._handlers.size === 0 && this.idleTimeout > 0) {
            this._clearIdleTimer()
            this._idleTimer = setTimeout(() => {
                this._idleTimer = undefined
                this.destroy()
            }, this.idleTimeout)
        }
    }

    public unref(): void {
        this._userUnref = true
        this._loopRef.release()
        this._clearIdleTimer()
    }

    public get pendingRequests(): number {
        return this._handlers.size
    }

    public destroy(): void {
        if (this.destroyed) return
        this.destroyed = true
        this._clearIdleTimer()
        this._loopRef.release()
        for (const handler of this._handlers.values()) {
            handler.onError(
                new Http2SessionError(
                    'ERR_HTTP2_SESSION_CLOSED',
                    'http2 session was destroyed'
                )
            )
        }
        this._handlers.clear()
        this._driver.destroy()
        this._emitClose()
    }

    public getProtocol(): string | undefined {
        return this._driver?.getProtocol()
    }

    public getCipher(): Record<string, any> | undefined {
        const name = this._driver?.getCipher()
        if (!name) return undefined
        return {
            name,
            standardName: this._driver?.getCipherStandardName() || name,
            version: normalizeProtocolVersion(this._driver?.getProtocol()) || 'Unknown'
        }
    }

    public getEphemeralKeyInfo(): Record<string, any> | null {
        const json = this._driver?.getEphemeralKeyInfo()
        if (!json) return {}
        try {
            const parsed = JSON.parse(json)
            if (parsed === null) return null
            return parsed && typeof parsed === 'object' ? parsed : {}
        } catch (e) {
            return {}
        }
    }

    public getSharedSigalgs(): string[] {
        const json = this._driver?.getSharedSigalgs()
        if (!json) return []
        try {
            const parsed = JSON.parse(json)
            return Array.isArray(parsed) ? parsed : []
        } catch (e) {
            return []
        }
    }

    public exportKeyingMaterial(length: number, label: string, context?: Buffer): Buffer {
        const ctx = context ? (new Uint8Array(context).buffer as ArrayBuffer) : undefined
        const result = this._driver?.exportKeyingMaterial(length, label, ctx)
        if (result) return Buffer.from(result)
        const error: any = new Error('exportKeyingMaterial failed: TLS session may not be established')
        error.code = 'ERR_TLS_EXPORT_KEYING_MATERIAL'
        throw error
    }

    public getPeerCertificate(detailed?: boolean): Record<string, any> | undefined {
        const json = this._driver?.getPeerCertificateJSON()
        if (!json) return undefined
        return decodePeerCertificateChain(
            json,
            (value) => Buffer.from(value, 'base64'),
            !!detailed,
            !this.authorizationError
        )
    }

    public isSessionReused(): boolean {
        return this._driver?.isSessionReused() ?? false
    }

    public getLocalAddress(): string {
        return this._driver?.getLocalAddress() ?? ''
    }

    public getRemoteAddress(): string {
        return this._driver?.getRemoteAddress() ?? ''
    }

    private _onEvent(event: number, payload: ArrayBuffer): void {
        try {
            this._handleEvent(event, payload)
        } catch (error) {
            if (this.listenerCount('error') > 0) {
                this.emit('error', error)
            } else {
                debugLog(() => `event handler failed: ${String(error)}`)
            }
        }
    }

    private _handleEvent(event: number, payload: ArrayBuffer): void {
        switch (event) {
            case Http2SessionEvent.READY: {
                this.ready = true
                this.alpnProtocol = this._driver.getALPN()
                this.authorizationError = this._driver.getAuthorizationError()
                debugLog(() => `ready alpn=${this.alpnProtocol}`)
                this.emit('ready')
                return
            }
            case Http2SessionEvent.HEADERS: {
                const parsed = this._parse<HeadersEventPayload>(payload)
                if (!parsed) return
                this._handlers.get(parsed.requestId)?.onHeaders({
                    status: parsed.status,
                    headers: parsed.headers,
                })
                return
            }
            case Http2SessionEvent.DATA: {
                const view = new DataView(payload)
                if (view.byteLength < 4) return
                const requestId = view.getUint32(0, false)
                const handler = this._handlers.get(requestId)
                if (!handler) return
                handler.onData(Buffer.from(new Uint8Array(payload, 4)))
                return
            }
            case Http2SessionEvent.TRAILERS: {
                const parsed = this._parse<TrailersEventPayload>(payload)
                if (!parsed) return
                this._handlers.get(parsed.requestId)?.onTrailers(parsed.headers)
                return
            }
            case Http2SessionEvent.DRAIN: {
                const view = new DataView(payload)
                if (view.byteLength < 4) return
                const requestId = view.getUint32(0, false)
                this._handlers.get(requestId)?.onDrain?.()
                return
            }
            case Http2SessionEvent.END: {
                const view = new DataView(payload)
                if (view.byteLength < 4) return
                const requestId = view.getUint32(0, false)
                const handler = this._handlers.get(requestId)
                this._handlers.delete(requestId)
                handler?.onEnd()
                this._maybeIdle()
                this.emit('stream-end', requestId)
                return
            }
            case Http2SessionEvent.ERROR: {
                const parsed = this._parse<ErrorEventPayload>(payload)
                if (!parsed) return
                const error = new Http2SessionError(
                    parsed.code,
                    parsed.message,
                    parsed.requestId
                )
                if (parsed.requestId !== undefined) {
                    const handler = this._handlers.get(parsed.requestId)
                    this._handlers.delete(parsed.requestId)
                    handler?.onError(error)
                    this._maybeIdle()
                    this.emit('stream-end', parsed.requestId)
                } else if (this.listenerCount('error') > 0) {
                    this.emit('error', error)
                } else {
                    debugLog(() => `session error (no listener): ${parsed.code} ${parsed.message}`)
                }
                return
            }
            case Http2SessionEvent.GOAWAY: {
                const parsed = this._parse<GoawayEventPayload>(payload)
                this.draining = true
                this.emit('goaway', parsed)
                return
            }
            case Http2SessionEvent.CLOSE: {
                this.destroyed = true
                this._clearIdleTimer()
                this._loopRef.release()
                for (const handler of this._handlers.values()) {
                    handler.onError(
                        new Http2SessionError(
                            'ERR_HTTP2_SESSION_CLOSED',
                            'http2 session closed'
                        )
                    )
                }
                this._handlers.clear()
                this._emitClose()
                return
            }
            case Http2SessionEvent.PING: {
                const parsed = this._parse<{ id: number; rttMs: number }>(payload)
                if (!parsed) return
                this.emit('ping', parsed)
                return
            }
            case Http2SessionEvent.KEYLOG: {
                this.emit('keylog', Buffer.from(payload))
                return
            }
            default:
                debugLog(() => `unhandled session event ${event}`)
        }
    }

    private _parse<T>(payload: ArrayBuffer): T | undefined {
        try {
            return JSON.parse(Buffer.from(payload).toString()) as T
        } catch (error) {
            debugLog(() => `failed to parse session event: ${String(error)}`)
            return undefined
        }
    }

    private _clearIdleTimer(): void {
        if (this._idleTimer !== undefined) {
            clearTimeout(this._idleTimer as any)
            this._idleTimer = undefined
        }
    }

    private _maybeIdle(): void {
        if (this.destroyed || this._handlers.size > 0) return
        // 空闲 session 不顶住无头宿主的事件循环（与 Node 的 unref'd socket 一致）
        this._loopRef.release()
        // 用户显式 unref 过 ⇒ 连空闲销毁定时器也不武装（它同样顶住 loop，见 `_userUnref`）
        if (this._userUnref) return
        if (this.idleTimeout <= 0) return
        this._clearIdleTimer()
        this._idleTimer = setTimeout(() => {
            this._idleTimer = undefined
            this.destroy()
        }, this.idleTimeout)
    }

    private _emitClose(): void {
        if (this._closeEmitted) return
        this._closeEmitted = true
        this.emit('close')
    }
}

function splitAddress(value: string | undefined): { address?: string; port?: number } {
    if (!value) return {}
    const text = value.trim()
    const colon = text.lastIndexOf(':')
    if (colon < 0) return { address: text }
    const host = text.slice(0, colon)
    const port = Number(text.slice(colon + 1))
    return {
        address: host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host,
        port: Number.isFinite(port) ? port : undefined,
    }
}

/**
 * `req.socket` / `res.socket` 在 H2 下的门面。
 *
 * ⚠️ 与设计 §5.4 的差异：`destroy()` 只 **abort 当前流**（RST_STREAM），不关闭整个
 * session —— `IncomingMessage.destroy()` 会调用它，关闭整个 session 会误伤同连接上
 * 其它请求。整个 session 的关闭由 Agent / `Http2Session.destroy()` 负责。
 */
export class Http2SessionSocket extends EventEmitter {
    public readonly remoteFamily = 'IPv4'
    private _session: Http2Session
    private _requestId: number
    private _timer?: ReturnType<typeof setTimeout>
    private _flowControl?: { pause: () => void; resume: () => void }

    constructor(session: Http2Session, requestId: number) {
        super()
        this._session = session
        this._requestId = requestId
    }

    /** @internal 请求真正建立后补上 native requestId。 */
    public setRequestId(requestId: number): void {
        this._requestId = requestId
    }

    public get destroyed(): boolean {
        return this._session.destroyed
    }

    public get remoteAddress(): string | undefined {
        return splitAddress(this._session.getRemoteAddress()).address
    }

    public get remotePort(): number | undefined {
        return splitAddress(this._session.getRemoteAddress()).port
    }

    public get localAddress(): string | undefined {
        return splitAddress(this._session.getLocalAddress()).address
    }

    public get localPort(): number | undefined {
        return splitAddress(this._session.getLocalAddress()).port
    }

    public get alpnProtocol(): string | undefined {
        return this._session.alpnProtocol
    }

    /** 本包扩展：同一条 H2 session 上的请求共享该 id。 */
    public get sessionId(): number {
        return this._session.id
    }

    public get authorized(): boolean {
        return !this._session.authorizationError
    }

    public get authorizationError(): string | undefined {
        return this._session.authorizationError
    }

    public getProtocol(): string | undefined {
        return this._session.getProtocol()
    }

    public getCipher(): Record<string, any> | undefined {
        return this._session.getCipher()
    }

    public getEphemeralKeyInfo(): Record<string, any> | null {
        return this._session.getEphemeralKeyInfo()
    }

    public getSharedSigalgs(): string[] {
        return this._session.getSharedSigalgs()
    }

    public exportKeyingMaterial(length: number, label: string, context?: Buffer): Buffer {
        return this._session.exportKeyingMaterial(length, label, context)
    }

    public getPeerCertificate(detailed?: boolean): Record<string, any> | undefined {
        return this._session.getPeerCertificate(detailed)
    }

    public isSessionReused(): boolean {
        return this._session.isSessionReused()
    }

    public setTimeout(msecs: number, callback?: () => void): this {
        this.clearTimeout()
        if (!Number.isFinite(msecs) || msecs <= 0) return this
        this._timer = setTimeout(() => {
            this._timer = undefined
            if (callback) callback()
            this.emit('timeout')
        }, msecs)
        return this
    }

    public clearTimeout(): void {
        if (this._timer !== undefined) {
            clearTimeout(this._timer as any)
            this._timer = undefined
        }
    }

    public setNoDelay(_enable = true): void {}
    public setKeepAlive(_enable = false, _delay = 0): void {}

    /**
     * node `Http2Session.ref()/unref()` 的等价物：`unref()` 之后这条连接不再顶住
     * 无头宿主的事件循环（在途流照跑，只是不保活）。
     */
    public ref(): void {
        this._session.ref()
    }

    public unref(): void {
        this._session.unref()
    }

    /**
     * 暂停/恢复**本流**的响应数据（node 里 `res.socket.pause()` 的效果）。
     *
     * 实现是 JS 侧的闸门：`ClientRequest.onData` 在暂停期间把 chunk 攒起来，`resume()`
     * 再按序 push。**已知限制**：攒的那段没有上限，也没有真正 withheld WINDOW_UPDATE
     * （那要原生支持）—— 对超大 body 长时间暂停会占内存。写在这里而不是留个空实现：
     * 空实现会让「暂停了但还在收 data」变成静默假成功（T1 的清假绿项）。
     */
    public pause(): void {
        this._flowControl?.pause()
    }

    public resume(): void {
        this._flowControl?.resume()
    }

    /** @internal 由 ClientRequest 在拿到 session 时注入。 */
    public setFlowControl(handlers: { pause: () => void; resume: () => void }): void {
        this._flowControl = handlers
    }

    public destroy(error?: Error): this {
        this.clearTimeout()
        this._session.abort(this._requestId)
        if (error) this.emit('error', error)
        this.emit('close')
        return this
    }

    public write(): never {
        throw new Error('ERR_HTTP2_SOCKET_UNSUPPORTED: write() is managed by the http2 engine')
    }

    public end(): never {
        throw new Error('ERR_HTTP2_SOCKET_UNSUPPORTED: end() is managed by the http2 engine')
    }
}
