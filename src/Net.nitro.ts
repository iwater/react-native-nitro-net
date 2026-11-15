import { type HybridObject } from 'react-native-nitro-modules'

export type NetEventType = 'connect' | 'data' | 'error' | 'close' | 'connection'

export interface NetEvent {
    type: NetEventType
    data?: ArrayBuffer
    error?: string
    id?: string // For 'connection' event (clientId)
}

export type NetEventHandler = (event: NetEvent) => void

export enum NetSocketEvent {
    CONNECT = 1,
    DATA = 2,
    ERROR = 3,
    CLOSE = 4,
    DRAIN = 5, // = 原生 NET_EVENT_WRITTEN：每条被接受的写各来一条
    TIMEOUT = 7,
    LOOKUP = 8,
    SESSION = 9,
    KEYLOG = 10,
    OCSP = 11,
    BUSY = 12 // 写通道满，需要在途写重试（背压）
}

export interface NetSocketDriver extends HybridObject<{ ios: 'swift', android: 'kotlin' }> {
    readonly id: number
    connect(host: string, port: number): void
    connectTLS(host: string, port: number, serverName?: string, rejectUnauthorized?: boolean): void
    connectTLSWithContext(host: string, port: number, serverName?: string, rejectUnauthorized?: boolean, secureContextId?: number): void
    connectTLSWithProxy(
        host: string,
        port: number,
        proxyHost: string,
        proxyPort: number,
        proxyAuthorization?: string,
        serverName?: string,
        rejectUnauthorized?: boolean,
        secureContextId?: number
    ): void
    /**
     * 经 https 代理建 TLS：TCP → TLS#1（到代理）→ CONNECT → TLS#2（到源站）。
     *
     * `proxyServerName` / `proxySecureContextId` 只作用于代理那一跳；
     * 为 undefined 时分别回退代理 host 与系统根。
     */
    connectTLSWithHttpsProxy(
        host: string,
        port: number,
        proxyHost: string,
        proxyPort: number,
        proxyAuthorization?: string,
        serverName?: string,
        rejectUnauthorized?: boolean,
        secureContextId?: number,
        proxyServerName?: string,
        proxyRejectUnauthorized?: boolean,
        proxySecureContextId?: number
    ): void
    connectTLSWithSocks(
        host: string,
        port: number,
        proxyHost: string,
        proxyPort: number,
        proxyVersion: number,
        proxyUsername?: string,
        proxyPassword?: string,
        serverName?: string,
        rejectUnauthorized?: boolean,
        secureContextId?: number
    ): void
    /**
     * 用 Chrome profile（BoringSSL）连接。profile/options/proxy 都是 JSON 文本；
     * `proxyJson` 为空表示直连。未编译 impersonate feature 时 emit
     * `ERR_IMPERSONATION_UNAVAILABLE`。
     */
    connectTLSWithProfile(
        host: string,
        port: number,
        serverName: string | undefined,
        profileJson: string,
        optionsJson: string,
        proxyJson?: string
    ): void
    /** 原生是否编译了 impersonate feature。 */
    impersonationAvailable(): boolean
    getAuthorizationError(): string | undefined
    getProtocol(): string | undefined
    getCipher(): string | undefined
    getCipherStandardName(): string | undefined
    getALPN(): string | undefined
    getPeerCertificateJSON(): string | undefined
    getEphemeralKeyInfo(): string | undefined
    getSharedSigalgs(): string | undefined
    isSessionReused(): boolean
    getSession(): ArrayBuffer | undefined
    setSession(session: ArrayBuffer): void
    connectUnix(path: string): void
    connectUnixTLS(path: string, serverName?: string, rejectUnauthorized?: boolean): void
    connectUnixTLSWithContext(path: string, serverName?: string, rejectUnauthorized?: boolean, secureContextId?: number): void
    /**
     * #82：在**已连接的明文 socket** 上就地起 TLS 握手（`tls.connect({socket})` 的实现）。
     * 成功时发 `NET_EVENT_TLS_READY`（不是 CONNECT —— 连接早已建立），失败走 ERROR。
     */
    startTLS(serverName: string, rejectUnauthorized: boolean, secureContextId: number): void
    write(data: ArrayBuffer): void
    pause(): void
    resume(): void
    shutdown(): void
    setTimeout(timeout: number): void
    destroy(): void
    resetAndDestroy(): void
    enableKeylog(): void
    enableTrace(): void
    exportKeyingMaterial(length: number, label: string, context?: ArrayBuffer): ArrayBuffer | undefined
    setNoDelay(enable: boolean): void
    setKeepAlive(enable: boolean, delay: number): void
    getLocalAddress(): string
    getRemoteAddress(): string
    onEvent: (event: number, data: ArrayBuffer) => void
}

export enum NetServerEvent {
    CONNECTION = 6,
    ERROR = 3,
    CLOSE = 4,
    DEBUG = 9,
    /** M5-3：accept 分流到 h2 引擎；载荷是 session id 的十进制文本。 */
    H2_SESSION = 7
}

