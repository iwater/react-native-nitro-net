import { Socket, Server as NetServer, SocketOptions } from './net'
import { Driver } from './Driver'
import { NetSocketDriver } from './Net.nitro'
import { debugLog as loggerDebugLog } from './Logger'
import { normalizePem, toBinaryArrayBuffer, type PemInput } from './pem'
import {
    alreadyListeningError,
    assertConnectTarget,
    describeReceivedValue,
    isPipeName,
    normalizeSocketPort,
    resolveListenTarget,
    type ListenTarget,
} from './socketPort'
import { nextTick } from './nextTick'
import { parseProxy, resolveProxyTls, type ParsedProxy, type ProxyTlsOptions } from './proxy'
import { decodePeerCertificateChain } from './peerCertificate'
import { checkServerIdentity } from './checkServerIdentity'
export { checkServerIdentity }
import { Buffer } from 'react-native-nitro-buffer'
import { buildImpersonationConnectOptions, type ImpersonationConnectOptions } from './impersonation'
import {
    getImpersonationConfig,
    isImpersonationAvailable,
    lookupProfile,
    setImpersonationAvailabilityProbe,
} from './profiles/registry'

// 原生能力探测（未编译 impersonate feature 时返回 false；方法不存在也不抛）
setImpersonationAvailabilityProbe(() => {
    try {
        return !!(Driver as any).impersonationAvailable?.();
    } catch {
        return false;
    }
});

function debugLog(message: string | (() => string)) {
    loggerDebugLog('TLS', message)
}

// -----------------------------------------------------------------------------
// #84：ALPN 的线缆形态（服务端回选用）
// -----------------------------------------------------------------------------
// 实现放在 `alpnProtocols.ts`（不带 Buffer 依赖，才能进 `yarn test:js`）；这里只转出，
// 保持 `import { convertALPNProtocols } from './tls'` 这类既有引用不断。
export { convertALPNProtocols } from './alpnProtocols';
import { convertALPNProtocols } from './alpnProtocols';

export interface PeerCertificate {
    subject: { [key: string]: string }
    issuer: { [key: string]: string }
    subjectaltname?: string
    ca?: boolean
    bits?: number
    /** DER SubjectPublicKeyInfo */
    pubkey?: Buffer
    asn1Curve?: string
    nistCurve?: string
    valid_from: string
    valid_to: string
    fingerprint: string
    fingerprint256: string
    fingerprint512?: string
    ext_key_usage?: string[]
    serialNumber: string
    /** DER 证书原文 */
    raw?: Buffer
    issuerCertificate?: PeerCertificate | Record<string, never>
    modulus?: string
    exponent?: string
    infoAccess?: Record<string, string[]>
}

export interface ConnectionOptions extends SocketOptions {
    host?: string
    port?: number
    path?: string
    servername?: string // SNI
    rejectUnauthorized?: boolean
    session?: ArrayBuffer | Uint8Array // TLS Session ticket for resumption (node 收 Buffer)
    secureContext?: SecureContext
    ca?: PemInput | PemInput[]
    cert?: PemInput | PemInput[]
    key?: PemInput | PemInput[]
    pfx?: PemInput
    passphrase?: string
    /** HTTP CONNECT 代理 URL；支持 http://、https://、socks5(h)://、socks4(a)://。 */
    proxy?: string
    /** `https://` 代理这一跳的 TLS 配置（源站的 ca/cert/key 不受影响）。 */
    proxyTls?: ProxyTlsOptions
    /** Chrome 指纹（impersonate）；缺省读全局 `configure()`。 */
    impersonate?: boolean | 'chrome'
    profile?: string
    forceHttp1?: boolean
    ALPNProtocols?: string[]
    keylog?: boolean // Enable keylogging (SSLKEYLOGFILE format)
    /**
     * Custom hostname verification function.
     * If provided, it will be called after the TLS handshake to verify the peer certificate.
     * Return `undefined` if valid, or an `Error` if invalid.
     * If not provided, the default `checkServerIdentity` is used.
     */
    checkServerIdentity?: (hostname: string, cert: PeerCertificate) => Error | undefined
}

/**
 * 原生返回的是 `TLSv1_3`（BoringSSL/rustls 的 `version_str()` 在 Rust 侧被换成了下划线），
 * 而 node 的 `getProtocol()` / `getCipher().version` 是 **`TLSv1.3`**（实测 node v22：
 * `res.socket.getProtocol() === 'TLSv1.3'`）。这里统一归一化 —— 别再让调用方写
 * `/^TLSv1[._][23]$/` 这种把差异抹平的宽松正则，那正是 T1 要清的假绿写法。
 */
export function normalizeProtocolVersion(value: string | undefined): string | undefined {
    return typeof value === 'string' ? value.replace(/_/g, '.') : value
}

export interface SecureContextOptions {
    pfx?: PemInput
    passphrase?: string
    cert?: PemInput | PemInput[]
    key?: PemInput | PemInput[]
    ca?: PemInput | PemInput[]
    /** 服务端：握手时向客户端要证书（node 的 `requestCert`；客户端配置里无效）。 */
    requestCert?: boolean
    /** 服务端：客户端证书校验失败是否拒绝握手；`false` ⇒ 不给证书也放行。 */
    rejectUnauthorized?: boolean
}

export const DEFAULT_MIN_VERSION = 'TLSv1.2';
export const DEFAULT_MAX_VERSION = 'TLSv1.3';
export const rootCertificates: string[] = [];
export const DEFAULT_ECDH_CURVE = 'auto'; // Managed by rustls
export const SLAB_BUFFER_SIZE = 10 * 1024 * 1024; // 10MB default

export class SecureContext {
    private _id: number;

    constructor(options?: SecureContextOptions) {
        if (options && options.pfx) {
            this._id = Driver.createEmptySecureContext();
            Driver.setPFXToSecureContext(this._id, toBinaryArrayBuffer(options.pfx), options.passphrase);
        } else if (options && options.cert && options.key) {
            const cert = normalizePem(Array.isArray(options.cert) ? options.cert[0] : options.cert, 'cert');
            const key = normalizePem(Array.isArray(options.key) ? options.key[0] : options.key, 'key');
            this._id = Driver.createSecureContext(cert, key, options.passphrase);
        } else {
            this._id = Driver.createEmptySecureContext();
        }

        if (options && options.ca) {
            const cas = Array.isArray(options.ca) ? options.ca : [options.ca];
            for (const ca of cas) {
                Driver.addCACertToSecureContext(this._id, normalizePem(ca, 'ca'));
            }
        }
        // node 的服务端客户端认证：`requestCert` + `rejectUnauthorized`。没开时行为不变
        // （原生保持 with_no_client_auth）；开了才在握手时发 CertificateRequest。
        Driver.setClientAuthToSecureContext(
            this._id,
            options?.requestCert === true,
            options?.rejectUnauthorized !== false,
        );
    }

    setOCSPResponse(ocsp: ArrayBuffer): void {
        Driver.setOCSPResponseToSecureContext(this._id, ocsp);
    }

    getTicketKeys(): ArrayBuffer | undefined {
        return Driver.getTicketKeys(this._id);
    }

    setTicketKeys(keys: ArrayBuffer): void {
        Driver.setTicketKeys(this._id, keys);
    }

    get id(): number {
        return this._id;
    }

    // Node.js doesn't have these on SecureContext but we might need them
    addCACert(ca: PemInput): void {
        Driver.addCACertToSecureContext(this._id, normalizePem(ca, 'ca'));
    }
}

export function createSecureContext(options?: SecureContextOptions): SecureContext {
    return new SecureContext(options);
}

