#pragma once

#include "NetBindings.hpp"
#include <functional>
#include <memory>
#include <shared_mutex>
#include <string>
#include <unordered_map>
#include <vector>

#define NM_TAG "NetManager"

// 诊断输出开关（**默认关闭**）。
//
// 非 Android 下这三条宏原先**无条件 `printf` 到 stdout**。而无头宿主的 parity 判据是
// stdout/stderr/退出码与 Node 逐字节一致，Node 在 require('net') / listen() 这条路径上
// 什么都不打 —— 于是任何用到 net 的程序必然判红（实测 P3 的 stdout 多出 4 行
// `[NetManager] …`）。**只改成 stderr 也没用**，parity 同样比对 stderr。
// 需要排查时在编译期定义 NETMANAGER_VERBOSE 重新打开（输出仍走 stdout，仅供本地调试）。
#ifdef NETMANAGER_VERBOSE
#include <cstdio>
#endif

#ifdef __ANDROID__
#include <android/log.h>
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, NM_TAG, __VA_ARGS__)
#define LOGW(...) __android_log_print(ANDROID_LOG_WARN, NM_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, NM_TAG, __VA_ARGS__)
#elif defined(NETMANAGER_VERBOSE)
#define LOGI(...)                                                              \
  printf("[" NM_TAG "] " __VA_ARGS__);                                         \
  printf("\n")
#define LOGW(...)                                                              \
  printf("[" NM_TAG "] WARN: " __VA_ARGS__);                                   \
  printf("\n")
#define LOGE(...)                                                              \
  printf("[" NM_TAG "] ERROR: " __VA_ARGS__);                                  \
  printf("\n")
#else
// 默认静默。仍把参数「吃掉」，否则静默后只被日志用到的变量会触发
// -Wunused-but-set-variable / -Wunused-parameter。logSink 不产生任何输出。
namespace margelo::nitro::net::detail {
template <typename... Args>
inline void logSink(const char *, Args &&...) noexcept {}
} // namespace margelo::nitro::net::detail
#define LOGI(...) ::margelo::nitro::net::detail::logSink(__VA_ARGS__)
#define LOGW(...) ::margelo::nitro::net::detail::logSink(__VA_ARGS__)
#define LOGE(...) ::margelo::nitro::net::detail::logSink(__VA_ARGS__)
#endif

#include <NitroModules/ArrayBuffer.hpp>
#include <NitroModules/Dispatcher.hpp>
#include <NitroModules/NitroLogger.hpp>

namespace margelo::nitro::net {

// -----------------------------------------------------------------------------
// 内存契约（跨 Rust / C++ / JS 三层的边界，改动任何一侧前先读这里）
//
// 为什么写在这里而不是 `NetBindings.hpp`：那个文件是 **cbindgen 生成的**
// （`rust_c_net/build.rs`），并由 `copy-clib-mac` 拷进本目录 —— 写在那里的内容
// 会在下一次刷新时被无声覆盖。这里是手写的，不会。
//
// ① JS → Rust：**ArrayBuffer 只在 FFI 调用期间有效**，Rust 侧同步拷走。
//    证据：`net_write`（rust_c_net/src/ffi.rs）在 try_send 之前先
//    `std::slice::from_raw_parts(data, len).to_vec()`，通道里流转的是 Rust 自己的 Vec。
//    所以 C++ 侧把 JS 传来的 buffer 交进去之后即可放手，不需要保活。
//
// ② Rust → C++：**回调里的 `data` 裸指针只在本次回调期间有效**。
//    证据：`emit_event`（rust_c_net/src/runtime.rs）把 `data.as_ptr()` 直接递给
//    CallbackPtr；而 socket.rs 的读循环传的是可复用的读缓冲 `&buf[..n]`——回调
//    返回后同一块内存立刻会被下一次 read 覆写。
//    因此 NetManager::dispatch 必须先把数据拷成自持的 std::vector（整个链路上
//    **唯一一次**数据拷贝，C-M7），之后再把 vector 的所有权移交 ArrayBuffer。
//
// ③ C++ → JS：交给 JS 的 `std::shared_ptr<ArrayBuffer>` **自持内存**（isOwner()），
//    JS 侧的 ArrayBuffer 通过 jsi::NativeState 持有它，因此 JS 持有期间不会被
//    原生覆写或释放——这正是 ② 的拷贝可以止步于一次的前提。
// -----------------------------------------------------------------------------

class NetManager {
public:
  // 事件载荷以 **std::shared_ptr<ArrayBuffer>** 传递：dispatch 只从 Rust 的借来指针
  // 拷贝一次进 vector，随即把 vector 的所有权移交 ArrayBuffer（C-M7）。
  // 旧签名是裸指针 (const uint8_t*, size_t)，handler 各自再 ArrayBuffer::copy 一次
  // —— 每包两次拷贝，第二次纯属多余（Rust 侧借出的内存已在 dispatch 里拷走）。
  // 契约见本文件顶部：裸指针只在回调期间有效，ArrayBuffer 则自持内存。
  using EventHandler =
      std::function<void(int eventType, const std::shared_ptr<ArrayBuffer> &data)>;

