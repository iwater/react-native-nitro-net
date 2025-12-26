#pragma once

#include "../nitrogen/generated/shared/c++/HybridNetSocketDriverSpec.hpp"
#include "NetBindings.hpp"
#include "NetManager.hpp"
#include <NitroModules/ArrayBuffer.hpp>
#include <string>

namespace margelo {
namespace nitro {
namespace net {

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