/** #82：`tls.connect({socket})` 的就地升级用的 SecureContext（0 = 未指定 ⇒ 进程默认根库）。 */
function upgradeSecureContextId(options: any): number {
    const explicit = options && options.secureContext
    if (explicit) return explicit.id
    if (options && (options.cert || options.key || options.ca)) {
        return createSecureContext({ cert: options.cert, key: options.key, ca: options.ca }).id
    }
    return 0
}

/** rustls 交不出/吃不下 session 字节时的统一错误（#67 的决定：显式抛，不静默）。 */
function sessionUnsupportedError(): Error {
    const error: any = new Error(
        'TLS session bytes cannot be exported or injected on the rustls backend: ' +
        'Tls13ClientSessionValue exposes no serializer, and this backend does not ' +
        'resume sessions today (isSessionReused() reports the handshake verdict).'
    )
    error.code = 'ERR_NOT_SUPPORTED'
    return error
}

/**
 * #82：就地 TLS 升级完成的事件号。**必须与 `rust_c_net/src/types.rs` 的
 * `NET_EVENT_TLS_READY` 保持一致**（那边是 C 侧事件通道的数字）。
 */
const NET_EVENT_TLS_READY = 30

export function serializeProfileTlsOptions(
    options: any,
    impersonation: ImpersonationConnectOptions
): string {
    const ca = options.ca
        ? (Array.isArray(options.ca) ? options.ca : [options.ca]).map((value: any) =>
              normalizePem(value, 'ca')
          )
        : [];
    const cert = options.cert
        ? normalizePem(Array.isArray(options.cert) ? options.cert[0] : options.cert, 'cert')
        : undefined;
    const key = options.key
        ? normalizePem(Array.isArray(options.key) ? options.key[0] : options.key, 'key')
        : undefined;
    const pfx = options.pfx
        ? Buffer.from(toBinaryArrayBuffer(options.pfx)).toString('base64')
        : undefined;
    return JSON.stringify({
        rejectUnauthorized: options.rejectUnauthorized !== false,
        ca,
        cert,
        key,
        pfx,
        passphrase: options.passphrase,
        keylog: !!options.keylog,
        forceHttp1: impersonation.forceHttp1,
    });
}

export function serializeProfileProxy(
    proxy: ParsedProxy | undefined,
    proxyTls?: ProxyTlsOptions
): string | undefined {
    if (!proxy) return undefined;
    if (proxy.kind === 'https') {
        // 代理跳用 rustls + SecureContext（与默认路径一致），源站仍由 btls 握手。
        const resolved = resolveProxyTls(proxy, proxyTls);
        let secureContextId: number | undefined;
        if (resolved.hasMaterials) {
            secureContextId = createSecureContext({
                ca: proxyTls?.ca,
                cert: proxyTls?.cert,
                key: proxyTls?.key,
                passphrase: proxyTls?.passphrase,
            }).id;
        }
        return JSON.stringify({
            k: 'https',
            host: proxy.host,
            port: proxy.port,
            authorization: proxy.authorization,
            tls: {
                serverName: resolved.servername,
                rejectUnauthorized: resolved.rejectUnauthorized,
                secureContextId,
            },
        });
    }
    if (proxy.kind === 'http') {
        return JSON.stringify({
            k: 'http',
            host: proxy.host,
            port: proxy.port,
            authorization: proxy.authorization,
        });
    }
    if (proxy.kind === 'socks5') {
        return JSON.stringify({
            k: 'socks5',
            host: proxy.host,
            port: proxy.port,
            username: proxy.username,
            password: proxy.password,
        });
    }
    if (proxy.kind === 'socks4') {
        return JSON.stringify({
            k: 'socks4',
            host: proxy.host,
            port: proxy.port,
            userId: proxy.userId,
        });
    }
    return undefined;
}

export class TLSSocket extends Socket {
    private _servername?: string
    /** 只有 impersonated(btls) 连接能交出/注入 node 那样的 session 字节 */
    private _sessionBytesSupported = false
    /**
     * 握手完成时的 TLS 观测值快照（#80）。`_driver` 在 `_destroy()` 里被清空，而 node 在
     * close/destroy 之后仍返回**握手时**的值（实测 v22：`authorized=true`、
     * `authorizationError=null`、`getProtocol()`/`getCipher()` 不变）。getter 优先读实时驱动，
     * 驱动没了才回落到这里 —— 以前直接返回 false/undefined，那是我在 #73 量形状时先被坑的地方。
     */
    private _tlsSnapshot?: {
        authorized: boolean
        authorizationError?: string
        alpn?: string
        protocol?: string
        cipher?: { name: string, standardName: string, version: string }
        peerCertJSON?: string
        ephemeral: Record<string, any> | null
        sigalgs: string[]
        sessionReused: boolean
    }
    /** #82：就地升级的身份校验参数，READY 时用。 */
    private _upgradeServername?: string
    private _upgradeRejectUnauthorized: boolean = true
    private _upgradeCheckServerIdentity?: (hostname: string, cert: any) => Error | undefined
    /**
     * #82：握手完成前的写入先攒在 JS 里。
     *
     * 明文 socket 的 writer 任务此刻正在跑握手；如果握手前把 Data 投进去，**明文会先于
     * ClientHello 发出**（服务端看到乱码）。node 也是把握手前的写入缓冲到握手完成。
     */
    private _upgradeWriteQueue?: any[][]

    get encrypted(): boolean {
        return true
    }

    get servername(): string | undefined {
        return this._servername
    }

    /**
     * `_driver` 在 `_destroy()` 里被清空。destroy 之后这些 getter 原来是
     * `undefined.getXXX()` → TypeError（实测 Node 同期返回空值，不抛）。
     */
    private get _tls(): NetSocketDriver | undefined {
        return (this as any)._driver as NetSocketDriver | undefined
    }

    /**
     * 快照当前 TLS 观测值（#80）。**必须在驱动还活着时调用** —— 客户端在 `'connect'` 里，
     * 服务端在 `tls.Server` 把 accepted socket 包好之后。之后再调用是空操作。
     */
    _captureTlsSnapshot(): void {
        const driver = this._tls
        if (!driver || this._tlsSnapshot) return
        this._tlsSnapshot = {
            authorized: driver.getAuthorizationError() === undefined,
            authorizationError: driver.getAuthorizationError(),
            alpn: driver.getALPN(),
            protocol: normalizeProtocolVersion(driver.getProtocol()),
            cipher: this._cipherFromDriver(driver),
            peerCertJSON: driver.getPeerCertificateJSON(),
            ephemeral: this._ephemeralFromDriver(driver),
            sigalgs: this._sigalgsFromDriver(driver),
            sessionReused: driver.isSessionReused(),
        }
    }

