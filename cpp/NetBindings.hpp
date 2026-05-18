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

/// C callback function pointer type for event notifications
using CallbackPtr = void(*)(uint32_t id,
                            int event_type,
                            const uint8_t *data,
                            uintptr_t len,
                            void *context);

extern "C" {

void net_init(CallbackPtr callback, void *context);

/// Initialize the net library with configuration
///
/// # Safety
/// - `callback` must be a valid function pointer
/// - `context` must remain valid during the callback
/// - `worker_threads`: number of worker threads, 0 means use CPU core count
///
/// Note: This function must be called before any other net_* functions,
/// otherwise the configuration will not take effect.
void net_init_with_config(CallbackPtr callback, void *context, uint32_t worker_threads);

/// Set the debug logging mode dynamically
void net_set_debug(bool debug);

uint32_t net_create_socket();

void net_connect(uint32_t id, const char *host, int port);

void net_connect_tls(uint32_t id,
                     const char *host,
                     int port,
                     const char *server_name,
                     int reject_unauthorized);

void net_connect_tls_with_context(uint32_t id,
                                  const char *host,
                                  int port,
                                  const char *server_name,
                                  int reject_unauthorized,
                                  uint32_t secure_context_id);

uintptr_t net_get_authorization_error(uint32_t id, char *buf, uintptr_t len);

uint32_t net_secure_context_create();

void net_secure_context_add_ca(uint32_t sc_id, const char *ca_pem);

void net_secure_context_set_cert_key(uint32_t sc_id,
                                     const char *cert_pem,
                                     const char *key_pem,
                                     const char *passphrase);

void net_secure_context_set_ocsp_response(uint32_t sc_id, const uint8_t *data, uintptr_t len);

void net_secure_context_set_pfx(uint32_t _sc_id,
                                const uint8_t *pfx_data,
                                uintptr_t len,
                                const char *passphrase);

void net_socket_enable_keylog(uint32_t id);

uintptr_t net_server_get_ticket_keys(uint32_t _sc_id, uint8_t *_buf, uintptr_t _len);

void net_server_set_ticket_keys(uint32_t sc_id, const uint8_t *keys, uintptr_t len);

uint32_t net_create_secure_context(const char *cert_pem,
                                   const char *key_pem,
                                   const char *passphrase);

void net_secure_context_add_context(uint32_t sc_id,
                                    const char *hostname,
                                    const char *cert_pem,
                                    const char *key_pem,
                                    const char *passphrase);

void net_write(uint32_t id, const uint8_t *data, uintptr_t len);

void net_close(uint32_t id);

void net_destroy_socket(uint32_t id);

void net_socket_reset_and_destroy(uint32_t id);

uint32_t net_create_server();

void net_listen(uint32_t id, int port, int backlog, bool ipv6_only, bool reuse_port);

void net_listen_tls(uint32_t id,
                    int port,
                    int backlog,
                    bool ipv6_only,
                    bool reuse_port,
                    uint32_t secure_context_id);

void net_listen_handle(uint32_t id, int fd, int backlog);

void net_server_set_max_connections(uint32_t id, int max_connections);

void net_server_close(uint32_t id);

void net_destroy_server(uint32_t id);

void net_set_nodelay(uint32_t id, bool enable);

void net_set_keepalive(uint32_t id, bool enable, uint64_t delay_ms);

uintptr_t net_get_local_address(uint32_t id, char *buf, uintptr_t len);

uintptr_t net_get_remote_address(uint32_t id, char *buf, uintptr_t len);

uintptr_t net_get_server_local_address(uint32_t id, char *buf, uintptr_t len);

uintptr_t net_get_protocol(uint32_t id, char *buf, uintptr_t len);

uintptr_t net_get_cipher(uint32_t id, char *buf, uintptr_t len);

uintptr_t net_get_alpn(uint32_t id, char *buf, uintptr_t len);

uintptr_t net_get_peer_certificate_json(uint32_t id, char *buf, uintptr_t len);

uintptr_t net_get_ciphers(char *buf, uintptr_t len);

void net_pause(uint32_t id);

void net_resume(uint32_t id);

void net_set_timeout(uint32_t id, uint64_t timeout_ms);

void net_shutdown(uint32_t id);

void net_connect_unix(uint32_t id, const char *path);

void net_connect_unix_tls(uint32_t id,
                          const char *path,
                          const char *server_name,
                          int reject_unauthorized);

void net_connect_unix_tls_with_context(uint32_t id,
                                       const char *path,
                                       const char *server_name,
                                       int reject_unauthorized,
                                       uint32_t secure_context_id);

void net_listen_unix(uint32_t id, const char *path, int backlog);

void net_listen_tls_unix(uint32_t id, const char *path, int backlog, uint32_t secure_context_id);

bool net_is_session_reused(uint32_t id);

uintptr_t net_get_session(uint32_t id, uint8_t *buf, uintptr_t len);

void net_set_session(uint32_t id, const uint8_t *ticket, uintptr_t len);

uintptr_t net_get_ephemeral_key_info(uint32_t id, char *buf, uintptr_t len);

uintptr_t net_get_shared_sigalgs(uint32_t id, char *buf, uintptr_t len);

uint32_t net_http_parser_create(int mode);

int net_http_parser_feed(uint32_t id,
                         const uint8_t *data,
                         uintptr_t len,
                         char *buf,
                         uintptr_t buf_len);

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
int net_socket_export_keying_material(uint32_t id,
                                      uintptr_t length,
                                      const char *label,
                                      const uint8_t *context,
                                      uintptr_t context_len,
                                      uint8_t *buf,
                                      uintptr_t buf_len);

} // extern "C"

#endif // NET_BINDINGS_H
