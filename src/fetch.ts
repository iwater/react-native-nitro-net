import * as http from './http'
import * as https from './https'
import { Buffer } from 'react-native-nitro-buffer'

/**
 * 把字符串 URL 拆成 `http.request` 认的 options 对象。
 *
 * **为什么必须自己拆**：有些宿主**没有全局 `URL`**（无头 JS 宿主常见；补 URL 是
 * 宿主侧的事）。而 `http.request(stringUrl)` / `https.request(stringUrl)`
 * 那条分支要 `new URL(...)` 才能拆出 hostname/port/path，在无 URL 的宿主里直接抛
 * `TypeError`（见 `urlCompat.ts` 的 `requireGlobalURL`）。
 *
 * 后果：`fetch('https://…')` 以前在这个宿主里**完全不可用** —— fetch 只接受字符串，
 * 没有"改用 options 对象"的退路。所以这个拆分放在 fetch 内部，产出 options 对象，
 * 走 `request` 的 **options 分支**（那条分支完全不碰 `URL`）。
 *
 * 刻意**不**改 `http.request`/`https.request` 的字符串分支：那会牵动 Node 的
 * 协议校验语义（`http.request('https://…')` 在 Node 里应报 `ERR_INVALID_PROTOCOL`），
 * 影响面比这里大得多。两者目前的不对称是有意的。
 *
 * 支持 `scheme://[userinfo@]host[:port]/path?query#fragment`，含 IPv6 字面量。
 * 不解析 userinfo（当前请求路径不需要）。
 */
