# react-native-nitro-net

基于 [Nitro Modules](https://github.com/mrousavy/nitro) 和 Rust 实现的 React Native Node.js `net` API。

## 特性

*   🚀 **高性能**: 基于 Rust 的 `tokio` 异步运行时构建。
*   🤝 **兼容 Node.js**: 实现了标准的 `net` 和 `tls` API，包括 `Socket`, `Server`, `TLSSocket` 和 `SecureContext`。
*   🛡️ **现代安全**: TLS 实现由 **Rustls 0.23** (Ring provider) 驱动，支持 TLS 1.2 和 1.3。
*   🔒 **全功能 TLS 支持**: 支持 PEM/PFX 证书、加密私钥、SNI、Session ticket，并实现 100% Node.js API 表面兼容。
*   ⚡ **Nitro Modules**: 使用 JSI 进行 JavaScript 和 Native 代码之间的零开销通信。
*   🛡️ **稳健且稳定**: 针对端口复用、死锁和 DNS 可靠性等常见网络问题进行了高级修复。
*   📱 **跨平台**: 支持 iOS 和 Android。

## 安装

```bash
npm install react-native-nitro-net
# or
yarn add react-native-nitro-net
```

### iOS

需要运行 `pod install` 来链接原生库。

```bash
cd ios && pod install
```

## 架构

本库采用高性能三层架构：

1.  **JavaScript 层**: 使用 `readable-stream` 和 `EventEmitter` 提供与 Node.js 兼容的高级 `net` 和 `tls` API。
2.  **C++ 桥接层 (Nitro)**: 使用 Nitro Hybrid Objects 和 JSI 在 JS 和 Rust 之间进行零拷贝调度。
3.  **Rust 核心层**: 使用 **Tokio** 异步运行时实现实际的网络逻辑，提供内存安全和高并发处理。

## 使用

### 客户端 (Socket)

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

### 服务端 (支持动态端口分配)

服务器支持通过使用端口 `0` 来绑定到动态端口。

```typescript
import net from 'react-native-nitro-net';

const server = net.createServer((socket) => {
  socket.write('Echo: ' + socket.read());
});

// 使用 0 进行动态端口分配
server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  console.log(`服务器监听在动态端口: ${address?.port}`);
});
```

### TLS (安全套接字)

```typescript
import { tls } from 'react-native-nitro-net';

// 客户端连接
const socket = tls.connect({
  host: 'example.com',
  port: 443,
  servername: 'example.com', // SNI
}, () => {
  console.log('安全连接已建立!');
  console.log('协议版本:', socket.getProtocol());
});

// 使用 PFX 的服务端
const server = tls.createServer({
  pfx: fs.readFileSync('server.pfx'),
  passphrase: 'your-password'
}, (socket) => {
  socket.write('Secure hello!');
});
server.listen(443);
```

## 稳定性改进

我们实施了多个关键修复以确保生产级的稳定性：

*   **端口复用 (`SO_REUSEPORT`)**: 在 Unix/iOS 上默认启用，允许服务器立即重启，避免 "Address already in use" 错误。
*   **防死锁逻辑**: C++ 层采用无锁回调调度，防止在高频事件期间 UI 冻结。
*   **DNS 可靠性**: 如果第一个解析出的 IP 地址连接失败，会自动重试所有解析出的地址。
*   **资源管理**: Rust 端严格的保护性关闭逻辑，防止 socket 和 Unix 域套接字文件泄漏。

## 兼容性说明

> [!IMPORTANT]
> **`Server.close()` 行为变更**: 与 Node.js 默认行为不同（`server.close()` 仅停止接受新连接），本实现在调用 `close()` 时会**立即销毁所有活跃连接**。这确保了资源的干净释放，更适合移动应用的使用场景。

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

**事件**: `connect`, `ready`, `data`, `error`, `close`, `timeout`, `lookup`。

### `tls.TLSSocket`
*继承自 `net.Socket`*

| 属性 / 方法 | 说明 |
| --- | --- |
| `authorized` | 如果对等证书已验证则为 `true`。 |
| `getProtocol()` | 返回协商的 TLS 版本 (如 "TLSv1.3")。 |
| `getCipher()` | 返回当前加密算法信息。 |
| `getPeerCertificate()`| 返回对等端证书的详细 JSON 格式。 |
| `getSession()` | 返回用于恢复连接的 Session ticket。 |
| `encrypted` | 始终为 `true`。 |

**事件**: `secureConnect`, `session`, `keylog`, `OCSPResponse`。

### 全局 API

| 方法 | 说明 |
| --- | --- |
| `initWithConfig(options)` | 可选。使用自定义设置（如 `workerThreads`）初始化 Rust 运行时。必须在进行任何其他操作之前调用。 |
| `setVerbose(bool)` | 开启/关闭 JS、C++ 和 Rust 的详细日志。 |
| `isIP(string)` | 返回 `0`, `4`, 或 `6`。 |

### `net.Server`

| 方法 | 说明 |
| --- | --- |
| `listen(options)` | 开始监听。支持 `port: 0` 进行动态分配。 |
| `close()` | 停止服务器并**销毁所有活跃连接**。 |
| `address()` | 返回绑定的地址（获取动态端口的关键）。 |
| `getConnections(cb)`| 获取当前活跃连接数。 |

**事件**: `listening`, `connection`, `error`, `close`。

### `tls.Server`
*继承自 `net.Server`*

支持方法: `listen`, `close`, `addContext`, `setTicketKeys`, `getTicketKeys`。
**事件**: `secureConnection`, `keylog`, `newSession`。

## 调试

启用详细日志以查看 JS、C++ 和 Rust 之间的内部数据流：

```typescript
import { setVerbose } from 'react-native-nitro-net';

setVerbose(true);
```

日志将显示在原生调试器（Xcode/logcat）和 JS 控制台中，前缀为 `[NET DEBUG]` 或 `[NET NATIVE]`。

## 许可

ISC
