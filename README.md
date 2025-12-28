# react-native-nitro-net

Node.js `net` API implementation for React Native using [Nitro Modules](https://github.com/mrousavy/nitro) and Rust.

## Features

*   🚀 **High Performance**: Built on top of Rust's `tokio` asynchronous runtime.
*   🤝 **Node.js Compatible**: Implements standard `net` and `tls` APIs including `Socket`, `Server`, `TLSSocket`, and `SecureContext`.
*   🛡️ **Modern Security**: TLS implementation powered by **Rustls 0.23** (Ring provider), supporting TLS 1.2 and 1.3.
*   🔒 **Full TLS Support**: Support for PEM/PFX certificates, encrypted private keys, SNI, Session tickets, and 100% Node.js API surface compatibility.
*   ⚡ **Nitro Modules**: Uses JSI for zero-overhead communication between JavaScript and Native code.
*   🛡️ **Robust & Stable**: Advanced fixes for port reuse, deadlocks, and DNS reliability.
*   📱 **Cross-Platform**: Supports both iOS and Android.

## Installation

```bash
npm install react-native-nitro-net
# or
yarn add react-native-nitro-net
```

### iOS

Requires `pod install` to link the native libraries.

```bash
cd ios && pod install
```

## Architecture

This library uses a high-performance three-layer architecture:

1.  **JavaScript Layer**: Provides high-level Node.js compatible `net` and `tls` APIs using `readable-stream` and `EventEmitter`.
2.  **C++ Bridge (Nitro)**: Handles the zero-copy orchestration between JS and Rust using Nitro Hybrid Objects and JSI.
3.  **Rust Core**: Implements the actual networking logic using the **Tokio** asynchronous runtime, providing memory safety and high concurrency.

## Usage

### Client (Socket)

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

### Server (Dynamic Port Support)

The server supports binding to a dynamic port by using `0`.

```typescript
import net from 'react-native-nitro-net';

const server = net.createServer((socket) => {
  socket.write('Echo: ' + socket.read());
});

// Use 0 for dynamic port allocation
server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  console.log(`Server listening on dynamic port: ${address?.port}`);
});
```

### TLS (Secure Socket)

```typescript
import { tls } from 'react-native-nitro-net';

// Client connection
const socket = tls.connect({
  host: 'example.com',
  port: 443,
  servername: 'example.com', // SNI
}, () => {
  console.log('Securely connected!');
  console.log('Protocol:', socket.getProtocol());
});

// Server with PFX
const server = tls.createServer({
  pfx: fs.readFileSync('server.pfx'),
  passphrase: 'your-password'
}, (socket) => {
  socket.write('Secure hello!');
});
server.listen(443);
```

## Stability Improvements

We have implemented several critical fixes to ensure production-grade stability:

*   **Port Reuse (`SO_REUSEPORT`)**: Automatically enabled on Unix/iOS to allow immediate server restarts without the "Address already in use" error.
*   **Anti-Deadlock Logic**: C++ layer uses lock-free callback dispatching to prevent UI freezes during high-frequency events.
*   **DNS Reliability**: Automatically retries all resolved IP addresses if the first one fails to connect.
*   **Resource Management**: Strict protective shutdown logic in Rust to prevent socket and Unix domain socket file leaks.

## Compatibility Notes

> [!IMPORTANT]
> **`Server.close()` Behavior**: Unlike Node.js's default behavior where `server.close()` only stops accepting new connections, this implementation **immediately destroys all active connections** when `close()` is called. This ensures clean resource release and is more intuitive for mobile applications.

## API Reference

### `net.Socket`

| Property / Method | Description |
| --- | --- |
| `connect(options)` | Connect to a remote host/port or Unix path. |
| `write(data)` | Send data asynchronously. Supports backpressure. |
| `destroy()` | Immediate closing of the socket and resource cleanup. |
| `setNoDelay(bool)` | Control Nagle's algorithm. |
| `setKeepAlive(bool)`| Enable/disable keep-alive. |
| `address()` | Returns `{ port, family, address }` for the local side. |

**Events**: `connect`, `ready`, `data`, `error`, `close`, `timeout`, `lookup`.

### `tls.TLSSocket`
*Extends `net.Socket`*

| Property / Method | Description |
| --- | --- |
| `authorized` | `true` if peer certificate is verified. |
| `getProtocol()` | Returns negotiated TLS version (e.g., "TLSv1.3"). |
| `getCipher()` | Returns current cipher information. |
| `getPeerCertificate()`| Returns detailed JSON of the peer certificate. |
| `getSession()` | Returns the session ticket for resumption. |
| `encrypted` | Always `true`. |

**Events**: `secureConnect`, `session`, `keylog`, `OCSPResponse`.

### Global APIs

| Method | Description |
| --- | --- |
| `initWithConfig(options)` | Optional. Initializes the Rust runtime with custom settings (e.g., `workerThreads`). Must be called before any other operation. |
| `setVerbose(bool)` | Toggle detailed logging for JS, C++, and Rust. |
| `isIP(string)` | Returns `0`, `4`, or `6`. |

### `net.Server`

| Method | Description |
| --- | --- |
| `listen(options)` | Start listening. Supports `port: 0` for dynamic allocation. |
| `close()` | Stops the server and **destroys all active connections**. |
| `address()` | Returns the bound address (crucial for dynamic ports). |
| `getConnections(cb)`| Get count of active connections. |

**Events**: `listening`, `connection`, `error`, `close`.

### `tls.Server`
*Extends `net.Server`*

Supported methods: `listen`, `close`, `addContext`, `setTicketKeys`, `getTicketKeys`.
**Events**: `secureConnection`, `keylog`, `newSession`.

## Debugging

Enable verbose logging to see the internal data flow across JS, C++, and Rust:

```typescript
import { setVerbose } from 'react-native-nitro-net';

setVerbose(true);
```

Logs will be visible in your native debugger (Xcode/logcat) and JS console, prefixed with `[NET DEBUG]` or `[NET NATIVE]`.

## License

ISC
