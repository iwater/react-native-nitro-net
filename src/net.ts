import { Duplex, DuplexOptions } from 'readable-stream'
import { EventEmitter } from 'eventemitter3'
import { Driver } from './Driver'
import type { NetSocketDriver, NetServerDriver, NetConfig } from './Net.nitro'
import { NetSocketEvent, NetServerEvent } from './Net.nitro'
import { Buffer } from 'react-native-nitro-buffer'

// -----------------------------------------------------------------------------
// Utils
// -----------------------------------------------------------------------------

function isIP(input: string): number {
    // Simple regex check
    if (/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(input)) return 4;
    // Basic IPv6 check allowing double colons
    if (/^([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$/.test(input)) return 6;
    if (/^((?:[0-9A-Fa-f]{1,4}(?::[0-9A-Fa-f]{1,4})*)?)::((?:[0-9A-Fa-f]{1,4}(?::[0-9A-Fa-f]{1,4})*)?)$/.test(input)) return 6;
    return 0;
}

function isIPv4(input: string): boolean {
    return isIP(input) === 4;
}

function isIPv6(input: string): boolean {
    return isIP(input) === 6;
}
// -----------------------------------------------------------------------------
// Global Configuration
// -----------------------------------------------------------------------------

let _autoSelectFamilyDefault = 4; // Node default is usually 4/6 independent, but we mock it.
let _isVerbose = false;
let _isInitialized = false;

function isVerbose(): boolean {
    return _isVerbose;
}

function setVerbose(enabled: boolean): void {
    _isVerbose = enabled;
}

function debugLog(message: string) {
    if (_isVerbose) {
        const timestamp = new Date().toISOString().split('T')[1].split('Z')[0];
        console.log(`[NET DEBUG ${timestamp}] ${message}`);
    }
}

function getDefaultAutoSelectFamily(): number {
    return _autoSelectFamilyDefault;
}

function setDefaultAutoSelectFamily(family: number): void {
    if (family !== 4 && family !== 6) throw new Error('Family must be 4 or 6');
    _autoSelectFamilyDefault = family;
}

/**
 * Ensures that the network module is initialized.
 * If initWithConfig hasn't been called, it will be called with default options.
 */
function ensureInitialized(): void {
    if (!_isInitialized) {
        initWithConfig({});
    }
}

/**
 * Initialize the network module with custom configuration.
 * Must be called before any socket/server operations, or the config will be ignored.
 * 
 * @param config Configuration options
 * @param config.workerThreads Number of worker threads (0 = use CPU core count)
 * 
 * @example
 * ```ts
 * import { initWithConfig } from 'react-native-nitro-net';
 * 
 * // Initialize with 4 worker threads
 * initWithConfig({ workerThreads: 4 });
 * ```
 */
function initWithConfig(config: NetConfig): void {
    _isInitialized = true;
    if (config.debug !== undefined) {
        setVerbose(config.debug);
    }
    Driver.initWithConfig(config);
}

// -----------------------------------------------------------------------------
// SocketAddress

// -----------------------------------------------------------------------------
// SocketAddress
// -----------------------------------------------------------------------------

export interface SocketAddressOptions {
    address?: string;
    family?: 'ipv4' | 'ipv6';
    port?: number;
    flowlabel?: number;
}

export class SocketAddress {
    readonly address: string;
    readonly family: 'ipv4' | 'ipv6';
    readonly port: number;
    readonly flowlabel: number;

    constructor(options: SocketAddressOptions = {}) {
        this.address = options.address ?? (options.family === 'ipv6' ? '::' : '127.0.0.1');
        this.family = options.family || (isIPv6(this.address) ? 'ipv6' : 'ipv4');
        this.port = options.port ?? 0;
        this.flowlabel = options.flowlabel ?? 0;
    }

    /**
     * Attempts to parse a string containing a socket address.
     * Returns a SocketAddress if successful, or undefined if not.
     * 
     * Supported formats:
     * - `ip:port` (e.g., `127.0.0.1:8080`, `[::1]:8080`)
     * - `ip` only (port defaults to 0)
     */
    static parse(input: string): SocketAddress | undefined {
        if (!input || typeof input !== 'string') return undefined;
        let address: string;
        let port = 0;

        // Handle IPv6 bracket notation: [::1]:port
        const ipv6Match = input.match(/^\[([^\]]+)\]:?(\d*)$/);
        if (ipv6Match) {
            address = ipv6Match[1];
            port = ipv6Match[2] ? parseInt(ipv6Match[2], 10) : 0;
            if (!isIPv6(address)) return undefined;
            return new SocketAddress({ address, port, family: 'ipv6' });
        }

        // Handle IPv4 or IPv6 without brackets
        const lastColon = input.lastIndexOf(':');
        if (lastColon === -1) {
            // No port, just IP
            address = input;
        } else {
            // Determine if the colon is a port separator or part of IPv6
            const potentialPort = input.slice(lastColon + 1);
            const potentialAddr = input.slice(0, lastColon);
            if (/^\d+$/.test(potentialPort) && (isIPv4(potentialAddr) || isIPv6(potentialAddr))) {
                address = potentialAddr;
                port = parseInt(potentialPort, 10);
            } else {
                // It's an IPv6 address without port
                address = input;
            }
        }

        const family = isIPv6(address) ? 'ipv6' : (isIPv4(address) ? 'ipv4' : undefined);
        if (!family) return undefined;
        return new SocketAddress({ address, port, family });
    }
}

// -----------------------------------------------------------------------------
// BlockList
// -----------------------------------------------------------------------------

export interface BlockListRule {
    type: 'address' | 'range' | 'subnet';
    address?: string;
    start?: string;
    end?: string;
    prefix?: number;
    family: 'ipv4' | 'ipv6';
}

export class BlockList {
    private _rules: Array<{ type: 'address' | 'range' | 'subnet', data: any }> = [];

    /** Returns an array of rules added to the blocklist. */
    get rules(): BlockListRule[] {
        return this._rules.map(r => {
            if (r.type === 'address') {
                return { type: 'address' as const, address: r.data.address, family: r.data.family };
            } else if (r.type === 'range') {
                return { type: 'range' as const, start: r.data.start, end: r.data.end, family: r.data.family };
            } else {
                return { type: 'subnet' as const, address: r.data.net, prefix: r.data.prefix, family: r.data.family };
            }
        });
    }

    addAddress(address: string, family?: 'ipv4' | 'ipv6'): void {
        this._rules.push({ type: 'address', data: { address, family: family || (isIPv6(address) ? 'ipv6' : 'ipv4') } });
    }

    addRange(start: string, end: string, family?: 'ipv4' | 'ipv6'): void {
        this._rules.push({ type: 'range', data: { start, end, family: family || (isIPv6(start) ? 'ipv6' : 'ipv4') } });
    }

    addSubnet(net: string, prefix: number, family?: 'ipv4' | 'ipv6'): void {
        this._rules.push({ type: 'subnet', data: { net, prefix, family: family || (isIPv6(net) ? 'ipv6' : 'ipv4') } });
    }

    check(address: string, family?: 'ipv4' | 'ipv6'): boolean {
        const addrFamily = family || (isIPv6(address) ? 'ipv6' : 'ipv4');
        const addrNum = addrFamily === 'ipv4' ? ipv4ToLong(address) : null;

        for (const rule of this._rules) {
            if (rule.data.family !== addrFamily) continue;

            if (rule.type === 'address') {
                if (rule.data.address === address) return true;
            } else if (rule.type === 'range' && addrNum !== null) {
                const start = ipv4ToLong(rule.data.start);
                const end = ipv4ToLong(rule.data.end);
                if (addrNum >= start && addrNum <= end) return true;
            } else if (rule.type === 'subnet' && addrNum !== null) {
                const net = ipv4ToLong(rule.data.net);
                const mask = ~(Math.pow(2, 32 - rule.data.prefix) - 1);
                if ((addrNum & mask) === (net & mask)) return true;
            }
        }
        return false;
    }

    /**
     * Serializes the BlockList to a JSON-compatible format.
     */
    toJSON(): BlockListRule[] {
        return this.rules;
    }

    /**
     * Creates a BlockList from a JSON array of rules.
     */
    static fromJSON(json: BlockListRule[]): BlockList {
        const list = new BlockList();
        for (const rule of json) {
            if (rule.type === 'address' && rule.address) {
                list.addAddress(rule.address, rule.family);
            } else if (rule.type === 'range' && rule.start && rule.end) {
                list.addRange(rule.start, rule.end, rule.family);
            } else if (rule.type === 'subnet' && rule.address && rule.prefix !== undefined) {
                list.addSubnet(rule.address, rule.prefix, rule.family);
            }
        }
        return list;
    }

    /**
     * Checks if a given value is a BlockList instance.
     */
    static isBlockList(value: unknown): value is BlockList {
        return value instanceof BlockList;
    }
}

function ipv4ToLong(ip: string): number {
    return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
}

// -----------------------------------------------------------------------------
// Socket
// -----------------------------------------------------------------------------

export interface SocketOptions extends DuplexOptions {
    fd?: any;
    allowHalfOpen?: boolean;
    readable?: boolean;
    writable?: boolean;
    path?: string;
    // Extension for internal use
    socketDriver?: NetSocketDriver;
    remoteFamily?: string;
}

export class Socket extends Duplex {
    protected _driver: NetSocketDriver | undefined;
    public connecting: boolean = false; // Changed from private _connecting
    protected _connected: boolean = false;
    protected _hadError: boolean = false; // Added
    public remoteAddress?: string;
    public remotePort?: number;
    public remoteFamily?: string;
    public localAddress?: string;
    public localPort?: number;
    public bytesRead: number = 0;
    public bytesWritten: number = 0;
    public autoSelectFamilyAttemptedAddresses: string[] = [];
    private _autoSelectFamily: boolean = false;
    private _timeout: number = 0;

    get localFamily(): string {
        return this.localAddress && this.localAddress.includes(':') ? 'IPv6' : 'IPv4';
    }

    get readyState(): string {
        if (this.connecting) return 'opening';
        if (this._connected) {
            // @ts-ignore
            if (this.writable && this.readable) return 'open';
            // @ts-ignore
            if (this.writable) return 'writeOnly';
            // @ts-ignore
            if (this.readable) return 'readOnly';
        }
        return 'closed';
    }

    get pending(): boolean {
        return this.connecting;
    }
    constructor(options?: SocketOptions) {
        super({
            allowHalfOpen: options?.allowHalfOpen ?? false,
            readable: options?.readable ?? true,
            writable: options?.writable ?? true,
            // @ts-ignore
            autoDestroy: false
        });

        if (options?.socketDriver) {
            // Wrapping existing socket (from Server)
            this._driver = options.socketDriver;
            this._connected = true;
            this._setupEvents();
            // Enable noDelay by default
            this._driver.setNoDelay(true);
            // Resume the socket since it starts paused on server-accept
            this.resume();
            // Emit connect for server-side socket? No, it's already connected.
        } else {
            // New client socket
            ensureInitialized();
            this._driver = Driver.createSocket();
            this._setupEvents();
            // Enable noDelay by default to match Node.js and reduce latency for small writes
            this._driver.setNoDelay(true);
            // Do NOT resume here - socket is not connected yet!
            // resume() will be called after 'connect' event in _connect()
        }

        this.on('finish', () => {
            // Writable side finished
        });
    }

    on(event: string | symbol, listener: (...args: any[]) => void): this {
        if (event === 'connect' && this._connected) {
            process.nextTick(listener);
            return this;
        }
        const ret = super.on(event, listener);
        if (event === 'data' && !this.isPaused() && (this as any).readableFlowing !== true) {
            debugLog(`Socket on('data'), flowing: ${(this as any).readableFlowing}`);
            this.resume();
        }
        return ret;
    }

    private _setupEvents() {
        if (!this._driver) return;
        const id = (this._driver as any).id ?? (this._driver as any)._id;
        this._driver.onEvent = (eventType: number, data: ArrayBuffer) => {
            this.emit('event', eventType, data);
            if (eventType === 3) { // ERROR
                const msg = new TextDecoder().decode(data);
                debugLog(`Socket (id: ${id}) NATIVE ERROR: ${msg}`);
            }
            if (eventType === 9) { // SESSION/DEBUG
                debugLog(`Socket (id: ${id}) NATIVE SESSION EVENT RECEIVED`);
                this.emit('session', data);
                return;
            }
            debugLog(`Socket (id: ${id}, localPort: ${this.localPort}) Event TYPE: ${eventType}, data len: ${data?.byteLength}`);
            switch (eventType) {
                case NetSocketEvent.CONNECT:
                    this.connecting = false;
                    this._connected = true;
                    this._updateAddresses();
                    // Now that we're connected, start receiving data
                    this.resume();
                    this.emit('connect');
                    this.emit('ready');
                    break;
                case NetSocketEvent.DATA:
                    debugLog(`Socket onEvent(DATA), len: ${data?.byteLength}, flowing: ${(this as any).readableFlowing}`);
                    if (data && data.byteLength > 0) {
                        const buffer = Buffer.from(data);
                        this.bytesRead += buffer.length;
                        if (!this.push(buffer)) {
                            this.pause();
                        }
                    }
                    break;
                case NetSocketEvent.ERROR: {
                    this._hadError = true;
                    const errorMsg = data ? Buffer.from(data).toString() : 'Unknown socket error';
                    const error = new Error(errorMsg);

                    if (this.connecting && this._autoSelectFamily) {
                        // If we were connecting, this is a connection attempt failure
                        // We attempt to get the last attempted address if available
                        const lastAttempt = this.autoSelectFamilyAttemptedAddresses[this.autoSelectFamilyAttemptedAddresses.length - 1];
                        if (lastAttempt) {
                            const [ip, port] = lastAttempt.split(':'); // distinct if ipv6?
                            // Simple parsing for event emission
                            const family = ip.includes(':') ? 6 : 4;
                            this.emit('connectionAttemptFailed', ip, parseInt(port || '0', 10), family, error);
                        }
                    }

                    this.emit('error', error);
                    this.destroy();
                    break;
                }
                case NetSocketEvent.CLOSE:
                    this._connected = false;
                    this.connecting = false;
                    this.push(null); // EOF
                    this.emit('close', this._hadError);
                    break;
                case NetSocketEvent.DRAIN:
                    this.emit('drain');
                    break;
                case NetSocketEvent.TIMEOUT:
                    if (this.connecting && this._autoSelectFamily) {
                        const lastAttempt = this.autoSelectFamilyAttemptedAddresses[this.autoSelectFamilyAttemptedAddresses.length - 1];
                        if (lastAttempt) {
                            const [ip, port] = lastAttempt.split(':');
                            const family = ip.includes(':') ? 6 : 4;
                            this.emit('connectionAttemptTimeout', ip, parseInt(port || '0', 10), family);
                        }
                    }
                    this.emit('timeout');
                    break;
                case NetSocketEvent.LOOKUP: {
                    if (data) {
                        const lookupStr = Buffer.from(data).toString();
                        const parts = lookupStr.split(',');
                        if (parts.length >= 2) {
                            const [ip, family] = parts;
                            this.remoteAddress = ip;
                            this.remoteFamily = family === '6' ? 'IPv6' : 'IPv4';

                            // Emit connectionAttempt
                            // We don't have the port in LOOKUP data usually, but we stored it in this.remotePort (dest)
                            // actually remotePort might not be set yet if we used _connect with port arg.
                            // But _connect sets this.remotePort = port.
                            const port = this.remotePort || 0;
                            const fam = family === '6' ? 6 : 4;
                            if (this._autoSelectFamily) {
                                this.emit('connectionAttempt', ip, port, fam);
                            }
                            this.autoSelectFamilyAttemptedAddresses.push(`${ip}:${port}`);
                        }
                        const host = parts.length > 2 ? parts[2] : undefined;
                        this.emit('lookup', null, parts[0], parts[1] ? parseInt(parts[1], 10) : undefined, host);
                    }
                    break;
                }
            }
        };
    }


    private _updateAddresses() {
        try {
            const local = this._driver?.getLocalAddress();
            if (local) {
                const parts = local.split(':');
                if (parts.length >= 2) {
                    this.localPort = parseInt(parts[parts.length - 1], 10);
                    this.localAddress = parts.slice(0, parts.length - 1).join(':').replace(/[\[\]]/g, '');
                }
            }
            const remote = this._driver?.getRemoteAddress();
            if (remote) {
                const parts = remote.split(':');
                if (parts.length >= 2) {
                    this.remotePort = parseInt(parts[parts.length - 1], 10);
                    this.remoteAddress = parts.slice(0, parts.length - 1).join(':').replace(/[\[\]]/g, '');
                    this.remoteFamily = this.remoteAddress.includes(':') ? 'IPv6' : 'IPv4';
                }
            }
        } catch (e) {
            // Ignore errors for now
        }
    }

    address(): { port: number; family: string; address: string } | null {
        if (!this.localAddress) return null;
        return {
            port: this.localPort || 0,
            family: this.localAddress.includes(':') ? 'IPv6' : 'IPv4',
            address: this.localAddress
        };
    }

    connect(options: any, connectionListener?: () => void): this {
        if (typeof options === 'string') {
            // Path?
            if (isNaN(Number(options))) {
                return this._connectUnix(options, connectionListener);
            }
        }

        if (typeof options === 'number' || typeof options === 'string') {
            const port = Number(options);
            const host = (arguments.length > 1 && typeof arguments[1] === 'string') ? arguments[1] : 'localhost';
            const cb = typeof arguments[1] === 'function' ? arguments[1] : connectionListener;
            // Default: Node 20 defaults autoSelectFamily to true
            this._autoSelectFamily = true;
            return this._connect(port, host, cb || arguments[2]);
        }

        if (options.path) {
            return this._connectUnix(options.path, connectionListener, options.signal);
        }

        const port = options.port;
        const host = options.host || 'localhost';

        // Handle autoSelectFamily option
        if (typeof options.autoSelectFamily === 'boolean') {
            this._autoSelectFamily = options.autoSelectFamily;
        } else {
            this._autoSelectFamily = true;
        }

        debugLog(`Socket.connect: target=${host}:${port}, autoSelectFamily=${this._autoSelectFamily}`);
        return this._connect(port, host, connectionListener, options.signal);
    }

    private _connect(port: number, host: string, listener?: () => void, signal?: AbortSignal): this {
        this.remotePort = port; // Store intended remote port
        if (this.connecting || this._connected) return this;
        if (signal?.aborted) {
            process.nextTick(() => this.emit('error', new Error('The operation was aborted')));
            return this;
        }
        this.connecting = true;
        if (listener) this.once('connect', listener);

        if (signal) {
            const abortHandler = () => {
                this.destroy(new Error('The operation was aborted'));
            };
            signal.addEventListener('abort', abortHandler, { once: true });
            this.once('connect', () => signal.removeEventListener('abort', abortHandler));
            this.once('close', () => signal.removeEventListener('abort', abortHandler));
        }

        debugLog(`Socket._connect: Calling driver.connect(${host}, ${port})`);
        this._driver?.connect(host, port);
        return this;
    }

    private _connectUnix(path: string, listener?: () => void, signal?: AbortSignal): this {
        if (this.connecting || this._connected) return this;
        if (signal?.aborted) {
            process.nextTick(() => this.emit('error', new Error('The operation was aborted')));
            return this;
        }
        this.connecting = true;
        if (listener) this.once('connect', listener);

        if (signal) {
            const abortHandler = () => {
                this.destroy(new Error('The operation was aborted'));
            };
            signal.addEventListener('abort', abortHandler, { once: true });
            this.once('connect', () => signal.removeEventListener('abort', abortHandler));
            this.once('close', () => signal.removeEventListener('abort', abortHandler));
        }

        this._driver?.connectUnix(path);
        return this;
    }

    end(cb?: () => void): this;
    end(chunk: any, cb?: () => void): this;
    end(chunk: any, encoding: string, cb?: () => void): this;
    end(chunk?: any, encoding?: any, cb?: any): this {
        debugLog(`Socket (localPort: ${this.localPort}) .end() called`);
        return super.end(chunk, encoding, cb);
    }

    _write(chunk: any, encoding: string, callback: (error?: Error | null) => void): void {
        if (!this._driver) {
            return callback(new Error('Socket not connected'));
        }
        try {
            const buffer = (chunk instanceof Buffer) ? chunk : Buffer.from(chunk, encoding as any);
            this.bytesWritten += buffer.length;
            const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
            debugLog(`Socket _write, len: ${ab.byteLength}`);
            this._driver.write(ab);
            callback(null);
        } catch (err: any) {
            callback(err);
        }
    }

    _read(size: number): void {
        if (this._driver) this._driver.resume();
    }

    _final(callback: (error?: Error | null) => void): void {
        if (this._driver) {
            this._driver.shutdown();
        }
        callback(null);
    }

    destroy(reason?: Error): this {
        debugLog(`Socket (localPort: ${this.localPort}) .destroy() called, reason: ${reason?.message}`);
        return super.destroy(reason);
    }

    _destroy(err: Error | null, callback: (error: Error | null) => void) {
        debugLog(`Socket (localPort: ${this.localPort}) ._destroy() called`);
        this._connected = false;
        this.connecting = false;
        this.destroyed = true;
        if (this._driver) {
            this._driver.destroy();
            this._driver = undefined;
        }
        callback(err);
    }

    // Standard net.Socket methods
    setTimeout(msecs: number, callback?: () => void): this {
        this._timeout = msecs;
        if (this._driver) {
            this._driver.setTimeout(msecs);
        }
        if (callback) this.once('timeout', callback);
        return this;
    }

    /**
     * Pause the reading of data. That is, 'data' events will not be emitted.
     * Useful to throttle back an upload.
     */
    pause(): this {
        super.pause();
        if (this._driver) {
            this._driver.pause();
        }
        return this;
    }

    /**
     * Resume reading after a call to pause().
     */
    resume(): this {
        const driver = this._driver as any;
        const id = driver?.id;
        debugLog(`Socket.resume() called, id: ${id === undefined ? 'none' : id}, destroyed: ${this.destroyed}`);
        super.resume();
        if (driver) {
            debugLog(`Socket.resume() calling driver.resume(), id: ${id}`);
            driver.resume();
        }
        return this;
    }

    /**
     * Enable/disable the use of Nagle's algorithm.
     */
    setNoDelay(noDelay?: boolean): this {
        this._driver?.setNoDelay(noDelay !== false);
        return this;
    }

    setKeepAlive(enable?: boolean, initialDelay?: number): this {
        this._driver?.setKeepAlive(enable !== false, initialDelay || 0);
        return this;
    }

    ref(): this { return this; }
    unref(): this { return this; }

    /**
     * Set the encoding for the socket as a Readable Stream.
     * Use 'utf8', 'hex', etc.
     */
    setEncoding(encoding: BufferEncoding): this {
        super.setEncoding(encoding);
        return this;
    }

    get timeout(): number {
        return this._timeout;
    }

    get bufferSize(): number {
        return 0; // Deprecated but often accessed
    }

    resetAndDestroy(): this {
        if (this._driver) {
            this._driver.resetAndDestroy();
            this._driver = undefined;
        }
        this._connected = false;
        this.connecting = false;
        this.destroyed = true;
        return this;
    }
}

// -----------------------------------------------------------------------------
// Server
// -----------------------------------------------------------------------------

export class Server extends EventEmitter {
    private _driver: NetServerDriver;
    private _sockets = new Set<Socket>();
    private _connections: number = 0;

    private _maxConnections: number = 0;
    private _dropMaxConnection: boolean = false;

    get maxConnections(): number {
        return this._maxConnections;
    }

    set maxConnections(value: number) {
        this._maxConnections = value;
        // We handle maxConnections in JS to support 'drop' event.
        // Disable native limit to ensure we receive the connection attempt.
        this._driver.maxConnections = 0;
    }

    get dropMaxConnection(): boolean {
        return this._dropMaxConnection;
    }

    set dropMaxConnection(value: boolean) {
        this._dropMaxConnection = value;
    }

    get listening(): boolean {
        // If we have a driver and we assume it's listening if it has been started?
        // Actually, checking _driver state might be hard if not exposed.
        // But typically 'listening' is true after 'listening' event.
        // We can track it with a private flag or by checking address() which returns null if not listening.
        return !!this.address();
    }

    constructor(options?: any, connectionListener?: (socket: Socket) => void) {
        super();
        ensureInitialized();
        this._driver = Driver.createServer();

        if (typeof options === 'function') {
            connectionListener = options;
            options = {};
        }

        if (connectionListener) {
            this.on('connection', connectionListener);
        }

        this._driver.onEvent = (eventType: number, data: ArrayBuffer) => {
            switch (eventType) {
                case NetServerEvent.CONNECTION: {
                    const payload = data ? Buffer.from(data).toString() : '';
                    if (payload === 'success') {
                        this.emit('listening');
                    } else {
                        const clientId = payload;
                        debugLog(`Server connection clientId: '${clientId}', current connections: ${this._connections}, max: ${this._maxConnections}`);
                        if (clientId) {
                            // Check maxConnections
                            if (this._maxConnections > 0 && this._connections >= this._maxConnections) {
                                debugLog(`Server maxConnections reached (${this._connections} >= ${this._maxConnections}). Dropping connection. clientId: ${clientId}`);

                                const socketDriver = Driver.createSocket(clientId);
                                const socket = new Socket({
                                    socketDriver: socketDriver,
                                    readable: true,
                                    writable: true
                                });
                                // @ts-ignore
                                socket._updateAddresses();

                                this.emit('drop', {
                                    localAddress: socket.localAddress,
                                    localPort: socket.localPort,
                                    localFamily: socket.localFamily,
                                    remoteAddress: socket.remoteAddress,
                                    remotePort: socket.remotePort,
                                    remoteFamily: socket.remoteFamily
                                });

                                socket.destroy();
                                return;
                            }

                            const socketDriver = Driver.createSocket(clientId);
                            const socket = new Socket({
                                socketDriver: socketDriver,
                                readable: true,
                                writable: true
                            });

                            // Initialize addresses immediately for server-side socket
                            // @ts-ignore
                            socket._updateAddresses();
                            debugLog(`Socket initialized addresses: local=${socket.localAddress}:${socket.localPort}, remote=${socket.remoteAddress}:${socket.remotePort}`);

                            // Keep reference to prevent GC
                            this._sockets.add(socket);
                            this._connections++;
                            socket.on('close', () => {
                                this._connections--;
                                this._sockets.delete(socket);
                            });
                            this.emit('connection', socket);
                        }
                    }
                    break;
                }
                case NetServerEvent.ERROR:
                    this.emit('error', new Error(data ? Buffer.from(data).toString() : 'Unknown server error'));
                    break;
                case NetServerEvent.DEBUG: {
                    debugLog(`Server NATIVE SESSION/DEBUG EVENT RECEIVED`);
                    this.emit('session', data);
                    break;
                }
                case NetServerEvent.CLOSE:
                    this.emit('close');
                    break;
            }
        };
    }


    ref(): this { return this; }
    unref(): this { return this; }

    // @ts-ignore
    [Symbol.asyncDispose](): Promise<void> {
        return new Promise((resolve) => {
            this.close(() => resolve());
        });
    }
    listen(port?: any, host?: any, backlog?: any, callback?: any): this {
        let _port = 0;
        let _host: string | undefined;
        let _backlog: number | undefined;
        let _path: string | undefined;
        let _callback: (() => void) | undefined;
        let signal: AbortSignal | undefined;
        let ipv6Only = false;
        let reusePort = false;
        let handle: { fd?: number } | undefined;

        if (typeof port === 'object' && port !== null) {
            // Check if it's a handle object with fd property
            if (typeof port.fd === 'number') {
                handle = port;
                _backlog = port.backlog;
                _callback = host; // listen(handle, cb)
            } else {
                _port = port.port;
                _host = port.host;
                _backlog = port.backlog;
                _path = port.path;
                signal = port.signal;
                ipv6Only = port.ipv6Only === true;
                reusePort = port.reusePort === true;
                _callback = host; // listen(options, cb)
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

        if (signal?.aborted) {
            process.nextTick(() => this.emit('error', new Error('The operation was aborted')));
            return this;
        }

        if (signal) {
            const abortHandler = () => {
                this.close();
                this.emit('error', new Error('The operation was aborted'));
            };
            signal.addEventListener('abort', abortHandler, { once: true });
            this.once('listening', () => signal.removeEventListener('abort', abortHandler));
            this.once('close', () => signal.removeEventListener('abort', abortHandler));
        }

        if (handle && typeof handle.fd === 'number') {
            // Listen on an existing file descriptor (handle)
            this._driver.listenHandle(handle.fd, _backlog);
        } else if (_path) {
            this._driver.listenUnix(_path, _backlog);
        } else {
            this._driver.listen(_port || 0, _backlog, ipv6Only, reusePort);
        }

        return this;
    }

    close(callback?: (err?: Error) => void): this {
        // Destroy all active connections first
        for (const socket of this._sockets) {
            socket.destroy();
        }
        this._sockets.clear();
        this._connections = 0;

        this._driver.close();
        if (callback) this.once('close', callback);
        return this;
    }

    address(): { port: number; family: string; address: string } | null {
        try {
            const addr = this._driver.getLocalAddress();
            if (addr) {
                const parts = addr.split(':');
                if (parts.length >= 2) {
                    const port = parseInt(parts[parts.length - 1], 10);
                    const address = parts.slice(0, parts.length - 1).join(':').replace(/[\[\]]/g, '');
                    const family = address.includes(':') ? 'IPv6' : 'IPv4';
                    return { port, family, address };
                }
            }
        } catch (e) {
            // Ignore
        }
        return null;
    }

    getConnections(cb: (err: Error | null, count: number) => void): void {
        cb(null, this._connections);
    }
}

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

export function createConnection(options: any, connectionListener?: () => void): Socket {
    const socket = new Socket(options);
    return socket.connect(options, connectionListener);
}

export const connect = createConnection;

export function createServer(options?: any, connectionListener?: (socket: Socket) => void): Server {
    return new Server(options, connectionListener);
}


export {
    isIP,
    isIPv4,
    isIPv6,
    getDefaultAutoSelectFamily,
    setDefaultAutoSelectFamily,
    isVerbose,
    setVerbose,
    initWithConfig,
};

export type { NetConfig };

export default {
    Socket,
    Server,
    SocketAddress,
    BlockList,
    createConnection,
    createServer,
    connect,
    isIP,
    isIPv4,
    isIPv6,
    getDefaultAutoSelectFamily,
    setDefaultAutoSelectFamily,
    setVerbose,
    initWithConfig,
};
