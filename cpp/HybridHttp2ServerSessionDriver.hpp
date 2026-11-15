#pragma once

#include "../nitrogen/generated/shared/c++/HybridHttp2ServerSessionDriverSpec.hpp"
#include "NetBindings.hpp"
#include "NetManager.hpp"
#include <NitroModules/ArrayBuffer.hpp>
#include <cmath>
#include <cstdint>
#include <functional>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace margelo {
namespace nitro {
namespace net {

using namespace margelo::nitro;

/**
 * 服务端 HTTP/2 session（M5-3）。
 *
 * 与客户端 driver 的差异：这个对象在 **accept 分流时由原生侧启动**，JS 通过
 * `NetServerDriver.takeHttp2Session()` 才拿到 —— 取到之前的 HEADERS/DATA 必须先缓存，
 * 否则首帧会丢。所以这里在**构造函数里**就注册 handler 并缓存事件（客户端是
 * setOnEvent 时注册，因为它自己控制 connect 的时机）。
 */
class HybridHttp2ServerSessionDriver
    : public HybridHttp2ServerSessionDriverSpec {
public:
  explicit HybridHttp2ServerSessionDriver(uint32_t id) : HybridObject(TAG) {
    _id = id;
  }

  /**
   * 必须在 `make_shared` **之后**调用：构造函数里 `shared_from_this()` 还是空的
   * （`bad_weak_ptr`）。它注册事件 handler 并开始缓存首帧 —— 早于 JS 的 setOnEvent
   * 也会进 `_pendingEvents`，所以 accept 后立刻到达的请求不会丢。
   */
  void attach() { ensureHandlerRegistered(); }

  ~HybridHttp2ServerSessionDriver() override { destroy(); }

  double getId() override { return static_cast<double>(_id); }

  std::function<void(double, const std::shared_ptr<ArrayBuffer> &)>
  getOnEvent() override {
    return _onEvent;
  }

  void setOnEvent(
      const std::function<void(double, const std::shared_ptr<ArrayBuffer> &)>
          &onEvent) override {
    _onEvent = onEvent;
    if (_onEvent && !_pendingEvents.empty()) {
      auto self = shared_from_this();
      auto pending = std::move(_pendingEvents);
      _pendingEvents.clear();
      for (const auto &entry : pending) {
        _onEvent(static_cast<double>(entry.first), entry.second);
      }
    }
  }

  void respond(double requestId, const std::string &headersJson,
               bool endStream) override {
    if (_id == 0) {
      return;
    }
    net_http2_server_respond(_id, checkedId(requestId), headersJson.c_str(),
                             endStream);
  }

  bool write(double requestId,
             const std::shared_ptr<ArrayBuffer> &data) override {
    if (_id == 0 || !data) {
      return true;
    }
    auto ok = net_http2_server_write(_id, checkedId(requestId), data->data(),
                                     data->size());
    return ok;
  }

  bool ping(double pingId) override {
    return _id != 0 && net_http2_server_ping(_id, checkedId(pingId));
  }

  void end(double requestId) override {
    if (_id != 0) {
      net_http2_server_end(_id, checkedId(requestId));
    }
  }

  void trailers(double requestId, const std::string &trailersJson) override {
    if (_id != 0) {
      net_http2_server_trailers(_id, checkedId(requestId),
                                trailersJson.c_str());
    }
  }

  void abort(double requestId, double code) override {
    if (_id != 0) {
      net_http2_server_abort(_id, checkedId(requestId), checkedCode(code));
    }
  }

  void close() override {
    if (_id != 0) {
      net_http2_server_close(_id);
    }
  }

  void destroy() override {
    if (_id != 0) {
      NetManager::shared().unregisterHandler(_id);
      net_http2_server_destroy(_id);
      _id = 0;
    }
  }

  std::optional<std::string> getALPN() override {
    return readString(net_http2_server_get_alpn);
  }
  std::optional<std::string> getProtocol() override {
    return readString(net_http2_server_get_protocol);
  }
  std::optional<std::string> getCipher() override {
    return readString(net_http2_server_get_cipher);
  }
  std::optional<std::string> getCipherStandardName() override {
    return readString(net_http2_server_get_cipher_standard_name);
  }
  std::optional<std::string> getPeerCertificateJSON() override {
    return readString(net_http2_server_get_peer_certificate_json);
  }
  std::string getLocalAddress() override {
    return readAddress(net_http2_server_get_local_address);
  }
  std::string getRemoteAddress() override {
    return readAddress(net_http2_server_get_remote_address);
  }
  bool isSessionReused() override {
    return _id != 0 && net_http2_server_is_session_reused(_id);
  }
  bool isAuthorized() override {
    return _id != 0 && net_http2_server_is_authorized(_id);
  }

private:
  using StringGetter = uintptr_t (*)(uint32_t, char *, uintptr_t);

  static uint32_t checkedId(double requestId) {
    if (!std::isfinite(requestId) || requestId < 1.0 ||
        requestId > 0xFFFFFFFFull) {
      throw std::invalid_argument("ERR_INVALID_ARG_VALUE: invalid requestId");
    }
    return static_cast<uint32_t>(requestId);
  }

  /** RST_STREAM 码：0..2^32-1（node 的 `stream.close(code)` 允许任意 32 位码）。 */
  static uint32_t checkedCode(double code) {
    if (!std::isfinite(code) || code < 0.0 || code > 0xFFFFFFFFull) {
      throw std::invalid_argument("ERR_INVALID_ARG_VALUE: invalid RST_STREAM code");
    }
    return static_cast<uint32_t>(code);
  }

  std::optional<std::string> readString(StringGetter getter) {
    if (_id == 0) {
      return std::nullopt;
    }
    uintptr_t len = getter(_id, nullptr, 0);
    if (len == 0) {
      return std::nullopt;
    }
    std::vector<char> buf(len + 1);
    uintptr_t got = getter(_id, buf.data(), buf.size());
    if (got == 0 || got > len) {
      return std::nullopt;
    }
    return std::string(buf.data(), got);
  }

  std::string readAddress(StringGetter getter) {
    auto value = readString(getter);
    return value.has_value() ? value.value() : std::string();
  }

  void ensureHandlerRegistered() {
    if (_handlerRegistered || _id == 0) {
      return;
    }
    _handlerRegistered = true;
    std::weak_ptr<HybridObject> weak = shared_from_this();
    HybridHttp2ServerSessionDriver *self = this;
    NetManager::shared().registerHandler(
        _id, [weak, self](int type, const std::shared_ptr<ArrayBuffer> &data) {
          auto alive = weak.lock();
          if (!alive) {
            return;
          }
          self->onNativeEvent(type, data);
        });
  }

  void onNativeEvent(int type, const std::shared_ptr<ArrayBuffer> &data) {
    if (!_onEvent) {
      if (_pendingEvents.size() >= kMaxPendingEvents) {
        // 首帧缓存有上限：超过时丢最旧的（正常路径下 JS 在一个 tick 内就会 setOnEvent）。
        _pendingEvents.erase(_pendingEvents.begin());
      }
      _pendingEvents.emplace_back(type, data);
      return;
    }
    _onEvent(static_cast<double>(type), data);
  }

  static constexpr size_t kMaxPendingEvents = 256;
  std::vector<std::pair<int, std::shared_ptr<ArrayBuffer>>> _pendingEvents;
  uint32_t _id = 0;
  bool _handlerRegistered = false;
  std::function<void(double, const std::shared_ptr<ArrayBuffer> &)> _onEvent;
};

} // namespace net
} // namespace nitro
} // namespace margelo
