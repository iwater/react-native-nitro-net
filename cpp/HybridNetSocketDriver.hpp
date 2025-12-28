#pragma once

#include "../nitrogen/generated/shared/c++/HybridNetSocketDriverSpec.hpp"
#include "NetBindings.hpp"
#include "NetManager.hpp"
#include <NitroModules/ArrayBuffer.hpp>
#include <optional>
#include <string>

namespace margelo {
namespace nitro {
namespace net {

using namespace margelo::nitro;

class HybridNetSocketDriver : public HybridNetSocketDriverSpec {
public:
  HybridNetSocketDriver() : HybridObject(TAG) {
    _id = net_create_socket();
    NetManager::shared().registerHandler(
        _id, [this](int type, const uint8_t *data, size_t len) {
          this->onNativeEvent(type, data, len);
        });
  }

  // For server connections (created with existing ID)
  explicit HybridNetSocketDriver(uint32_t id) : HybridObject(TAG), _id(id) {
    NetManager::shared().registerHandler(
        _id, [this](int type, const uint8_t *data, size_t len) {
          this->onNativeEvent(type, data, len);
        });
  }

  ~HybridNetSocketDriver() override { destroy(); }

  // Properties
  double getId() override { return static_cast<double>(_id); }

  std::function<void(double, const std::shared_ptr<ArrayBuffer> &)>
  getOnEvent() override {
    return _onEvent;
  }
  void setOnEvent(
      const std::function<void(double, const std::shared_ptr<ArrayBuffer> &)>
          &onEvent) override {
    _onEvent = onEvent;
  }

  // Methods
  void connect(const std::string &host, double port) override {
    net_connect(_id, host.c_str(), static_cast<int>(port));
  }

  void connectTLS(const std::string &host, double port,
                  const std::optional<std::string> &serverName,
                  std::optional<bool> rejectUnauthorized) override {
    const char *sni = serverName.has_value() ? serverName->c_str() : nullptr;
    bool ru = rejectUnauthorized.value_or(true);
    net_connect_tls(_id, host.c_str(), static_cast<int>(port), sni,
                    static_cast<int>(ru));
  }

  void connectTLSWithContext(const std::string &host, double port,
                             const std::optional<std::string> &serverName,
                             std::optional<bool> rejectUnauthorized,
                             std::optional<double> secureContextId) override {
    const char *sni = serverName.has_value() ? serverName->c_str() : nullptr;
    bool ru = rejectUnauthorized.value_or(true);
    if (secureContextId.has_value()) {
      net_connect_tls_with_context(
          _id, host.c_str(), static_cast<int>(port), sni, static_cast<int>(ru),
          static_cast<uint32_t>(secureContextId.value()));
    } else {
      net_connect_tls(_id, host.c_str(), static_cast<int>(port), sni,
                      static_cast<int>(ru));
    }
  }

  std::optional<std::string> getAuthorizationError() override {
    char buf[1024];
    size_t len = net_get_authorization_error(_id, buf, sizeof(buf));
    if (len > 0) {
      return std::string(buf);
    }
    return std::nullopt;
  }

  std::optional<std::string> getProtocol() override {
    char buf[128];
    size_t len = net_get_protocol(_id, buf, sizeof(buf));
    if (len > 0) {
      return std::string(buf);
    }
    return std::nullopt;
  }

  std::optional<std::string> getCipher() override {
    char buf[256];
    size_t len = net_get_cipher(_id, buf, sizeof(buf));
    if (len > 0) {
      return std::string(buf);
    }
    return std::nullopt;
  }

  std::optional<std::string> getALPN() override {
    char buf[64];
    size_t len = net_get_alpn(_id, buf, sizeof(buf));
    if (len > 0) {
      return std::string(buf);
    }
    return std::nullopt;
  }

  std::optional<std::string> getPeerCertificateJSON() override {
    char buf[16384];
    size_t len = net_get_peer_certificate_json(_id, buf, sizeof(buf));
    if (len > 0) {
      return std::string(buf, len);
    }
    return std::nullopt;
  }

  std::optional<std::string> getEphemeralKeyInfo() override {
    char buf[512];
    size_t len = net_get_ephemeral_key_info(_id, buf, sizeof(buf));
    if (len > 0) {
      return std::string(buf, len);
    }
    return std::nullopt;
  }