    /**
     * #82：`tls.connect({socket})` —— 在**已连接的明文 socket** 上就地起 TLS。
     *
     * node v22 实测的边界：
     * · 不建连、忽略 `host`/`port`；
     * · socket 已连上 ⇒ **不发 'connect'**，只发 'secureConnect'；
     *   socket 还在 connecting ⇒ 先 'connect' 再 'secureConnect'；
     * · `tlsSock.destroy()` 会连带销毁原 socket（`raw.destroy()` 也会关掉 TLS 连接）；
     * · 非流值（`{}`/`'x'`/`42`）在构造时报 `stream.pause is not a function`。
     */
    private _connectOverExistingSocket(raw: any, opts: {
        servername?: string
        rejectUnauthorized: boolean
        secureContextId: number
        listener?: () => void
        checkServerIdentity?: (hostname: string, cert: any) => Error | undefined
    }): this {
        // 只收编本包的 net.Socket 形状（跨模块 `instanceof` 不可靠，见 connect() 的注释）。
        if (!raw || typeof raw !== 'object' || typeof raw.pause !== 'function'
            || typeof raw._releaseLoopRef !== 'function') {
            const error: any = new TypeError(
                'The "options.socket" property must be an instance of net.Socket'
            )
            error.code = 'ERR_INVALID_ARG_TYPE'
            throw error
        }
        if (opts.listener) this.once('secureConnect', opts.listener)

        // 构造时本对象已经建了一条**空的** native socket；升级要换成原 socket 的 driver。
        // 构造到 connect 之间没有取过 loop ref，销毁它不会漏 ref。
        this._connected = false
        if (raw.destroyed || !raw._driver) {
            // 原 socket 已销毁：node 在这个组合下**静默**什么都不做；静默会让调用方
            // 永远等下去，我们走异步 error（有意偏差，已登记）。
            const error: any = new Error('The provided socket is already destroyed')
            error.code = 'ERR_SOCKET_CLOSED'
            this.connecting = false
            setTimeout(() => this.emit('error', error), 0)
            return this
        }

        const ownDriver = (this as any)._driver
        if (ownDriver && ownDriver !== raw._driver) {
            try { ownDriver.destroy() } catch { /* 已销毁 */ }
        }
        ;(this as any)._driver = raw._driver
        this._setupEvents()
        // 地址来自原 socket 的那条连接（node 的升级 socket 同样报底层 TCP 地址）
        this._updateAddresses()

        const driver = this._tls
        if (!driver) {
            const error: any = new Error('The provided socket is already destroyed')
            error.code = 'ERR_SOCKET_CLOSED'
            this.connecting = false
            setTimeout(() => this.emit('error', error), 0)
            return this
        }

        this.connecting = true
        // 归属转移：原 socket 交出 loop ref；它之后的 destroy 由本对象代劳（见 net.ts）。
        raw._releaseLoopRef?.()
        this._acquireLoopRef()
        raw._adoptedBy = this
        ;(this as any)._adoptedRaw = raw
        ;(this as any)._isUnix = (raw as any)._isUnix === true

        this._upgradeServername = opts.servername || 'localhost'
        this._upgradeRejectUnauthorized = opts.rejectUnauthorized
        this._upgradeCheckServerIdentity = opts.checkServerIdentity
        this._servername = opts.servername
        this._upgradeWriteQueue = []

        const start = () => {
            if (this.destroyed) return
            try {
                driver.startTLS(this._upgradeServername!, opts.rejectUnauthorized, opts.secureContextId)
            } catch (error) {
                this.emit('error', error as Error)
                this.destroy(error as Error)
            }
        }
        if (raw.connecting) {
            // node：TCP 先建立 ⇒ 发 'connect'，随后才 secureConnect
            this.once('connect', start)
        } else {
            // 与 node 的"下一 tick 开始握手"一致
            setTimeout(start, 0)
        }
        return this
    }

    /** #82：就地升级握手完成 —— 身份校验 + `secureConnect`（与普通路径同一套语义）。 */
    private _onTlsReady(): void {
        this.connecting = false
        this._connected = true
        this._captureTlsSnapshot()
        if (this._upgradeRejectUnauthorized !== false) {
            const cert = this.getPeerCertificate() as PeerCertificate
            if (cert && Object.keys(cert).length > 0) {
                const verifyFn = this._upgradeCheckServerIdentity || checkServerIdentity
                const verifyErr = verifyFn(this._upgradeServername || 'localhost', cert)
                if (verifyErr) {
                    this._upgradeWriteQueue = undefined
                    this.emit('error', verifyErr)
                    this.destroy(verifyErr)
                    return
                }
            }
        }
        // 握手前的写入现在可以走了（node 也是握手完成才放行）
        const queued = this._upgradeWriteQueue
        this._upgradeWriteQueue = undefined
        if (queued) {
            for (const args of queued) {
                super.write(args[0], args[1], args[2])
            }
        }
        this.emit('secureConnect')
    }

    override write(chunk: any, encoding?: any, cb?: any): boolean {
        // #82：就地升级握手完成前先缓冲 —— 否则明文会抢在 ClientHello 之前发出去
        if (this._upgradeWriteQueue) {
            this._upgradeWriteQueue.push([chunk, encoding, cb])
            return true
        }
        return super.write(chunk, encoding, cb)
    }

    get authorized(): boolean {
        const driver = this._tls
        if (driver) return driver.getAuthorizationError() === undefined
        return this._tlsSnapshot ? this._tlsSnapshot.authorized : false
    }

    get authorizationError(): string | undefined {
        const driver = this._tls
        if (driver) return driver.getAuthorizationError()
        return this._tlsSnapshot ? this._tlsSnapshot.authorizationError : undefined
    }

    get alpnProtocol(): string | undefined {
        const driver = this._tls
        if (driver) return driver.getALPN()
        return this._tlsSnapshot ? this._tlsSnapshot.alpn : undefined
    }

    getProtocol(): string | undefined {
        const driver = this._tls
        if (driver) return normalizeProtocolVersion(driver.getProtocol())
        return this._tlsSnapshot ? this._tlsSnapshot.protocol : undefined
    }

    getCipher(): { name: string, standardName: string, version: string } | undefined {
        const driver = this._tls
        if (driver) return this._cipherFromDriver(driver)
        return this._tlsSnapshot ? this._tlsSnapshot.cipher : undefined
    }

    private _cipherFromDriver(driver: NetSocketDriver): { name: string, standardName: string, version: string } | undefined {
        const cipher = driver.getCipher()
        if (!cipher) return undefined
        return {
            name: cipher,
            standardName: driver.getCipherStandardName() || cipher,
            version: normalizeProtocolVersion(driver.getProtocol()) || 'Unknown'
        }
    }

    getPeerCertificate(detailed?: boolean): PeerCertificate | {} {
        const driver = this._tls
        const json = driver ? driver.getPeerCertificateJSON() : this._tlsSnapshot?.peerCertJSON
        if (json) {
            // node 的形状：默认不带 `issuerCertificate`；`detailed` 时每级都带、根自引用。
            // 单证书链是否带该键取决于验证是否成功（node 实测），所以把 authorizationError
            // 作为「已验证」的判据传下去。
            return decodePeerCertificateChain(
                json,
                (value) => Buffer.from(value, 'base64'),
                !!detailed,
                !this.authorizationError
            ) as PeerCertificate
        }
        return {}
    }

    isSessionReused(): boolean {
        const driver = this._tls
        if (driver) return driver.isSessionReused()
        // 以前这里对 `undefined` 直接调方法 —— destroy 之后调用会 TypeError（node 返回握手值）
        return this._tlsSnapshot ? this._tlsSnapshot.sessionReused : false
    }

    getSession(): Buffer | undefined {
        const driver = (this as any)._driver as NetSocketDriver
        if (!driver) return undefined
        if (!this._sessionBytesSupported) {
            // node 在握手前返回 undefined；握手后 rustls 交不出字节 ⇒ 显式抛错
            if (!this._connected) return undefined
            const error: any = new Error(
                'TLS session bytes are only available on impersonated (btls) connections: ' +
                'rustls exposes no public session serializer (Tls13ClientSessionValue). ' +
                'The rustls backend does not resume sessions today.'
            )
            error.code = 'ERR_NOT_SUPPORTED'
            throw error
        }
        const session = driver.getSession()
        // node 返回 Buffer（实测 v22）；native/驱动按 ArrayBuffer 传，边界转换
        return session ? Buffer.from(session) : undefined
    }

