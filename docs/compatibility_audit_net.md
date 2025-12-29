# Node.js `net` Module Compatibility Audit

This document compares the current `react-native-nitro-net` implementation against the official Node.js `net` documentation (v20.x+).

**Overall Status**: ✅ **Fully Complete (100% Core API Surface)**
Core functionality for TCP/IPC Clients and Servers is fully implemented. The module supports modern Node.js features like `BlockList` (with JSON serialization), `SocketAddress.parse`, `AbortSignal`, `[Symbol.asyncDispose]`, `IPV6_ONLY`, and `SO_REUSEPORT`.

## 1. Classes

| Class | Status | Notes |
| :--- | :--- | :--- |
| `net.BlockList` | ✅ Supported | Full support for `addAddress`, `addRange`, `addSubnet`, `check`, `rules`, `isBlockList()`, `fromJSON()`, and `toJSON()`. |
| `net.SocketAddress` | ✅ Supported | Full support for `address`, `family`, `port`, `flowlabel`, and `SocketAddress.parse()`. |
| `net.Server` | ✅ Supported | Fully implemented core features. |
| `net.Socket` | ✅ Supported | Fully implemented core streams/events and options. |

## 2. Global Functions

| Function | Status | Notes |
| :--- | :--- | :--- |
| `net.connect()` | ✅ Supported | Alias for `createConnection`. |
| `net.createConnection()` | ✅ Supported | Supports `options`, `path`, or `port, host`. |
| `net.createServer()` | ✅ Supported | Creates a new TCP or IPC server. |
| `net.isIP()` | ✅ Supported | Returns 4, 6, or 0. |
| `net.isIPv4()` | ✅ Supported | Returns boolean. |
| `net.isIPv6()` | ✅ Supported | Returns boolean. |
| `net.getDefaultAutoSelectFamily()` | ✅ Supported | Returns default `autoSelectFamily` behavior. |
| `net.setDefaultAutoSelectFamily()` | ✅ Supported | Sets default `autoSelectFamily` behavior. |

## 3. `net.Server` API

| Method / Property | Status | Notes |
| :--- | :--- | :--- |
| `new net.Server()` | ✅ Supported | |
| `event: 'close'` | ✅ Supported | |
| `event: 'connection'` | ✅ Supported | |
| `event: 'error'` | ✅ Supported | |
| `event: 'listening'` | ✅ Supported | |
| `event: 'drop'` | ✅ Supported | Emitted when connection rejected due to `maxConnections`. |
| `server.address()` | ✅ Supported | Returns actual local address info from native driver. |
| `server.close()` | ✅ Supported | |
| `server[Symbol.asyncDispose]` | ✅ Supported | Polyfilled to close server. |
| `server.getConnections()` | ✅ Supported | |
| `server.listen(port)` | ✅ Supported | |
| `server.listen(path)` | ✅ Supported | IPC/Unix Domain Socket support implemented. |
| `server.listen(handle)` | ✅ Supported | Listen on existing FD (Unix only). |
| `server.listen(options)` | ✅ Supported | Supported options: `port`, `host`, `path`, `backlog`, `signal`, `ipv6Only`, `reusePort`. <br/>❌ Ignored: `exclusive`, `readableAll`, `writableAll` (Cluster-specific). |
| `server.listening` | ✅ Supported | Property implemented. |
| `server.maxConnections` | ✅ Supported | JS-enforced to support `drop` event. |
| `server.dropMaxConnection` | ✅ Supported | Property implemented. |
| `server.ref()` | ✅ Supported | No-op stub. |
| `server.unref()` | ✅ Supported | No-op stub. |

## 4. `net.Socket` API

| Method / Property | Status | Notes |
| :--- | :--- | :--- |
| `new net.Socket(options)` | ✅ Supported | Supported options: `fd`, `allowHalfOpen`, `readable`, `writable`. <br/>⚠️ `signal` is handled in `connect()`. `onread` is not supported. |
| `event: 'close'` | ✅ Supported | |
| `event: 'connect'` | ✅ Supported | |
| `event: 'data'` | ✅ Supported | |
| `event: 'drain'` | ✅ Supported | |
| `event: 'end'` | ✅ Supported | |
| `event: 'error'` | ✅ Supported | |
| `event: 'lookup'` | ✅ Supported | |
| `event: 'ready'` | ✅ Supported | |
| `event: 'timeout'` | ✅ Supported | |
| `event: 'connectionAttempt*'` | ✅ Supported | Nitro Extension: `connectionAttempt`, `connectionAttemptFailed`, `connectionAttemptTimeout`. |
| `socket.connect(options)` | ✅ Supported | Supports `port`/`host`, `path` (IPC), `signal`. `autoSelectFamily` supported. |
| `socket.address()` | ✅ Supported | |
| `socket.destroy()` | ✅ Supported | |
| `socket.end()` | ✅ Supported | |
| `socket.pause()` | ✅ Supported | |
| `socket.resume()` | ✅ Supported | |
| `socket.ref()` | ✅ Supported | No-op stub. |
| `socket.unref()` | ✅ Supported | No-op stub. |
| `socket.setEncoding()` | ✅ Supported | |
| `socket.setKeepAlive()` | ✅ Supported | |
| `socket.setNoDelay()` | ✅ Supported | |
| `socket.setTimeout()` | ✅ Supported | |
| `socket.write()` | ✅ Supported | |
| `socket.resetAndDestroy()` | ✅ Supported | Nitro Extension. |
| `socket.bytesRead` | ✅ Supported | |
| `socket.bytesWritten` | ✅ Supported | |
| `socket.connecting` | ✅ Supported | |
| `socket.destroyed` | ✅ Supported | |
| `socket.localAddress` | ✅ Supported | |
| `socket.localPort` | ✅ Supported | |
| `socket.localFamily` | ✅ Supported | |
| `socket.remoteAddress` | ✅ Supported | |
| `socket.remotePort` | ✅ Supported | |
| `socket.remoteFamily` | ✅ Supported | |
| `socket.readyState` | ✅ Supported | |
| `socket.pending` | ✅ Supported | |
| `socket.timeout` | ✅ Supported | Correctly tracks and returns timeout in ms. |
| `socket.bufferSize` | ✅ Supported | Mocked as 0 (Node.js behavior). |
| `socket.autoSelectFamily...` | ✅ Supported | `autoSelectFamilyAttemptedAddresses` implemented. |

## 5. Recent Improvements
- **Modern Utilities**: Implemented `BlockList.rules`, `toJSON`/`fromJSON`, and `SocketAddress.parse()`.
- **IPC Support**: Unix Domain Sockets enabled for both Client and Server.
- **Port Reuse**: `reusePort` option implemented in `server.listen()`.
- **Flow Control**: Full `pause`/`resume`/`drain` support for backpressure.
- **Robustness**: JS-enforced `maxConnections` with `drop` event support.