  std::optional<std::string> getSharedSigalgs() override {
    char buf[1024];
    size_t len = net_get_shared_sigalgs(_id, buf, sizeof(buf));
    if (len > 0) {
      return std::string(buf, len);
    }
    return std::nullopt;
  }

  bool isSessionReused() override { return net_is_session_reused(_id); }

  std::optional<std::shared_ptr<ArrayBuffer>> getSession() override {
    uint8_t buf[2048];
    size_t len = net_get_session(_id, buf, sizeof(buf));
    if (len > 0) {
      return ArrayBuffer::copy(buf, len);
    }
    return std::nullopt;
  }

  void setSession(const std::shared_ptr<ArrayBuffer> &session) override {
    if (session && session->size() > 0) {
      net_set_session(_id, session->data(), session->size());
    }
  }

  void write(const std::shared_ptr<ArrayBuffer> &data) override {
    if (!data)
      return;
    net_write(_id, data->data(), data->size());
  }

  void destroy() override {
    if (_id != 0) {
      NetManager::shared().unregisterHandler(_id);
      net_destroy_socket(_id);
      _id = 0;
    }
  }

  void resetAndDestroy() override {
    if (_id != 0) {
      net_socket_reset_and_destroy(_id);
      NetManager::shared().unregisterHandler(_id);
      _id = 0;
    }
  }

  void enableKeylog() override { net_socket_enable_keylog(_id); }

  void setNoDelay(bool enable) override { net_set_nodelay(_id, enable); }

  void setKeepAlive(bool enable, double delay) override {
    net_set_keepalive(_id, enable, static_cast<uint64_t>(delay));
  }

  void setTimeout(double timeout) override {
    net_set_timeout(_id, static_cast<uint64_t>(timeout));
  }

  std::string getLocalAddress() override {
    char buf[256];
    size_t len = net_get_local_address(_id, buf, sizeof(buf));
    if (len > 0 && len < sizeof(buf)) {
      return std::string(buf);
    }
    return "";
  }

  std::string getRemoteAddress() override {
    char buf[256];
    size_t len = net_get_remote_address(_id, buf, sizeof(buf));
    if (len == 0)
      return "";
    return std::string(buf);
  }

  void pause() override { net_pause(_id); }

  void resume() override { net_resume(_id); }

  void shutdown() override { net_shutdown(_id); }

  void connectUnix(const std::string &path) override {
    net_connect_unix(_id, path.c_str());
  }

  void connectUnixTLS(const std::string &path,
                      const std::optional<std::string> &serverName,
                      std::optional<bool> rejectUnauthorized) override {
#if !defined(__ANDROID__)
    const char *sni = serverName.has_value() ? serverName->c_str() : "";
    bool ru = rejectUnauthorized.value_or(true);
    net_connect_unix_tls(_id, path.c_str(), sni, static_cast<int>(ru));
#else
    // Unix TLS not supported on Android
    (void)path;
    (void)serverName;
    (void)rejectUnauthorized;
#endif
  }

  void
  connectUnixTLSWithContext(const std::string &path,
                            const std::optional<std::string> &serverName,
                            std::optional<bool> rejectUnauthorized,
                            std::optional<double> secureContextId) override {
#if !defined(__ANDROID__)
    const char *sni = serverName.has_value() ? serverName->c_str() : "";
    bool ru = rejectUnauthorized.value_or(true);
    if (secureContextId.has_value()) {
      net_connect_unix_tls_with_context(
          _id, path.c_str(), sni, static_cast<int>(ru),
          static_cast<uint32_t>(secureContextId.value()));
    } else {
      net_connect_unix_tls(_id, path.c_str(), sni, static_cast<int>(ru));
    }
#else
    // Unix TLS not supported on Android
    (void)path;
    (void)serverName;
    (void)rejectUnauthorized;
    (void)secureContextId;
#endif
  }

private:
  void onNativeEvent(int type, const uint8_t *data, size_t len) {
    if (!_onEvent)
      return;

    std::shared_ptr<ArrayBuffer> ab;
    if (data && len > 0) {
      ab = ArrayBuffer::copy(data, len);
    } else {
      static uint8_t empty = 0;
      ab = ArrayBuffer::copy(&empty, 0);
    }

    _onEvent(static_cast<double>(type), ab);
  }

  uint32_t _id;
  std::function<void(double, const std::shared_ptr<ArrayBuffer> &)> _onEvent;
};

} // namespace net
} // namespace nitro
} // namespace margelo