  static NetManager &shared() {
    static NetManager instance;
    return instance;
  }

  // 刻意不在构造函数里初始化 runtime（C-M2）：`shared()` 一旦被调用就锁定默认配置，
  // 之后 initWithConfig(workerThreads) 永远被忽略。改为首次真正需要时惰性初始化。
  NetManager() = default;

  void setDispatcher(std::shared_ptr<margelo::nitro::Dispatcher> dispatcher) {
    LOGI("NetManager: Dispatcher installed.");
    // C-M3：写方在 JS 线程、读方在 tokio 线程，必须同步（见 dispatch）。
    std::unique_lock lock(_mutex);
    _dispatcher = std::move(dispatcher);
  }

  /// Initialize with custom worker thread count（仅首次生效，之后幂等）
  void initWithConfig(uint32_t workerThreads) {
    ensureRuntimeInitialized(workerThreads, /*explicitConfig=*/true);
  }

private:
  /// 幂等初始化：只在首次真正调用 net_init*。
  /// `explicitConfig` 为 false 表示这是"没配置就先用起来了"的兜底路径，会告警。
  void ensureRuntimeInitialized(uint32_t workerThreads, bool explicitConfig) {
    {
      std::unique_lock lock(_mutex);
      if (_initialized) {
        // 只有显式配置重复调用才告警；registerHandler 的兜底路径传 0，不该刷屏。
        if (explicitConfig && workerThreads != _workerThreads) {
          LOGW("NetManager already initialized with %u worker threads; requested %u ignored",
               _workerThreads, workerThreads);
        }
        return;
      }
      _initialized = true;
      _workerThreads = workerThreads;
    }

    if (explicitConfig) {
      LOGI("Initializing NetManager with %u worker threads...", workerThreads);
    } else {
      LOGW("NetManager: initializing with default config (%u worker threads); "
           "call initWithConfig() before creating sockets to customize it",
           workerThreads);
    }

    auto callback = [](uint32_t id, int event_type, const uint8_t *data, size_t len,
             void *context) {
            // 异常绝不允许穿出 extern "C" 回调边界——穿出去就是 std::terminate。
            // 这层 catch 把「进程直接 abort」降级为「丢一个事件 + 一行日志」，
            // 让这类问题可观测而不是致命。
            // 注意：这只是纵深防御。生命周期缺陷（如宿主侧的悬垂 EventLoop&——
            // 宿主在卸载运行时会先释放它）必须先在本层之下修好——否则这层
            // catch 会把「崩溃」掩盖成「静默丢事件」。
            try {
              auto mgr = static_cast<NetManager *>(context);
              mgr->dispatch(id, event_type, data, len);
            } catch (const std::exception &e) {
              LOGE("exception in native event callback (id=%u, type=%d): %s",
                   id, event_type, e.what());
            } catch (...) {
              LOGE("unknown exception in native event callback (id=%u, type=%d)",
                   id, event_type);
            }
          };

    if (workerThreads > 0) {
      net_init_with_config(callback, this, workerThreads);
    } else {
      net_init(callback, this);
    }
  }

