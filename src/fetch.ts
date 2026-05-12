import * as http from './http'
import * as https from './https'
import { Buffer } from 'react-native-nitro-buffer'

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
    const netClient = url.startsWith('https') ? https : http;

    // 处理超时
    const timeoutId = setTimeout(() => {
      reject(new Error('Request timeout'));
    }, timeout);

    // 处理 AbortSignal
    const onAbort = () => {
      clearTimeout(timeoutId);
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

    const requestOptions = {
      method,
      headers: requestHeaders,
      rejectUnauthorized: init?.rejectUnauthorized,
      agent: false,
      checkServerIdentity: () => undefined
    };

    try {
      const req = netClient.request(url, requestOptions, (res: any) => {
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