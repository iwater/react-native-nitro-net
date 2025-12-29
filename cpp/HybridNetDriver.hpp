#pragma once

#include "../nitrogen/generated/shared/c++/HybridHttpParserSpec.hpp"
#include "../nitrogen/generated/shared/c++/HybridNetDriverSpec.hpp"
#include "HybridHttpParser.hpp"
#include "HybridNetServerDriver.hpp"
#include "HybridNetSocketDriver.hpp"
#include "NetManager.hpp"
#include <NitroModules/ArrayBuffer.hpp>
#include <optional>
#include <string>

namespace margelo {
namespace nitro {
namespace net {

using namespace margelo::nitro;

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

  std::shared_ptr<HybridHttpParserSpec> createHttpParser(double mode) override {
    return std::make_shared<HybridHttpParser>(static_cast<int>(mode));
  }

  double
  createSecureContext(const std::string &cert, const std::string &key,
                      const std::optional<std::string> &passphrase) override {
    return static_cast<double>(net_create_secure_context(
        cert.c_str(), key.c_str(),
        passphrase.has_value() ? passphrase.value().c_str() : nullptr));
  }

  double createEmptySecureContext() override {
    return static_cast<double>(net_secure_context_create());
  }

  void addCACertToSecureContext(double scId, const std::string &ca) override {
    net_secure_context_add_ca(static_cast<uint32_t>(scId), ca.c_str());
  }

  void addContextToSecureContext(
      double scId, const std::string &hostname, const std::string &cert,
      const std::string &key,
      const std::optional<std::string> &passphrase) override {
    net_secure_context_add_context(
        static_cast<uint32_t>(scId), hostname.c_str(), cert.c_str(),
        key.c_str(),
        passphrase.has_value() ? passphrase.value().c_str() : nullptr);
  }

  void
  setPFXToSecureContext(double scId, const std::shared_ptr<ArrayBuffer> &pfx,
                        const std::optional<std::string> &passphrase) override {
    if (pfx) {
      net_secure_context_set_pfx(
          static_cast<uint32_t>(scId), pfx->data(), pfx->size(),
          passphrase.has_value() ? passphrase.value().c_str() : nullptr);
    }
  }

  void setOCSPResponseToSecureContext(
      double scId, const std::shared_ptr<ArrayBuffer> &ocsp) override {
    if (ocsp) {
      net_secure_context_set_ocsp_response(static_cast<uint32_t>(scId),
                                           ocsp->data(), ocsp->size());
    }
  }

  std::optional<std::shared_ptr<ArrayBuffer>>
  getTicketKeys(double scId) override {
    uint8_t buf[256];
    size_t len = net_server_get_ticket_keys(static_cast<uint32_t>(scId), buf,
                                            sizeof(buf));
    if (len > 0) {
      return ArrayBuffer::copy(buf, len);
    }
    return std::nullopt;
  }

  void setTicketKeys(double scId,
                     const std::shared_ptr<ArrayBuffer> &keys) override {
    if (keys) {
      net_server_set_ticket_keys(static_cast<uint32_t>(scId), keys->data(),
                                 keys->size());
    }
  }

  void initWithConfig(const NetConfig &config) override {
    uint32_t workerThreads = config.workerThreads.value_or(0);
    NetManager::shared().initWithConfig(workerThreads);
  }
};

} // namespace net
} // namespace nitro
} // namespace margelo