    /**
     * 设置本连接要复用的 TLS session（node 的 `tlsSocket.setSession(session)`）。
     * 必须在握手前调用；内容非法由原生在建连阶段报错（node 在握手期报
     * ERR_SSL_TOO_LONG —— 错误码不同，已登记）。
     */
    setSession(session: ArrayBuffer | Uint8Array): void {
        const driver = (this as any)._driver as NetSocketDriver
        if (!(session instanceof ArrayBuffer) && !ArrayBuffer.isView(session)) {
            const error: any = new TypeError('The "session" argument must be an instance of Buffer, TypedArray, or ArrayBuffer')
            error.code = 'ERR_INVALID_ARG_TYPE'
            throw error
        }
        if (!this._sessionBytesSupported) {
            const error: any = new Error(
                'TLS session bytes can only be injected into impersonated (btls) connections: ' +
                'rustls exposes no public session deserializer, so node\'s SSL_SESSION DER cannot ' +
                'be consumed. The rustls backend does not resume sessions today.'
            )
            error.code = 'ERR_NOT_SUPPORTED'
            throw error
        }
        driver.setSession(toBinaryArrayBuffer(session))
    }

    getEphemeralKeyInfo(): Record<string, any> | null {
        const driver = this._tls
        if (driver) return this._ephemeralFromDriver(driver)
        return this._tlsSnapshot ? this._tlsSnapshot.ephemeral : {}
    }

    private _ephemeralFromDriver(driver: NetSocketDriver): Record<string, any> | null {
        const json = driver.getEphemeralKeyInfo()
        if (!json) return {}
        try {
            const parsed = JSON.parse(json)
            // node：服务端 socket 返回 null；客户端非 ephemeral 时返回空对象
            if (parsed === null) return null
            return parsed && typeof parsed === 'object' ? parsed : {}
        } catch (e) {
            return {}
        }
    }

    getFinished(): Buffer | undefined {
        throw new Error('getFinished is not supported by rustls');
    }

    getPeerFinished(): Buffer | undefined {
        throw new Error('getPeerFinished is not supported by rustls');
    }

    getSharedSigalgs(): string[] {
        const driver = this._tls
        if (driver) return this._sigalgsFromDriver(driver)
        return this._tlsSnapshot ? this._tlsSnapshot.sigalgs : []
    }

    private _sigalgsFromDriver(driver: NetSocketDriver): string[] {
        const json = driver.getSharedSigalgs()
        if (!json) return []
        try {
            const parsed = JSON.parse(json)
            return Array.isArray(parsed) ? parsed : []
        } catch (e) {
            return []
        }
    }

    renegotiate(options: any, callback: (err: Error | null) => void): boolean {
        if (callback) {
            setTimeout(() => {
                const err = new Error('Renegotiation is not supported by rustls');
                (err as any).code = 'ERR_TLS_RENEGOTIATION_DISABLED';
                callback(err);
            }, 0);
        }
        return false;
    }

    disableRenegotiation(): void {
        // No-op, already effectively disabled
    }

    /**
     * node 的 `tlssocket.enableTrace()` 把 OpenSSL `SSL_trace()` 的记录级输出打到 stderr
     * （实测 v22；node 文档声明该格式未文档化、可随版本变化）。BoringSSL 没有
     * `SSL_trace`，只有 `SSL_CTX_set_msg_callback`（内容类型 + 原始消息字节）——
     * 复刻一个格式不同的 trace 既无法与 node 一致，又会给调试口增加非 node 的表面。
     * 按 §3「要么生效，要么显式抛错」：这里抛 `ERR_NOT_SUPPORTED`（有意偏差，见 #65）。
     */
    enableTrace(): void {
        const error: any = new Error('enableTrace is not implemented in this host')
        error.code = 'ERR_NOT_SUPPORTED'
        throw error
    }

    /**
     * Exports keying material for use by external protocols.
     * 
     * @param length The number of bytes to return.
     * @param label A label identifying the keying material.
     * @param context An optional context.
     * @returns Buffer containing keying material.
     * @throws Error if export fails (e.g., TLS not connected).
     */
    exportKeyingMaterial(length: number, label: string, context?: Buffer): Buffer {
        const driver = (this as any)._driver as NetSocketDriver
        if (driver) {
            const ctx = context ? new Uint8Array(context).buffer as ArrayBuffer : undefined
            const result = driver.exportKeyingMaterial(length, label, ctx)
            if (result) {
                return Buffer.from(result)
            }
        }
        const err = new Error('exportKeyingMaterial failed: TLS connection may not be established')
            ; (err as any).code = 'ERR_TLS_EXPORT_KEYING_MATERIAL'
        throw err
    }

    constructor(socket: Socket, options?: ConnectionOptions)
    constructor(options: ConnectionOptions)
    constructor(socketOrOptions: Socket | ConnectionOptions, options?: ConnectionOptions) {
        let opts: ConnectionOptions = {}
        if (socketOrOptions instanceof Socket) {
            opts = { ...options, socketDriver: (socketOrOptions as any)._driver }
        } else {
            opts = socketOrOptions || {}
        }

        super(opts)

        if (socketOrOptions instanceof Socket) {
            this._servername = (socketOrOptions as any)._servername
        }

        this.on('event', (event: number, data?: ArrayBuffer) => {
            if (event === 10 && data) { // KEYLOG
                this.emit('keylog', Buffer.from(data))
            } else if (event === 11 && data) { // OCSP
                this.emit('OCSPResponse', Buffer.from(data))
            } else if (event === NET_EVENT_TLS_READY) {
                // #82：就地升级握手完成（不是 CONNECT —— 连接早就建立了）
                this._onTlsReady()
            }
        })
    }

    /**
     * node 的 TLS 握手在 `tls.connect()` 返回后的下一个 tick 才开始。原生 connect* 同步
     * 启动会让 `tls.connect()` 之后同步调用的 `socket.setSession()`（以及 https 的
     * 'socket' 事件处理器）永远赶不上握手。这里把**原生 connect 调用**推迟一个微任务；
     * 同步参数校验仍在原处（抛出时由外层 catch 回滚 ref）。
     */
    private _startNativeConnect(run: () => void): void {
        // 用宏任务而不是微任务：宿主会在每次 JSI 调用边界抽干微任务队列，微任务会赶在
        // `https` 的 'socket' 事件（createConnection 返回后才 emit）之前，setSession 又输了。
        setTimeout(() => {
            if (this.destroyed) return
            try {
                run()
            } catch (error) {
                // Nitro 边界的同步抛改为异步 error（node 的连接错误本来就是异步的）
                this._releaseLoopRef()
                this.connecting = false
                setTimeout(() => this.emit('error', error as Error), 0)
            }
        }, 0)
    }

