#pragma once

#include "../nitrogen/generated/shared/c++/HybridNetSocketDriverSpec.hpp"
#include "NetBindings.hpp"
#include "NetManager.hpp"
#include <NitroModules/ArrayBuffer.hpp>
#include <cmath>
#include <cstdint>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

namespace margelo {
namespace nitro {
namespace net {

using namespace margelo::nitro;

class HybridNetSocketDriver : public HybridNetSocketDriverSpec {
public:
  // 注意：handler 不在构造函数里注册 —— 此时 weak_from_this() 仍是空的
  //（enable_shared_from_this 的控制块还没绑定到 shared_ptr），注册了也永远锁不到对象。
  // 注册推迟到 setOnEvent()，见 ensureHandlerRegistered()。
  HybridNetSocketDriver() : HybridObject(TAG) {
    _id = net_create_socket();
  }

  // For server connections (created with existing ID)
  explicit HybridNetSocketDriver(uint32_t id) : HybridObject(TAG), _id(id) {}

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
    ensureHandlerRegistered();

    // 回放 _onEvent 设置之前到达的事件（C-M8）：TS 要等 createSocket() 返回后才赋 onEvent，
    // 这个窗口内到达的 CONNECT/ERROR/DATA 若不缓存就会被 `if (!_onEvent) return;` 丢掉 ——
    // loopback 快速失败时 ERROR 丢失会让 JS 侧 promise 永久悬挂。
    if (_onEvent && !_pendingEvents.empty()) {
      // 保活：下面会在 JS 线程上同步进回调，回调期间最后一个 JS 引用可能被释放
      auto self = shared_from_this();
      auto pending = std::move(_pendingEvents);
      _pendingEvents.clear();
      for (const auto &entry : pending) {
        // 缓存期已持有归属自己的 ArrayBuffer，回放时直接交出，无需再拷贝
        _onEvent(static_cast<double>(entry.first), entry.second);
      }
    }
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

  // 以下 getter 统一用"两次调用"模式：先以 (nullptr, 0) 只查长度，再按长度精确分配。
  // 直接把定长栈缓冲区交给原生是不安全的：Rust 侧在缓冲区不足时不拷贝、但仍然返回
  // 真实长度，若按返回长度去构造 string / ArrayBuffer，就会越界读取未初始化的栈内存
  // 并把内容交给 JS（C-H1 / C-M10）。
  std::optional<std::string> getAuthorizationError() override {
    size_t len = net_get_authorization_error(_id, nullptr, 0);
    if (len == 0)
      return std::nullopt;
    // 多留 1 字节：Rust 侧要求 len >= s_len + 1 才写入 NUL 终止符
    std::vector<char> buf(len + 1);
    size_t got = net_get_authorization_error(_id, buf.data(), buf.size());
    if (got == 0 || got > len)
      return std::nullopt;
    return std::string(buf.data(), got);
  }

  std::optional<std::string> getProtocol() override {
    size_t len = net_get_protocol(_id, nullptr, 0);
    if (len == 0)
      return std::nullopt;
    std::vector<char> buf(len + 1);
    size_t got = net_get_protocol(_id, buf.data(), buf.size());
    if (got == 0 || got > len)
      return std::nullopt;
    return std::string(buf.data(), got);
  }

  std::optional<std::string> getCipher() override {
    size_t len = net_get_cipher(_id, nullptr, 0);
    if (len == 0)
      return std::nullopt;
    std::vector<char> buf(len + 1);
    size_t got = net_get_cipher(_id, buf.data(), buf.size());
    if (got == 0 || got > len)
      return std::nullopt;
    return std::string(buf.data(), got);
  }

  std::optional<std::string> getALPN() override {
    size_t len = net_get_alpn(_id, nullptr, 0);
    if (len == 0)
      return std::nullopt;
    std::vector<char> buf(len + 1);
    size_t got = net_get_alpn(_id, buf.data(), buf.size());
    if (got == 0 || got > len)
      return std::nullopt;
    return std::string(buf.data(), got);
  }