  bool _initialized = false;
  uint32_t _workerThreads = 0;
  std::shared_ptr<margelo::nitro::Dispatcher> _dispatcher;

public:
  void registerHandler(uint32_t id, EventHandler handler) {
    // 兜底：driver 开始关心事件之前，native callback 必须已安装，否则事件会静默丢失。
    // 用户若没先调 initWithConfig()，这里以默认配置初始化并告警。
    ensureRuntimeInitialized(0, /*explicitConfig=*/false);

    std::unique_lock lock(_mutex);
    // 同 id 重复注册意味着上一个 driver 还活着（或没走 unregisterHandler）——
    // 覆盖会让它再也收不到事件。行为不变（仍然覆盖，改语义要动生命周期），
    // 但要留痕，否则这类泄漏在现场只能靠猜。
    if (auto it = _handlers.find(id); it != _handlers.end()) {
      LOGW("NetManager: registerHandler(%u) overwrites an existing handler", id);
    }
    LOGI("Registering handler for ID %u", id);
    _handlers[id] = std::move(handler);
  }

  void unregisterHandler(uint32_t id) {
    LOGI("Unregistering handler for ID %u", id);
    std::unique_lock lock(_mutex);
    _handlers.erase(id);
  }

private:
  /// 把已归 C++ 所有的字节移交 ArrayBuffer：**不拷贝**。
  ///
  /// 空载荷也必须是**非空**的可拥有 buffer —— JS 侧一律按 ArrayBuffer 收（见
  /// HybridNetSocketDriver::onNativeEvent）。而 ArrayBuffer::move 对空 vector 会
  /// wrap 出 `data() == nullptr`（空 vector 未分配内存），交给 JSI 不安全，
  /// 因此空载荷走 allocate(0)：与改动前的 `copy(&empty, 0)` 等价（同样是 new uint8_t[0]）。
  static std::shared_ptr<ArrayBuffer> makeEventBuffer(std::vector<uint8_t> &&bytes) {
    if (bytes.empty()) {
      return ArrayBuffer::allocate(0);
    }
    // move() 内部：new 一个 vector 持有这块内存、wrap 其 data()、deleter 里 delete。
    // 于是「dispatch 的那次拷贝」就是整个链路上唯一的一次数据拷贝（C-M7）。
    return ArrayBuffer::move(std::move(bytes));
  }

  void dispatch(uint32_t id, int eventType, const uint8_t *data, size_t len) {
    // 1. 唯一一次数据拷贝：`data` 是 Rust 借出的指针，只在本次回调期间有效
    //    （契约见本文件顶部），必须在这里拷成自持的 vector。
    std::vector<uint8_t> buffer;
    if (data && len > 0) {
        buffer.assign(data, data + len);
    }
    std::shared_ptr<ArrayBuffer> payload = makeEventBuffer(std::move(buffer));

    // 2. Define the actual dispatch logic
    auto doDispatch = [this, id, eventType, payload = std::move(payload)]() {
        EventHandler handler;
        {
          std::shared_lock lock(_mutex);
          auto it = _handlers.find(id);
          if (it != _handlers.end()) {
            handler = it->second;
          }
        }

        if (handler) {
          handler(eventType, payload);
        }
    };

    // 3. 取 dispatcher（C-M3：JS 线程写、tokio 线程读，因此经 _mutex 同步；
    //    不在这里用 std::atomic<std::shared_ptr>，因为它在各 NDK libc++ 版本上
    //    可用性不一致，而这里每次事件只读一次、不构成热点）。
    //    取出后立即放锁，绝不在持锁期间调 runAsync。
    std::shared_ptr<margelo::nitro::Dispatcher> dispatcher;
    {
      std::shared_lock lock(_mutex);
      dispatcher = _dispatcher;
    }

    if (dispatcher) {
      dispatcher->runAsync(std::move(doDispatch));
    } else {
      // 绝不在 Rust 回调线程上同步执行 JS 回调：非 JS 线程触碰 JSI runtime 是 UB。
      // dispatcher 缺失属初始化时序问题，事件丢弃并告警 —— TS 侧负责保证安装成功。
      LOGW("NetManager: dispatcher not installed, dropping event (id=%u, type=%d)",
           id, eventType);
    }
  }

  std::shared_mutex _mutex;
  std::unordered_map<uint32_t, EventHandler> _handlers;
};

} // namespace margelo::nitro::net
