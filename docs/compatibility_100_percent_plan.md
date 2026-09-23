# 100% 兼容性实现详细计划

本计划基于 [兼容性审计报告](./compatibility_audit.md) 制定，旨在填补 `react-native-nitro-net` 与 Node.js 官方 API 之间的所有已知差距。

## 执行策略

我们将分四个阶段完成兼容性补全：
1.  **API 对齐 (Polyfill)**: 纯 JavaScript 层的缺失类和方法补全。
2.  **结构重构**: 修正类继承关系和事件流。
3.  **功能增强**: 实现缺失的逻辑（如代理、身份验证检查）。
4.  **Native 桥接**: 需要底层 C++/Rust 支持的高级功能。

---

## 1. HTTP 模块 (`http`)

### 1.1 代理 (Proxy) 支持
Node.js 的 `http.Agent` 能够根据环境变量自动配置代理。
*   **任务**:
    *   在 `Agent` 构造函数中读取 `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`。
    *   引入或实现一个轻量级的 `ProxyAgent` 逻辑：
        *   对 `http:` 目标：建立到代理服务器的 TCP 连接，发送原始请求（或通过 `CONNECT`）。
        *   对 `https:` 目标：发送 `CONNECT` 请求建立隧道，然后在隧道上进行 TLS 握手。

### 1.2 类型定义与签名
*   **任务**:
    *   更新 `react-native-nitro-net/src/http.ts`。
    *   修正 `createServer` 导出定义，使其包含 `(options, requestListener)` 重载。
    *   确保运行时即使忽略某些 options 也不报错。

---

## 2. HTTPS 模块 (`https`)

### 2.1 继承链重构 (Critical)
当前 `https.Server` 继承自 `http.Server`，这导致 `instanceof tls.Server` 检查失败，且无法自然继承 TLS 事件。
*   **任务**:
    *   修改 `https.Server` 继承自 `tls.Server`。
    *   **逻辑调整**:
        *   `tls.Server` 负责处理 TCP 连接和 TLS 握手。
        *   握手成功后 (`secureConnection`)，将 socket 移交给 `http.Server` 的请求解析逻辑（`_connectionListener`）。
    *   **收益**: 自动获得 `tls.Server` 的所有方法（`addContext`, `setTicketKeys`）和事件。

### 2.2 事件转发补全
*   **任务**:
    *   确保以下事件从底层正确冒泡：
        *   `tlsClientError`: 握手失败时的错误信息。
        *   `newSession` / `resumeSession`: TLS 会话管理事件。
        *   `keylog`: 用于调试的密钥日志。

### 2.3 `SNICallback` 兼容
`rustls` 支持 SNI，但目前的 API 是通过 `addContext` 预先注册。Node.js 允许通过 `SNICallback` 异步决定。
*   **兼容方案**:
    *   如果提供了 `SNICallback`，我们可以在 JS 层封装一个 `addContext` 的动态调用，但这受限于握手阶段的同步性。
    *   **替代方案**: 实现一个 shim，当 `SNICallback` 存在时，打印警告建议使用 `addContext`，或者尝试在 Native 层实现 ClientHello 回调（复杂度高，优先级低）。

---

## 3. Net 模块 (`net`)

### 3.1 缺失类 Polyfill
这些类是纯逻辑实现，不依赖 Native。
*   **任务**:
    *   实现 `net.BlockList`: 参考 Node.js 源码，实现 IP 地址段匹配逻辑。
    *   实现 `net.SocketAddress`: 解析 IP 地址和端口字符串。

### 3.2 缺失属性与选项
*   **任务**:
    *   `bufferSize`: 在 JS `Socket` 类中追踪待写入队列的大小。
    *   `server.listen(options)`: 解析并处理 `exclusive`, `ipv6Only` (已支持), `backlog` 等参数。对于不支持的参数（如 `readableAll`），记录 Debug 日志并忽略。

---

## 4. TLS 模块 (`tls`)

### 4.1 主机名校验 (`checkServerIdentity`)
目前 `tls.connect` 仅依赖底层 Rustls 的校验。Node.js 允许用户自定义或使用默认的 JS 层校验。
*   **任务**:
    *   移植 Node.js 的 `checkServerIdentity` 函数到 `tls.ts`。
    *   在 `tls.connect` 握手完成后，自动调用该函数校验 `getPeerCertificate()` 返回的证书。
    *   如果校验失败，触发 `error` 并断开连接。

### 4.2 导出密钥材料 (`exportKeyingMaterial`)
用于高级协议（如 WebRTC, HTTP/2）。
*   **任务**:
    *   在 Rust 层 (`rust_c_net`) 暴露 socket 的 `export_keying_material` 接口。
    *   通过 JSI 暴露给 JS 层。

### 4.3 显式不支持特性的处理
对于 `renegotiation` 等 Rustls 不支持的特性：
*   **任务**:
    *   保留 API 方法存根。
    *   调用时抛出符合 Node.js 规范的错误代码 (`ERR_TLS_RENEGOTIATION_DISABLED`)，而不是通用的 "Not implemented"。

---

## 5. 验收标准

*   **测试套件**: 移植 Node.js 的 `test/parallel/test-http*`, `test-https*`, `test-tls*` 关键测试用例。
*   **TypeScript 类型**: 100% 匹配 `@types/node` 的定义。
*   **文档**: 更新 API 文档，明确标注任何细微的行为差异（如果有）。
