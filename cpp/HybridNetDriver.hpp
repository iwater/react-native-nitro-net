#pragma once

#include "../nitrogen/generated/shared/c++/HybridHttpParserSpec.hpp"
#include "../nitrogen/generated/shared/c++/HybridNetDriverSpec.hpp"
#include "HybridHttpParser.hpp"
#include "HybridHttp2SessionDriver.hpp"
#include "HybridNetServerDriver.hpp"
#include "HybridNetSocketDriver.hpp"
#include "NetManager.hpp"
#include <NitroModules/ArrayBuffer.hpp>
#include <jsi/jsi.h>
#include <optional>
#include <string>
#include <vector>

namespace margelo {
namespace nitro {
namespace net {

using namespace margelo::nitro;

class HybridNetDriver : public HybridNetDriverSpec {
public:
  HybridNetDriver() : HybridObject(TAG) {}

  jsi::Value installDispatcher(jsi::Runtime &runtime, const jsi::Value &,
                               const jsi::Value *, size_t) {
    auto dispatcher =
        margelo::nitro::Dispatcher::getRuntimeGlobalDispatcher(runtime);
    NetManager::shared().setDispatcher(dispatcher);
    return jsi::Value::undefined();
  }

  bool impersonationAvailable() override {
    return net_impersonation_available();
  }

  void loadHybridMethods() override {
    HybridNetDriverSpec::loadHybridMethods();
    registerHybrids(this, [](Prototype &prototype) {
      prototype.registerRawHybridMethod("installDispatcher", 0,
                                        &HybridNetDriver::installDispatcher);
    });
  }

  std::shared_ptr<HybridNetSocketDriverSpec>
  createSocket(const std::optional<std::string> &id) override {
    if (id.has_value()) {
      // Existing socket from server accept
      // 解析失败不能静默新建一个空 socket：调用方拿到的对象 id 与请求的
      // 对不上，事件会挂在没有任何人监听的新 socket 上，表现是"连上了但永远
      // 收不到数据"。报出来。
      // （Nitro 的 HybridFunction 会把 std::exception 转成 JS Error，
      //  见 nitro/core/HybridFunction.hpp 的 catch(const std::exception&)。）
      try {
        std::size_t parsed = 0;
        unsigned long long socketId = std::stoull(id.value(), &parsed);
        if (parsed != id.value().size() || socketId > 0xFFFFFFFFull) {
          throw std::invalid_argument("socket id out of range or trailing garbage");
        }
        return std::make_shared<HybridNetSocketDriver>(
            static_cast<uint32_t>(socketId));
      } catch (const std::exception &e) {
        throw std::invalid_argument(
            "createSocket: invalid socket id \"" + id.value() + "\" (" + e.what() + ")");
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

  bool http2Available() override { return net_http2_available(); }

  std::shared_ptr<HybridHttp2SessionDriverSpec> createHttp2Session() override {
    return std::make_shared<HybridHttp2SessionDriver>();
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

  void setClientAuthToSecureContext(double scId, bool requestCert,
                                    bool rejectUnauthorized) override {
    net_secure_context_set_client_auth(static_cast<uint32_t>(scId), requestCert,
                                       rejectUnauthorized);
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

  // #84：服务端 ALPN（线缆形态由 JS 侧 convertALPNProtocols 生成）。
  // 与 OCSP 不同，`size() == 0` 是**合法**输入（node 的 `ALPNProtocols: []`），
  // 所以这里只挡空指针，不能照抄 OCSP 的 `len == 0` 早退。
  void setAlpnProtocolsToSecureContext(
      double scId, const std::shared_ptr<ArrayBuffer> &protocols) override {
    if (protocols) {
      net_secure_context_set_alpn(static_cast<uint32_t>(scId),
                                  protocols->data(), protocols->size());
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
    if (config.debug.has_value()) {
      net_set_debug(config.debug.value());
    }
  }

  std::string getNetworkInterfaces() override {
    // 两次调用：先只查长度，再按长度精确分配；定长栈缓冲区会在接口 JSON
    // 超过缓冲区时被越界读取（Rust 侧不足时不拷贝但仍返回真实长度）
    size_t len = ::net_get_interfaces(nullptr, 0);
    if (len == 0)
      return "{}";
    std::vector<char> buf(len + 1); // 多留 1 字节供 Rust 写 NUL 终止符
    size_t got = ::net_get_interfaces(buf.data(), buf.size());
    if (got == 0 || got > len)
      return "{}";
    return std::string(buf.data(), got);
  }
};

} // namespace net
} // namespace nitro
} // namespace margelo