/**
 * H2 session 事件编号（与 NetSocketEvent 的 1–12 分开）。
 *
 * HEADERS/TRAILERS/ERROR 是 JSON；DATA/END 的前 4 字节是大端 requestId；
 * READY/CLOSE 无载荷。
 */
export enum Http2SessionEvent {
    READY = 20,
    HEADERS = 21,
    DATA = 22,
    TRAILERS = 23,
    END = 24,
    ERROR = 25,
    CLOSE = 26,
    GOAWAY = 27,
    KEYLOG = 28,
    DRAIN = 29,
    /** P5：PING 回执；JSON `{ id, rttMs }`（crate 不暴露对端 payload）。 */
    PING = 31
}

/**
 * 独立的 HTTP/2 session（一个 Nitro 对象 = 一条 TCP+TLS 连接 × 多路复用流）。
 *
 * 请求/响应通过 `onEvent` 回到 JS；`requestId` 由 JS 分配，native 不用它做 streamId。
 */
export interface Http2SessionDriver extends HybridObject<{ ios: 'swift', android: 'kotlin' }> {

    /** P5：发 PING；`pingId` 由 JS 分配，回执走 PING 事件。false = 队列满/未就绪。 */
    ping(pingId: number): boolean
    /** M5-2：ALPN 只答 h1 时是否留下了可交还的已握手流（只读，不会领走）。 */
    canTakeStream(): boolean
    /** M5-2：领走那条已握手流，变成普通 socket；没有时抛 ERR_INVALID_STATE。 */
    takeStream(): NetSocketDriver
    readonly id: number
    connect(
        host: string,
        port: number,
        serverName: string | undefined,
        profileJson: string,
        optionsJson: string,
        proxyJson?: string
    ): void
    request(requestId: number, requestJson: string): void
    /** 返回 false 表示 body 缓冲已满，等 DRAIN 事件后再写。 */
    write(requestId: number, data: ArrayBuffer): boolean
    end(requestId: number): void
    /** 发送 trailers 并结束流；请求必须有一个 streaming body（endStream=false）。 */
    trailers(requestId: number, trailersJson: string): void
    abort(requestId: number): void
    destroy(): void
    getALPN(): string | undefined
    getProtocol(): string | undefined
    getCipher(): string | undefined
    getCipherStandardName(): string | undefined
    getPeerCertificateJSON(): string | undefined
    getAuthorizationError(): string | undefined
    isSessionReused(): boolean
    getEphemeralKeyInfo(): string | undefined
    getSharedSigalgs(): string | undefined
    exportKeyingMaterial(length: number, label: string, context?: ArrayBuffer): ArrayBuffer | undefined
    getLocalAddress(): string
    getRemoteAddress(): string
    onEvent: (event: number, data: ArrayBuffer) => void
}

export interface NetServerDriver extends HybridObject<{ ios: 'swift', android: 'kotlin' }> {
    onEvent: (event: number, data: ArrayBuffer) => void
    /**
     * Listen on a TCP port.
     * @param host 绑定地址（Node 语义：IP 字面量或主机名，省略时绑通配地址）。
     *             此前接口没有此参数，JS 传入的 host 被静默丢弃、恒绑通配。
     */
    listen(port: number, host?: string, backlog?: number, ipv6Only?: boolean, reusePort?: boolean): void
    /**
     * Listen on a TCP port with TLS.
     * @param host 绑定地址（Node 语义，与 `listen` 相同）。**追加在参数表末尾**是为了
     *             不改既有位置；省略时绑通配地址（node：`::` 双栈）。#83 之前这个参数
     *             不存在，`tls.Server.listen(port, host)` 的 host 被静默忽略 ⇒ 本意绑
     *             回环的 TLS 服务会暴露到所有接口。
     */
    listenTLS(port: number, secureContextId: number, backlog?: number, ipv6Only?: boolean, reusePort?: boolean, host?: string): void
    listenUnix(path: string, backlog?: number): void
    listenTLSUnix(path: string, secureContextId: number, backlog?: number): void
    /**
     * Listen on an existing file descriptor (handle)
     * @param fd File descriptor of an already-bound TCP listener
     * @param backlog Listen backlog (optional, defaults to 128)
     */
    listenHandle(fd: number, backlog?: number): void
    getLocalAddress(): string
    maxConnections: number
    close(): void
    /**
     * M5-3：设置监听器的 h2 模式 —— 0=off，1=只接 h2，2=h2 + HTTP/1.1 回退（`allowHTTP1`）。
     * 必须在 `listen*` 之前调用；accept 循环按它决定连接是进 h2 引擎还是 h1 socket 通道。
     */
    setHttp2Mode(mode: number): void
    /** M5-3：把 accept 分流的 h2 会话取成 JS 对象（收到 `h2session` 事件后调用，一次一个）。 */
    takeHttp2Session(): Http2ServerSessionDriver
}

/**
 * 服务端 HTTP/2 session（M5-3 P3/P4）。
 *
 * 与客户端 `Http2SessionDriver` 对称，但方向相反：HEADERS/DATA/TRAILERS/END 是**请求**，
 * `respond`/`write`/`end`/`trailers` 是**响应**。id 由 accept 循环分配，JS 通过
 * `NetServerDriver.takeHttp2Session()` 取得对象。
 */
