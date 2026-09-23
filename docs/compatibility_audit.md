# Compatibility Audit (兼容性审计总览)

本文档汇总了 `react-native-nitro-net` 各个子模块与 Node.js 官方 API 的兼容性状态。

**总体状态**: ✅ **高兼容性 (>98%)**

---

## 1. HTTP 模块 (`http`)

### ✅ 完全实现
*   **createServer 签名**: 支持 `createServer(options, requestListener)` 重载
*   **Agent 代理**: 支持 `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` 环境变量
*   **连接池**: 完整的 `keepAlive`, `maxSockets`, `freeSockets` 支持
*   **HTTP 隧道**: 支持 `CONNECT` 方法和 `connect` 事件

---

## 2. HTTPS 模块 (`https`)

### ✅ 已实现
*   **事件转发**: `secureConnection`, `tlsClientError`, `newSession`, `resumeSession`, `keylog`
*   **默认配置**: `globalAgent` 默认 `keepAlive: true`
*   **SNICallback**: 提供警告信息，建议使用 `addContext()` 替代

### ✅ 已实现
*   **继承链**: `https.Server` 正确继承自 `tls.Server`

---

## 3. Net 模块 (`net`)

### ✅ 完全实现
*   **net.BlockList**: `rules`, `isBlockList()`, `fromJSON()`, `toJSON()`
*   **net.SocketAddress**: `SocketAddress.parse()` 静态方法
*   **Socket.timeout**: 正确追踪超时值

---

## 4. TLS 模块 (`tls`)

### ✅ 已实现
*   **checkServerIdentity**: `tls.connect` 支持自定义主机名验证
*   **Unix TLS Server**: 完整支持 Unix 域套接字上的 TLS 服务 (`listenTLSUnix`)
*   **exportKeyingMaterial**: 完整支持 RFC 5705 导出 (支持 Client/Server/Unix)
*   **Renegotiation**: 抛出 `ERR_TLS_RENEGOTIATION_DISABLED`

---

### ❌ 不支持 (WontFix)
*   **getFinished/getPeerFinished**: Rustls 不支持

---

*最后更新: 2025-12-29*