  std::optional<std::string> getPeerCertificateJSON() override {
    size_t len = net_get_peer_certificate_json(_id, nullptr, 0);
    if (len == 0)
      return std::nullopt;
    std::vector<char> buf(len + 1);
    size_t got = net_get_peer_certificate_json(_id, buf.data(), buf.size());
    if (got == 0 || got > len)
      return std::nullopt;
    return std::string(buf.data(), got);
  }

  std::optional<std::string> getEphemeralKeyInfo() override {
    size_t len = net_get_ephemeral_key_info(_id, nullptr, 0);
    if (len == 0)
      return std::nullopt;
    std::vector<char> buf(len + 1);
    size_t got = net_get_ephemeral_key_info(_id, buf.data(), buf.size());
    if (got == 0 || got > len)
      return std::nullopt;
    return std::string(buf.data(), got);
  }

  std::optional<std::string> getSharedSigalgs() override {
    size_t len = net_get_shared_sigalgs(_id, nullptr, 0);
    if (len == 0)
      return std::nullopt;
    std::vector<char> buf(len + 1);
    size_t got = net_get_shared_sigalgs(_id, buf.data(), buf.size());
    if (got == 0 || got > len)
      return std::nullopt;
    return std::string(buf.data(), got);
  }

  bool isSessionReused() override { return net_is_session_reused(_id); }

