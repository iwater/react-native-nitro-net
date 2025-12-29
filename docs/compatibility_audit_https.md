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
| `event: 'keylog'` | ✅ Supported | Re-emitted from managed TLS sockets. |

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
- **Enhanced Sockets**: Added `enableTrace()` and `exportKeyingMaterial()`.
