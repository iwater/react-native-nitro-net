#pragma once

#include "../nitrogen/generated/shared/c++/HybridNetServerDriverSpec.hpp"
#include "NetBindings.hpp"
#include "NetManager.hpp"
#include <NitroModules/ArrayBuffer.hpp>
#include <memory>
#include <optional>
#include <string>

namespace margelo {
namespace nitro {
namespace net {

class HybridNetServerDriver : public HybridNetServerDriverSpec {
public:
  // 同 Socket driver：构造函数内 weak_from_this() 还是空的，注册推迟到 setOnEvent()
  HybridNetServerDriver() : HybridObject(TAG) {
    _id = net_create_server();
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
    ensureHandlerRegistered();
  }

  double getMaxConnections() override { return _maxConnections; }
  void setMaxConnections(double maxConnections) override {
    _maxConnections = maxConnections;
    net_server_set_max_connections(_id, static_cast<int>(maxConnections));
  }

  // Methods
  void listen(double port, const std::optional<std::string> &host,
              std::optional<double> backlog,
              std::optional<bool> ipv6Only,
              std::optional<bool> reusePort) override {
    ensureServerId();
    // host 透传给 Rust 侧绑定（Node 语义）；未指定时绑通配地址
    net_listen(_id, static_cast<int>(port),
               host.has_value() ? host->c_str() : nullptr,
               static_cast<int>(backlog.value_or(128)),
               ipv6Only.value_or(false), reusePort.value_or(false));
  }

  void listenTLS(double port, double secureContextId,
                 std::optional<double> backlog, std::optional<bool> ipv6Only,
                 std::optional<bool> reusePort) override {
    ensureServerId();
    net_listen_tls(_id, static_cast<int>(port),
                   static_cast<int>(backlog.value_or(128)),
                   ipv6Only.value_or(false), reusePort.value_or(false),
                   static_cast<uint32_t>(secureContextId));
  }

  void listenUnix(const std::string &path,
                  std::optional<double> backlog) override {
    ensureServerId();
    net_listen_unix(_id, path.c_str(), static_cast<int>(backlog.value_or(128)));
  }

  void listenTLSUnix(const std::string &path, double secureContextId,
                     std::optional<double> backlog) override {
    ensureServerId();
    net_listen_tls_unix(_id, path.c_str(),
                        static_cast<int>(backlog.value_or(128)),
                        static_cast<uint32_t>(secureContextId));
  }

  void listenHandle(double fd, std::optional<double> backlog) override {
    ensureServerId();
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
    // 立刻把 _id 清零：否则 close() 之后、CLOSE 事件到达之前若用户直接再次 listen()
    // （计划 Step 2 的 [手测] 正是这个序列），会带着旧 _id 去 net_listen，
    // 随后迟到的 CLOSE 还会把这个"新"监听标记成已死。
    // 旧 id 的 handler **保留**到 CLOSE 到达再注销 —— TS 侧还要靠那个事件 emit 'close'。
    if (_id != 0) {
      const uint32_t dying = _id;
      _id = 0;
      _handlerRegistered = false;
      net_server_close(dying);
    }
  }

private:
  // 与 Socket driver 同构：handler 持有 weak_ptr，注册推迟到 setOnEvent()
  void ensureHandlerRegistered() {
    if (_handlerRegistered || _id == 0)
      return;
    _handlerRegistered = true;
    // 与 Socket driver 同构：HybridObject 是虚基类（无法 static_cast 向下转型）、
    // 且不引入 dynamic_cast 的 RTTI 依赖，因此用 weak_ptr 作存活令牌 + 派生类指针。
    std::weak_ptr<HybridObject> weak = shared_from_this();
    HybridNetServerDriver *self = this;
    // 把注册时的 id 一并捕获：CLOSE 事件必须能分辨"自己是不是当前那个 server"，
    // 否则 close() 后立刻重新 listen 时，旧 server 迟到的 CLOSE 会误伤新 server（见 onNativeEvent）。
    const uint32_t registeredId = _id;
    NetManager::shared().registerHandler(
        _id, [weak, self, registeredId](int type,
                                        const std::shared_ptr<ArrayBuffer> &data) {
          auto alive = weak.lock(); // 保活到本次回调结束
          if (!alive)
            return;
          self->onNativeEvent(registeredId, type, data);
        });
  }

  /// 惰性（重）建底层 server。所有 listen* 入口都要先调它。
  ///
  /// `_id` 会在 close() 与 CLOSE 事件后被清零，而 TS 层是**复用同一个 driver 对象**
  /// 再次 listen 的（net.ts 的 Server.listen 直接调 `this._driver.listen(...)`，
  /// 不会重建 driver）。若带着 `_id == 0` 去 net_listen，Rust 会照常 bind 但没有任何
  /// handler 接收事件，之后就再也关不掉 —— 幽灵监听器（C-H4）。
  void ensureServerId() {
    if (_id != 0)
      return;
    _id = net_create_server();
    _handlerRegistered = false; // 旧 id 的 handler 会在其 CLOSE 到达时注销，这里用新 id 重注册
    if (_maxConnections > 0) {
      // max_connections 存在 Rust 的 SERVER_MAP ctx 里，而新 server 是全新的 ctx：
      // 必须把驱动缓存的设置重新下发，否则重新 listen 后这个限制会静默失效。
      net_server_set_max_connections(_id, static_cast<int>(_maxConnections));
    }
    ensureHandlerRegistered();
  }

  void destroy() {
    if (_id != 0) {
      NetManager::shared().unregisterHandler(_id);
      net_destroy_server(_id);
      _id = 0;
    }
  }

  void onNativeEvent(uint32_t eventId, int type,
                     const std::shared_ptr<ArrayBuffer> &data) {
    if (!_onEvent)
      return;

    // 保活：下面的 _onEvent() 是 JS 回调，回调期间最后一个 JS 引用可能被释放——
    // 那样对象会在回调中被析构，回调之后的 _id / destroy() 就落在已释放对象上。
    auto self = shared_from_this();

    _onEvent(static_cast<double>(type), data);

    if (type == 4) { // CLOSE
      // Rust 侧监听循环是**自己收尾之后**（drop listener、移除 SERVER_MAP 条目）才发的
      // CLOSE，所以这里只需注销 handler，不必再 net_destroy_server。
      // 注意事件带的是**注册时**的 id：close() 后立刻重新 listen 的情况下，这个 CLOSE
      // 属于已经作废的旧 server，绝不能把当前 _id 清零（那会把新监听变成幽灵）。
      LOGI("Server %u received CLOSE event", eventId);
      NetManager::shared().unregisterHandler(eventId);
      if (eventId == _id) {
        _id = 0;
        _handlerRegistered = false;
      }
    }
  }

  uint32_t _id;
  double _maxConnections = 0;
  bool _handlerRegistered = false;
  std::function<void(double, const std::shared_ptr<ArrayBuffer> &)> _onEvent;
};

} // namespace net
} // namespace nitro
} // namespace margelo