  std::optional<std::shared_ptr<ArrayBuffer>> getSession() override {
    size_t len = net_get_session(_id, nullptr, 0);
    if (len == 0)
      return std::nullopt;
    // 二进制数据，不需要 NUL 终止符
    std::vector<uint8_t> buf(len);
    size_t got = net_get_session(_id, buf.data(), buf.size());
    if (got == 0 || got > buf.size())
      return std::nullopt;
    return ArrayBuffer::copy(buf.data(), got);
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

  void enableTrace() override { net_socket_enable_trace(_id); }

  std::optional<std::shared_ptr<ArrayBuffer>> exportKeyingMaterial(
      double length, const std::string &label,
      const std::optional<std::shared_ptr<ArrayBuffer>> &context) override {
    // length 直接 static_cast<size_t> 是三个坑叠在一起：
    //   · 负数 / 0 / 0.5  → 绕成巨大的 size_t，std::vector 直接 bad_alloc（或更糟）
    //   · NaN / +Inf      → 转换本身就是 UB
    //   · 超大值          → 一次性按调用方要求分配（Rust 侧根本给不出这么多）
    // 处理对齐 Node 实测的下界（<1 → RangeError ERR_OUT_OF_RANGE），上界按
    // 双方约定的 64KB 钳制（rust 侧 net_socket_export_keying_material 同样封顶）
    // —— 宁可少给也不要为一条错误输入去要 4GB 内存。
    static constexpr size_t kMaxExportLength = 64 * 1024;
    if (!std::isfinite(length) || length < 1.0) {
      throw std::invalid_argument(
          "ERR_OUT_OF_RANGE: The value of \"length\" is out of range. It must be >= 1 && <= "
          + std::to_string(kMaxExportLength) + ". Received " + std::to_string(length));
    }
    size_t len = static_cast<size_t>(length);
    if (len > kMaxExportLength) {
      LOGW("exportKeyingMaterial: length %zu exceeds %zu, clamped", len, kMaxExportLength);
      len = kMaxExportLength;
    }
    std::vector<uint8_t> output(len);

    const uint8_t *ctx_data = nullptr;
    size_t ctx_len = 0;
    if (context.has_value() && context.value()) {
      ctx_data = context.value()->data();
      ctx_len = context.value()->size();
    }

    int result = net_socket_export_keying_material(
        _id, len, label.c_str(), ctx_data, ctx_len, output.data(),
        output.size());

    if (result > 0) {
      return ArrayBuffer::copy(output.data(), static_cast<size_t>(result));
    }
    return std::nullopt;
  }

  void setNoDelay(bool enable) override { net_set_nodelay(_id, enable); }

  void setKeepAlive(bool enable, double delay) override {
    // 负的 double 转 uint64_t 是 UB（实测绕成 ~1.8e19 ms ≈ 58 万年），
    // NaN 同理。钳到 0：调用方明显写错了，但让它变成一个荒谬的超长定时器更糟。
    net_set_keepalive(_id, enable, clampMillis(delay));
  }

  void setTimeout(double timeout) override {
    net_set_timeout(_id, clampMillis(timeout));
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
    // 两次调用：先只查长度，再按长度精确分配。原实现没有任何上限检查，
    // 直接把定长栈缓冲区交给 std::string(buf) —— 地址超过 256 字节就读取未初始化栈内存
    size_t len = net_get_remote_address(_id, nullptr, 0);
    if (len == 0)
      return "";
    std::vector<char> buf(len + 1); // 多留 1 字节供 Rust 写 NUL 终止符
    size_t got = net_get_remote_address(_id, buf.data(), buf.size());
    if (got == 0 || got > len)
      return "";
    return std::string(buf.data(), got);
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
  // JS 侧的毫秒数经 double 进 FFI，负值与 NaN 转 uint64_t 都是 UB
  // （负数实测绕成 ~1.8e19 ms）。统一钳到 [0, ...] 再转。
  static uint64_t clampMillis(double millis) {
    if (!std::isfinite(millis) || millis <= 0.0)
      return 0;
    return static_cast<uint64_t>(millis);
  }

  // 惰性注册，且 handler 持有 weak_ptr 而非裸 this：对象析构后，即使还有已排队的
  // 回调，weak.lock() 也会失败并安全返回 —— 结构上不再依赖
  // NetManager::dispatch "执行时重新查表" 这一偶然性质来避免访问悬垂对象。
  void ensureHandlerRegistered() {
    if (_handlerRegistered || _id == 0)
      return;
    _handlerRegistered = true;
    // 两个约束决定了这里的写法：
    // 1) 不能在构造函数里注册：那时 weak_from_this() 还是空的，lambda 永远锁不到对象，
    //    事件会被静默丢弃。所以注册推迟到这里（setOnEvent 时对象已被 shared_ptr 管理）。
    // 2) HybridObject 在继承链中是**虚基类**（生成的 spec 声明为
    //    `public virtual HybridObject`），因此 static_cast 无法向下转型；而 Nitro/jsi
    //    全库不使用 dynamic_cast，为不引入 RTTI 依赖，这里用
    //    「weak_ptr 作存活令牌 + 派生类指针作调用目标」：只要 weak.lock() 成功，
    //    对象就保证存活到本次回调结束，不会有悬垂访问。
    std::weak_ptr<HybridObject> weak = shared_from_this();
    HybridNetSocketDriver *self = this;
    NetManager::shared().registerHandler(
        _id, [weak, self](int type, const std::shared_ptr<ArrayBuffer> &data) {
          auto alive = weak.lock(); // 保活到本次回调结束
          if (!alive)
            return;
          self->onNativeEvent(type, data);
        });
  }

  void onNativeEvent(int type, const std::shared_ptr<ArrayBuffer> &data) {
    if (!_onEvent) {
      // onEvent 尚未设置（TS 的 createSocket() → setOnEvent() 之间的窗口）：先缓存，
      // 等 setOnEvent 时回放，避免事件被静默丢弃（C-M8）。上限 64 条，超出丢最旧的。
      // 缓存的正是 NetManager 交出来的那个 ArrayBuffer：它自持内存，什么时候回放都有效。
      if (_pendingEvents.size() >= kMaxPendingEvents) {
        LOGW("HybridNetSocketDriver: pending event queue full (id=%u), dropping oldest",
             _id);
        _pendingEvents.erase(_pendingEvents.begin());
      }
      _pendingEvents.emplace_back(type, data);
      return;
    }

    _onEvent(static_cast<double>(type), data);
  }

  /// onEvent 设置之前到达的事件（C-M8），在 setOnEvent 里按序回放
  static constexpr size_t kMaxPendingEvents = 64;
  std::vector<std::pair<int, std::shared_ptr<ArrayBuffer>>> _pendingEvents;
  uint32_t _id;
  bool _handlerRegistered = false;
  std::function<void(double, const std::shared_ptr<ArrayBuffer> &)> _onEvent;
};

} // namespace net
} // namespace nitro
} // namespace margelo
