#ifndef NET_BINDINGS_H
#define NET_BINDINGS_H

#pragma once

#include <cstdarg>
#include <cstdint>
#include <cstdlib>
#include <ostream>
#include <new>

constexpr static const int NET_EVENT_CONNECT = 1;

constexpr static const int NET_EVENT_DATA = 2;

constexpr static const int NET_EVENT_ERROR = 3;

constexpr static const int NET_EVENT_CLOSE = 4;

constexpr static const int NET_EVENT_WRITTEN = 5;

constexpr static const int NET_EVENT_CONNECTION = 6;

constexpr static const int NET_EVENT_TIMEOUT = 7;

constexpr static const int NET_EVENT_LOOKUP = 8;

constexpr static const int NET_EVENT_SESSION = 9;

constexpr static const int NET_EVENT_KEYLOG = 10;

constexpr static const int NET_EVENT_OCSP = 11;

constexpr static const int NET_EVENT_BUSY = 12;

/// #82：就地 TLS 升级完成（`tls.connect({socket})`）。
///
/// **不是** CONNECT：node 在传进来的 socket 已经连上时不发 `'connect'`（实测 v22），
/// 只在握手完成后发 `'secureConnect'`。JS 侧把这个事件路由到身份校验 + secureConnect。
constexpr static const int NET_EVENT_TLS_READY = 30;

constexpr static const int NET_EVENT_H2_READY = 20;

constexpr static const int NET_EVENT_H2_HEADERS = 21;

constexpr static const int NET_EVENT_H2_DATA = 22;

constexpr static const int NET_EVENT_H2_TRAILERS = 23;

constexpr static const int NET_EVENT_H2_END = 24;

constexpr static const int NET_EVENT_H2_ERROR = 25;

constexpr static const int NET_EVENT_H2_CLOSE = 26;

constexpr static const int NET_EVENT_H2_GOAWAY = 27;

constexpr static const int NET_EVENT_H2_KEYLOG = 28;

constexpr static const int NET_EVENT_H2_DRAIN = 29;

/// P5：PING 回执；JSON `{ id, rttMs }`（crate 不暴露对端 payload，门面只报 RTT）。
constexpr static const int NET_EVENT_H2_PING = 31;

/// 服务端通道专用：accept 分流把一条连接交给了 h2 引擎；载荷是 session id 的十进制文本。
/// ⚠️ 7 在 **socket** 通道是 TIMEOUT —— 事件编号按通道分族，这里只看 server 驱动。
constexpr static const int NET_EVENT_H2_SERVER_SESSION = 7;