    override connect(options: any, connectionListener?: () => void): this {
        // 与 net.Socket.connect 同一道闸门（node 的 tls.connect 走的就是 net 的规则）：
        // `tls.connect({host})` 在 node 是同步 `ERR_MISSING_ARGS`，而这里原先直接
        // `normalizeSocketPort(undefined)` ⇒ 归 0 并真的建了个 socket（假放行）。
        // #82：tls 额外允许 `{socket}`（就地升级，不需要 port/path）；net 不放开。
        assertConnectTarget(options, true)
        // 数字签名 `connect(port[, host][, cb])` 下 host 在 arguments[1]。
        // 原来只认 `typeof options === 'string'`，于是 `connect(443, 'example.com')`
        // 的 host 静默落到 'localhost'（连错地方，且 SNI 也跟着错）。
        // 端口必须在这里就归一成**数字**：`http.Agent.createConnection` 交下来的 options
        // 直接进 `driver.connectTLS*`，字符串端口（node-fetch 经 `url.parse()` 传 `port:"52061"`）
        // 会在计时器回调里抛内核的 `Value is a string, expected a number` —— 报完还挂住进程。
        // #44 只在 net.ts 的 `_connect` 做了归一，TLS 侧漏了（矩阵 `nf https + 自定义 ca`
        // 的「挂起」就是这么来的）。放在 `_acquireLoopRef()` **之前**：抛出时不能留下 ref。
        const port = normalizeSocketPort(typeof options === 'number' ? options : options.port)
        const host = (typeof options === 'object' && options.host)
            ? options.host
            : ((typeof options === 'string' || typeof options === 'number') && typeof arguments[1] === 'string')
                ? arguments[1]
                : 'localhost'
        // 回调位置随参数个数变化（同 net.ts，形参 connectionListener === arguments[1]）：
        //   (port, cb) → arguments[1]；(port, host, cb) → arguments[2]；(port, host) → 无回调。
        // 直接用形参会在 `(port, host)` 下把 host 字符串当监听函数注册 → TypeError。
        const listener: (() => void) | undefined = typeof arguments[1] === 'function'
            ? arguments[1]
            : (typeof arguments[2] === 'function' ? arguments[2] : undefined)
        const path = (typeof options === 'object' && options.path) ? options.path : undefined
        const servername = (typeof options === 'object' && options.servername) ? options.servername : (path ? 'localhost' : host)
        this._servername = servername
        const rejectUnauthorized = (typeof options === 'object' && options.rejectUnauthorized !== undefined) ? options.rejectUnauthorized : true
        const session = (typeof options === 'object' && options.session) ? options.session : undefined

        // #82：`tls.connect({socket})` —— 在已连接的明文 socket 上就地升级。
        // node 忽略 host/port、不建连；握手结果由 NET_EVENT_TLS_READY 驱动。
        const upgradeSocket = (typeof options === 'object' && options.socket) ? options.socket : undefined
        if (upgradeSocket !== undefined) {
            if (session) {
                const error = sessionUnsupportedError()
                this.connecting = false
                setTimeout(() => this.emit('error', error), 0)
                return this
            }
            return this._connectOverExistingSocket(upgradeSocket, {
                // 与 node 一致：没给 servername 时不发 SNI（rustls 仍需要一个名字，
                // 缺省取 'localhost'，这一点见差异文档）
                servername: (typeof options === 'object' && options.servername) ? options.servername : undefined,
                rejectUnauthorized,
                secureContextId: upgradeSecureContextId(options),
                listener,
                checkServerIdentity: (typeof options === 'object' && options.checkServerIdentity)
                    ? options.checkServerIdentity
                    : undefined,
            })
        }

        const driver = (this as any)._driver as NetSocketDriver

        if (driver) {
            this.connecting = true;
            // 本 override 不调 super.connect —— 只在 net.ts 的 _connect 埋点的话，
            // TLS client（含 https client）永不 ref，无头宿主下事件循环提前收泵。
            // 释放走 Socket._destroy（'close' 的唯一出口）。
            this._acquireLoopRef();
            // 下面直到 driver.connect* 之间都可能**同步**抛 —— 抛点在 Nitro/JSI 边界：
            // cert/key/session 传了非 string 的类型（Node 的 tls 收 Buffer，用户照抄
            // `fs.readFileSync` 就会踩到）、以及 driver.connect* 自身。
            // ⚠️ 「PEM 解析失败」**不算**：原生 net_secure_context_set_cert_key 解析不出
            // 证书时只 log + return（rust_c_net/src/ffi.rs），失败推迟到握手的异步阶段，
            // 走正常 ERROR/CLOSE 释放 —— 别把它当成本块的抛点。
            // 同 net.ts listen / tls.Server.listen 的写法：没有 handle 就不该留下 ref。
            try {
                if (listener) this.once('secureConnect', listener);

                this.once('connect', () => {
                    // #80：握手刚完成、驱动还活着 —— 把 TLS 观测值**快照**下来。
                    // node 在 close/destroy 之后仍返回握手时的值（实测：authorized=true、
                    // authorizationError=null、getProtocol()/getCipher() 不变）；我们的
                    // getter 读 `_driver`，而它在 `_destroy` 里被清空 ⇒ 以前 close 之后
                    // 全变成 false/undefined。快照让 getter 在没有驱动时回落到握手值。
                    this._captureTlsSnapshot()
                    // #79：node 的 'connect' 是 **TCP 建立**（握手之前）就发的，'secureConnect'
                    // 在它之后。我们只有一个"握手完成"事件，所以只能保证**顺序**：把
                    // secureConnect 推到 nextTick，让本轮所有 'connect' 监听器先跑完。
                    // （残余差异登记在 #79：我们的 connect 发生时握手已经完成。）
                    // ⚠️ 不能写裸 `process.nextTick`：RN 的 process 没有它（T4 设备实测崩）。
                    nextTick(() => {
                        // After the native TLS handshake, perform hostname verification
                        if (rejectUnauthorized !== false) {
                            const cert = this.getPeerCertificate() as PeerCertificate;
                            if (cert && Object.keys(cert).length > 0) {
                                const verifyFn = (typeof options === 'object' && options.checkServerIdentity)
                                    ? options.checkServerIdentity
                                    : checkServerIdentity;
                                const verifyErr = verifyFn(servername, cert);
                                if (verifyErr) {
                                    this.emit('error', verifyErr);
                                    this.destroy(verifyErr);
                                    return;
                                }
                            }
                        }
                        this.emit('secureConnect')
                    })
                })

                const secureContext = (typeof options === 'object' && options.secureContext) ? options.secureContext : undefined;
                let secureContextId: number | undefined = secureContext ? secureContext.id : undefined;

                // If cert/key/ca provided directly, create a temporary secure context
                if (!secureContextId && typeof options === 'object' && (options.cert || options.key || options.ca)) {
                    secureContextId = createSecureContext({
                        cert: options.cert,
                        key: options.key,
                        ca: options.ca
                    }).id;
                }

                if (options && options.keylog) {
                    driver.enableKeylog()
                }

                const proxyUrl = typeof options === 'object' ? options.proxy : undefined;
                const proxyTls: ProxyTlsOptions | undefined = typeof options === 'object' ? options.proxyTls : undefined;
                if (path && proxyUrl) {
                    throw new Error('proxy is not supported for Unix sockets');
                }
                const proxy = proxyUrl ? parseProxy(proxyUrl) : undefined;

                if (!path) {
                    const impersonation = buildImpersonationConnectOptions(
                        undefined,
                        {
                            impersonate: (options as any).impersonate,
                            profile: (options as any).profile,
                            forceHttp1: (options as any).forceHttp1,
                            alpnProtocols: (options as any).ALPNProtocols,
                            headers: (options as any).headers,
                        },
                        host,
                        getImpersonationConfig(),
                        lookupProfile,
                        isImpersonationAvailable()
                    );
                    if (impersonation) {
                        this._sessionBytesSupported = true
                        if (session) this.setSession(session)
                        let proxyJson: string | undefined;
                        try {
                            proxyJson = serializeProfileProxy(proxy, proxyTls);
                        } catch (e) {
                            // proxyTls cert/key 不成对等：与连接失败同一条异步 error 通道
                            this._releaseLoopRef();
                            this.connecting = false;
                            const err = e as Error;
                            setTimeout(() => this.emit('error', err), 0);
                            return this;
                        }
                        debugLog(`TLSSocket.connect: Calling driver.connectTLSWithProfile(${host}:${port}, profile=${impersonation.profile}, forceHttp1=${impersonation.forceHttp1}, proxy=${proxy ? proxy.kind : 'none'})`);
                        this._startNativeConnect(() => driver.connectTLSWithProfile(
                            host,
                            port,
                            servername,
                            JSON.stringify(impersonation.profileData),
                            serializeProfileTlsOptions(options, impersonation),
                            proxyJson
                        ));
                        return this;
                    }
                }

                // rustls 0.23 的会话值没有公开的序列化/反序列化入口（见 §5.1 的 file:line 证据），
                // 所以 setSession 的输入不可能生效 —— 不能静默忽略。
                // 这里在 agent 的 nextTick 里跑，同步抛会变成未捕获异常 ⇒ 走异步 error 通道。
                if (session) {
                    this._releaseLoopRef()
                    this.connecting = false
                    const error: any = new Error(
                        'TLS session bytes cannot be exported or injected on the rustls backend: ' +
                        'Tls13ClientSessionValue exposes no serializer, and this backend does not ' +
                        'resume sessions today (isSessionReused() reports the handshake verdict).'
                    )
                    error.code = 'ERR_NOT_SUPPORTED'
                    setTimeout(() => this.emit('error', error), 0)
                    return this
                }

                if (path) {
                    // #73：Unix 连接的 address() 是空对象（node 实测），与 TCP 形状不同，
                    // 这条分支不经过 net.ts 的 `_connectUnix`，所以要自己置旗标。
                    this._isUnix = true
                    if (secureContextId !== undefined) {
                        debugLog(`TLSSocket.connect: Calling driver.connectUnixTLSWithContext(${path}, ${servername}, ctx=${secureContextId})`);
                        this._startNativeConnect(() => driver.connectUnixTLSWithContext(path, servername, rejectUnauthorized, secureContextId))
                    } else {
                        debugLog(`TLSSocket.connect: Calling driver.connectUnixTLS(${path}, ${servername})`);
                        this._startNativeConnect(() => driver.connectUnixTLS(path, servername, rejectUnauthorized))
                    }
                } else {
                    if (proxy && proxy.kind === 'https') {
                        // 代理跳与源站跳各用各的信任材料：proxyTls 里给了 ca/cert/key
                        // 才建代理专用的 SecureContext（ca 是替换语义，不用系统根）。
                        let resolved: ReturnType<typeof resolveProxyTls>;
                        try {
                            resolved = resolveProxyTls(proxy, proxyTls);
                        } catch (e) {
                            // cert/key 不成对是**新**的同步抛点：addRequest 在 nextTick 里跑，
                            // 同步抛出去就是穿过 native→JS 边界的未捕获异常（无头宿主 exit 134）。
                            // 改走与原生连接失败同一条异步 error 通道。
                            this._releaseLoopRef();
                            this.connecting = false;
                            const err = e as Error;
                            setTimeout(() => this.emit('error', err), 0);
                            return this;
                        }
                        let proxySecureContextId: number | undefined;
                        if (resolved.hasMaterials) {
                            proxySecureContextId = createSecureContext({
                                ca: proxyTls?.ca,
                                cert: proxyTls?.cert,
                                key: proxyTls?.key,
                                passphrase: proxyTls?.passphrase,
                            }).id;
                        }
                        debugLog(`TLSSocket.connect: Calling driver.connectTLSWithHttpsProxy(${host}:${port} via https ${proxy.host}:${proxy.port}, sni=${servername}, proxySni=${resolved.servername})`);
                        this._startNativeConnect(() => driver.connectTLSWithHttpsProxy(
                            host,
                            port,
                            proxy.host,
                            proxy.port,
                            proxy.authorization,
                            servername,
                            rejectUnauthorized,
                            secureContextId,
                            resolved.servername,
                            resolved.rejectUnauthorized,
                            proxySecureContextId
                        ))
                    } else if (proxy && proxy.kind === 'http') {
                        debugLog(`TLSSocket.connect: Calling driver.connectTLSWithProxy(${host}:${port} via ${proxy.host}:${proxy.port}, sni=${servername})`);
                        this._startNativeConnect(() => driver.connectTLSWithProxy(
                            host,
                            port,
                            proxy.host,
                            proxy.port,
                            proxy.authorization,
                            servername,
                            rejectUnauthorized,
                            secureContextId
                        ))
                    } else if (proxy && proxy.kind === 'socks5') {
                        debugLog(`TLSSocket.connect: Calling driver.connectTLSWithSocks(socks5 ${host}:${port} via ${proxy.host}:${proxy.port}, sni=${servername})`);
                        this._startNativeConnect(() => driver.connectTLSWithSocks(
                            host,
                            port,
                            proxy.host,
                            proxy.port,
                            5,
                            proxy.username,
                            proxy.password,
                            servername,
                            rejectUnauthorized,
                            secureContextId
                        ))
                    } else if (proxy && proxy.kind === 'socks4') {
                        debugLog(`TLSSocket.connect: Calling driver.connectTLSWithSocks(socks4 ${host}:${port} via ${proxy.host}:${proxy.port}, sni=${servername})`);
                        this._startNativeConnect(() => driver.connectTLSWithSocks(
                            host,
                            port,
                            proxy.host,
                            proxy.port,
                            4,
                            proxy.userId,
                            undefined,
                            servername,
                            rejectUnauthorized,
                            secureContextId
                        ))
                    } else if (secureContextId !== undefined) {
                        debugLog(`TLSSocket.connect: Calling driver.connectTLSWithContext(${host}, ${port}, ${servername}, ctx=${secureContextId})`);
                        this._startNativeConnect(() => driver.connectTLSWithContext(host, port, servername, rejectUnauthorized, secureContextId))
                    } else {
                        debugLog(`TLSSocket.connect: Calling driver.connectTLS(${host}, ${port}, ${servername})`);
                        this._startNativeConnect(() => driver.connectTLS(host, port, servername, rejectUnauthorized))
                    }
                }
            } catch (e) {
                // 同步抛（如用户传的 cert/key 非法、createSecureContext 抛）时回滚：
                // ref 已计、connecting 已置位，若不释放，永远不会有原生 handle 发 CLOSE
                // → 无头宿主下事件循环被顶住、进程挂死。
                this._releaseLoopRef();
                this.connecting = false;
                throw e;
            }
        }

        return this
    }
}

