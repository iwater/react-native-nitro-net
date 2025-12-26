#pragma once

#include "../nitrogen/generated/shared/c++/HybridNetDriverSpec.hpp"
#include "HybridNetServerDriver.hpp"
#include "HybridNetSocketDriver.hpp"
#include "NetManager.hpp"

namespace margelo {
namespace nitro {
namespace net {

class HybridNetDriver : public HybridNetDriverSpec {
public:
  HybridNetDriver() : HybridObject(TAG) {}

  std::shared_ptr<HybridNetSocketDriverSpec>
  createSocket(const std::optional<std::string> &id) override {
    if (id.has_value()) {
      // Existing socket from server accept
      try {
        uint32_t socketId = static_cast<uint32_t>(std::stoul(id.value()));
        return std::make_shared<HybridNetSocketDriver>(socketId);
      } catch (...) {
        return std::make_shared<HybridNetSocketDriver>();
      }
    }
    return std::make_shared<HybridNetSocketDriver>();
  }

  std::shared_ptr<HybridNetServerDriverSpec> createServer() override {
    return std::make_shared<HybridNetServerDriver>();
  }

  void initWithConfig(const NetConfig &config) override {
    uint32_t workerThreads = config.workerThreads.value_or(0);
    NetManager::shared().initWithConfig(workerThreads);
  }
};

} // namespace net
} // namespace nitro
} // namespace margelo
