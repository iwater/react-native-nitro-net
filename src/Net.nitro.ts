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
    DRAIN = 5,
    TIMEOUT = 7,
    LOOKUP = 8,
    SESSION = 9,
    KEYLOG = 10,
    OCSP = 11
}

export interface NetSocketDriver extends HybridObject<{ ios: 'swift', android: 'kotlin' }> {
    readonly id: number
    connect(host: string, port: number): void
    connectTLS(host: string, port: number, serverName?: string, rejectUnauthorized?: boolean): void
    connectTLSWithContext(host: string, port: number, serverName?: string, rejectUnauthorized?: boolean, secureContextId?: number): void
    getAuthorizationError(): string | undefined
    getProtocol(): string | undefined
    getCipher(): string | undefined
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
    write(data: ArrayBuffer): void
    pause(): void
    resume(): void
    shutdown(): void
    setTimeout(timeout: number): void
    destroy(): void
    resetAndDestroy(): void
    enableKeylog(): void
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
    DEBUG = 9
}

export interface NetServerDriver extends HybridObject<{ ios: 'swift', android: 'kotlin' }> {
    onEvent: (event: number, data: ArrayBuffer) => void
    listen(port: number, backlog?: number, ipv6Only?: boolean, reusePort?: boolean): void
    listenTLS(port: number, secureContextId: number, backlog?: number, ipv6Only?: boolean, reusePort?: boolean): void
    listenUnix(path: string, backlog?: number): void
    /**
     * Listen on an existing file descriptor (handle)
     * @param fd File descriptor of an already-bound TCP listener
     * @param backlog Listen backlog (optional, defaults to 128)
     */
    listenHandle(fd: number, backlog?: number): void
    getLocalAddress(): string
    maxConnections: number
    close(): void
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
}

export interface NetDriver extends HybridObject<{ ios: 'swift', android: 'kotlin' }> {
    createSocket(id?: string): NetSocketDriver
    createServer(): NetServerDriver
    createSecureContext(cert: string, key: string, passphrase?: string): number
    createEmptySecureContext(): number
    addCACertToSecureContext(scId: number, ca: string): void
    addContextToSecureContext(scId: number, hostname: string, cert: string, key: string, passphrase?: string): void
    setPFXToSecureContext(scId: number, pfx: ArrayBuffer, passphrase?: string): void
    setOCSPResponseToSecureContext(scId: number, ocsp: ArrayBuffer): void
    getTicketKeys(scId: number): ArrayBuffer | undefined
    setTicketKeys(scId: number, keys: ArrayBuffer): void
    /**
     * Initialize the network module with custom configuration
     * Must be called before any other network operations
     * @param config Configuration options
     */
    initWithConfig(config: NetConfig): void
}