export function connect(options: ConnectionOptions, connectionListener?: () => void): TLSSocket
export function connect(port: number, host?: string, options?: ConnectionOptions, connectionListener?: () => void): TLSSocket
export function connect(port: number, options?: ConnectionOptions, connectionListener?: () => void): TLSSocket
export function connect(path: string, options?: ConnectionOptions, connectionListener?: () => void): TLSSocket
export function connect(...args: any[]): TLSSocket {
    // 归一规则**照抄 node**（`_tls_wrap.js` 的 `normalizeConnectArgs` + `net.js` 的
    // `normalizeArgs`，本轮从 node v22.11 的 builtin 源码读出，不是推测）：
    //   arg0 是对象            → options 就是它
    //   arg0 是 pipe 名        → options.path = arg0        ← #73：以前这里当端口用，
    //     （`isPipeName`：字符串且 `Number() >= 0` 不成立）     `tls.connect('/run/x.sock', opts)`
    //   否则                   → options.port = arg0；args[1] 是字符串时 = host   被 normalizeSocketPort 判成
    //   然后把 args[1] **或** args[2] 上的对象**合并进** options                    ERR_SOCKET_BAD_PORT
    //     （node 的注释：「options.host overrides a host arg」）
    //   回调 = args 的最后一个函数
    // ⚠️ 这层**不发明端口默认值**：原来是 `port = options.port || 443`，于是
    // `tls.connect({host})` / `tls.connect({})` / `tls.connect(new Date())` 都拿到 443，
    // 绕过闸门变成假放行（node 是同步 ERR_MISSING_ARGS，实测 v24）。缺省时原样传下去，
    // 由 `assertConnectTarget` 判定、由 `normalizeSocketPort` 归一。
    const options: ConnectionOptions = {}
    const first = args[0]

    if (first !== null && typeof first === 'object') {
        Object.assign(options, first)
    } else if (isPipeName(first)) {
        options.path = first
    } else {
        options.port = first as any
        if (typeof args[1] === 'string') options.host = args[1]
    }
    if (args[1] !== null && typeof args[1] === 'object') {
        Object.assign(options, args[1])
    } else if (args[2] !== null && typeof args[2] === 'object') {
        Object.assign(options, args[2])
    }
    const last = args[args.length - 1]
    const listener = typeof last === 'function' ? last as () => void : undefined

    // #82：`{socket}` 就地升级。⚠️ **不能用 `instanceof Socket`**：宿主把 `net`/`tls`
    // 各注册成一个内建模块，`require('net')` 拿到的 Socket 与 tls 内部 `import './net'`
    // 的那份**可能不是同一个类对象**（实测 `instanceof` 为 false），node 自己也是按
    // 鸭子类型处理流的。这里只认"本包 net.Socket 的形状"：有 driver 收编入口 + pause。
    const rawSocket = (options as any).socket
    if (rawSocket && typeof rawSocket !== 'object') {
        const error: any = new TypeError(
            'The "options.socket" property must be an instance of net.Socket'
        )
        error.code = 'ERR_INVALID_ARG_TYPE'
        throw error
    }
    if (rawSocket && (typeof rawSocket.pause !== 'function' || typeof rawSocket._releaseLoopRef !== 'function')) {
        // node 对非流值在构造里报 `stream.pause is not a function`；我们只收编本包的
        // net.Socket（要拿它的 native driver），其余显式报类型错（有意偏差，已登记）。
        const error: any = new TypeError(
            'The "options.socket" property must be an instance of net.Socket'
        )
        error.code = 'ERR_INVALID_ARG_TYPE'
        throw error
    }

    const socket = new TLSSocket(options)
    socket.connect({
        ...options,
        host: options.host ?? 'localhost',
    }, listener)
    return socket
}

