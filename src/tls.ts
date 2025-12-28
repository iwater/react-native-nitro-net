import { Socket, Server as NetServer, SocketOptions } from './index'
import { Driver } from './Driver'
import { NetSocketDriver } from './Net.nitro'

export interface PeerCertificate {
    subject: { [key: string]: string }
    issuer: { [key: string]: string }
    valid_from: string
    valid_to: string
    fingerprint: string
    fingerprint256: string
    serialNumber: string
}

export interface ConnectionOptions extends SocketOptions {
    host?: string
    port?: number
    path?: string
    servername?: string // SNI
    rejectUnauthorized?: boolean
    session?: ArrayBuffer // TLS Session ticket for resumption
    secureContext?: SecureContext
    ca?: string | string[]
    cert?: string | string[]
    key?: string | string[]
    pfx?: string | ArrayBuffer
    passphrase?: string
    keylog?: boolean // Enable keylogging (SSLKEYLOGFILE format)
}

export interface SecureContextOptions {
    pfx?: string | ArrayBuffer
    passphrase?: string
    cert?: string | string[]
    key?: string | string[]
    ca?: string | string[]
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
            const pfx = typeof options.pfx === 'string' ? Buffer.from(options.pfx).buffer : options.pfx;
            Driver.setPFXToSecureContext(this._id, pfx, options.passphrase);
        } else if (options && options.cert && options.key) {
            const cert = Array.isArray(options.cert) ? options.cert[0] : options.cert;
            const key = Array.isArray(options.key) ? options.key[0] : options.key;
            this._id = Driver.createSecureContext(cert, key, options.passphrase);
        } else {
            this._id = Driver.createEmptySecureContext();
        }

        if (options && options.ca) {
            const cas = Array.isArray(options.ca) ? options.ca : [options.ca];
            for (const ca of cas) {
                Driver.addCACertToSecureContext(this._id, ca);
            }
        }
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
    addCACert(ca: string): void {
        Driver.addCACertToSecureContext(this._id, ca);
    }
}

export function createSecureContext(options?: SecureContextOptions): SecureContext {
    return new SecureContext(options);
}

export class TLSSocket extends Socket {
    private _servername?: string

    get encrypted(): boolean {
        return true
    }

    get servername(): string | undefined {
        return this._servername
    }

    get authorized(): boolean {
        const driver = (this as any)._driver as NetSocketDriver
        return driver.getAuthorizationError() === undefined
    }

    get authorizationError(): string | undefined {
        const driver = (this as any)._driver as NetSocketDriver
        return driver.getAuthorizationError()
    }

    get alpnProtocol(): string | undefined {
        const driver = (this as any)._driver as NetSocketDriver
        return driver.getALPN()
    }

    getProtocol(): string | undefined {
        const driver = (this as any)._driver as NetSocketDriver
        return driver.getProtocol()
    }

    getCipher(): { name: string, version: string } | undefined {
        const driver = (this as any)._driver as NetSocketDriver
        const cipher = driver.getCipher()
        const protocol = driver.getProtocol()
        if (cipher) {
            return {
                name: cipher,
                version: protocol || 'Unknown'
            }
        }
        return undefined
    }

    getPeerCertificate(detailed?: boolean): PeerCertificate | {} {
        const driver = (this as any)._driver as NetSocketDriver
        const json = driver.getPeerCertificateJSON()
        if (json) {
            try {
                return JSON.parse(json) as PeerCertificate
            } catch (e) {
                console.error('Failed to parse peer certificate JSON', e)
            }
        }
        return {}
    }

    isSessionReused(): boolean {
        const driver = (this as any)._driver as NetSocketDriver
        return driver.isSessionReused()
    }

    getSession(): ArrayBuffer | undefined {
        const driver = (this as any)._driver as NetSocketDriver
        return driver.getSession()
    }

    getEphemeralKeyInfo(): string | undefined {
        const driver = (this as any)._driver as NetSocketDriver
        return driver.getEphemeralKeyInfo()
    }

    getFinished(): Buffer | undefined {
        throw new Error('getFinished is not supported by rustls');
    }

    getPeerFinished(): Buffer | undefined {
        throw new Error('getPeerFinished is not supported by rustls');
    }

    getSharedSigalgs(): string | undefined {
        const driver = (this as any)._driver as NetSocketDriver
        return driver.getSharedSigalgs()
    }

    renegotiate(options: any, callback: (err: Error | null) => void): boolean {
        if (callback) {
            process.nextTick(() => callback(new Error('Renegotiation is not supported by rustls')));
        }
        return false;
    }

    disableRenegotiation(): void {
        // No-op, already effectively disabled
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
            }
        })
    }

    override connect(options: any, connectionListener?: () => void): this {
        // Override connect to use connectTLS
        const port = typeof options === 'number' ? options : options.port
        const host = (typeof options === 'object' && options.host) ? options.host : (typeof options === 'string' ? arguments[1] : 'localhost')
        const path = (typeof options === 'object' && options.path) ? options.path : undefined
        const servername = (typeof options === 'object' && options.servername) ? options.servername : (path ? 'localhost' : host)
        this._servername = servername
        const rejectUnauthorized = (typeof options === 'object' && options.rejectUnauthorized !== undefined) ? options.rejectUnauthorized : true
        const session = (typeof options === 'object' && options.session) ? options.session : undefined

        const driver = (this as any)._driver as NetSocketDriver

        if (driver) {
            this.connecting = true;
            if (connectionListener) this.once('secureConnect', connectionListener);

            this.once('connect', () => {
                this.emit('secureConnect')
            })

            if (session) {
                driver.setSession(session)
            }

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

            if (path) {
                if (secureContextId !== undefined) {
                    driver.connectUnixTLSWithContext(path, servername, rejectUnauthorized, secureContextId)
                } else {
                    driver.connectUnixTLS(path, servername, rejectUnauthorized)
                }
            } else {
                if (secureContextId !== undefined) {
                    driver.connectTLSWithContext(host, port, servername, rejectUnauthorized, secureContextId)
                } else {
                    driver.connectTLS(host, port, servername, rejectUnauthorized)
                }
            }
        }

        return this
    }
}

