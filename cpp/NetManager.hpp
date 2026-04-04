#pragma once

#include "NetBindings.hpp"
#include <functional>
#include <memory>
#include <shared_mutex>
#include <string>
#include <unordered_map>
#include <vector>

#define NM_TAG "NetManager"

#ifdef __ANDROID__
#include <android/log.h>
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, NM_TAG, __VA_ARGS__)
#define LOGW(...) __android_log_print(ANDROID_LOG_WARN, NM_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, NM_TAG, __VA_ARGS__)
#else
#include <cstdio>
#define LOGI(...)                                                              \
  printf("[" NM_TAG "] " __VA_ARGS__);                                         \
  printf("\n")
#define LOGW(...)                                                              \
  printf("[" NM_TAG "] WARN: " __VA_ARGS__);                                   \
  printf("\n")
#define LOGE(...)                                                              \
  printf("[" NM_TAG "] ERROR: " __VA_ARGS__);                                  \
  printf("\n")
#endif

#include <NitroModules/Dispatcher.hpp>
#include <NitroModules/NitroLogger.hpp>

namespace margelo::nitro::net {

class NetManager {
public:
  using EventHandler =
      std::function<void(int eventType, const uint8_t *data, size_t len)>;

  static NetManager &shared() {
    static NetManager instance;
    return instance;
  }

  NetManager() {
    LOGI("Initializing NetManager with default config...");
    initializeRuntime(0); // 0 = use default (CPU core count)
  }

  void setDispatcher(std::shared_ptr<margelo::nitro::Dispatcher> dispatcher) {
    LOGI("NetManager: Dispatcher installed.");
    _dispatcher = dispatcher;
  }

  /// Initialize with custom worker thread count
  void initWithConfig(uint32_t workerThreads) {
    if (!_initialized) {
      LOGI("Initializing NetManager with %u worker threads...", workerThreads);
      initializeRuntime(workerThreads);
    } else {
      LOGW("NetManager already initialized, config ignored.");
    }
  }

private:
  void initializeRuntime(uint32_t workerThreads) {
    if (_initialized)
      return;
    _initialized = true;

    auto callback = [](uint32_t id, int event_type, const uint8_t *data, size_t len,
             void *context) {
            auto mgr = static_cast<NetManager *>(context);
            mgr->dispatch(id, event_type, data, len);
          };

    if (workerThreads > 0) {
      net_init_with_config(callback, this, workerThreads);
    } else {
      net_init(callback, this);
    }
  }

  bool _initialized = false;
  std::shared_ptr<margelo::nitro::Dispatcher> _dispatcher;

public:
  void registerHandler(uint32_t id, EventHandler handler) {
    LOGI("Registering handler for ID %u", id);
    std::unique_lock lock(_mutex);
    _handlers[id] = handler;
  }

  void unregisterHandler(uint32_t id) {
    LOGI("Unregistering handler for ID %u", id);
    std::unique_lock lock(_mutex);
    _handlers.erase(id);
  }

private:
  void dispatch(uint32_t id, int eventType, const uint8_t *data, size_t len) {
    // 1. Prepare data (copy if needed for async)
    std::vector<uint8_t> buffer;
    if (data && len > 0) {
        buffer.assign(data, data + len);
    }

    // 2. Define the actual dispatch logic
    auto doDispatch = [this, id, eventType, buffer = std::move(buffer)]() {
        EventHandler handler;
        {
          std::shared_lock lock(_mutex);
          auto it = _handlers.find(id);
          if (it != _handlers.end()) {
            handler = it->second;
          }
        }

        if (handler) {
          handler(eventType, buffer.data(), buffer.size());
        }
    };

    // 3. Dispatch either via JS Dispatcher (Async) or immediately (Sync fallback)
    if (_dispatcher) {
        _dispatcher->runAsync(std::move(doDispatch));
    } else {
        doDispatch();
    }
  }

  std::shared_mutex _mutex;
  std::unordered_map<uint32_t, EventHandler> _handlers;
};

} // namespace margelo::nitro::net
