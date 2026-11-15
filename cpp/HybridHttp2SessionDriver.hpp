#pragma once

#include "../nitrogen/generated/shared/c++/HybridHttp2SessionDriverSpec.hpp"
#include "HybridNetSocketDriver.hpp"
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
 * 一个 Nitro 对象 = 一条 BoringSSL TLS + HTTP/2 连接。
 *
 * 生命周期/事件缓存与 HybridNetSocketDriver 相同：handler 推迟到 setOnEvent()
 * 注册，未回放的事件先缓存（C-M8），回调里用 weak_ptr 保活。
 */
class HybridHttp2SessionDriver : public HybridHttp2SessionDriverSpec {
public:
  HybridHttp2SessionDriver() : HybridObject(TAG) {
    _id = net_create_http2_session();
  }

  ~HybridHttp2SessionDriver() override { destroy(); }

  double getId() override { return static_cast<double>(_id); }

  std::function<void(double, const std::shared_ptr<ArrayBuffer> &)>
  getOnEvent() override {
    return _onEvent;
  }

  void setOnEvent(
      const std::function<void(double, const std::shared_ptr<ArrayBuffer> &)>
          &onEvent) override {
    _onEvent = onEvent;
    ensureHandlerRegistered();

    if (_onEvent && !_pendingEvents.empty()) {
      auto self = shared_from_this();
      auto pending = std::move(_pendingEvents);
      _pendingEvents.clear();
      for (const auto &entry : pending) {
        _onEvent(static_cast<double>(entry.first), entry.second);
      }
    }
  }

  void connect(const std::string &host, double port,
               const std::optional<std::string> &serverName,
               const std::string &profileJson, const std::string &optionsJson,
               const std::optional<std::string> &proxyJson) override {
    if (_id == 0) {
      throw std::runtime_error(
          "ERR_HTTP2_UNAVAILABLE: this native build was compiled without the "
          "http2 feature");
    }
    if (!std::isfinite(port) || port < 0 || port > 65535) {
      throw std::invalid_argument("ERR_INVALID_ARG_VALUE: invalid port");
    }
    const char *sni = serverName.has_value() ? serverName->c_str() : nullptr;
    const char *proxy = proxyJson.has_value() ? proxyJson->c_str() : nullptr;
    net_http2_connect(_id, host.c_str(), static_cast<int>(port), sni,
                      profileJson.c_str(), optionsJson.c_str(), proxy);
  }

  // P5：PING；回执走 session 事件（NET_EVENT_H2_PING）。
  bool ping(double pingId) override {
    return _id != 0 && net_http2_ping(_id, checkedId(pingId));
  }

  // M5-2：ALPN 只答 h1 时，把已握手的流交还成一个普通 socket（先问再取）。
  bool canTakeStream() override {
    return _id != 0 && net_h2_can_take_stream(_id);
  }

  std::shared_ptr<HybridNetSocketDriverSpec> takeStream() override {
    uint32_t sock = _id != 0 ? net_h2_take_stream(_id) : 0;
    if (sock == 0) {
      throw std::runtime_error(
          "ERR_INVALID_STATE: no handshake stream left to take");
    }
    return std::make_shared<HybridNetSocketDriver>(sock);
  }

  void request(double requestId, const std::string &requestJson) override {
    net_http2_request(_id, checkedId(requestId), requestJson.c_str());
  }

  bool write(double requestId,
             const std::shared_ptr<ArrayBuffer> &data) override {
    // 空 ArrayBuffer 也要走一次 end-of-chunk 语义：data 为空时 Rust 侧跳过，
    // 真正结束流由 end() 负责。返回值 false 表示 body 缓冲满，等 DRAIN。
    if (!data) {
      return true;
    }
    return net_http2_write(_id, checkedId(requestId), data->data(),
                           data->size());
  }

  void end(double requestId) override {
    net_http2_end(_id, checkedId(requestId));
  }

  void trailers(double requestId, const std::string &trailersJson) override {
    net_http2_trailers(_id, checkedId(requestId), trailersJson.c_str());
  }

  void abort(double requestId) override {
    net_http2_abort(_id, checkedId(requestId));
  }

  void destroy() override {
    if (_id != 0) {
      NetManager::shared().unregisterHandler(_id);
      net_http2_destroy(_id);
      _id = 0;
    }
  }

  std::optional<std::string> getALPN() override {
    return readString(net_http2_get_alpn);
  }
  std::optional<std::string> getProtocol() override {
    return readString(net_http2_get_protocol);
  }
  std::optional<std::string> getCipher() override {
    return readString(net_http2_get_cipher);
  }
  std::optional<std::string> getCipherStandardName() override {
    return readString(net_http2_get_cipher_standard_name);
  }
  std::optional<std::string> getPeerCertificateJSON() override {
    return readString(net_http2_get_peer_certificate_json);
  }
  std::optional<std::string> getAuthorizationError() override {
    return readString(net_http2_get_authorization_error);
  }
  bool isSessionReused() override { return net_http2_is_session_reused(_id); }
  std::optional<std::string> getEphemeralKeyInfo() override {
    return readString(net_http2_get_ephemeral_key_info);
  }
  std::optional<std::string> getSharedSigalgs() override {
    return readString(net_http2_get_shared_sigalgs);
  }
  std::optional<std::shared_ptr<ArrayBuffer>> exportKeyingMaterial(
      double length, const std::string &label,
      const std::optional<std::shared_ptr<ArrayBuffer>> &context) override {
    // 语义与 H1（HybridNetSocketDriver::exportKeyingMaterial）一致；上界 64KB。
    static constexpr size_t kMaxExportLength = 64 * 1024;
    if (!std::isfinite(length) || length < 1.0 ||
        length > static_cast<double>(kMaxExportLength)) {
      throw std::invalid_argument(
          "ERR_OUT_OF_RANGE: The value of \"length\" is out of range. It must be >= 1 && <= " +
          std::to_string(kMaxExportLength) + ". Received " + std::to_string(length));
    }
    size_t len = static_cast<size_t>(length);
    std::vector<uint8_t> output(len);
    const uint8_t *ctx_data = nullptr;
    size_t ctx_len = 0;
    if (context.has_value() && context.value()) {
      ctx_data = context.value()->data();
      ctx_len = context.value()->size();
    }
    int result = net_http2_export_keying_material(
        _id, len, label.c_str(), ctx_data, ctx_len, output.data(), output.size());
    if (result > 0) {
      return ArrayBuffer::copy(output.data(), static_cast<size_t>(result));
    }
    return std::nullopt;
  }
  std::string getLocalAddress() override {
    return readAddress(net_http2_get_local_address);
  }
  std::string getRemoteAddress() override {
    return readAddress(net_http2_get_remote_address);
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
    HybridHttp2SessionDriver *self = this;
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
        _pendingEvents.erase(_pendingEvents.begin());
      }
      _pendingEvents.emplace_back(type, data);
      return;
    }
    _onEvent(static_cast<double>(type), data);
  }

  static constexpr size_t kMaxPendingEvents = 64;
  std::vector<std::pair<int, std::shared_ptr<ArrayBuffer>>> _pendingEvents;
  uint32_t _id = 0;
  bool _handlerRegistered = false;
  std::function<void(double, const std::shared_ptr<ArrayBuffer> &)> _onEvent;
};

} // namespace net
} // namespace nitro
} // namespace margelo