export class Server extends NetServer {
    private _secureContextId: number = 0;
    /**
     * node 的公开字段（实测 `https.createServer({}).ALPNProtocols` = `<Buffer 08 'http/1.1'>`，
     * 即线缆形态本身；`tls.createServer` 没给时是 `undefined`）。这里是 `Uint8Array` 而不是
     * `Buffer` —— 内容逐字节相同（`convertALPNProtocols` 的输出），只是为了让那段校验能
     * 脱离 `react-native-nitro-buffer` 进 `yarn test:js`。
     */
    public ALPNProtocols?: Uint8Array;

    constructor(options?: any, connectionListener?: (socket: Socket) => void) {
        super(options);

        // #84：node 在 `tls.Server` 构造里就把 ALPNProtocols 转成线缆形态并交给原生
        // （`_tls_wrap.js`：`convertALPNProtocols(options.ALPNProtocols, this)` →
        // `ssl.setALPNProtocols`），并且 ALPNCallback 与它**互斥**（实测 ERR_TLS_ALPN_CALLBACK_WITH_PROTOCOLS）。
        if (options && options.ALPNCallback && options.ALPNProtocols) {
            const err = new Error('The ALPNCallback and ALPNProtocols TLS options are mutually exclusive') as Error & { code?: string };
            err.code = 'ERR_TLS_ALPN_CALLBACK_WITH_PROTOCOLS';
            throw err;
        }
        if (options && options.ALPNProtocols !== undefined) {
            this.ALPNProtocols = convertALPNProtocols(options.ALPNProtocols);
        }

        if (options && options.secureContext) {
            this._secureContextId = (options.secureContext as SecureContext).id;
        } else if (options && (options.key || options.cert || options.ca)) {
            this._secureContextId = createSecureContext({
                cert: options.cert,
                key: options.key,
                ca: options.ca,
                // 服务端客户端认证的两个开关必须一起传下去：只丢 cert/key/ca 的话
                // `requestCert: true` 永远到不了原生（原来所有服务端配置都是 no_client_auth）。
                requestCert: (options as any).requestCert,
                rejectUnauthorized: (options as any).rejectUnauthorized,
            }).id;
        } else {
            // Create empty secure context to allow late configuration (addContext)
            this._secureContextId = createSecureContext().id;
        }

        this._applyAlpnProtocols();

        this.on('connection', (socket: Socket) => {
            const tlsSocket = new TLSSocket(socket);
            // #80：服务端 socket 同病 —— close 之后 node 仍给握手时的 cipher/protocol/证书。
            ;(tlsSocket as any)._captureTlsSnapshot();
            // #73：Unix 监听器上 accept 出来的连接，address() 也必须是空对象（node 两侧一致），
            // 旗标随 driver 一起转移到包装后的 TLSSocket。
            ;(tlsSocket as any)._isUnix = (socket as any)._isUnix === true;
            // TLSSocket 复用了同一个 native driver 并覆盖了它的 onEvent（见 TLSSocket 构造函数），
            // 所以原 Socket 再也收不到 CLOSE 事件 —— 继续跟踪它会让 _connections 只增不减，
            // maxConnections 很快就被耗尽（TS-H1）。把跟踪转移到包装后的 tlsSocket。
            this._untrackSocket(socket);
            this._trackSocket(tlsSocket);
            // LoopRef 随 driver 一起转移：原 socket 的 onEvent 已被 TLSSocket 覆盖、
            // 再也收不到 CLOSE，它在 accept 时 acquire 的 ref 必须在这里释放，
            // 否则每连接泄漏一次 → 进程挂死。
            socket._releaseLoopRef();
            tlsSocket._acquireLoopRef();
            this.emit('secureConnection', tlsSocket);
        });

        this.on('session', (data: ArrayBuffer) => {
            this.emit('newSession', data);
        });

        if (options && options.SNICallback) {
            console.warn("SNICallback is not supported yet, use addContext() instead");
        }

        if (connectionListener) {
            this.on('secureConnection', connectionListener);
        }
    }

    addContext(hostname: string, context: { key: PemInput, cert: PemInput }): void {
        if (!this._secureContextId) {
            throw new Error("Cannot addContext to a non-TLS server. Provide initial cert/key in constructor.");
        }
        Driver.addContextToSecureContext(
            this._secureContextId,
            hostname,
            normalizePem(context.cert, 'cert'),
            normalizePem(context.key, 'key')
        );
    }

    setSecureContext(options: { key: PemInput, cert: PemInput, ca?: PemInput | PemInput[] }): void {
        this._secureContextId = createSecureContext(options).id;
        // 上下文换了 ⇒ ALPN 要重新落上去（node 的 setSecureContext 同样重发
        // `ssl.setALPNProtocols`，见 `_tls_wrap.js` 里那一段）。
        this._applyAlpnProtocols();
    }

    /**
     * #84：把 `ALPNProtocols` 落到服务端配置上。
     *
     * 空列表（`ALPNProtocols: []`）也要**照发**：node 实测它与「不发」同形
     * （不协商、不报错），而原生侧 `Some(vec![])` 与 `None` 的差别只影响后续调试。
     */
    private _applyAlpnProtocols(): void {
        if (!this._secureContextId || this.ALPNProtocols === undefined) return;
        const buf = this.ALPNProtocols;
        const ab = buf.byteOffset === 0 && buf.byteLength === buf.buffer.byteLength
            ? buf.buffer
            : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        Driver.setAlpnProtocolsToSecureContext(this._secureContextId, ab as ArrayBuffer);
    }

    getTicketKeys(): ArrayBuffer | undefined {
        return this._secureContextId ? Driver.getTicketKeys(this._secureContextId) : undefined;
    }

    setTicketKeys(keys: ArrayBuffer): void {
        if (!this._secureContextId) throw new Error("Not a TLS server");
        Driver.setTicketKeys(this._secureContextId, keys);
    }

