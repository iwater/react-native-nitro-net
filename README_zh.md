# react-native-nitro-net

基于 [Nitro Modules](https://github.com/mrousavy/nitro) 和 Rust 实现的 React Native Node.js `net`, `tls`, `http`, `https` 和 `http2` API。

## 特性

*   🚀 **高性能**: 基于 Rust 的 `tokio` 异步运行时构建。
*   🤝 **兼容 Node.js**: 完整实现了标准的 `net`, `tls`, `http`, `https` 以及 `http2` API。
*   🌐 **Fetch API**: 基于 Web 标准实现的 `fetch` API，支持响应头到达即返回，body 按需流式读取。
*   🛡️ **现代安全**: 默认 TLS 由 **Rustls 0.23** (Ring provider) 驱动，支持 TLS 1.2 和 1.3；支持服务端 mTLS（客户端认证）与 ALPN 协商。
*   🎭 **可选 Chrome 指纹**: `configure({ impersonate: 'chrome' })` 启用 BoringSSL + HTTP/2 指纹伪装。
*   🔀 **HTTP/2 支持**: 导出标准 `http2` 模块（客户端门面及原生驱动的 H2 服务器）。
*   🔒 **全协议支持**: 支持 PEM/PFX 证书、SNI、HTTP Trailers、100 Continue、协议升级 (101)、HTTP 隧道 (CONNECT) 以及现有 Socket 平滑升级为 TLS (`tls.connect({ socket })`)。
*   ⚡ **Nitro Modules**: 使用 JSI 进行 JavaScript 和 Native 代码之间的零开销通信。
*   🛡️ **稳健且稳定**: 连接生命周期严格对齐 Node.js（`server.close()`、`closeAllConnections()`），彻底解决流 `instanceof` 分叉和跨包依赖问题。
*   📱 **跨平台**: 支持 iOS 和 Android（以及 macOS 编译与本地开发）。

## 安装

```bash
npm install react-native-nitro-net
# or
yarn add react-native-nitro-net
```

### iOS

需要运行 `pod install` 来链接原生库：

```bash
cd ios && pod install
```

> **注意**: iOS Deployment Target 最低支持 iOS 15.1（受 CocoaPods `min_ios_version_supported` 影响）。

## 架构

本库采用高性能三层架构：

1.  **JavaScript 层**: 提供与 Node.js 兼容的高级 API，基类统一按 core 模块 `stream` 导入（通过依赖别名消除 `readable-stream` 跨包多副本与 `instanceof` 分叉）。
2.  **C++ 桥接层 (Nitro)**: 使用 Nitro Hybrid Objects 和 JSI 在 JS 和 Rust 之间进行零拷贝调度。
3.  **Rust 核心层**: 使用 **Tokio** 异步运行时实现底层的网络、TLS 与 HTTP/2 状态机，兼具内存安全与高并发吞吐。

## 使用指南

### TCP 客户端 (`net.Socket`)

```typescript
import net from 'react-native-nitro-net';

const client = net.createConnection({ port: 8080, host: '1.1.1.1' }, () => {
  console.log('已连接!');
  client.write('Hello Server!');
});

client.on('data', (data) => {
  console.log('收到数据:', data.toString());
});

client.on('error', (err) => {
  console.error('错误:', err.message);
});
```

### TCP 服务端 (`net.Server`)

支持通过绑定端口 `0` 进行动态端口分配，支持 Unix domain socket 路径：

```typescript
import net from 'react-native-nitro-net';

const server = net.createServer((socket) => {
  socket.write('Echo: ' + socket.read());
});

// 使用 0 进行动态端口分配
server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  console.log(`服务器监听在动态端口: ${typeof address === 'object' ? address?.port : address}`);
});
```

### TLS (安全套接字)

```typescript
import { tls } from 'react-native-nitro-net';

// 1. 客户端连接
const socket = tls.connect({
  host: 'example.com',
  port: 443,
  servername: 'example.com', // SNI
}, () => {
  console.log('安全连接已建立!');
  console.log('协议版本:', socket.getProtocol());
});

// 2. 现有 net.Socket 升级为 TLS
const rawSocket = net.connect(443, 'example.com', () => {
  const tlsSocket = tls.connect({
    socket: rawSocket,
    servername: 'example.com',
  }, () => {
    console.log('TLS 升级握手成功');
  });
});

// 3. 服务端（支持 PFX、mTLS 客户端证书校验与 ALPN 协商）
const server = tls.createServer({
  pfx: fs.readFileSync('server.pfx'),
  passphrase: 'your-password',
  ALPNProtocols: ['h2', 'http/1.1'],
  requestCert: true,
  rejectUnauthorized: true,
  ca: [fs.readFileSync('client-ca.crt')],
}, (socket) => {
  console.log('客户端证书验证状态:', socket.authorized);
  socket.write('Secure hello!');
});
server.listen(443);
```

*   **高级特性**: 支持 Wireshark 的 `keylog` 事件重发、会话恢复 (`setSession`)、Unix 路径支持以及 `asyncDispose`。
*   **性能调优**: 可配置 `headersTimeout`, `keepAliveTimeout`, 和 `requestTimeout`。
*   **资源管理**: 引入 LoopRef 机制保持事件循环活跃，平滑释放 native socket 和 Unix domain socket 资源。

### HTTP / HTTPS 请求

实现了标准的 Node.js `http` 与 `https` API，支持 `url.URL` 参数、`AbortSignal` 取消以及 Agent 连接池：

```typescript
import { http, https } from 'react-native-nitro-net';

// HTTP GET
http.get('http://example.com', (res) => {
  console.log(`状态码: ${res.statusCode}`);
  res.on('data', (chunk) => console.log(`收到数据分块: ${chunk.length} 字节`));
  res.on('end', () => console.log('请求完成'));
});

// 支持 AbortSignal 取消
const controller = new AbortController();
const req = http.request('http://example.com', { signal: controller.signal }, (res) => {
  // ...
});
// controller.abort();

// HTTPS 与 Agent 连接复用
const agent = new https.Agent({ keepAlive: true });
https.get('https://api.github.com/users/margelo', { agent }, (res) => {
  // ...
});
```

### HTTP/2 (node:http2 兼容)

导出对齐 Node.js `node:http2` 的核心 API：

```typescript
import { http2, isHttp2Available, configure } from 'react-native-nitro-net';

// 1. 客户端会话
if (isHttp2Available()) {
  configure({ impersonate: 'chrome' });

  const client = http2.connect('https://example.com');
  const req = client.request({ ':path': '/' });

  req.on('response', (headers, flags) => {
    console.log('H2 状态码:', headers[':status']);
  });

  req.setEncoding('utf8');
  req.on('data', (chunk) => console.log('分块:', chunk));
  req.on('end', () => client.close());
}

// 2. HTTP/2 服务端
const server = http2.createServer((stream, headers) => {
  stream.respond({
    ':status': 200,
    'content-type': 'text/plain; charset=utf-8',
  });
  stream.end('Hello HTTP/2!');
});

server.listen(8443);
```

支持 Node.js `http2` 模块的 11 项标准导出：`connect`, `createServer`, `createSecureServer`, `getDefaultSettings`, `getPackedSettings`, `getUnpackedSettings`, `Http2ServerRequest`, `Http2ServerResponse`, `constants`, `sensitiveHeaders`, `performServerHandshake`。

### Chrome 指纹伪装（可选）

```typescript
import { configure, isImpersonationAvailable, isHttp2Available } from 'react-native-nitro-net';

// 原生构建需编译 impersonate feature（BoringSSL + HTTP/2）
if (isImpersonationAvailable()) {
  configure({ impersonate: 'chrome', match: ['*.example.com'] });
}
console.log('HTTP/2 支持:', isHttp2Available());
```

* 匹配的 HTTPS 请求使用 Chrome 150 的 TLS ClientHello（cipher/curve/sigalg/GREASE/ALPS/ECH grease）。
* 自动协商 HTTP/2：SETTINGS、WINDOW_UPDATE、伪头 `m,a,s,p` 与普通头顺序均与实测抓包一致。
* 服务端只选 `http/1.1` 时自动回退现有 H1 路径（按 Agent 记忆）。
* 不调用 `configure(...)` 时行为完全不变：Rustls + HTTP/1.1。
* 自定义 `lookup` / `createConnection` / `checkServerIdentity`、`Upgrade`、`CONNECT` 保持走 H1。

### Fetch API (Web 标准)

基于 Nitro Net 高性能核心实现的 Web 标准 `fetch` API，响应头到达即刻返回，支持真正的按需流式读取：

```typescript
import { fetch, FetchHeaders, FetchResponse } from 'react-native-nitro-net';

const response = await fetch('https://api.example.com/data', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ key: 'value' })
});

console.log('状态码:', response.status);
const data = await response.json();
const blob = await response.blob(); // 支持二进制 Blob
```

### 解压支持

提供 zlib provider 后，`fetch` 会自动解码 gzip / deflate / br / zstd：

```typescript
import { setZlibProvider } from 'react-native-nitro-net';
import * as zlib from 'react-native-nitro-zlib';

setZlibProvider(zlib);
```

* 如果外部 provider 未提供 zstd，会自动回退到内置的纯 JS zstd 解码器。
* `http.request` / `https.request` 保持 Node 语义，返回原始未解压字节。

### 代理支持

HTTPS 请求可以使用 HTTP CONNECT / SOCKS / HTTPS 代理：

```typescript
import { https, fetch } from 'react-native-nitro-net';

const agent = new https.Agent({ proxy: 'socks5://user:pass@proxy.local:1080' });
https.get('https://example.com', { agent }, (res) => { /* ... */ });

const response = await fetch('https://example.com', {
  proxy: 'http://proxy.local:8080'
});

// HTTPS-to-proxy：先与代理做 TLS，在隧道里 CONNECT，再与源站做 TLS。
// proxyTls 只作用于代理这一跳，源站的 ca/cert/key 完全独立。
const tlsProxy = new https.Agent({
  proxy: 'https://user:pass@proxy.example:443',
  proxyTls: { ca: fs.readFileSync('corp-proxy-ca.pem') },
});
```

支持的 scheme：`http://`（CONNECT）、`https://`（TLS 上做 CONNECT）、`socks5://` / `socks5h://`、`socks4://` / `socks4a://`。
同时支持环境变量 `HTTPS_PROXY` / `HTTP_PROXY` 与 `NO_PROXY`。

---

## 兼容性与行为说明

> [!NOTE]
> **`Server.close()` 行为（对齐 Node.js）**:
> 自 **v0.6.2** 起，`server.close([callback])` 已与 Node.js 规范完全对齐——它**只停止接受新的连接**，已建立的活跃连接会继续保留直到自然关闭。
> 如果你需要立即强制销毁所有已建立连接（即早期的旧行为），请显式调用新增的 **`server.closeAllConnections()`**（对齐 Node 18.2+）。

> [!NOTE]
> **`TLSSocket.getSession()` 说明**:
> 默认的 Rustls 后端不提供客户端 session ticket 导出（调用将抛出 `ERR_NOT_SUPPORTED`）。该方法仅在启用 Chrome 指纹伪装（BoringSSL / btls）连接下返回有效 session Buffer。可使用 `setSession(session)` 传入预存会话。

> [!NOTE]
> **流依赖一致性**:
> 本库已将所有流基类统一重构至 core 名字 `stream`，消除多份 `readable-stream` 导致的 `instanceof` 分叉问题。

---

## API 参考

### `net.Socket`

| 属性 / 方法 | 说明 |
| --- | --- |
| `connect(options)` | 连接到远程 host/port 或 Unix 路径。 |
| `write(data)` | 异步发送数据。支持背压。 |
| `destroy()` | 立即关闭 socket 并清理资源。 |
| `setNoDelay(bool)` | 控制 Nagle 算法。 |
| `setKeepAlive(bool)`| 启用/禁用 keep-alive。 |
| `address()` | 返回本地端的 `{ port, family, address }`。 |
| `ref()` / `unref()` | 挂钩宿主事件循环活跃计数（RN 上平滑降级为 no-op）。 |

**事件**: `connect`, `ready`, `data`, `error`, `close`, `timeout`, `lookup`。

### `tls.TLSSocket`
*继承自 `net.Socket`*

| 属性 / 方法 | 说明 |
| --- | --- |
| `authorized` | 如果对等证书已验证通过则为 `true`。 |
| `authorizationError` | 证书验证失败时的错误原因。 |
| `getProtocol()` | 返回协商的 TLS 版本 (如 "TLSv1.3")。 |
| `getCipher()` | 返回当前加密算法信息。 |
| `getPeerCertificate()`| 返回对等端证书的详细 JSON 格式。 |
| `getSession()` | 返回 Session ticket（仅限 BoringSSL / Chrome 伪装连接）。 |
| `setSession(buffer)` | 传入要在建连握手时复用的 Session ticket。 |
| `encrypted` | 始终为 `true`。 |

**事件**: `secureConnect`, `session`, `keylog`, `OCSPResponse`。

### `net.Server`

| 方法 | 说明 |
| --- | --- |
| `listen(options)` | 开始监听。支持 `port: 0` 动态分配，支持 Unix domain socket 路径。 |
| `close([callback])` | 停止接受新连接（已建立连接继续处理，对齐 Node.js）。 |
| `closeAllConnections()` | **立即强制断开并销毁所有活跃连接**（对齐 Node 18.2+）。 |
| `setTimeout([msecs][, callback])` | 设置服务器无活动超时时间。 |
| `address()` | 返回绑定的地址对象 `{ port, family, address }` 或 Unix socket 路径。 |
| `getConnections(cb)`| 获取当前活跃连接数。 |

**事件**: `listening`, `connection`, `close`, `error`。

### `tls.Server`
*继承自 `net.Server`*

支持方法: `listen`, `close`, `closeAllConnections`, `addContext`, `setTicketKeys`, `getTicketKeys`。
支持选项: `ALPNProtocols`（协商应用层协议）、`requestCert` / `rejectUnauthorized` / `ca`（客户端证书 mTLS 验证）、`cert` / `key` / `pfx`。
**事件**: `secureConnection`, `keylog`, `newSession`。

### `http2` 模块

| 导出项 | 类型 | 说明 |
| --- | --- | --- |
| `connect(authority, options)` | 函数 | 建立客户端 ClientHttp2Session 会话。 |
| `createServer(options, onStream)` | 函数 | 创建明文 HTTP/2 服务端。 |
| `createSecureServer(options, onStream)` | 函数 | 创建 TLS HTTP/2 服务端（支持 `allowHTTP1`）。 |
| `getDefaultSettings()` | 函数 | 获取默认 HTTP/2 SETTINGS 参数。 |
| `getPackedSettings(settings)` | 函数 | 将设置对象序列化为二进制 Buffer。 |
| `getUnpackedSettings(buf)` | 函数 | 将二进制 Buffer 解码为设置对象。 |
| `Http2ServerRequest` / `Http2ServerResponse` | 类 | 兼容 Node.js 的 HTTP/2 服务端请求与响应类。 |
| `constants` | 对象 | HTTP/2 帧类型、错误码与标志常量表。 |
| `sensitiveHeaders` | Symbol | 标记敏感头字段的 Symbol。 |

### 全局 API

| 方法 / 导出 | 说明 |
| --- | --- |
| `initWithConfig(options)` | 可选。使用自定义设置 (例如 `workerThreads`, `debug`) 初始化 Rust 运行时。 |
| `setVerbose(bool)` | 开启/关闭 JS、C++ 和 Rust 的详细日志。 |
| `isIP(string)` | 返回 `0`, `4`, 或 `6`。 |
| `isHttp2Available()` | 返回当前原生二进制是否支持 HTTP/2 引擎。 |
| `isImpersonationAvailable()` | 返回当前原生二进制是否支持 Chrome 指纹伪装。 |
| `networkInterfaces()` | 返回本地网络接口对象 (类似于 Node 的 `os.networkInterfaces()`)。 |
| `FetchHeaders` / `FetchResponse` | 导出的标准 Web Fetch 请求头与响应构造类型。 |
| `setZlibProvider(provider)` | 注入外部解压模块（如 `react-native-nitro-zlib`）。 |

## 调试

启用详细日志以查看 JS、C++ 和 Rust 之间的内部数据流：

```typescript
import { setVerbose } from 'react-native-nitro-net';

setVerbose(true);
```

日志将显示在原生调试器（Xcode/logcat）和 JS 控制台中，前缀为 `[NET DEBUG]` 或 `[NET NATIVE]`。

## 许可

ISC
