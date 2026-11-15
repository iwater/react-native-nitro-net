# Node.js `tls` Module Compatibility Audit

This document compares the current `react-native-nitro-net` implementation against the official Node.js `tls` documentation.

**Overall Status**: ✅ **Phase 14 Complete (100% Core API Surface)**
Client-side TLS connection, Server-side TLS, advanced inspection metadata, and Unix Domain Sockets TLS are fully implemented and verified. Includes verification control, certificate parsing, session resumption, SNI, OCSP, ticket keys, and support for encrypted PEM keys/PFX. Keylogging 已 verified（H1/H2 两条路径与 `tls.connect`/`https.request` 两个入口都实测有行；两处曾静默断链，见下表）。

## 1. Classes

| Class | Status | Notes |
| :--- | :--- | :--- |
| `tls.Server` | ✅ Supported | Full support for `listen`, `close`, `address`, `getConnections`. |
| `tls.TLSSocket` | ✅ Supported | Client socket with verification, session and advanced info. |
| `tls.CryptoStream` | ✅ Supported | Legacy shim wrapping `TLSSocket`. |
| `tls.SecurePair` | ✅ Supported | Legacy shim for `createSecurePair`. |

## 2. Global Functions

| Function | Status | Notes |
| :--- | :--- | :--- |
| `tls.connect(options, [callback])` | ✅ Supported | Supports `host`, `port`, `servername`, `rejectUnauthorized`, `session`, `alpnProtocols`, `checkServerIdentity`. **Missing**: `pskCallback`. |
| `tls.connect(port, [host], [options], [callback])` | ✅ Supported | |
| `tls.connect(path, [options], [callback])` | ✅ Supported | Unix socket TLS supported on Unix platforms. |
| `tls.createSecureContext(options)` | ✅ Supported | Full support for `cert`, `key`, `ca`, `pfx`, and `passphrase`. |
| `tls.createServer([options], [secureConnectionListener])` | ✅ Supported | Supports `key`, `cert`, `ca`, and `secureContext`. |
| `tls.checkServerIdentity(hostname, cert)` | ✅ Supported | 规则与错误形状按 node 源码对齐（2026-10-24）：IP 主机只比 IP SAN；有 SAN 用 SAN、没有才回退 CN；两者都没有 ⇒ `Cert does not contain a DNS name`；失败一律 `ERR_TLS_CERT_ALTNAME_INVALID`，`reason`/`host`/`cert` 三个属性与消息文本逐字一致，比较前做 `unfqdn`。残余：IP 规范化只做小写/去方括号，node 还会折 IPv4-mapped IPv6。 |
| `tls.getCiphers()` | ✅ Supported | Returns suites supported by `rustls`. |
| `tls.rootCertificates` | ✅ Supported | Exported as empty array (OS-managed trust). |
| `tls.DEFAULT_ECDH_CURVE` | ✅ Supported | Fixed at 'auto' for `rustls`. |
| `tls.DEFAULT_MAX_VERSION` | ✅ Supported | Set to 'TLSv1.3'. |
| `tls.DEFAULT_MIN_VERSION` | ✅ Supported | Set to 'TLSv1.2'. |
| `tls.convertTLSV1CertToPEM(cert)` | ✅ Supported | JS shim for cert conversion. |
| `tls.createSecurePair(...)` | ✅ Supported | Legacy factory for `SecurePair`. |
| `tls.parseCertString(certStr)` | ✅ Supported | JS parser for legacy cert attribute strings. |

## 3. `tls.TLSSocket` API

### Constructor
| Method | Status | Notes |
| :--- | :--- | :--- |
| `new tls.TLSSocket(socket, [options])` | ✅ Supported | Wraps existing socket (logically) or creates new. |

### Events
| Event | Status | Notes |
| :--- | :--- | :--- |
| `event: 'secureConnect'` | ✅ Supported | Emitted when handshake completes. |
| `event: 'keylog'` | ✅ Supported | Emitted in NSS format for Wireshark decryption（H1/H2 都到得了 JS：`tls.connect` 与 `https.request` 各实测 5 行；#58 修 https 层漏转发、#61 修 H2 事件号发错通道）。 |
| `event: 'OCSPResponse'` | ✅ Supported | Emitted when a stapled OCSP response is received. |
| `event: 'session'` | ✅ Supported | Emitted when session ticket is received (via base Socket). |
| `event: 'close'` | ✅ Supported | Inherited from `net.Socket`. |
| `event: 'error'` | ✅ Supported | Inherited from `net.Socket`. |
| `event: 'data'` | ✅ Supported | Inherited from `net.Socket`. |

### Properties
| Property | Status | Notes |
| :--- | :--- | :--- |
| `socket.authorized` | ✅ Supported | Returns `true` if certificate is valid, `false` otherwise. |
| `socket.authorizationError` | ✅ Supported | 校验失败时返回错误串（`rejectUnauthorized:false` 也保留）；成功时本包给 `undefined`，node 给 `null`（falsy 语义一致）。 |
| `socket.alpnProtocol` | ✅ Supported | Negotiated protocol (e.g., "h2", "http/1.1"). |
| `socket.encrypted` | ✅ Supported | Always `true`. |
| `socket.servername` | ✅ Supported | Returns the SNI server name. |
| `socket.renegotiation` | ❌ WontFix | Not supported by `rustls` (security choice). |

