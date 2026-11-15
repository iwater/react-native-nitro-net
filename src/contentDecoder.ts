import { decompress as zstdDecompress } from 'fzstd';

/**
 * fetch 响应的 Content-Encoding 解码。
 *
 * 原生实现通过 provider 注入，避免把 react-native-nitro-zlib 变成硬依赖：
 *   import { setZlibProvider } from 'react-native-nitro-net'
 *   import * as zlib from 'react-native-nitro-zlib'
 *   setZlibProvider(zlib)
 *
 * 无头 JS 宿主也可以设置 globalThis.__nitroZlib。
 * ⚠️ 两条都没接线时，遇到非 identity 的 Content-Encoding 会抛
 *   `ERR_ZLIB_PROVIDER_MISSING`（以前是静默返回压缩字节，见 M3-T0/F8）。
 * zstd 优先使用 provider.zstdDecompressSync，否则回退到纯 JS 的 fzstd。
 */

export interface ZlibProvider {
  gunzipSync(data: Uint8Array): Uint8Array | ArrayBuffer;
  inflateSync(data: Uint8Array): Uint8Array | ArrayBuffer;
  brotliDecompressSync(data: Uint8Array): Uint8Array | ArrayBuffer;
  /** 可选：原生 provider 若支持 zstd，优先于内置 fzstd fallback。 */
  zstdDecompressSync?(data: Uint8Array): Uint8Array | ArrayBuffer;
}

let explicitProvider: ZlibProvider | null = null;

export function setZlibProvider(provider: ZlibProvider | null): void {
  explicitProvider = provider;
}

export function getZlibProvider(): ZlibProvider | null {
  if (explicitProvider) return explicitProvider;
  const injected = (globalThis as any).__nitroZlib;
  return injected ?? null;
}

function toUint8Array(value: Uint8Array | ArrayBuffer): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

function errWithCode(code: string, message: string): Error {
  const err = new Error(message);
  (err as any).code = code;
  return err;
}

/**
 * provider 里必须真的有这个方法。缺了要报得清楚 —— 否则调用方看到的是一句
 * `zlib.brotliDecompressSync is not a function`，排查方向会被带偏到解压实现里。
 */
function requireFn(
  zlib: ZlibProvider,
  name: keyof ZlibProvider,
  encoding: string
): (data: Uint8Array) => Uint8Array | ArrayBuffer {
  const fn = zlib[name];
  if (typeof fn !== 'function') {
    throw errWithCode(
      'ERR_ZLIB_PROVIDER_INCOMPLETE',
      `zlib provider has no ${String(name)} — cannot decode Content-Encoding: ${encoding}`
    );
  }
  return fn.bind(zlib) as (data: Uint8Array) => Uint8Array | ArrayBuffer;
}

/**
 * provider 实际能解哪些编码 —— `fetch` 的 `accept-encoding` 必须按这个来声明，
 * 否则我们会向服务端承诺解不了的东西（zstd 除外：有纯 JS 的 fzstd 兜底）。
 */
export function supportedEncodings(zlib: ZlibProvider | null): string[] {
  if (!zlib) return [];
  const out: string[] = [];
  if (typeof zlib.gunzipSync === 'function') out.push('gzip');
  if (typeof zlib.inflateSync === 'function') out.push('deflate');
  if (typeof zlib.brotliDecompressSync === 'function') out.push('br');
  out.push('zstd');  // fzstd fallback，不依赖 provider
  return out;
}

export function decodeContentEncoding(
  data: Uint8Array,
  encoding: string | undefined | null
): Uint8Array {
  if (!encoding) return data;

  const encodings = encoding
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

  if (encodings.length === 0 || encodings.every((item) => item === 'identity')) {
    return data;
  }

  const zlib = getZlibProvider();
  if (!zlib) {
    // 这里**不能**回退成「原样返回」：那等于把压缩字节当明文交给调用方，
    // 表现是 body 长度对、内容是二进制垃圾，而且没有任何报错（M3-T0 的 axios 腿
    // 就是这么发现所有宿主/App 都没接线）。宁可立刻炸在真正缺的东西上。
    throw errWithCode(
      'ERR_ZLIB_PROVIDER_MISSING',
      `cannot decode Content-Encoding: ${encoding} — no zlib provider is installed. ` +
      'Call setZlibProvider(zlib) (e.g. react-native-nitro-zlib) or set globalThis.__nitroZlib.'
    );
  }

  let out = data;
  for (let i = encodings.length - 1; i >= 0; i--) {
    switch (encodings[i]) {
      case 'gzip':
      case 'x-gzip':
        out = toUint8Array(requireFn(zlib, 'gunzipSync', encoding)(out));
        break;
      case 'deflate':
        out = toUint8Array(requireFn(zlib, 'inflateSync', encoding)(out));
        break;
      case 'br':
        out = toUint8Array(requireFn(zlib, 'brotliDecompressSync', encoding)(out));
        break;
      case 'zstd':
        out = zlib.zstdDecompressSync
          ? toUint8Array(zlib.zstdDecompressSync(out))
          : zstdDecompress(out);
        break;
      case 'identity':
        break;
      default:
        throw errWithCode(
          'ERR_UNSUPPORTED_CONTENT_ENCODING',
          `Unsupported content-encoding: ${encodings[i]}`
        );
    }
  }
  return out;
}

export function createContentDecoder(
  encoding: string | undefined | null
): ((data: Uint8Array) => Uint8Array) | undefined {
  if (!encoding) return undefined;
  const normalized = encoding.trim().toLowerCase();
  if (!normalized || normalized === 'identity') return undefined;
  return (data) => decodeContentEncoding(data, encoding);
}
