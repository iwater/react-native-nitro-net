#pragma once

#include "../nitrogen/generated/shared/c++/HybridHttpParserSpec.hpp"
#include "NetBindings.hpp"
#include <NitroModules/ArrayBuffer.hpp>
#include <string>

namespace margelo {
namespace nitro {
namespace net {

using namespace margelo::nitro;

class HybridHttpParser : public HybridHttpParserSpec {
public:
  HybridHttpParser(int mode) : HybridObject(TAG) {
    _id = net_http_parser_create(mode);
  }

  ~HybridHttpParser() { net_http_parser_destroy(_id); }

  std::string feed(const std::shared_ptr<ArrayBuffer> &data) override {
    if (!data)
      return "";

    char buf[4096];
    int res =
        net_http_parser_feed(_id, data->data(), data->size(), buf, sizeof(buf));

    if (res > 0) {
      // Complete message
      return std::string(buf, res);
    } else if (res == 0) {
      // Partial message
      return "";
    } else if (res < -3) {
      // Buffer too small, required size is -res
      size_t requiredSize = static_cast<size_t>(-res);
      std::string largerBuf(requiredSize, '\0');
      res = net_http_parser_feed(_id, nullptr, 0, &largerBuf[0],
                                 requiredSize + 1);
      if (res > 0) {
        return std::string(largerBuf.data(), res);
      }
      return "ERROR: Re-parse failed after enlarging buffer";
    } else {
      // Error
      switch (res) {
      case -1:
        return "ERROR: JSON serialization failed";
      case -2:
        return "ERROR: HTTP parse failed";
      case -3:
        return "ERROR: Parser not found";
      default:
        return "ERROR: Unknown error";
      }
    }
  }

private:
  uint32_t _id;
};

} // namespace net
} // namespace nitro
} // namespace margelo
