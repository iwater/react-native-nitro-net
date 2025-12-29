# Node.js `http` Module Compatibility Audit

This document compares the `react-native-nitro-net` implementation of the `http` module with the official Node.js API.

**Overall Status**: ✅ **Fully Complete (100% Core API Surface)**
The module provides full feature parity, including `Agent` connection pooling, detailed `ClientRequest` lifecycle management, and full `Server` functionality with protocol upgrades.

## 1. Classes

| Class | Status | Notes |
| :--- | :--- | :--- |
| `http.Agent` | ✅ Supported | Supports `keepAlive`, concurrency limits, auto-proxy config, and `destroy()`. |
| `http.ClientRequest` | ✅ Supported | Extends `OutgoingMessage`. Supports streaming writes, auto-chunking, `101 Upgrade` detection. |
| `http.IncomingMessage` | ✅ Supported | Extends `Readable`. Supports streaming reads (Headers & Body), and **Trailers** access. |
| `http.Server` | ✅ Supported | Supports `connection` handling, `request`/`checkContinue`/`upgrade`/`connect` events. |
| `http.ServerResponse` | ✅ Supported | Extends `OutgoingMessage`. Supports delayed header sending, streaming writes, and **Trailers**. |
| `http.OutgoingMessage`| ✅ Supported | Base class providing header management, timeout handling, and chunked encoding logic. |

## 2. Global Functions

| Function | Status | Notes |
| :--- | :--- | :--- |
| `http.createServer([options], [requestListener])` | ✅ Supported | Supports 2 overloaded signatures. |
| `http.request(url, [options], [callback])` | ✅ Supported | Supports 3 overloaded signatures. |
| `http.get(url, [options], [callback])` | ✅ Supported | Convenience wrapper for GET requests. |
| `http.globalAgent` | ✅ Supported | Global default agent. |
| `http.METHODS` | ✅ Supported | List of supported HTTP methods. |
| `http.STATUS_CODES` | ✅ Supported | Map of status codes to standard messages. |

## 3. `http.Agent` API

| Option / Method | Status | Notes |
| :--- | :--- | :--- |
| `options.keepAlive` | ✅ Supported | |
| `options.keepAliveMsecs` | ✅ Supported | |
| `options.maxSockets` | ✅ Supported | |
| `options.maxFreeSockets` | ✅ Supported | |
| `options.timeout` | ✅ Supported | |
| `options.maxTotalSockets` | ✅ Supported | Extended feature. |
| `options.scheduling` | ✅ Supported | 'fifo' or 'lifo'. |
| `options.maxCachedSessions` | ✅ Supported | TLS session reuse. |
| `agent.createConnection()` | ✅ Supported | |
| `agent.destroy()` | ✅ Supported | |
| `agent.getName()` | ✅ Supported | |
| `agent.getProxy()` | ✅ Supported | Auto-detects `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY`. |

## 4. `http.Server` API

| Method / Property | Status | Notes |
| :--- | :--- | :--- |
| `server.listen()` | ✅ Supported | |
| `server.close()` | ✅ Supported | |
| `server.address()` | ✅ Supported | |
| `server.setTimeout()` | ✅ Supported | Delegates to underlying `net.Server`. |
| `server.maxHeaderSize` | ✅ Supported | Default: 16KB. |
| `server.headersTimeout` | ✅ Supported | Default: 60s. |
| `server.requestTimeout` | ✅ Supported | Default: 300s. |
| `server.keepAliveTimeout` | ✅ Supported | Default: 5s. |
| `server.maxRequestsPerSocket` | ✅ Supported | |
| `server.listening` | ✅ Supported | |
| `server.maxConnections` | ✅ Supported | Manually managed. |
| `event: 'request'` | ✅ Supported | |
| `event: 'listening'` | ✅ Supported | |
| `event: 'error'` | ✅ Supported | |
| `event: 'close'` | ✅ Supported | |
| `event: 'upgrade'` | ✅ Supported | Supports `websocket` upgrades. |
| `event: 'checkContinue'` | ✅ Supported | `Expect: 100-continue` support. |
| `event: 'connect'` | ✅ Supported | HTTP Tunneling support. |

## 5. `http.ClientRequest` API

| Method / Event | Status | Notes |
| :--- | :--- | :--- |
| `request.write()` | ✅ Supported | Supports streaming and auto/manual chunked encoding. |
| `request.end()` | ✅ Supported | Resolved race conditions before connection establishment. |
| `request.setTimeout()` | ✅ Supported | |
| `request.destroy()` | ✅ Supported | |
| `request.abort()` | ✅ Supported | |
| `request.flushHeaders()` | ✅ Supported | |
| `request.setNoDelay()` | ✅ Supported | |
| `request.setSocketKeepAlive()` | ✅ Supported | |
| `event: 'response'` | ✅ Supported | |
| `event: 'socket'` | ✅ Supported | |
| `event: 'upgrade'` | ✅ Supported | Upgrade protocol detection. |
| `event: 'continue'` | ✅ Supported | `Expect: 100-continue`. |
| `event: 'information'` | ✅ Supported | 1xx intermediate response handling. |

## 6. `http.ServerResponse` API

| Method | Status | Notes |
| :--- | :--- | :--- |
| `response.writeHead()` | ✅ Supported | Delayed header sending; fixes Content-Length/Chunked conflicts. |
| `response.write()` | ✅ Supported | |
| `response.end()` | ✅ Supported | |
| `response.setTimeout()` | ✅ Supported | |
| `response.addTrailers()` | ✅ Supported | Appends trailing headers to chunked response. |
| `response.setHeader()` | ✅ Supported | Inherited from `OutgoingMessage`. |
| `response.getHeader()` | ✅ Supported | Inherited from `OutgoingMessage`. |
| `response.removeHeader()` | ✅ Supported | Inherited from `OutgoingMessage`. |
| `response.hasHeader()` | ✅ Supported | Inherited from `OutgoingMessage`. |

## 7. `http.IncomingMessage` API

Extends `stream.Readable`.

| Property | Status | Notes |
| :--- | :--- | :--- |
| `msg.headers` | ✅ Supported | Keys converted to lower-case. |
| `msg.rawHeaders` | ✅ Supported | |
| `msg.trailers` | ✅ Supported | Access to trailing headers in chunked messages. |
| `msg.method` / `url` | ✅ Supported | Request mode only. |
| `msg.statusCode` / `statusMessage` | ✅ Supported | Response mode only. |
| `msg.httpVersion` | ✅ Supported | |
| `msg.socket` | ✅ Supported | |
| `msg.complete` | ✅ Supported | Indicates message reception is finished. |

## 8. Recent Improvements
- **Full Proxy Support**: `Agent` now correctly parses `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY`.
- **Server Extensions**: `http.Server` options for `maxHeaderSize`, `keepAliveTimeout` etc. match Node.js.
- **Protocol Features**: Full support for **Trailers**, **101 Upgrade**, and **1xx Information** responses.
- **Connection Pooling**: Fixed race conditions in `Agent` socket reuse.
- **HTTP Tunneling**: Added support for `CONNECT` method and event in `http.Server`.
