# Node.js `https` Module Compatibility Audit

This document compares the `react-native-nitro-net` implementation of the `https` module against the official Node.js documentation (v20+).

**Overall Status**: ✅ **Phase 14 Complete (100% Core API Surface)**
The `https` module now provides full API compatibility. It correctly extends `tls` and `http` classes, supports `globalAgent` configuration, and implements key TLS features like hostname verification and keying material export.

## 1. Classes

| Class | Status | Notes |
| :--- | :--- | :--- |
| `https.Agent` | ✅ Supported | Extends `http.Agent`. Full support for connection pooling and TLS options. |
| `https.Server` | ✅ Supported | Extends `tls.Server`. Reuses HTTP parsing via internal setup. |
| `https.ClientRequest` | ✅ Supported | Extends `http.ClientRequest`. Automatically handles `https:` protocol and 443 port. |

## 2. Global Functions

| Function | Status | Notes |
| :--- | :--- | :--- |
| `https.createServer(options, [requestListener])` | ✅ Supported | Returns compatible `https.Server`. |
| `https.request(url\|options, [options], [cb])` | ✅ Supported | Fully compatible with URL strings, URL objects, and option objects. |
| `https.get(url\|options, [options], [cb])` | ✅ Supported | Convenience wrapper for `GET` requests. |
| `https.globalAgent` | ✅ Supported | Defaults match Node.js: `keepAlive: true`, `timeout: 5000`. |

## 3. `https.Agent` API

| Option / Property | Status | Notes |
| :--- | :--- | :--- |
| `options.ca`, `cert`, `key` | ✅ Supported | Passed to `tls.connect`. |
| `options.pfx`, `passphrase` | ✅ Supported | Passed to `tls.connect`. |
| `options.rejectUnauthorized` | ✅ Supported | Defaulted to `true`. |
| `options.servername` | ✅ Supported | Supported for SNI. |
| `options.checkServerIdentity` | ✅ Supported | Automatically called in `connect` flow. |
| `options.timeout` | ✅ Supported | Inherited from `http.ClientRequest`. |
| `options.maxCachedSessions` | ✅ Supported | Session caching enabled by default. |
| `event: 'keylog'` | ✅ Supported（H1 与 H2 同形） | 落点是 **Agent**（`Agent.createConnection` 把 TLSSocket 的 'keylog' 转成 `agent.emit('keylog', line, socket)`；H2 那半是 `Agent._createH2Session` 订阅 session 的 'keylog'）。实测（2026-10-23，#58+#61 修完）：H1 与 H2 各 **5 行**，首行 `CLIENT_HANDSHAKE_TRAFFIC_SECRET …`，不开 `keylog` 时 **0 行**。曾经的两个静默断点都记在 `probe_h2_features` 的注释里：https 层的选项转发表漏了 `keylog`；原生把 H2 的行发成 socket 通道的号（`10`）而 session 通道听的是 `28`。 |

## 4. `https.Server` API

| Method / Property | Status | Notes |
| :--- | :--- | :--- |
| `new https.Server(options, [listener])` | ✅ Supported | |
| `server.addContext(hostname, context)` | ✅ Supported | Proxied to `tls.Server` for SNI. |
| `server.close()` | ✅ Supported | Inherited from `tls.Server`. |
| `server.listen([port])` | ✅ Supported | Inherited from `tls.Server`. |
| `server.headersTimeout` | ✅ Supported | Default: 60000ms. |
| `server.requestTimeout` | ✅ Supported | Default: 300000ms. |
| `server.keepAliveTimeout` | ✅ Supported | Default: 5000ms. |
| `server[Symbol.asyncDispose]` | ✅ Supported | Clean resource teardown. |
| `options.SNICallback` | ⚠️ Warning | Warning emitted; use `addContext()` for SNI. |
| `event: 'request'` | ✅ Supported | Standard HTTP request processing. |
| `event: 'upgrade'` | ✅ Supported | Supports protocol upgrades over TLS. |
| `event: 'secureConnection'` | ✅ Supported | Emitted when TLS handshake is complete. |
| `event: 'newSession'` | ✅ Supported | Emitted when a new session ticket is received. |
| `event: 'checkContinue'` | ✅ Supported | Inherited from `http.Server`. |
| `event: 'connect'` | ✅ Supported | Inherited from `http.Server`. |

## 5. Recent Improvements
- **Inheritance Fix**: `https.Server` now correctly extends `tls.Server`.
- **Automatic Verification**: Hostname matching is now part of the `connect` lifecycle.
- **Improved Defaults**: `globalAgent` now aligns with Node.js production defaults.
- **Enhanced Sockets**: `exportKeyingMaterial()` on the rustls path (not yet on impersonated); `enableTrace()` 显式抛 `ERR_NOT_SUPPORTED`（BoringSSL 无 `SSL_trace`）。
