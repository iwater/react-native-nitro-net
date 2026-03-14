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

  HttpParsedMessage feed(const std::shared_ptr<ArrayBuffer> &data) override {
    if (!data)
      return HttpParsedMessage("", std::nullopt);

    char jsonBuf[8192];
    int res = net_http_parser_feed(_id, data->data(), data->size(), jsonBuf,
                                   sizeof(jsonBuf));

    if (res > 0) {
      // JSON Metadata successfully retrieved
      std::string metadata(jsonBuf, res);

      // Check if there is a body to fetch
      size_t bodyLen = net_http_parser_get_body(_id, nullptr, 0);
      std::optional<std::shared_ptr<ArrayBuffer>> body = std::nullopt;

      if (bodyLen > 0) {
        // Allocate and copy body
        auto ab = ArrayBuffer::allocate(bodyLen);
        net_http_parser_get_body(_id, ab->data(), bodyLen);
        body = ab;
      }

      return HttpParsedMessage(metadata, body);
    } else if (res == 0) {
      // Partial message
      return HttpParsedMessage("", std::nullopt);
    } else if (res < -3) {
      // Buffer too small, required size is -res
      size_t requiredSize = static_cast<size_t>(-res);
      std::vector<char> largerBuf(requiredSize + 1);
      res = net_http_parser_feed(_id, nullptr, 0, largerBuf.data(),
                                 requiredSize + 1);
      if (res > 0) {
        std::string metadata(largerBuf.data(), res);
        size_t bodyLen = net_http_parser_get_body(_id, nullptr, 0);
        std::optional<std::shared_ptr<ArrayBuffer>> body = std::nullopt;
        if (bodyLen > 0) {
          auto ab = ArrayBuffer::allocate(bodyLen);
          net_http_parser_get_body(_id, ab->data(), bodyLen);
          body = ab;
        }
        return HttpParsedMessage(metadata, body);
      }
      return HttpParsedMessage("ERROR: Re-parse failed after enlarging buffer",
                               std::nullopt);
    } else {
      // Error
      std::string error;
      switch (res) {
      case -1:
        error = "ERROR: JSON serialization failed";
        break;
      case -2:
        error = "ERROR: HTTP parse failed";
        break;
      case -3:
        error = "ERROR: Parser not found";
        break;
      default:
        error = "ERROR: Unknown error";
        break;
      }
      return HttpParsedMessage(error, std::nullopt);
    }
  }

private:
  uint32_t _id;
};

} // namespace net
} // namespace nitro
} // namespace margelo