extern "C" {

/// # Safety
///
/// 指针参数须指向有效内存（字符串以 NUL 结尾），
/// 且在本函数返回前不被释放或改写 —— 违反即 UB。
void net_init(void (*callback)(uint32_t, int, const uint8_t*, uintptr_t, void*), void *context);

/// Initialize the net library with configuration
///
/// # Safety
/// - `callback` must be a valid function pointer
/// - `context` must remain valid during the callback
/// - `worker_threads`: number of worker threads, 0 means use CPU core count
///
/// Note: This function must be called before any other net_* functions,
/// otherwise the configuration will not take effect.
/// # Safety
///
/// 指针参数须指向有效内存（字符串以 NUL 结尾），
/// 且在本函数返回前不被释放或改写 —— 违反即 UB。
void net_init_with_config(void (*callback)(uint32_t, int, const uint8_t*, uintptr_t, void*),
                          void *context,
                          uint32_t worker_threads);

/// Set the debug logging mode dynamically
void net_set_debug(bool debug);

uint32_t net_create_socket();

/// # Safety
///
/// 指针参数须指向有效内存（字符串以 NUL 结尾），
/// 且在本函数返回前不被释放或改写 —— 违反即 UB。
void net_connect(uint32_t id, const char *host, int port);

/// # Safety
///
/// 指针参数须指向有效内存（字符串以 NUL 结尾），
/// 且在本函数返回前不被释放或改写 —— 违反即 UB。
void net_connect_tls(uint32_t id,
                     const char *host,
                     int port,
                     const char *server_name,
                     int reject_unauthorized);

/// #82：在**已连接的明文 socket** 上就地升级为 TLS（`tls.connect({socket})`）。
///
/// 同步返回；握手在 writer 任务里进行，结果走事件：
/// 成功 `NET_EVENT_TLS_READY`，失败 `NET_EVENT_ERROR`。**不发 CONNECT**（连接早已建立）。
///
/// # Safety
///
/// `server_name` 须是以 NUL 结尾的合法字符串（可为空指针）。
void net_starttls(uint32_t id,
                  const char *server_name,
                  bool reject_unauthorized,
                  uint32_t secure_context_id);

/// # Safety
///
/// 指针参数须指向有效内存（字符串以 NUL 结尾），
/// 且在本函数返回前不被释放或改写 —— 违反即 UB。
void net_connect_tls_with_context(uint32_t id,
                                  const char *host,
                                  int port,
                                  const char *server_name,
                                  int reject_unauthorized,
                                  uint32_t secure_context_id);

/// 通过 HTTP CONNECT 代理建立 TLS 连接。
///
/// `secure_context_id == 0` 表示不使用自定义 SecureContext。
///
/// # Safety
///
/// 指针参数须指向有效内存（字符串以 NUL 结尾），
/// 且在本函数返回前不被释放或改写 —— 违反即 UB。
void net_connect_tls_with_proxy(uint32_t id,
                                const char *host,
                                int port,
                                const char *server_name,
                                int reject_unauthorized,
                                uint32_t secure_context_id,
                                const char *proxy_host,
                                int proxy_port,
                                const char *proxy_authorization);

/// 通过 **https** 代理建立 TLS 连接：TCP → TLS#1（到代理）→ CONNECT → TLS#2（到源站）。
///
/// 与 `net_connect_tls_with_proxy` 的区别只在「到代理」那一段也要 TLS：
/// 代理跳与源站跳各有独立的 SNI / 校验开关 / SecureContext，校验结论分别上报
/// （`Proxy TLS error:` vs `TLS error:`）。
///
/// `secure_context_id` / `proxy_secure_context_id` 为 0 表示用系统根；
/// `proxy_server_name` 为 null 时回退 `proxy_host`。
///
/// # Safety
///
/// 指针参数须指向有效内存（字符串以 NUL 结尾），
/// 且在本函数返回前不被释放或改写 —— 违反即 UB。
void net_connect_tls_with_https_proxy(uint32_t id,
                                      const char *host,
                                      int port,
                                      const char *server_name,
                                      int reject_unauthorized,
                                      uint32_t secure_context_id,
                                      const char *proxy_host,
                                      int proxy_port,
                                      const char *proxy_authorization,
                                      const char *proxy_server_name,
                                      int proxy_reject_unauthorized,
                                      uint32_t proxy_secure_context_id);

/// 原生是否编译了 `impersonate` feature（JS 的 `isImpersonationAvailable()` 数据源）。
bool net_impersonation_available();

/// 用 Chrome profile（BoringSSL）建立 TLS 连接。
///
/// `profile_json` / `options_json` / `proxy_json` 都是 JSON 文本；`proxy_json` 为 null/空表示直连。
/// 未编译 `impersonate` feature 时仍导出该符号，但直接 emit `ERR_IMPERSONATION_UNAVAILABLE`
/// （JS 会先通过 `net_impersonation_available` 判断，这里是纵深防御）。
///
/// # Safety
///
/// 指针参数须指向有效内存（字符串以 NUL 结尾），且在本函数返回前不被释放或改写。
void net_connect_tls_with_profile(uint32_t id,
                                  const char *host,
                                  int port,
                                  const char *server_name,
                                  const char *profile_json,
                                  const char *options_json,
                                  const char *proxy_json);

/// H2 session 能力探测（feature 编译 + 引擎可用）。
bool net_http2_available();

/// 创建一个 H2 session 句柄；未编译 feature 时返回 0。
uint32_t net_create_http2_session();

void net_http2_destroy(uint32_t id);

/// 建立 H2 session：TCP →（可选代理）→ BoringSSL → ALPN 必须是 h2 → H2 引擎。
///
/// # Safety
///
/// 指针参数须指向有效内存（字符串以 NUL 结尾），且在本函数返回前不被释放或改写。
void net_http2_connect(uint32_t id,
                       const char *host,
                       int port,
                       const char *server_name,
                       const char *profile_json,
                       const char *options_json,
                       const char *proxy_json);

/// # Safety
///
/// 指针参数须指向有效内存（字符串以 NUL 结尾），且在本函数返回前不被释放或改写。
void net_http2_request(uint32_t id,
                       uint32_t request_id,
                       const char *json);

/// # Safety
///
/// `data` 须指向有效内存，且将在本函数返回前被拷贝。
bool net_http2_write(uint32_t id, uint32_t request_id, const uint8_t *data, uintptr_t len);

void net_http2_end(uint32_t id, uint32_t request_id);

/// # Safety
///
/// `json` 须指向以 NUL 结尾的有效字符串。
void net_http2_trailers(uint32_t id, uint32_t request_id, const char *json);

void net_http2_abort(uint32_t id, uint32_t request_id);

/// # Safety
///
/// 指针参数须指向有效内存，且 `len` 覆盖写入长度。
uintptr_t net_http2_get_protocol(uint32_t id, char *buf, uintptr_t len);

/// # Safety
///
/// 指针参数须指向有效内存，且 `len` 覆盖写入长度。
uintptr_t net_http2_get_cipher_standard_name(uint32_t id, char *buf, uintptr_t len);

uintptr_t net_http2_get_ephemeral_key_info(uint32_t id, char *buf, uintptr_t len);

uintptr_t net_http2_get_shared_sigalgs(uint32_t id, char *buf, uintptr_t len);

/// H2 session 的 `exportKeyingMaterial`（T3）。语义/参数校验与
/// `net_socket_export_keying_material` 一致。
int net_http2_export_keying_material(uint32_t id,
                                     uintptr_t length,
                                     const char *label,
                                     const uint8_t *context,
                                     uintptr_t context_len,
                                     uint8_t *buf,
                                     uintptr_t buf_len);

uintptr_t net_http2_get_cipher(uint32_t id, char *buf, uintptr_t len);

/// # Safety
///
/// 指针参数须指向有效内存，且 `len` 覆盖写入长度。
uintptr_t net_http2_get_alpn(uint32_t id, char *buf, uintptr_t len);

/// # Safety
///
/// 指针参数须指向有效内存，且 `len` 覆盖写入长度。
uintptr_t net_http2_get_authorization_error(uint32_t id, char *buf, uintptr_t len);

/// # Safety
///
/// 指针参数须指向有效内存，且 `len` 覆盖写入长度。
uintptr_t net_http2_get_local_address(uint32_t id, char *buf, uintptr_t len);

/// # Safety
///
/// 指针参数须指向有效内存，且 `len` 覆盖写入长度。
uintptr_t net_http2_get_remote_address(uint32_t id, char *buf, uintptr_t len);

/// 通过 SOCKS4/SOCKS5 代理建立 TLS 连接。
///
/// `secure_context_id == 0` 表示不使用自定义 SecureContext。
/// `proxy_version` 为 4 或 5；SOCKS4 使用 username 作为 userid。
///
/// # Safety
///
/// 指针参数须指向有效内存（字符串以 NUL 结尾），
/// 且在本函数返回前不被释放或改写 —— 违反即 UB。
void net_connect_tls_with_socks(uint32_t id,
                                const char *host,
                                int port,
                                const char *server_name,
                                int reject_unauthorized,
                                uint32_t secure_context_id,
                                const char *proxy_host,
                                int proxy_port,
                                int proxy_version,
                                const char *proxy_username,
                                const char *proxy_password);

/// # Safety
///
/// 指针参数须指向有效内存（字符串以 NUL 结尾），
/// 且在本函数返回前不被释放或改写 —— 违反即 UB。
uintptr_t net_get_authorization_error(uint32_t id, char *buf, uintptr_t len);

uint32_t net_secure_context_create();

void net_secure_context_set_client_auth(uint32_t sc_id,
                                        bool request_cert,
                                        bool reject_unauthorized);

/// # Safety
///
/// 指针参数须指向有效内存（字符串以 NUL 结尾），
/// 且在本函数返回前不被释放或改写 —— 违反即 UB。
void net_secure_context_add_ca(uint32_t sc_id, const char *ca_pem);

/// # Safety
///
/// 指针参数须指向有效内存（字符串以 NUL 结尾），
/// 且在本函数返回前不被释放或改写 —— 违反即 UB。
void net_secure_context_set_cert_key(uint32_t sc_id,
                                     const char *cert_pem,
                                     const char *key_pem,
                                     const char *passphrase);

/// # Safety
///
/// 指针参数须指向有效内存（字符串以 NUL 结尾），
/// 且在本函数返回前不被释放或改写 —— 违反即 UB。
void net_secure_context_set_ocsp_response(uint32_t sc_id, const uint8_t *data, uintptr_t len);

/// #84：给 secure context 设服务端 ALPN 列表。
///
/// `data` 是 node 的线缆形态（每项 `1 字节长度 + 协议名`，由 JS 侧
/// `convertALPNProtocols` 生成 —— 与 node 把 `ALPNProtocols` 交给
/// `ssl.setALPNProtocols(buffer)` 的形态一致），所以这里不需要再解字符串数组。
/// `len == 0` 是**合法输入**（node 的 `ALPNProtocols: []`），表示「显式给了空列表」，
/// 实测与不给的效果一致（不协商、不报错），但仍记录来源以区分 None。
///
/// # Safety
///
/// 指针参数须指向有效内存，且在本函数返回前不被释放或改写 —— 违反即 UB。
void net_secure_context_set_alpn(uint32_t sc_id,
                                 const uint8_t *data,
                                 uintptr_t len);

/// # Safety
///
/// 指针参数须指向有效内存（字符串以 NUL 结尾），
/// 且在本函数返回前不被释放或改写 —— 违反即 UB。
void net_secure_context_set_pfx(uint32_t _sc_id,
                                const uint8_t *pfx_data,
                                uintptr_t len,
                                const char *passphrase);

void net_socket_enable_keylog(uint32_t id);

/// # Safety
///
/// 指针参数须指向有效内存（字符串以 NUL 结尾），
/// 且在本函数返回前不被释放或改写 —— 违反即 UB。
uintptr_t net_server_get_ticket_keys(uint32_t _sc_id, uint8_t *_buf, uintptr_t _len);

/// # Safety
///
/// 指针参数须指向有效内存（字符串以 NUL 结尾），
/// 且在本函数返回前不被释放或改写 —— 违反即 UB。
void net_server_set_ticket_keys(uint32_t sc_id, const uint8_t *keys, uintptr_t len);

/// # Safety
///
/// 指针参数须指向有效内存（字符串以 NUL 结尾），
/// 且在本函数返回前不被释放或改写 —— 违反即 UB。
uint32_t net_create_secure_context(const char *cert_pem,
                                   const char *key_pem,
                                   const char *passphrase);

/// # Safety
///
/// 指针参数须指向有效内存（字符串以 NUL 结尾），
/// 且在本函数返回前不被释放或改写 —— 违反即 UB。
void net_secure_context_add_context(uint32_t sc_id,
                                    const char *hostname,
                                    const char *cert_pem,
                                    const char *key_pem,
                                    const char *passphrase);

/// # Safety
///
/// 指针参数须指向有效内存（字符串以 NUL 结尾），
/// 且在本函数返回前不被释放或改写 —— 违反即 UB。
void net_write(uint32_t id, const uint8_t *data, uintptr_t len);

void net_close(uint32_t id);

void net_destroy_socket(uint32_t id);

void net_socket_reset_and_destroy(uint32_t id);

uint32_t net_create_server();

/// # Safety
///
/// 指针参数须指向有效内存（字符串以 NUL 结尾），
/// 且在本函数返回前不被释放或改写 —— 违反即 UB。
void net_listen(uint32_t id,
                int port,
                const char *host,
                int backlog,
                bool ipv6_only,
                bool reuse_port);

void net_listen_tls(uint32_t id,
                    int port,
                    int backlog,
                    bool ipv6_only,
                    bool reuse_port,
                    uint32_t secure_context_id,
                    const char *host);

void net_listen_handle(uint32_t id, int fd, int backlog);

void net_server_set_max_connections(uint32_t id, int max_connections);

void net_server_close(uint32_t id);

void net_destroy_server(uint32_t id);

void net_set_nodelay(uint32_t id, bool enable);

void net_set_keepalive(uint32_t id, bool enable, uint64_t delay_ms);

/// # Safety
///
/// 指针参数须指向有效内存（字符串以 NUL 结尾），
/// 且在本函数返回前不被释放或改写 —— 违反即 UB。
uintptr_t net_get_local_address(uint32_t id, char *buf, uintptr_t len);

/// # Safety
///
/// 指针参数须指向有效内存（字符串以 NUL 结尾），
/// 且在本函数返回前不被释放或改写 —— 违反即 UB。
uintptr_t net_get_remote_address(uint32_t id, char *buf, uintptr_t len);

/// # Safety
///
/// 指针参数须指向有效内存（字符串以 NUL 结尾），
/// 且在本函数返回前不被释放或改写 —— 违反即 UB。
uintptr_t net_get_server_local_address(uint32_t id, char *buf, uintptr_t len);

/// # Safety
///
/// 指针参数须指向有效内存（字符串以 NUL 结尾），
/// 且在本函数返回前不被释放或改写 —— 违反即 UB。
uintptr_t net_get_protocol(uint32_t id, char *buf, uintptr_t len);

/// # Safety
///
/// 指针参数须指向有效内存（字符串以 NUL 结尾），
/// 且在本函数返回前不被释放或改写 —— 违反即 UB。
uintptr_t net_get_cipher(uint32_t id, char *buf, uintptr_t len);

/// # Safety
///
/// 指针参数须指向有效内存（字符串以 NUL 结尾），
/// 且在本函数返回前不被释放或改写 —— 违反即 UB。
uintptr_t net_get_alpn(uint32_t id, char *buf, uintptr_t len);

uintptr_t net_get_peer_certificate_json(uint32_t id, char *buf, uintptr_t len);

/// H2 session 的叶子证书（Node 形态 JSON）；没有证书或解析失败返回 0。
///
/// # Safety
///
/// 指针参数须指向有效内存，且 `len` 覆盖写入长度。
uintptr_t net_http2_get_peer_certificate_json(uint32_t id, char *buf, uintptr_t len);

bool net_http2_is_session_reused(uint32_t id);

/// # Safety
///
/// 指针参数须指向有效内存（字符串以 NUL 结尾），
/// 且在本函数返回前不被释放或改写 —— 违反即 UB。
uintptr_t net_get_cipher_standard_name(uint32_t id, char *buf, uintptr_t len);

uintptr_t net_get_ciphers(char *buf, uintptr_t len);

void net_pause(uint32_t id);

void net_resume(uint32_t id);

void net_set_timeout(uint32_t id, uint64_t timeout_ms);

void net_shutdown(uint32_t id);

/// # Safety
///
/// 指针参数须指向有效内存（字符串以 NUL 结尾），
/// 且在本函数返回前不被释放或改写 —— 违反即 UB。
void net_connect_unix(uint32_t id, const char *path);

/// # Safety
///
/// 指针参数须指向有效内存（字符串以 NUL 结尾），
/// 且在本函数返回前不被释放或改写 —— 违反即 UB。
void net_connect_unix_tls(uint32_t id,
                          const char *path,
                          const char *server_name,
                          int reject_unauthorized);

/// # Safety
///
/// 指针参数须指向有效内存（字符串以 NUL 结尾），
/// 且在本函数返回前不被释放或改写 —— 违反即 UB。
void net_connect_unix_tls_with_context(uint32_t id,
                                       const char *path,
                                       const char *server_name,
                                       int reject_unauthorized,
                                       uint32_t secure_context_id);

/// # Safety
///
/// 指针参数须指向有效内存（字符串以 NUL 结尾），
/// 且在本函数返回前不被释放或改写 —— 违反即 UB。
void net_listen_unix(uint32_t id, const char *path, int backlog);

/// # Safety
///
/// 指针参数须指向有效内存（字符串以 NUL 结尾），
/// 且在本函数返回前不被释放或改写 —— 违反即 UB。
void net_listen_tls_unix(uint32_t id, const char *path, int backlog, uint32_t secure_context_id);

bool net_is_session_reused(uint32_t id);

/// 读取本 socket 关联的 session DER。
///
/// impersonated（btls）连接：返回握手后的 session；票据到达后是**可复用**的票据 session
/// （T2，§1.24）。默认 rustls 连接：rustls 0.23 不把 session 序列化成字节，返回 0；
/// 复用由 `runtime::CLIENT_SESSION_STORE` 内部完成（#67 记录该字节语义的缺口）。
/// # Safety
///
/// 指针参数须指向有效内存（字符串以 NUL 结尾），
/// 且在本函数返回前不被释放或改写 —— 违反即 UB。
uintptr_t net_get_session(uint32_t id,
                          uint8_t *buf,
                          uintptr_t len);

/// 导入 session 数据：**当前为 no-op（暂不支持）**。
///
/// rustls 0.23 的 `ClientSessionStore` 只接受由 rustls 自己构造的
/// `Tls12ClientSessionValue` / `Tls13ClientSessionValue`，没有从原始字节构造的公开 API
/// （恢复所需的 PSK secret 也不经序列化暴露），因此无法把外部 Buffer 注入会话缓存。
/// 与其像以前那样先存进 `last_session` 再假装生效（"能调但无效"），不如显式 no-op + 告警。
/// # Safety
///
/// 指针参数须指向有效内存（字符串以 NUL 结尾），
/// 且在本函数返回前不被释放或改写 —— 违反即 UB。
void net_set_session(uint32_t id,
                     const uint8_t *ticket,
                     uintptr_t len);

/// # Safety
///
/// 指针参数须指向有效内存（字符串以 NUL 结尾），
/// 且在本函数返回前不被释放或改写 —— 违反即 UB。
uintptr_t net_get_ephemeral_key_info(uint32_t id, char *buf, uintptr_t len);

/// # Safety
///
/// 指针参数须指向有效内存（字符串以 NUL 结尾），
/// 且在本函数返回前不被释放或改写 —— 违反即 UB。
uintptr_t net_get_shared_sigalgs(uint32_t id, char *buf, uintptr_t len);

uint32_t net_http_parser_create(int mode);

/// # Safety
///
/// 指针参数须指向有效内存（字符串以 NUL 结尾），
/// 且在本函数返回前不被释放或改写 —— 违反即 UB。
int net_http_parser_feed(uint32_t id,
                         const uint8_t *data,
                         uintptr_t len,
                         char *buf,
                         uintptr_t buf_len);

/// # Safety
///
/// 指针参数须指向有效内存（字符串以 NUL 结尾），
/// 且在本函数返回前不被释放或改写 —— 违反即 UB。
uintptr_t net_http_parser_get_body(uint32_t id, uint8_t *buf, uintptr_t len);

void net_http_parser_destroy(uint32_t id);

/// Enable trace output for a TLS socket.
/// When enabled, detailed TLS debug information will be logged.
void net_socket_enable_trace(uint32_t id);

/// Export keying material from a TLS connection (RFC 5705).
///
/// # Arguments
/// * `id` - Socket ID
/// * `length` - Number of bytes to export
/// * `label` - Label string (null-terminated)
/// * `context` - Optional context data (can be null)
/// * `context_len` - Length of context data
/// * `buf` - Output buffer
/// * `buf_len` - Size of output buffer
///
/// # Returns
/// * Positive value: number of bytes written
/// * 0: socket not found or not a TLS socket
/// * -1: Export not available (connection still pending or not TLS)
/// # Safety
///
/// 指针参数须指向有效内存（字符串以 NUL 结尾），
/// 且在本函数返回前不被释放或改写 —— 违反即 UB。
int net_socket_export_keying_material(uint32_t id,
                                      uintptr_t length,
                                      const char *label,
                                      const uint8_t *context,
                                      uintptr_t context_len,
                                      uint8_t *buf,
                                      uintptr_t buf_len);

/// # Safety
///
/// 指针参数须指向有效内存（字符串以 NUL 结尾），
/// 且在本函数返回前不被释放或改写 —— 违反即 UB。
uintptr_t net_get_interfaces(char *buf, uintptr_t len);

/// M5-2：把「ALPN 只答 h1」时保留下来的 TLS 流变成一个普通 socket，返回新 id；交不出返回 0。
/// 握手元数据在 session 线程里已快照（`BtlsMetadata`），这里逐项写进 socket ctx ——
/// cipher/证书/已验证链/authError/session 字节都要与一条正常 H1 btls 连接同形。
uint32_t net_h2_take_stream(uint32_t session_id);

/// M5-2：只读探针，配合 `net_h2_take_stream` 使用（先问再取，问不消耗）。
bool net_h2_can_take_stream(uint32_t session_id);

/// 在 `listen()` 之前设置监听器的 h2 模式：0=off，1=只接 h2，2=h2 + HTTP/1.1 回退。
void net_set_http2_mode(uint32_t server_id,
                        uint8_t mode);

bool net_http2_server_is_authorized(uint32_t id);

uintptr_t net_http2_server_get_alpn(uint32_t id, char *buf, uintptr_t len);

uintptr_t net_http2_server_get_protocol(uint32_t id, char *buf, uintptr_t len);

uintptr_t net_http2_server_get_cipher(uint32_t id, char *buf, uintptr_t len);

uintptr_t net_http2_server_get_cipher_standard_name(uint32_t id, char *buf, uintptr_t len);

uintptr_t net_http2_server_get_peer_certificate_json(uint32_t id, char *buf, uintptr_t len);

uintptr_t net_http2_server_get_local_address(uint32_t id, char *buf, uintptr_t len);

uintptr_t net_http2_server_get_remote_address(uint32_t id, char *buf, uintptr_t len);

bool net_http2_server_is_session_reused(uint32_t id);

/// 发响应头（`:status` 从 JSON 的 pairs 里取；缺失时默认 200）。
void net_http2_server_respond(uint32_t id,
                              uint32_t request_id,
                              const char *headers_json,
                              bool end_stream);

/// 响应体写入。返回 false 表示命令通道满（v1 没有服务端 DRAIN，调用方按"已接受"处理）。
bool net_http2_server_write(uint32_t id,
                            uint32_t request_id,
                            const uint8_t *data,
                            uintptr_t len);

void net_http2_server_end(uint32_t id, uint32_t request_id);

void net_http2_server_trailers(uint32_t id, uint32_t request_id, const char *headers_json);

void net_http2_server_abort(uint32_t id, uint32_t request_id, uint32_t code);

/// 优雅关闭：向对端发 GOAWAY，等在途流结束（crate 的 graceful_shutdown）。
void net_http2_server_close(uint32_t id);

void net_http2_server_destroy(uint32_t id);

/// P5：发一个 PING（`ping_id` 由 JS 分配，回执走 `NET_EVENT_H2_PING`）。
bool net_http2_ping(uint32_t id, uint32_t ping_id);

/// P5：服务端 session 的 PING（同一套回执事件）。
bool net_http2_server_ping(uint32_t id, uint32_t ping_id);

} // extern "C"

#endif // NET_BINDINGS_H
