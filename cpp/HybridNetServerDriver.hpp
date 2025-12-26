#pragma once

#include "../nitrogen/generated/shared/c++/HybridNetServerDriverSpec.hpp"
#include "NetBindings.hpp"
#include "NetManager.hpp"
#include <NitroModules/ArrayBuffer.hpp>
#include <optional>
#include <string>

namespace margelo {
namespace nitro {
namespace net {

class HybridNetServerDriver : public HybridNetServerDriverSpec {
public:
  HybridNetServerDriver() : HybridObject(TAG) {
    _id = net_create_server();
    NetManager::shared().registerHandler(
        _id, [this](int type, const uint8_t *data, size_t len) {
          this->onNativeEvent(type, data, len);
        });
  }

  ~HybridNetServerDriver() override { destroy(); }

  // Properties
  std::function<void(double, const std::shared_ptr<ArrayBuffer> &)>
  getOnEvent() override {
    return _onEvent;
  }
  void setOnEvent(
      const std::function<void(double, const std::shared_ptr<ArrayBuffer> &)>
          &onEvent) override {
    _onEvent = onEvent;
  }

  double getMaxConnections() override { return _maxConnections; }
  void setMaxConnections(double maxConnections) override {
    _maxConnections = maxConnections;
    net_server_set_max_connections(_id, static_cast<int>(maxConnections));
  }

  // Methods
  void listen(double port, std::optional<double> backlog,
              std::optional<bool> ipv6Only,
              std::optional<bool> reusePort) override {
    net_listen(_id, static_cast<int>(port),
               static_cast<int>(backlog.value_or(128)),
               ipv6Only.value_or(false), reusePort.value_or(false));
  }

  void listenUnix(const std::string &path,
                  std::optional<double> backlog) override {
    net_listen_unix(_id, path.c_str(), static_cast<int>(backlog.value_or(128)));
  }

  void listenHandle(double fd, std::optional<double> backlog) override {
    net_listen_handle(_id, static_cast<int>(fd),
                      static_cast<int>(backlog.value_or(128)));
  }

  std::string getLocalAddress() override {
    char buf[256];
    size_t len = net_get_server_local_address(_id, buf, sizeof(buf));
    if (len > 0 && len < sizeof(buf)) {
      buf[len] = '\0';
      return std::string(buf);
    }
    return "";
  }

  void close() override {
    if (_id != 0) {
      net_server_close(_id);
    }
  }

private:
  void destroy() {
    if (_id != 0) {
      NetManager::shared().unregisterHandler(_id);
      net_destroy_server(_id);
      _id = 0;
    }
  }

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

    if (type == 4) { // CLOSE
      LOGI("Server %u received CLOSE event, destroying...", _id);
      destroy();
    }
  }

  uint32_t _id;
  double _maxConnections = 0;
  std::function<void(double, const std::shared_ptr<ArrayBuffer> &)> _onEvent;
};

} // namespace net
} // namespace nitro
} // namespace margelo