    override listen(port?: any, host?: any, backlog?: any, callback?: any): this {
        // #81：与 net.Server.listen 同一道闸（tls.Server 自己解析参数、不总是调 super，
        // 所以两处都要有）。判据是"已经 listening"，不是"调用过 listen" —— node 对
        // 首次 listen 尚未完成时的再次调用不抛（实测）。
        if (this._sawListening) throw alreadyListeningError();
        if (!this._secureContextId) {
            return super.listen(port, host, backlog, callback);
        }

        let _port: unknown = 0;
        let _host: string | undefined;
        let _backlog: number | undefined;
        let _path: string | undefined;
        let _callback: (() => void) | undefined;
        let ipv6Only = false;
        let reusePort = false;
        let handle: { fd?: number } | undefined;
        // 与 net.Server.listen 同一套 node 视角（闸门规则见 socketPort.ts）
        let hasPort = false;
        let hasPath = false;
        const omitted = arguments.length === 0 || typeof port === 'function';
        let normalizedOptions: unknown;

        if (typeof port === 'object' && port !== null) {
            normalizedOptions = port;
            hasPort = 'port' in port;
            hasPath = 'path' in port;
            if (typeof port.fd === 'number') {
                handle = port;
                _backlog = port.backlog;
                _callback = host;
            } else {
                _port = port.port;
                _host = port.host;
                _backlog = port.backlog;
                _path = port.path;
                ipv6Only = port.ipv6Only === true;
                reusePort = port.reusePort === true;
                _callback = host;
            }
        } else {
            // 与 net.Server.listen 同：首参是 pipe 名时进 `options.path`，不是端口。
            const isPath = isPipeName(port);
            _port = isPath ? undefined : port;
            _path = isPath ? port : undefined;
            hasPort = !isPath;
            hasPath = isPath;
            normalizedOptions = isPath ? { path: port } : { port };
            // 与 net.Server.listen 同：`listen(cb)` 的回调在首参位置上（node 取末位函数）。
            if (typeof port === 'function') _callback = port;

            if (typeof host === 'string') {
                _host = host;
                if (hasPort) (normalizedOptions as any).host = host;
            } else if (typeof host === 'function') _callback = host;

            if (typeof backlog === 'number') _backlog = backlog;
            else if (typeof backlog === 'function') _callback = backlog;

            if (typeof callback === 'function') _callback = callback;
        }

        // 本 override 绕过了 net.Server.listen，所以闸门必须在这里也过一遍：
        // 否则 tls/https 的 Server 拿到的是「native 边界 InternalError」或异步无 code 的错误。
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
        // `server.address()` 对 pipe 监听返回路径字符串（同 net.Server.listen）
        this._listenPath = target.path;

        if (_callback) this.once('listening', _callback);

        const driver = (this as any)._driver;

        // 本 override 只在这条分支里自己调 driver.listenTLS*，完全绕过 net.ts 的
        // Server.listen —— 不在这里登记的话，listening 的 tls.Server（含 https.Server）
        // 永不 ref。释放侧无需动：tls.Server 复用 net.Server 构造器装的 onEvent
        // switch，CLOSE/ERROR 的 release 路径本来就走得到。
        this._acquireLoopRef();
        // #81：node 的 `_handle` 在 pipe / fd / 端口（无 host）形态里同步建立；带 host 时
        // 先 `dns.lookup` ⇒ 同一 tick 的第二次 listen **不抛**（实测 v22.11）。#83 之后
        // listenTLS 也能收到 host，所以这里按同一规则判定。
        this._listenHandlePending = !!_path || !!handle || _host === undefined;
        try {
            if (_path) {
                driver.listenTLSUnix(_path, this._secureContextId, _backlog);
            } else if (handle) {
                console.warn("TLS over handles not fully implemented yet");
                driver.listenTLS((_port as number) || 0, this._secureContextId, _backlog, ipv6Only, reusePort, _host);
            } else {
                driver.listenTLS((_port as number) || 0, this._secureContextId, _backlog, ipv6Only, reusePort, _host);
            }
        } catch (e) {
            this._listenHandlePending = false;
            this._releaseLoopRef();
            throw e;
        }

        return this;
    }
}

export function createServer(options?: any, connectionListener?: (socket: Socket) => void): Server {
    return new Server(options, connectionListener);
}

export function getCiphers(): string[] {
    return [
        'TLS_AES_128_GCM_SHA256',
        'TLS_AES_256_GCM_SHA384',
        'TLS_CHACHA20_POLY1305_SHA256',
        'TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256',
        'TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384',
        'TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256',
        'TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256',
        'TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384',
        'TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256'
    ];
}


// -----------------------------------------------------------------------------
// Legacy Classes & Utils
// -----------------------------------------------------------------------------

/**
 * Legacy CryptoStream for Node.js compatibility.
 * In this implementation, it's a simple wrapper around TLSSocket.
 */
export class CryptoStream extends TLSSocket {
    constructor(options?: ConnectionOptions) {
        super(options || {});
    }
}

/**
 * Legacy SecurePair for Node.js compatibility.
 */
export class SecurePair {
    public cleartext: CryptoStream;
    public encrypted: CryptoStream;

    constructor(secureContext?: SecureContext, isServer?: boolean, requestCert?: boolean, rejectUnauthorized?: boolean) {
        this.cleartext = new CryptoStream();
        this.encrypted = this.cleartext; // Logically the same in our simplified model
    }
}

export function createSecurePair(secureContext?: SecureContext, isServer?: boolean, requestCert?: boolean, rejectUnauthorized?: boolean): SecurePair {
    return new SecurePair(secureContext, isServer, requestCert, rejectUnauthorized);
}

/**
 * Legacy certificate string parser.
 */
export function parseCertString(certString: string): { [key: string]: string } {
    const out: { [key: string]: string } = {};
    const parts = certString.split('/');
    for (const part of parts) {
        const [key, value] = part.split('=');
        if (key && value) out[key] = value;
    }
    return out;
}

/**
 * Mock implementation of convertTLSV1CertToPEM.
 */
export function convertTLSV1CertToPEM(cert: string | Buffer): string {
    if (typeof cert === 'string' && cert.includes('BEGIN CERTIFICATE')) return cert;
    const body = (cert instanceof Buffer) ? cert.toString('base64') : Buffer.from(cert).toString('base64');
    return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----`;
}

// node 的这些内建有 ESM default（= 模块对象）；got@16 按 `import https from 'node:https'` 取。
// 全部写成 **getter**：本文件与 tls/http 之间有循环依赖，对象字面量的简写属性会在
// 求值时触碰尚未初始化的绑定（某些宿主报成 `Agent is not initialized`，实测）。
export default {
    get normalizeProtocolVersion() { return normalizeProtocolVersion },
    get DEFAULT_MIN_VERSION() { return DEFAULT_MIN_VERSION },
    get DEFAULT_MAX_VERSION() { return DEFAULT_MAX_VERSION },
    get rootCertificates() { return rootCertificates },
    get DEFAULT_ECDH_CURVE() { return DEFAULT_ECDH_CURVE },
    get SecureContext() { return SecureContext },
    get createSecureContext() { return createSecureContext },
    get serializeProfileTlsOptions() { return serializeProfileTlsOptions },
    get serializeProfileProxy() { return serializeProfileProxy },
    get TLSSocket() { return TLSSocket },
    get connect() { return connect },
    get Server() { return Server },
    get createServer() { return createServer },
    get getCiphers() { return getCiphers },
    get CryptoStream() { return CryptoStream },
    get SecurePair() { return SecurePair },
    get createSecurePair() { return createSecurePair },
};
