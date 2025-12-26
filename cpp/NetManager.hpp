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

  /// Initialize with custom worker thread count
  /// Must be called before any other operations, or the config will be ignored
  void initWithConfig(uint32_t workerThreads) {
    if (!_initialized) {
      LOGI("Initializing NetManager with %u worker threads...", workerThreads);
      initializeRuntime(workerThreads);
    } else {
      LOGW("NetManager already initialized, config ignored. Call "
           "initWithConfig before any socket/server operations.");
    }
  }

private:
  void initializeRuntime(uint32_t workerThreads) {
    if (_initialized)
      return;
    _initialized = true;

    if (workerThreads > 0) {
      net_init_with_config(
          [](uint32_t id, int event_type, const uint8_t *data, size_t len,
             void *context) {
            auto mgr = static_cast<NetManager *>(context);
            mgr->dispatch(id, event_type, data, len);
          },
          this, workerThreads);
    } else {
      net_init(
          [](uint32_t id, int event_type, const uint8_t *data, size_t len,
             void *context) {
            auto mgr = static_cast<NetManager *>(context);
            mgr->dispatch(id, event_type, data, len);
          },
          this);
    }
  }

  bool _initialized = false;

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
    // Log all events for debugging
    const char *eventName = "UNKNOWN";
    switch (eventType) {
    case 1:
      eventName = "CONNECT";
      break;
    case 2:
      eventName = "DATA";
      break;
    case 3:
      eventName = "ERROR";
      break;
    case 4:
      eventName = "CLOSE";
      break;
    case 5:
      eventName = "DRAIN";
      break;
    case 6:
      eventName = "CONNECTION";
      break;
    case 7:
      eventName = "TIMEOUT";
      break;
    case 8:
      eventName = "LOOKUP";
      break;
    case 9:
      eventName = "DEBUG";
      break;
    }

    LOGI("dispatch: id=%u, event=%s(%d), len=%zu", id, eventName, eventType,
         len);

    // Copy handler outside of lock to avoid deadlock
    // (handler may call unregisterHandler which needs unique_lock)
    EventHandler handler;
    {
      std::shared_lock lock(_mutex);
      auto it = _handlers.find(id);
      if (it != _handlers.end()) {
        handler = it->second;
      }
    }

    // Call handler outside of lock
    if (handler) {
      handler(eventType, data, len);
    } else {
      LOGW("No handler found for id=%u, event=%s", id, eventName);
    }
  }

  std::shared_mutex _mutex;
  std::unordered_map<uint32_t, EventHandler> _handlers;
};

} // namespace margelo::nitro::net
