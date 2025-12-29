import * as http from './http'
import * as tls from './tls'
import { Driver } from './Driver'
import { Buffer } from 'react-native-nitro-buffer'
import { IncomingMessage } from './http'

// ========== Server ==========

export class Server extends tls.Server {
    private _httpConnections = new Set<any>();
    public maxHeaderSize: number = 16384;
    public maxRequestsPerSocket: number = 0;
    public headersTimeout: number = 60000;
    public requestTimeout: number = 300000;
    public keepAliveTimeout: number = 5000;

    constructor(options?: any, requestListener?: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
        if (typeof options === 'function') {
            requestListener = options;
            options = {};
        }
        super(options);

        if (requestListener) {
            this.on('request', requestListener);
        }

        // Initialize HTTP connection setup for secure connections
        this.on('secureConnection', (socket: any) => {
            // @ts-ignore - access internal http logic
            (http.Server.prototype as any)._setupHttpConnection.call(this, socket);
        });
    }

    public setTimeout(ms: number, callback?: () => void): this {
        // @ts-ignore - access netServer via super's internal or cast
        (this as any)._netServer.setTimeout(ms, callback);
        return this;
    }
}

export function createServer(options?: any, requestListener?: (req: http.IncomingMessage, res: http.ServerResponse) => void): Server {
    return new Server(options, requestListener);
}

// ========== ClientRequest ==========

export class ClientRequest extends http.ClientRequest {
    constructor(options: any, callback?: (res: http.IncomingMessage) => void) {
        if (typeof options === 'string') {
            options = new URL(options);
        }
        if (options instanceof URL) {
            options = {
                protocol: options.protocol,
                hostname: options.hostname,
                path: options.pathname + options.search,
                port: options.port ? parseInt(options.port) : 443
            };
        }
        options.protocol = 'https:';
        super(options, callback);
    }
}

export function request(
    urlOrOptions: string | URL | http.RequestOptions,
    optionsOrCallback?: http.RequestOptions | ((res: http.IncomingMessage) => void),
    callback?: (res: http.IncomingMessage) => void
): ClientRequest {
    let opts: http.RequestOptions = {};
    let cb: ((res: http.IncomingMessage) => void) | undefined = callback;

    if (typeof urlOrOptions === 'string') {
        const url = new URL(urlOrOptions);
        opts = {
            protocol: url.protocol,
            hostname: url.hostname,
            path: url.pathname + url.search,
            port: url.port ? parseInt(url.port) : 443
        };
    } else if (urlOrOptions instanceof URL) {
        opts = {
            protocol: urlOrOptions.protocol,
            hostname: urlOrOptions.hostname,
            path: urlOrOptions.pathname + urlOrOptions.search,
            port: urlOrOptions.port ? parseInt(urlOrOptions.port) : 443
        };
    } else {
        opts = { ...urlOrOptions };
    }

    if (typeof optionsOrCallback === 'function') {
        cb = optionsOrCallback;
    } else if (optionsOrCallback) {
        opts = { ...opts, ...optionsOrCallback };
    }

    opts.protocol = 'https:';
    return new ClientRequest(opts, cb);
}

export function get(
    urlOrOptions: string | URL | http.RequestOptions,
    optionsOrCallback?: http.RequestOptions | ((res: http.IncomingMessage) => void),
    callback?: (res: http.IncomingMessage) => void
): ClientRequest {
    const req = request(urlOrOptions, optionsOrCallback, callback);
    req.end();
    return req;
}

// ========== Agent ==========

export class Agent extends http.Agent {
    constructor(options?: any) {
        super(options);
    }
}

export const globalAgent = new Agent({
    keepAlive: true,
    scheduling: 'lifo',
    timeout: 5000,
});

export { IncomingMessage };
