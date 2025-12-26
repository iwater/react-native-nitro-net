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
void net_write(uint32_t id, const uint8_t *data, size_t len);
void net_close(uint32_t id);
void net_destroy_socket(uint32_t id);
void net_socket_reset_and_destroy(uint32_t id);

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

// IPC
void net_connect_unix(uint32_t id, const char *path);
void net_listen_unix(uint32_t id, const char *path, int backlog);

// Server
uint32_t net_create_server();
void net_listen(uint32_t id, int port, int backlog, bool ipv6_only,
                bool reuse_port);
void net_server_close(uint32_t id);
void net_destroy_server(uint32_t id);
void net_server_set_max_connections(uint32_t id, int max_connections);
size_t net_get_server_local_address(uint32_t id, char *buf, size_t len);
/// Listen on an existing file descriptor (handle)
/// @param id Server ID
/// @param fd File descriptor of an already-bound TCP listener
/// @param backlog Listen backlog
void net_listen_handle(uint32_t id, int fd, int backlog);

// Event Types
#define NET_EVENT_CONNECT 1
#define NET_EVENT_DATA 2
#define NET_EVENT_ERROR 3
#define NET_EVENT_CLOSE 4
#define NET_EVENT_CONNECTION 6
}
