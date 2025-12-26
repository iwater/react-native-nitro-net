# Node.js `net` Module Compatibility Audit

This document compares the current `react-native-nitro-net` implementation against the official Node.js `net` documentation (v20.x+).

**Overall Status**: ✅ **Near Complete (Core functionality, IPC, Timeouts, and Modern APIs done)**
TCP/IPC Client and Server functionality is fully implemented, including flow control, inactivity timeouts, DNS events, and modern utilities like `BlockList`/`SocketAddress`. Some newer Node.js features (v18+) and specific properties are currently missing.

## 1. Classes

| Class | Status | Notes |
| :--- | :--- | :--- |
| `net.BlockList` | ✅ Supported | Implemented as JS utility class. |
| `net.SocketAddress` | ✅ Supported | Implemented as JS utility class. |
| `net.Server` | ✅ Supported | Implemented with most common features. |
| `net.Socket` | ✅ Supported | Implemented with core streams/events and options. |

## 2. `net.Server` API

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
| `server.listen(options)` | ✅ Supported | `port`, `host`, `path`, `ipv6Only`, `signal` available. `reusePort` available. |
| `server.listen(handle)` | ✅ Supported | Listen on existing FD (Unix only). |
| `server.listening` | ✅ Supported | Property implemented. |
| `server.maxConnections` | ✅ Supported | JS-enforced to support `drop` event. |
| `server.dropMaxConnection` | ✅ Supported | Property implemented. |
| `server.ref()` | ✅ Supported | No-op stub. |
| `server.unref()` | ✅ Supported | No-op stub. |

## 3. `net.Socket` API

| Method / Property | Status | Notes |
| :--- | :--- | :--- |
| `new net.Socket()` | ✅ Supported | |
| `event: 'close'` | ✅ Supported | |
| `event: 'connect'` | ✅ Supported | |
| `event: 'data'` | ✅ Supported | |
| `event: 'connectionAttempt*'` | ✅ Supported | `connectionAttempt`, `connectionAttemptFailed`, `connectionAttemptTimeout` events implemented. |
| `socket.localFamily` | ✅ Supported | |
| `socket.autoSelectFamily...` | ✅ Supported | `autoSelectFamilyAttemptedAddresses` implemented. |

This document tracks the compatibility status of `react-native-nitro-net` with the Node.js `net` module API.

**Overall Compatibility: ~99%** (Core API Surface)

## Global Functions
- `connect()`: ✅ Supported (Supports all common overloads)
- `createConnection()`: ✅ Supported
- `createServer()`: ✅ Supported
- `isIP()`: ✅ Supported
- `isIPv4()`: ✅ Supported
- `isIPv6()`: ✅ Supported
- `getDefaultAutoSelectFamily()`: ✅ Supported
- `setDefaultAutoSelectFamily()`: ✅ Supported

## `net.Socket`
### Events
- `close`: ✅ Supported
- `connect`: ✅ Supported
- `data`: ✅ Supported
- `drain`: ✅ Supported
- `end`: ✅ Supported
- `error`: ✅ Supported
- `lookup`: ✅ Supported
- `ready`: ✅ Supported
- `timeout`: ✅ Supported
- `connectionAttempt*`: ✅ Supported

### Properties
- `address()`: ✅ Supported
- `bytesRead`: ✅ Supported
- `bytesWritten`: ✅ Supported
- `connecting`: ✅ Supported
- `destroyed`: ✅ Supported
- `localAddress`: ✅ Supported
- `localPort`: ✅ Supported
- `localFamily`: ✅ Supported
- `pending`: ✅ Supported
- `readyState`: ✅ Supported
- `remoteAddress`: ✅ Supported
- `remoteFamily`: ✅ Supported
- `remotePort`: ✅ Supported
- `timeout`: ✅ Supported
- `bufferSize`: ✅ Supported (Mocked 0, matching Node.js deprecation behavior)
- `autoSelectFamilyAttemptedAddresses`: ✅ Supported

### Methods
- `connect()`: ✅ Supported (Supports host/port and Unix path)
- `destroy()`: ✅ Supported
- `end()`: ✅ Supported
- `pause()`: ✅ Supported
- `resume()`: ✅ Supported
- `setEncoding()`: ✅ Supported
- `setKeepAlive()`: ✅ Supported
- `setNoDelay()`: ✅ Supported
- `setTimeout()`: ✅ Supported
- `write()`: ✅ Supported
- `ref()`: ✅ Supported (No-op stub)
- `unref()`: ✅ Supported (No-op stub)
- `resetAndDestroy()`: ✅ Supported (Native RST support via `SO_LINGER=0`)

## `net.Server`
### Events
- `close`: ✅ Supported
- `connection`: ✅ Supported
- `error`: ✅ Supported
- `listening`: ✅ Supported
- `drop`: ✅ Supported

### Properties
- `address()`: ✅ Supported
- `listening`: ✅ Supported
- `maxConnections`: ✅ Supported (JS-enforced)

### Methods
- `address()`: ✅ Supported
- `close()`: ✅ Supported
- `getConnections()`: ✅ Supported
- `listen()`: ✅ Supported (Supports port, host, backlog, path, signal, ipv6Only, reusePort)
- `ref()`: ✅ Supported (No-op stub)
- `unref()`: ✅ Supported (No-op stub)
- `[Symbol.asyncDispose]()`: ✅ Supported

## Specialized Classes
- `net.BlockList`: ✅ Supported (Basic functionality)
- `net.SocketAddress`: ✅ Supported (Basic functionality)

---
*Audit last updated: Phase 8 Completion*
