# react-native-nitro-net

基于 [Nitro Modules](https://github.com/mrousavy/nitro) 和 Rust 实现的 React Native Node.js `net` API。

## 特性

*   🚀 **高性能**: 基于 Rust 的 `tokio` 异步运行时构建。
*   🤝 **兼容 Node.js**: 实现了标准的 `net` API，包括 `Socket` (Duplex 流) 和 `Server`。
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

1.  **JavaScript 层**: 使用 `readable-stream` 和 `EventEmitter` 提供与 Node.js 兼容的高级 `net.Socket` (Duplex) 和 `net.Server` API。
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

## 稳定性改进

我们实施了多个关键修复以确保生产级的稳定性：

*   **端口复用 (`SO_REUSEPORT`)**: 在 Unix/iOS 上默认启用，允许服务器立即重启，避免 "Address already in use" 错误。
*   **防死锁逻辑**: C++ 层采用无锁回调调度，防止在高频事件期间 UI 冻结。
*   **DNS 可靠性**: 如果第一个解析出的 IP 地址连接失败，会自动重试所有解析出的地址。
*   **资源管理**: Rust 端严格的保护性关闭逻辑，防止 socket 和 Unix 域套接字文件泄漏。

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
| `close()` | 停止服务器接收新连接。 |
| `address()` | 返回绑定的地址（获取动态端口的关键）。 |
| `getConnections(cb)`| 获取当前活跃连接数。 |

**事件**: `listening`, `connection`, `error`, `close`。

## 调试

启用详细日志以查看 JS、C++ 和 Rust 之间的内部数据流：

```typescript
import { setVerbose } from 'react-native-nitro-net';

setVerbose(true);
```

日志将显示在原生调试器（Xcode/logcat）和 JS 控制台中，前缀为 `[NET DEBUG]` 或 `[NET NATIVE]`。

## 许可

ISC
