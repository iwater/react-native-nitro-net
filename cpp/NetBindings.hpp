#pragma once

#include <stddef.h>
#include <stdint.h>

extern "C" {

// Callback function type
typedef void (*NetCallback)(uint32_t id, int event_type, const uint8_t *data,
                            size_t len, void *context);

// Init
void net_init(NetCallback callback, void *context);
/// Initialize with configuration
/// @param callback Event callback function
/// @param context User context passed to callback
/// @param worker_threads Number of worker threads, 0 = use CPU core count
void net_init_with_config(NetCallback callback, void *context,
                          uint32_t worker_threads);

// Socket
uint32_t net_create_socket();
void net_connect(uint32_t id, const char *host, int port);
void net_connect_tls(uint32_t id, const char *host, int port,
                     const char *server_name, int reject_unauthorized);
void net_connect_tls_with_context(uint32_t id, const char *host, int port,
                                  const char *server_name,
                                  int reject_unauthorized,
                                  uint32_t secure_context_id);
size_t net_get_authorization_error(uint32_t id, char *buf, size_t len);
size_t net_get_protocol(uint32_t id, char *buf, size_t len);
size_t net_get_cipher(uint32_t id, char *buf, size_t len);
size_t net_get_alpn(uint32_t id, char *buf, size_t len);
size_t net_get_peer_certificate_json(uint32_t id, char *buf, size_t len);
void net_socket_enable_keylog(uint32_t id);
void net_write(uint32_t id, const uint8_t *data, size_t len);
void net_close(uint32_t id);
void net_destroy_socket(uint32_t id);
void net_socket_reset_and_destroy(uint32_t id);

// Phase 13: Advanced TLS inspection
size_t net_get_ephemeral_key_info(uint32_t id, char *buf, size_t len);
size_t net_get_shared_sigalgs(uint32_t id, char *buf, size_t len);

// TLS Features: enableTrace and exportKeyingMaterial
void net_socket_enable_trace(uint32_t id);
int net_socket_export_keying_material(uint32_t id, size_t length,
                                      const char *label, const uint8_t *context,
                                      size_t context_len, uint8_t *buf,
                                      size_t buf_len);

// New Options
void net_set_nodelay(uint32_t id, bool enable);
void net_set_keepalive(uint32_t id, bool enable, uint64_t delay_ms);
void net_set_timeout(uint32_t id, uint64_t timeout_ms);

// New Address Info
// Returns length of address string. buf can be null to query length.
size_t net_get_local_address(uint32_t id, char *buf, size_t len);
size_t net_get_remote_address(uint32_t id, char *buf, size_t len);

// Flow Control
void net_pause(uint32_t id);
void net_resume(uint32_t id);
void net_shutdown(uint32_t id);

// IPC / Unix Domain Sockets
void net_connect_unix(uint32_t id, const char *path);
void net_listen_unix(uint32_t id, const char *path, int backlog);
void net_listen_tls_unix(uint32_t id, const char *path, int backlog,
                         uint32_t secure_context_id);

#if !defined(__ANDROID__)
// Unix-only TLS functions (not available on Android)
void net_connect_unix_tls(uint32_t id, const char *path,
                          const char *server_name, int reject_unauthorized);
void net_connect_unix_tls_with_context(uint32_t id, const char *path,
                                       const char *server_name,
                                       int reject_unauthorized,
                                       uint32_t secure_context_id);
#endif

// Server
uint32_t net_create_server();
void net_listen(uint32_t id, int port, int backlog, bool ipv6_only,
                bool reuse_port);
void net_listen_tls(uint32_t id, int port, int backlog, bool ipv6_only,
                    bool reuse_port, uint32_t secure_context_id);
void net_server_close(uint32_t id);
void net_destroy_server(uint32_t id);
void net_server_set_max_connections(uint32_t id, int max_connections);
size_t net_get_server_local_address(uint32_t id, char *buf, size_t len);
uint32_t net_create_secure_context(const char *cert_pem, const char *key_pem,
                                   const char *passphrase);
uint32_t net_secure_context_create();
void net_secure_context_add_ca(uint32_t sc_id, const char *ca_pem);
void net_secure_context_set_cert_key(uint32_t sc_id, const char *cert_pem,
                                     const char *key_pem,
                                     const char *passphrase);
void net_secure_context_add_context(uint32_t sc_id, const char *hostname,
                                    const char *cert_pem, const char *key_pem,
                                    const char *passphrase);
void net_secure_context_set_pfx(uint32_t sc_id, const uint8_t *data, size_t len,
                                const char *passphrase);
void net_secure_context_set_ocsp_response(uint32_t sc_id, const uint8_t *data,
                                          size_t len);
/// Listen on an existing file descriptor (handle)
/// @param id Server ID
/// @param fd File descriptor of an already-bound TCP listener
/// @param backlog Listen backlog
void net_listen_handle(uint32_t id, int fd, int backlog);

// Session
bool net_is_session_reused(uint32_t id);
size_t net_get_session(uint32_t id, uint8_t *buf, size_t len);
void net_set_session(uint32_t id, const uint8_t *ticket, size_t ticket_len);
size_t net_server_get_ticket_keys(uint32_t id, uint8_t *buf, size_t len);
void net_server_set_ticket_keys(uint32_t id, const uint8_t *keys, size_t len);

// HTTP Parser
uint32_t net_http_parser_create(int mode);
int net_http_parser_feed(uint32_t id, const uint8_t *data, size_t len,
                         char *buf, size_t buf_len);
void net_http_parser_destroy(uint32_t id);

// Event Types
#define NET_EVENT_CONNECT 1
#define NET_EVENT_DATA 2
#define NET_EVENT_ERROR 3
#define NET_EVENT_CLOSE 4
#define NET_EVENT_CONNECTION 6
#define NET_EVENT_KEYLOG 10
#define NET_EVENT_OCSP 11
}