export function connect(options: ConnectionOptions, connectionListener?: () => void): TLSSocket
export function connect(port: number, host?: string, options?: ConnectionOptions, connectionListener?: () => void): TLSSocket
export function connect(port: number, options?: ConnectionOptions, connectionListener?: () => void): TLSSocket
export function connect(...args: any[]): TLSSocket {
    let port: number
    let host: string = 'localhost'
    let options: ConnectionOptions = {}
    let listener: (() => void) | undefined

    if (typeof args[0] === 'object') {
        options = args[0]
        port = options.port || 443
        host = options.host || 'localhost'
        listener = args[1]
    } else {
        port = args[0]
        if (typeof args[1] === 'string') {
            host = args[1]
            options = args[2] || {}
            listener = args[3]
        } else if (typeof args[1] === 'object') {
            options = args[1]
            listener = args[2]
        } else if (typeof args[1] === 'function') {
            listener = args[1]
        }
    }

    const socket = new TLSSocket(options)
    socket.connect({
        port,
        host,
        ...options
    }, listener)
    return socket
}

export class Server extends NetServer {
    private _secureContextId: number = 0;

    constructor(options?: any, connectionListener?: (socket: Socket) => void) {
        super(options);

        if (options && options.secureContext) {
            this._secureContextId = (options.secureContext as SecureContext).id;
        } else if (options && (options.key || options.cert || options.ca)) {
            this._secureContextId = createSecureContext({
                cert: options.cert,
                key: options.key,
                ca: options.ca
            }).id;
        }

        this.on('connection', (socket: Socket) => {
            const tlsSocket = new TLSSocket(socket);
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

    addContext(hostname: string, context: { key: string, cert: string }): void {
        if (!this._secureContextId) {
            throw new Error("Cannot addContext to a non-TLS server. Provide initial cert/key in constructor.");
        }
        Driver.addContextToSecureContext(this._secureContextId, hostname, context.cert, context.key);
    }

    setSecureContext(options: { key: string, cert: string, ca?: string | string[] }): void {
        this._secureContextId = createSecureContext(options).id;
    }

    getTicketKeys(): ArrayBuffer | undefined {
        return this._secureContextId ? Driver.getTicketKeys(this._secureContextId) : undefined;
    }

    setTicketKeys(keys: ArrayBuffer): void {
        if (!this._secureContextId) throw new Error("Not a TLS server");
        Driver.setTicketKeys(this._secureContextId, keys);
    }

    override listen(port?: any, host?: any, backlog?: any, callback?: any): this {
        if (!this._secureContextId) {
            return super.listen(port, host, backlog, callback);
        }

        let _port = 0;
        let _host: string | undefined;
        let _backlog: number | undefined;
        let _path: string | undefined;
        let _callback: (() => void) | undefined;
        let ipv6Only = false;
        let reusePort = false;
        let handle: { fd?: number } | undefined;

        if (typeof port === 'object' && port !== null) {
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
            _port = typeof port === 'number' ? port : (typeof port === 'string' && !isNaN(Number(port)) ? Number(port) : 0);
            if (typeof port === 'string' && isNaN(Number(port))) _path = port;

            if (typeof host === 'string') _host = host;
            else if (typeof host === 'function') _callback = host;

            if (typeof backlog === 'number') _backlog = backlog;
            else if (typeof backlog === 'function') _callback = backlog;

            if (typeof callback === 'function') _callback = callback;
        }

        if (_callback) this.once('listening', _callback);

        const driver = (this as any)._driver;

        if (handle || _path) {
            console.warn("TLS over Unix sockets/handles not fully implemented yet");
        }

        driver.listenTLS(_port || 0, this._secureContextId, _backlog, ipv6Only, reusePort);

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

export function checkServerIdentity(hostname: string, cert: PeerCertificate): Error | undefined {
    const subject = cert.subject;
    const dnsNames: string[] = [];

    // In a real implementation we'd extract SANs from the cert object if available.
    // Our PeerCertificate already has subject.CN.
    if (subject && subject.CN) {
        dnsNames.push(subject.CN);
    }

    // SANs are preferred over CN but our current peer_cert JSON might not have them exploded yet
    // unless x509-parser logic is updated. For now, we match against CN.
    // Wildcard matching logic:
    const matchHash = (host: string, pattern: string) => {
        const parts = host.split('.');
        const patternParts = pattern.split('.');
        if (parts.length !== patternParts.length) return false;
        for (let i = 0; i < parts.length; i++) {
            if (patternParts[i] === '*') continue;
            if (parts[i].toLowerCase() !== patternParts[i].toLowerCase()) return false;
        }
        return true;
    };

    const matches = dnsNames.some(name => {
        if (name.includes('*')) {
            return matchHash(hostname, name);
        }
        return name.toLowerCase() === hostname.toLowerCase();
    });

    if (!matches) {
        const err = new Error(`Hostname/IP does not match certificate's altnames: Host: ${hostname}. is not in cert's altnames: ${dnsNames.join(', ')}`);
        (err as any).reason = 'Host name mismatch';
        (err as any).host = hostname;
        (err as any).cert = cert;
        return err;
    }

    return undefined;
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