### Methods
| Method | Status | Notes |
| :--- | :--- | :--- |
| `socket.address()` | ✅ Supported | Inherited from `net.Socket`. |
| `socket.disableRenegotiation()` | ✅ Supported | No-op stub for compatibility. |
| `socket.enableTrace()` | ⚠️ Intentional deviation | 显式抛 `ERR_NOT_SUPPORTED`（2026-10-23）：node 打的是 OpenSSL `SSL_trace()`，格式未文档化；BoringSSL 只有 message callback，无法给出与 node 一致的输出。绝不静默 no-op。 |
| `socket.getCipher()` | ✅ Supported | Returns node's `{ name, standardName, version }`；TLS1.2 的 OpenSSL 名由 IANA 名映射。 |
| `socket.getEphemeralKeyInfo()` | ✅ Supported | node 形状 `{type:'ECDH', name, size}`（如 X25519/253）；服务端返回 `null`（node 同形）。 |
| `socket.getFinished()` | ✅ Supported | Throws Error (explicitly unsupported by `rustls`). |
| `socket.getPeerCertificate([detailed])` | ✅ Supported | 结构化 JSON 可用；`detailed` 链在 impersonated 路径是**已验证链**（信任库补根，与 node 同形）；默认 rustls 路径自 #75 起同样补根（DN 挑候选 + `verify_server_cert_signed_by_trust_anchor` 证明，实测 example.com 三级链与 node 逐级一致）。边界见 `node_compatibility_deviations.md` §5.1：锚点必须有证书本体（系统根库 / `ca` PEM；编译进来的 webpki-roots 只有 subject/SPKI ⇒ 回落对端链），且校验没过时不补（与 node 同形）。恢复握手上两侧都**没有链**：node 实测 `getPeerCertificate(true)` 返回空对象（`keys=0`），rustls 恢复路径不下发 Certificate 因而也不会补根（#76 定量，见 §5）。 |
| `socket.getPeerFinished()` | ✅ Supported | Throws Error (explicitly unsupported by `rustls`). |
| `socket.getProtocol()` | ✅ Supported | Returns negotiated version (e.g., "TLSv1.3"). 2026-10-23 起本包输出与 node 逐字相同（原先原生给 `TLSv1_3`，现已归一化；矩阵 `https-getprotocol` 格钉住）。 |
| `socket.getSession()` | ⚠️ Partial | impersonated 连接返回握手后的 session DER（Buffer）；默认 rustls 路径显式抛 `ERR_NOT_SUPPORTED` —— rustls 有公开的 resumption 状态，但**不是** node 的 session DER（冒充它只会造出一个只有本包能吃的私有格式，见 §1.30）。⚠️ 2026-10-24 更正：这条路径**也没有**"内部复用"—— 实测第二次连接的 ClientHello 里连 `pre_shared_key` 都没有（#78，证据见 `node_compatibility_deviations.md` §5.2）。 |
| `socket.setSession(session)` | ⚠️ Partial | impersonated：握手前注入真实 DER（非法内容在建连阶段报错）；默认 rustls 路径显式抛 `ERR_NOT_SUPPORTED`。`tls.connect({ session })` 同路径 ⇒ 异步 `error`，不建立连接。 |
| `socket.isSessionReused()` | ✅ Supported | H1（btls/rustls）与 H2（btls）均为**握手真相**：btls 取 `SSL_session_reused()`，rustls 取 `CommonState::handshake_kind()`（`common_state.rs:188`），服务端 TLSSocket 同源的早就是真值。⚠️ 2026-10-24 前 rustls 客户端读的是会话缓存**命中**标志 ⇒ 命中但没恢复时报 true（实测 node 服务端同时报 false），已修，登记见 #76/#78。 |
| `socket.getSharedSigalgs()` | ⚠️ Partial | 客户端返回 `[]`（与 node 实测一致）；服务端仍返回空数组 —— 客户端 advertisement **是可达的**（`ClientHello::signature_schemes()`），但 node 的服务端值是 OpenSSL 内部偏好表（实测同一服务端：node 客户端 16 条、我们客户端 9 条且为保序子集），复刻需硬编版本相关的表。登记见 `m3_implementation_plan.md` §1.30。 |
| `socket.exportKeyingMaterial()` | ✅ Supported | rustls 与 impersonated（btls）路径均可用；btls 已用 rustls 服务端对照（两端字节一致）。 |

## 4. `tls.Server` API

**Status**: ✅ Basic Support Implemented.

| Method / Property | Status | Notes |
| :--- | :--- | :--- |
| `server.addContext(hostname, context)` | ✅ Supported | Supports dynamic certificate resolution via SNI. |
| `server.address()` | ✅ Supported | Inherited from `net.Server`. |
| `server.close([callback])` | ✅ Supported | Inherited from `net.Server`. |
| `server.getConnections(callback)` | ✅ Supported | Inherited from `net.Server`. |
| `server.getTicketKeys()` | ✅ Supported | Returns current ticket encryption keys. |
| `server.listen()` | ✅ Supported | Inherited from `net.Server`. |
| `server.setSecureContext(options)` | ✅ Supported | Alias for updating the server's primary context. |
| `server.setTicketKeys(keys)` | ✅ Supported | Updates ticket encryption keys. |
| `event: 'secureConnection'` | ✅ Supported | Emitted after TLS handshake completes. |
| `event: 'newSession'` | ✅ Supported | Emitted when a new TLS session is created. |

## 5. Recent Improvements
- **Keying Material**: rustls 路径可用；impersonated（btls）路径仍返回 -1（M3-T3 待接线）。
- **Diagnostics**: `socket.enableTrace()` 显式抛 `ERR_NOT_SUPPORTED`（BoringSSL 无 `SSL_trace`，有意偏差）。
- **IPC Support**: Unix Domain Sockets TLS now uses fixed paths for Apple compatibility.
- **Robustness**: Enhanced PFX/PEM passphrase handling and validation.