export interface Http2ServerSessionDriver extends HybridObject<{ ios: 'swift', android: 'kotlin' }> {
    readonly id: number
    onEvent: (event: number, data: ArrayBuffer) => void
    /** 发响应头；`headersJson` 是 `[[name, value], ...]`（含 `:status`）。 */
    respond(requestId: number, headersJson: string, endStream: boolean): void
    /** 响应体；返回 false 表示命令通道满，随后会来一条 DRAIN 事件（会话级）。 */
    write(requestId: number, data: ArrayBuffer): boolean
    /** P5：发 PING（回执走 PING 事件）。false = 队列满/会话已关闭。 */
    ping(pingId: number): boolean
    end(requestId: number): void
    trailers(requestId: number, trailersJson: string): void
    /**
     * 取消当前流并写 RST_STREAM。`code` 是错误码本身（node 的 `stream.close(code)`；
     * 默认 0 = `NGHTTP2_NO_ERROR`，node v22.11 实测 `close()`/`destroy()` 都发 0）。
     * 以前这里不收 code，原生一律发 CANCEL(8) —— 于是 `close(NGHTTP2_REFUSED_STREAM)`
     * 到对端永远是 CANCEL，客户端的「REFUSED 后重试」判据根本拿不到 7。
     */
    abort(requestId: number, code: number): void
    /** 优雅关闭：向对端发 GOAWAY，在途流继续。 */
    close(): void
    destroy(): void
    getALPN(): string | undefined
    getProtocol(): string | undefined
    getCipher(): string | undefined
    getCipherStandardName(): string | undefined
    getPeerCertificateJSON(): string | undefined
    getLocalAddress(): string
    getRemoteAddress(): string
    isSessionReused(): boolean
    /** node 的 `socket.authorized`：客户端证书是否通过校验（`requestCert` 未开时恒 false）。 */
    isAuthorized(): boolean
}
export interface HttpParsedMessage {
    metadata: string
    body?: ArrayBuffer
}

export interface HttpParser extends HybridObject<{ ios: 'swift', android: 'kotlin' }> {
    /**
     * Feed data to the parser
     * @param data Raw byte data from the network
     * @returns HttpParsedMessage containing the JSON metadata and optional binary body
     */
    feed(data: ArrayBuffer): HttpParsedMessage
}

/**
 * Runtime configuration for the network module
 */
export interface NetConfig {
    /**
     * Number of worker threads for the async runtime
     * 0 = use CPU core count (default)
     */
    workerThreads?: number
    /**
     * Whether to enable verbose debug logging
     */
    debug?: boolean
}

export interface NetDriver extends HybridObject<{ ios: 'swift', android: 'kotlin' }> {
    createSocket(id?: string): NetSocketDriver
    createServer(): NetServerDriver
    createHttpParser(mode: number): HttpParser
    createSecureContext(cert: string, key: string, passphrase?: string): number
    createEmptySecureContext(): number
    addCACertToSecureContext(scId: number, ca: string): void
    /**
     * 服务端 TLS 的客户端认证开关（node 的 `tls.Server({ requestCert, rejectUnauthorized })`）。
     * 以前这两个选项在服务端完全没被读取 —— 所有服务端配置都以 `with_no_client_auth()` 收尾，
     * 握手时从不发 CertificateRequest（H2 mTLS 两格 mtls=no 的根因）。
     */
    setClientAuthToSecureContext(scId: number, requestCert: boolean, rejectUnauthorized: boolean): void
    addContextToSecureContext(scId: number, hostname: string, cert: string, key: string, passphrase?: string): void
    setPFXToSecureContext(scId: number, pfx: ArrayBuffer, passphrase?: string): void
    setOCSPResponseToSecureContext(scId: number, ocsp: ArrayBuffer): void
    /**
     * #84：给服务端 secure context 设 ALPN 列表。
     * `protocols` 是 node 的线缆形态（每项 `1 字节长度 + 协议名`），由 JS 侧
     * `convertALPNProtocols` 生成 —— 与 node 交给 `ssl.setALPNProtocols(buffer)` 的形态一致。
     */
    setAlpnProtocolsToSecureContext(scId: number, protocols: ArrayBuffer): void
    getTicketKeys(scId: number): ArrayBuffer | undefined
    setTicketKeys(scId: number, keys: ArrayBuffer): void
    /**
     * Initialize the network module with custom configuration
     * Must be called before any other network operations
     * @param config Configuration options
     */
    initWithConfig(config: NetConfig): void
    getNetworkInterfaces(): string
    /** 原生是否编译了 impersonate feature（进程级能力探测）。 */
    impersonationAvailable(): boolean
    /** 原生是否带 HTTP/2 引擎（当前与 impersonate feature 同开）。 */
    http2Available(): boolean
    /** 创建 H2 session；能力不可用时返回的 driver 的 id 为 0。 */
    createHttp2Session(): Http2SessionDriver
}
