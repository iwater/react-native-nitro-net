# react-native-nitro-net

Ultra-high-performance networking for React Native combining a memory-safe Rust core with the zero-overhead Nitro Modules JSI bridge. Provides standard Node.js-compatible `net`, `tls`, `http`, `https`, and `http2` APIs.

[![license](https://img.shields.io/badge/license-ISC-blue.svg)]()
[![platform](https://img.shields.io/badge/platform-ios%20%7C%20android-lightgrey.svg)]()
[![compatibility](https://img.shields.io/badge/Node.js-100%25%20net-green.svg)]()
[中文文档](./README_zh.md)

## Features

*   🚀 **High Performance**: Built on top of Rust's `tokio` asynchronous runtime.
*   🤝 **Node.js Compatible**: Implements standard `net`, `tls`, `http`, `https`, and `http2` APIs.
*   🌐 **Fetch API**: Web-standard `fetch` implementation with immediate header resolution and on-demand streaming body consumption.
*   🛡️ **Modern Security**: TLS powered by **Rustls 0.23** (Ring provider), supporting TLS 1.2 and 1.3; supports server-side mTLS (client certificates) and ALPN negotiation.
*   🎭 **Optional Chrome Fingerprint**: Opt-in BoringSSL + HTTP/2 impersonation (`configure({ impersonate: 'chrome' })`).
*   🔀 **HTTP/2 Support**: Exports standard `http2` module (client facade and native-driven H2 servers).
*   🔒 **Full Protocol Support**: Support for PEM/PFX certificates, SNI, HTTP Trailers, 100 Continue, Protocol Upgrades (101), HTTP Tunneling (CONNECT), and upgrading existing sockets to TLS (`tls.connect({ socket })`).
*   ⚡ **Nitro Modules**: Uses JSI for zero-overhead communication between JavaScript and Native code.
*   🛡️ **Robust & Stable**: Connection lifecycle aligned with Node.js (`server.close()`, `closeAllConnections()`), and stream `instanceof` splitting resolved via core `stream` imports.
*   📱 **Cross-Platform**: Supports iOS and Android (as well as macOS local builds and debugging).

## Installation

```bash
npm install react-native-nitro-net
# or
yarn add react-native-nitro-net
```

### iOS

Requires `pod install` to link the native libraries:

```bash
cd ios && pod install
```

> **Note**: Minimum iOS deployment target is iOS 15.1 (governed by CocoaPods `min_ios_version_supported`).

## Architecture

This library uses a high-performance three-layer architecture:

1.  **JavaScript Layer**: Provides high-level Node.js compatible APIs. Base classes import directly from the core name `stream` (aliased to eliminate duplicate `readable-stream` packages and cross-package `instanceof` skew).
2.  **C++ Bridge (Nitro)**: Handles zero-copy orchestration between JS and Rust using Nitro Hybrid Objects and JSI.
3.  **Rust Core**: Implements the actual networking, TLS, and HTTP/2 state machines using the **Tokio** asynchronous runtime for memory safety and high concurrency.

## Usage

### TCP Client (`net.Socket`)

```typescript
import net from 'react-native-nitro-net';

const client = net.createConnection({ port: 8080, host: '1.1.1.1' }, () => {
  console.log('Connected!');
  client.write('Hello Server!');
});

client.on('data', (data) => {
  console.log('Received:', data.toString());
});

client.on('error', (err) => {
  console.error('Error:', err.message);
});
```

### TCP Server (`net.Server`)

Supports dynamic port allocation by binding to port `0`, as well as Unix domain sockets:

```typescript
import net from 'react-native-nitro-net';

const server = net.createServer((socket) => {
  socket.write('Echo: ' + socket.read());
});

// Use 0 for dynamic port allocation
server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  console.log(`Server listening on dynamic port: ${typeof address === 'object' ? address?.port : address}`);
});
```

### TLS (Secure Socket)

```typescript
import { tls, net } from 'react-native-nitro-net';

// 1. Client connection
const socket = tls.connect({
  host: 'example.com',
  port: 443,
  servername: 'example.com', // SNI
}, () => {
  console.log('Securely connected!');
  console.log('Protocol:', socket.getProtocol());
});

// 2. Upgrade an existing net.Socket to TLS
const rawSocket = net.connect(443, 'example.com', () => {
  const tlsSocket = tls.connect({
    socket: rawSocket,
    servername: 'example.com',
  }, () => {
    console.log('TLS upgrade handshake completed');
  });
});

// 3. Server with PFX, client certificate validation (mTLS), and ALPN
const server = tls.createServer({
  pfx: fs.readFileSync('server.pfx'),
  passphrase: 'your-password',
  ALPNProtocols: ['h2', 'http/1.1'],
  requestCert: true,
  rejectUnauthorized: true,
  ca: [fs.readFileSync('client-ca.crt')],
}, (socket) => {
  console.log('Client authorized:', socket.authorized);
  socket.write('Secure hello!');
});
server.listen(443);
```

*   **Advanced Features**: Supports Wireshark `keylog` event re-emission, session ticket resumption (`setSession`), Unix path targets, and `asyncDispose`.
*   **Performance Tuning**: Configurable `headersTimeout`, `keepAliveTimeout`, and `requestTimeout`.
*   **Resource Management**: Integrates LoopRef to keep the runtime loop alive, releasing native sockets and Unix socket files cleanly.

### HTTP / HTTPS Requests

Implements standard Node.js `http` and `https` APIs with support for `url.URL` instances, cancellation via `AbortSignal`, and Agent connection pooling:

```typescript
import { http, https } from 'react-native-nitro-net';

// HTTP GET
http.get('http://example.com', (res) => {
  console.log(`Status: ${res.statusCode}`);
  res.on('data', (chunk) => console.log(`Body segment: ${chunk.length} bytes`));
  res.on('end', () => console.log('Request complete'));
});

// Cancellation via AbortSignal
const controller = new AbortController();
const req = http.request('http://example.com', { signal: controller.signal }, (res) => {
  // ...
});
// controller.abort();

// HTTPS with Connection Pooling
const agent = new https.Agent({ keepAlive: true });
https.get('https://api.github.com/users/margelo', { agent }, (res) => {
  // ... handle response
});
```

### HTTP/2 (`node:http2` Compatible)

Exports standard APIs mirroring Node.js `node:http2`:

```typescript
import { http2, isHttp2Available, configure } from 'react-native-nitro-net';

// 1. Client Session
if (isHttp2Available()) {
  configure({ impersonate: 'chrome' });

  const client = http2.connect('https://example.com');
  const req = client.request({ ':path': '/' });

  req.on('response', (headers, flags) => {
    console.log('H2 status:', headers[':status']);
  });

  req.setEncoding('utf8');
  req.on('data', (chunk) => console.log('Chunk:', chunk));
  req.on('end', () => client.close());
}

// 2. HTTP/2 Server
const server = http2.createServer((stream, headers) => {
  stream.respond({
    ':status': 200,
    'content-type': 'text/plain; charset=utf-8',
  });
  stream.end('Hello HTTP/2!');
});

server.listen(8443);
```

Exports Node.js `http2`'s 11 standard entries: `connect`, `createServer`, `createSecureServer`, `getDefaultSettings`, `getPackedSettings`, `getUnpackedSettings`, `Http2ServerRequest`, `Http2ServerResponse`, `constants`, `sensitiveHeaders`, and `performServerHandshake`.

### Chrome Fingerprint Impersonation (Opt-in)

```typescript
import { configure, isImpersonationAvailable, isHttp2Available } from 'react-native-nitro-net';

// Requires native build with impersonate feature (BoringSSL + HTTP/2)
if (isImpersonationAvailable()) {
  configure({ impersonate: 'chrome', match: ['*.example.com'] });
}
console.log('HTTP/2 available:', isHttp2Available());
```

* Matching HTTPS requests use Chrome 150's TLS ClientHello (ciphers/curves/sigalgs/GREASE/ALPS/ECH grease).
* HTTP/2 is negotiated automatically; SETTINGS, WINDOW_UPDATE, pseudo-headers (`m,a,s,p`) and header order match real-world captures.
* Servers that only select `http/1.1` fall back to the existing H1 path (remembered per Agent).
* Without calling `configure(...)`, behavior remains standard: Rustls + HTTP/1.1.
* Custom `lookup` / `createConnection` / `checkServerIdentity`, `Upgrade`, and `CONNECT` stay on H1.

### Fetch API (Web Standard)

Web-standard `fetch` implementation powered by the high-performance Nitro Net core with immediate header return and streaming body reading:

```typescript
import { fetch, FetchHeaders, FetchResponse } from 'react-native-nitro-net';

const response = await fetch('https://api.example.com/data', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ key: 'value' })
});

console.log('Status:', response.status);
const data = await response.json();
const blob = await response.blob(); // Proper binary data support
```

### Compression

`fetch` automatically decodes gzip / deflate / br / zstd when a zlib provider is supplied:

```typescript
import { setZlibProvider } from 'react-native-nitro-net';
import * as zlib from 'react-native-nitro-zlib';

setZlibProvider(zlib);
```

* If the external provider lacks zstd, it automatically falls back to the bundled pure-JS zstd decoder.
* `http.request` / `https.request` retain Node semantics and return raw compressed bytes.

### Proxy Support

HTTPS requests can use an HTTP CONNECT / SOCKS / HTTPS proxy:

```typescript
import { https, fetch } from 'react-native-nitro-net';

const agent = new https.Agent({ proxy: 'socks5://user:pass@proxy.local:1080' });
https.get('https://example.com', { agent }, (res) => { /* ... */ });

const response = await fetch('https://example.com', {
  proxy: 'http://proxy.local:8080'
});

// HTTPS-to-proxy: TLS to proxy, CONNECT tunnel, then TLS to origin.
// proxyTls only affects the proxy hop; origin ca/cert/key remain independent.
const tlsProxy = new https.Agent({
  proxy: 'https://user:pass@proxy.example:443',
  proxyTls: { ca: fs.readFileSync('corp-proxy-ca.pem') },
});
```

Supported schemes: `http://` (CONNECT), `https://` (CONNECT over TLS), `socks5://` / `socks5h://`, `socks4://` / `socks4a://`.
Environment variables `HTTPS_PROXY` / `HTTP_PROXY` and `NO_PROXY` are also honored.

---

## Compatibility Notes

> [!NOTE]
> **`Server.close()` Behavior (Aligned with Node.js)**:
> Starting from **v0.6.2**, `server.close([callback])` is aligned with Node.js—it **only stops accepting new connections**. Existing active connections continue until they naturally finish.
> If you need to immediately and forcefully terminate all established connections (the earlier pre-v0.6.2 behavior), call **`server.closeAllConnections()`** (matching Node 18.2+).

> [!NOTE]
> **`TLSSocket.getSession()`**:
> The default Rustls backend does not serialize client session tickets (`getSession()` throws `ERR_NOT_SUPPORTED`). This method returns a valid session Buffer only on impersonated (BoringSSL / btls) connections. Use `setSession(session)` to provide a ticket prior to connection.

> [!NOTE]
> **Stream Family Contract**:
> Base classes are imported from core `stream` to eliminate duplicate `readable-stream` packages and `instanceof` skew across dependencies.

---

## API Reference

### `net.Socket`

| Property / Method | Description |
| --- | --- |
| `connect(options)` | Connect to a remote host/port or Unix socket path. |
| `write(data)` | Send data asynchronously. Supports backpressure. |
| `destroy()` | Immediate closing of the socket and resource cleanup. |
| `setNoDelay(bool)` | Control Nagle's algorithm. |
| `setKeepAlive(bool)`| Enable/disable keep-alive. |
| `address()` | Returns `{ port, family, address }` for the local side. |
| `ref()` / `unref()` | Integrates with host event loop tracking (graceful no-op on RN). |

**Events**: `connect`, `ready`, `data`, `error`, `close`, `timeout`, `lookup`.

### `tls.TLSSocket`
*Extends `net.Socket`*

| Property / Method | Description |
| --- | --- |
| `authorized` | `true` if peer certificate is verified. |
| `authorizationError` | Failure reason if peer certificate verification failed. |
| `getProtocol()` | Returns negotiated TLS version (e.g., "TLSv1.3"). |
| `getCipher()` | Returns current cipher information. |
| `getPeerCertificate()`| Returns detailed JSON of the peer certificate. |
| `getSession()` | Returns the session ticket Buffer (BoringSSL / Chrome impersonation only). |
| `setSession(buffer)` | Supplies a session ticket to resume prior to handshake. |
| `encrypted` | Always `true`. |

**Events**: `secureConnect`, `session`, `keylog`, `OCSPResponse`.

### `net.Server`

| Method | Description |
| --- | --- |
| `listen(options)` | Start listening. Supports `port: 0` for dynamic port allocation and Unix socket paths. |
| `close([callback])` | Stops accepting new connections (existing connections remain open; matches Node.js). |
| `closeAllConnections()` | **Forcefully closes and destroys all active connections** (matches Node 18.2+). |
| `setTimeout([msecs][, callback])` | Sets the server idle timeout. |
| `address()` | Returns the bound address object `{ port, family, address }` or Unix path string. |
| `getConnections(cb)`| Returns the count of active connections. |

**Events**: `listening`, `connection`, `close`, `error`.

### `tls.Server`
*Extends `net.Server`*

Supported methods: `listen`, `close`, `closeAllConnections`, `addContext`, `setTicketKeys`, `getTicketKeys`.
Supported options: `ALPNProtocols` (negotiate ALPN), `requestCert` / `rejectUnauthorized` / `ca` (mTLS client verification), `cert` / `key` / `pfx`.
**Events**: `secureConnection`, `keylog`, `newSession`.

### `http2` Module

| Export | Type | Description |
| --- | --- | --- |
| `connect(authority, options)` | Function | Establishes a client ClientHttp2Session. |
| `createServer(options, onStream)` | Function | Creates an HTTP/2 server. |
| `createSecureServer(options, onStream)` | Function | Creates a TLS HTTP/2 server (supports `allowHTTP1`). |
| `getDefaultSettings()` | Function | Returns default HTTP/2 SETTINGS parameters. |
| `getPackedSettings(settings)` | Function | Encodes settings object into a binary Buffer. |
| `getUnpackedSettings(buf)` | Function | Decodes binary Buffer into a settings object. |
| `Http2ServerRequest` / `Http2ServerResponse` | Class | Node.js-compatible HTTP/2 server request and response classes. |
| `constants` | Object | HTTP/2 frame, error code, and flag constants. |
| `sensitiveHeaders` | Symbol | Symbol used to mark sensitive headers. |

### Global APIs

| Method / Export | Description |
| --- | --- |
| `initWithConfig(options)` | Optional. Initializes the Rust runtime with custom settings (e.g., `workerThreads`, `debug`). |
| `setVerbose(bool)` | Toggle detailed logging for JS, C++, and Rust. |
| `isIP(string)` | Returns `0`, `4`, or `6`. |
| `isHttp2Available()` | Reports whether the native build supports the HTTP/2 engine. |
| `isImpersonationAvailable()` | Reports whether the native build supports Chrome impersonation. |
| `networkInterfaces()` | Returns local network interfaces object (similar to Node's `os.networkInterfaces()`). |
| `FetchHeaders` / `FetchResponse` | Exported classes for standard Web Fetch headers and response. |
| `setZlibProvider(provider)` | Injects an external decompression provider (e.g., `react-native-nitro-zlib`). |

## Debugging

Enable verbose logging to see internal data flows across JS, C++, and Rust:

```typescript
import { setVerbose } from 'react-native-nitro-net';

setVerbose(true);
```

Logs will appear in your native debugger (Xcode/logcat) and JS console, prefixed with `[NET DEBUG]` or `[NET NATIVE]`.

## License

ISC