function parseRequestUrl(input: string): { protocol: string; hostname: string; port: number; path: string } {
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(\?[^#]*)?/.exec(input);
  if (!m) {
    throw new TypeError(
      `fetch(): cannot parse URL ${JSON.stringify(input)} — expected an absolute URL like "https://host/path"`
    );
  }
  const protocol = m[1].toLowerCase() + ':';
  let authority = m[2] || '';
  const path = (m[3] || '/') + (m[4] || '');

  // 去掉 userinfo（只取最后一个 '@'，密码里可以有 '@'）
  const at = authority.lastIndexOf('@');
  if (at >= 0) authority = authority.slice(at + 1);

  let hostname: string;
  let portStr = '';
  if (authority.startsWith('[')) {
    // IPv6 字面量：[::1]:8080
    const end = authority.indexOf(']');
    if (end < 0) throw new TypeError(`fetch(): malformed IPv6 host in ${JSON.stringify(input)}`);
    hostname = authority.slice(1, end);
    const rest = authority.slice(end + 1);
    if (rest.startsWith(':')) portStr = rest.slice(1);
  } else {
    const colon = authority.lastIndexOf(':');
    if (colon >= 0) {
      hostname = authority.slice(0, colon);
      portStr = authority.slice(colon + 1);
    } else {
      hostname = authority;
    }
  }

  if (!hostname) throw new TypeError(`fetch(): missing host in ${JSON.stringify(input)}`);
  const port = portStr ? parseInt(portStr, 10) : (protocol === 'https:' ? 443 : 80);
  if (!Number.isFinite(port) || port <= 0) {
    throw new TypeError(`fetch(): invalid port ${JSON.stringify(portStr)} in ${JSON.stringify(input)}`);
  }
  return { protocol, hostname, port, path };
}

// 模拟 fetch 的 Headers 类型
class FetchHeaders {
  private headers: Map<string, string>;

  constructor(init?: Record<string, string | string[]>) {
    this.headers = new Map();
    if (init) {
      Object.entries(init).forEach(([key, value]) => {
        this.headers.set(key.toLowerCase(), Array.isArray(value) ? value.join(', ') : value);
      });
    }
  }

  get(name: string): string | null {
    return this.headers.get(name.toLowerCase()) || null;
  }

  has(name: string): boolean {
    return this.headers.has(name.toLowerCase());
  }

  entries(): [string, string][] {
    return Array.from(this.headers.entries());
  }

  toJSON(): Record<string, string> {
    return Object.fromEntries(this.headers.entries());
  }

  forEach(callback: (value: string, name: string, headers: FetchHeaders) => void): void {
    this.headers.forEach((value, name) => callback(value, name, this));
  }

  [Symbol.iterator](): Iterator<[string, string]> {
    return this.headers.entries();
  }
}

// 模拟 fetch 的 Response 类型
class FetchResponse {
  readonly status: number;
  readonly statusText: string;
  readonly ok: boolean;
  readonly headers: FetchHeaders;
  readonly url: string;
  readonly redirectUrls: string[];
  private _body: Uint8Array;

  constructor(status: number, body: Uint8Array, headers: Record<string, string | string[]>, url: string, redirectUrls: string[] = []) {
    this.status = status;
    this.statusText = status >= 200 && status < 300 ? 'OK' : 'Error';
    this.ok = (status >= 200 && status < 300);
    this.headers = new FetchHeaders(headers);
    this._body = body;
    this.url = url;
    this.redirectUrls = redirectUrls;
  }

  async text(): Promise<string> {
    const decoder = new TextDecoder();
    return decoder.decode(this._body);
  }

  async json(): Promise<any> {
    try {
      const text = await this.text();
      return JSON.parse(text);
    } catch (e) {
      return null;
    }
  }

  async blob(): Promise<Blob> {
    const mimeType = this.headers.get('content-type') || 'text/plain';
    return new Blob([this._body as any], { type: mimeType });
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    return this._body.buffer.slice(
      this._body.byteOffset,
      this._body.byteOffset + this._body.byteLength
    ) as ArrayBuffer;
  }
}

// RequestInit 类型定义（与 fetch 兼容）
interface RequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  signal?: AbortSignal;
  timeout?: number;
  rejectUnauthorized?: boolean;
  redirect?: 'follow' | 'manual' | 'error';
  _redirectCount?: number; // 内部使用，防止无限重定向
  _redirectUrls?: string[]; // 内部使用，记录所有重定向 URL
}

// 按照 fetch Web API 标准封装的请求函数
export const fetch = (
  input: string | URL,
  init?: RequestInit
): Promise<FetchResponse> => {
  const url = input.toString();
  const method = init?.method || 'GET';
  const timeout = init?.timeout || 15000;
  const signal = init?.signal;
  const redirect = init?.redirect || 'follow';
  const redirectCount = init?._redirectCount || 0;
  const redirectUrls = init?._redirectUrls || [url];

  return new Promise((resolve, reject) => {
    // 自己拆 URL（宿主可能没有全局 `URL`）。**在 Promise 执行器里拆**：
    // 拆不动时抛的错会被 Promise 构造器转成 reject —— 与 Node 的 fetch 一致，
    // 不是同步抛。见 parseRequestUrl() 的注释。
    const parsed = parseRequestUrl(url);
    const netClient = parsed.protocol === 'https:' ? https : http;

    // 先声明，供超时/中止回调取消底层请求（下方在 try 内赋值）
    let req: any;

    // 处理超时
    const timeoutId = setTimeout(() => {
      // 不取消底层请求的话，它会在超时后继续跑完并一直持有 socket（TS-M15）
      try { req?.destroy(); } catch {}
      reject(new Error('Request timeout'));
    }, timeout);

    // 处理 AbortSignal
    const onAbort = () => {
      clearTimeout(timeoutId);
      try { req?.destroy(); } catch {}
      reject(new Error('Request aborted'));
    };

    if (signal) {
      signal.addEventListener('abort', onAbort);
      if (signal.aborted) {
        onAbort();
        return;
      }
    }

    // 合并默认 headers
    const defaultHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': '*/*',
    };
    const requestHeaders = { ...defaultHeaders, ...init?.headers };

    // 不要传 checkServerIdentity：它一旦真的到达 tls.ts，就会覆盖内置的主机名校验
    // （tls.ts 只有在没收到该选项时才回退到 checkServerIdentity）。
    // 注：当前 Agent.createConnection（http.ts）只透传 host/port/servername/
    // rejectUnauthorized/ca/cert/key，所以原先那行其实是死代码；但它是个陷阱——
    // 哪天 options 被 spread 进 connectOptions，主机名校验就会静默失效。
    const requestOptions = {
      // 用 options 对象而不是字符串 URL：options 分支完全不碰全局 `URL`
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.path,
      method,
      headers: requestHeaders,
      rejectUnauthorized: init?.rejectUnauthorized,
      agent: false,
    };

    try {
      req = netClient.request(requestOptions, (res: any) => {
        const statusCode = res.statusCode || 0;

        // 处理重定向
        if (redirect === 'follow' && [301, 302, 303, 307, 308].includes(statusCode)) {
          const location = res.headers?.location;
          if (location) {
            if (redirectCount >= 10) {
              clearTimeout(timeoutId);
              if (signal) signal.removeEventListener('abort', onAbort);
              reject(new Error('Too many redirects'));
              res.destroy();
              return;
            }

            clearTimeout(timeoutId);
            if (signal) signal.removeEventListener('abort', onAbort);
            res.destroy();

            // 解析重定向 URL
            let nextUrl: string;
            try {
              nextUrl = new URL(location, url).href;
            } catch (e) {
              nextUrl = location;
            }

            // 执行下一次请求
            fetch(nextUrl, {
              ...init,
              _redirectCount: redirectCount + 1,
              _redirectUrls: [...redirectUrls, nextUrl]
            }).then(resolve).catch(reject);
            return;
          }
        }

        // 对于 HEAD 请求，不需要读取数据体
        if (method === 'HEAD') {
          clearTimeout(timeoutId);
          if (signal) {
            signal.removeEventListener('abort', onAbort);
          }
          resolve(new FetchResponse(statusCode, new Uint8Array(0), res.headers || {}, url, redirectUrls));
          res.destroy();
          return;
        }

        // GET/POST 等请求需要读取数据
        const chunks: any[] = [];
        res.on('data', (chunk: any) => {
          chunks.push(chunk);
        });
        res.on('end', () => {
          clearTimeout(timeoutId);
          if (signal) {
            signal.removeEventListener('abort', onAbort);
          }
          const body = Buffer.concat(chunks);
          resolve(new FetchResponse(statusCode, body, res.headers || {}, url, redirectUrls));
        });
        res.on('error', (err: any) => {
          clearTimeout(timeoutId);
          if (signal) {
            signal.removeEventListener('abort', onAbort);
          }
          reject(err);
        });
      });

      req.on('error', (err: any) => {
        clearTimeout(timeoutId);
        if (signal) {
          signal.removeEventListener('abort', onAbort);
        }
        reject(err);
      });

      // 发送请求体（如果存在）
      if (init?.body) {
        req.write(init.body);
      }

      req.end();
    } catch (error) {
      clearTimeout(timeoutId);
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
      reject(error);
    }
  });
};