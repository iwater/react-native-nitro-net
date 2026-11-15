import * as http from './http'
import * as https from './https'
import { Buffer } from 'react-native-nitro-buffer'
import { FetchBody } from './fetchBody'
import { createContentDecoder, getZlibProvider, supportedEncodings } from './contentDecoder'
import type { ProxyTlsOptions } from './proxy'

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

// fetch 的 Headers 类型。
//
// ⚠️ **导出**的原因：宿主需要把它挂成全局 `Headers`（无头宿主环境启动期接线），
// 而 `fetch()` 返回的 `res.headers` 就是这个类的实例 —— 若全局 `Headers` 是另
// 一份实现，`res.headers instanceof Headers` 会是 false。**两处必须同一个类**。
//
// 已实现的规范面：构造（record / 数组对 / 另一个 Headers）、get/set/append/
// delete/has/keys/values/entries/forEach/[Symbol.iterator]/toJSON/getSetCookie。
// 未实现：header 名的合法性校验（不抛 TypeError）、set-cookie 的独立存储、
// keys()/values()/entries() 返回**数组**而不是迭代器（可 for...of / 展开，
// 但没有 .next()）。
export class FetchHeaders {
  private headers: Map<string, string>;

  constructor(init?: any) {
    this.headers = new Map();
    if (init === undefined || init === null) return;
    if (Array.isArray(init)) {
      for (const pair of init) {
        if (pair && pair.length >= 2) this.append(String(pair[0]), String(pair[1]));
      }
      return;
    }
    if (typeof init.entries === 'function') {
      const it = init.entries();
      // entries() 可能返回数组（本类）或迭代器（原生 Headers / Map）
      if (Array.isArray(it)) {
        for (const [k, v] of it) this.append(String(k), String(v));
      } else {
        let step = it.next();
        while (!step.done) {
          this.append(String(step.value[0]), String(step.value[1]));
          step = it.next();
        }
      }
      return;
    }
    if (typeof init === 'object') {
      Object.entries(init).forEach(([key, value]) => {
        this.set(key, Array.isArray(value) ? value.join(', ') : String(value));
      });
    }
  }

  get(name: string): string | null {
    const v = this.headers.get(name.toLowerCase());
    return v === undefined ? null : v;
  }

  set(name: string, value: string): void {
    this.headers.set(name.toLowerCase(), String(value));
  }

  append(name: string, value: string): void {
    const key = name.toLowerCase();
    const cur = this.headers.get(key);
    this.headers.set(key, cur === undefined ? String(value) : cur + ', ' + String(value));
  }

  delete(name: string): void {
    this.headers.delete(name.toLowerCase());
  }

  has(name: string): boolean {
    return this.headers.has(name.toLowerCase());
  }

  getSetCookie(): string[] {
    const v = this.headers.get('set-cookie');
    return v === undefined ? [] : v.split(', ');
  }

  entries(): [string, string][] {
    return Array.from(this.headers.entries());
  }

  keys(): string[] {
    return Array.from(this.headers.keys());
  }

  values(): string[] {
    return Array.from(this.headers.values());
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

// 把任意 header 容器归一成普通对象，供底层 `http.request({headers})` 用。
// 接受的形态：普通对象 / 数组对 / 有 entries() 的对象 / 有 forEach() 的对象。
// 为什么需要：`fetch(url, { headers: new FetchHeaders(...) })` 与
// `fetch(new Request(...))`（Request 的 headers 是 Headers 实例）都要能走通，
// 而 `{...init.headers}` 对类实例只会展开出私有字段（空对象）。
function headersToObject(h: any): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  if (Array.isArray(h)) {
    for (const pair of h) if (pair && pair.length >= 2) out[String(pair[0])] = String(pair[1]);
    return out;
  }
  if (typeof h.entries === 'function') {
    const it = h.entries();
    if (Array.isArray(it)) {
      for (const [k, v] of it) out[String(k)] = String(v);
    } else {
      let step = it.next();
      while (!step.done) {
        out[String(step.value[0])] = String(step.value[1]);
        step = it.next();
      }
    }
    return out;
  }
  if (typeof h === 'object') {
    Object.entries(h).forEach(([k, v]) => {
      out[k] = Array.isArray(v) ? v.join(', ') : String(v);
    });
  }
  return out;
}

// 把 WHATWG `Response` 构造器的第一个参数（body）归一成字节。
// 规范里 body 可以是 string / ArrayBuffer / TypedArray / Blob / FormData /
// URLSearchParams / ReadableStream / null。这里覆盖前四种 + null；
// 其余（FormData / URLSearchParams / ReadableStream）**不支持**，见文件末尾的
// 已登记缺口。
function toBodyBytes(body: any): Uint8Array {
  if (body === undefined || body === null) return new Uint8Array(0);
  if (typeof body === 'string') return new Uint8Array(Buffer.from(body, 'utf8'));
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, (body as any).byteOffset, (body as any).byteLength);
  }
  // Blob（宿主提供的那个）内部就是 Uint8Array，见 WebGlobals 的 installBlob
  if (typeof body._bytes !== 'undefined' && body._bytes instanceof Uint8Array) {
    return body._bytes;
  }
  return new Uint8Array(Buffer.from(String(body), 'utf8'));
}

// 常见的 HTTP 状态码 → 原因短语。
//
// ⚠️ **只用于内部形态**（`fetch()` 收到响应时填 statusText）—— 因为在无头宿主或
// RN 这条链路拿不到 HTTP 响应行里的真实 reason phrase（nitro-net 只透传
// statusCode），退而用表查。规范里的 `new Response(body, {status: 201})`
// **不推导** statusText（Node 实测给 `''`），所以 WHATWG 分支不查这张表。
const STATUS_TEXT: Record<number, string> = {
  200: 'OK', 201: 'Created', 202: 'Accepted', 203: 'Non-Authoritative Information',
  204: 'No Content', 205: 'Reset Content', 206: 'Partial Content',
  301: 'Moved Permanently', 302: 'Found', 303: 'See Other', 304: 'Not Modified',
  307: 'Temporary Redirect', 308: 'Permanent Redirect',
  400: 'Bad Request', 401: 'Unauthorized', 402: 'Payment Required',
  403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed',
  406: 'Not Acceptable', 408: 'Request Timeout', 409: 'Conflict', 410: 'Gone',
  413: 'Payload Too Large', 415: 'Unsupported Media Type',
  418: "I'm a Teapot", 422: 'Unprocessable Entity', 429: 'Too Many Requests',
  500: 'Internal Server Error', 501: 'Not Implemented', 502: 'Bad Gateway',
  503: 'Service Unavailable', 504: 'Gateway Timeout'
};

// fetch 的 Response 类型。
//
// ⚠️ **导出**的原因同 FetchHeaders：宿主把它挂成全局 `Response`，这样
// `fetch(...)` 的返回值 `instanceof Response` 才为 true。
//
// 已实现的规范面：status / statusText / ok / headers / url / type / redirected /
// bodyUsed / text() / json() / arrayBuffer() / blob() / clone() / Response.json()。
// 未实现：body（ReadableStream）、Response.error() / Response.redirect()、
// formData()（需要 FormData 解析）。
//
// ── 构造器有两种形态（这是**刻意**的，不是历史包袱）────────────────────────
//
//   A. 内部形态  `(status, body, headers, url, redirectUrls?, statusText?)`
//      —— `fetch()` 自己用的，也是 RN 侧既有调用方用的。
//   B. WHATWG 形态 `(body, init)` —— 宿主把它挂成全局 `Response` 之后，
//      **用户代码**会用这种。
//
// 为什么必须两种都认：挂全局的如果是纯内部形态，`new Response('hi', {status:
// 201})` 会**静默**得到 `status === 'hi'`（不抛、不报、类型还骗过 TS），
// 是最难查的一类错。而只做 WHATWG 形态又会破坏既有调用方。
// 判据是 `typeof 第一个参数 === 'number'`：内部调用点永远传数字，用户代码的
// 第一个参数是 body（string / Uint8Array / Blob / null），不会撞车。
export class FetchResponse {
  readonly status: number;
  readonly statusText: string;
  readonly ok: boolean;
  readonly headers: FetchHeaders;
  readonly url: string;
  readonly redirectUrls: string[];
  readonly type: string = 'basic';
  readonly redirected: boolean;
  private _body: FetchBody;

  get bodyUsed(): boolean {
    return this._body.bodyUsed;
  }

  constructor(
    statusOrBody: number | any,
    bodyOrInit?: any,
    headers?: Record<string, string | string[]> | FetchHeaders,
    url?: string,
    redirectUrls: string[] = [],
    statusText?: string
  ) {
    if (typeof statusOrBody !== 'number') {
      // ---- B. WHATWG 形态 (body, init) ----
      const init: any = bodyOrInit || {};
      const status = init.status === undefined ? 200 : Number(init.status);
      this.status = status;
      // 规范**不**从 status 推导 statusText（Node 实测 `new Response('',
      // {status: 201}).statusText === ''）。内部形态才查表。
      this.statusText = init.statusText === undefined ? '' : String(init.statusText);
      this.ok = status >= 200 && status < 300;
      this.headers = init.headers instanceof FetchHeaders
        ? init.headers
        : new FetchHeaders(init.headers);
      this._body = new FetchBody(toBodyBytes(statusOrBody));
      this.url = init.url === undefined ? '' : String(init.url);
      this.redirectUrls = [];
      this.redirected = false;
      return;
    }

    // ---- A. 内部形态 ----
    const status = statusOrBody;
    this.status = status;
    this.statusText = statusText !== undefined
      ? statusText
      : (STATUS_TEXT[status] || (status >= 200 && status < 300 ? 'OK' : ''));
    this.ok = status >= 200 && status < 300;
    this.headers = headers instanceof FetchHeaders ? headers : new FetchHeaders(headers);
    this._body = bodyOrInit instanceof FetchBody
      ? bodyOrInit
      : new FetchBody(
        (bodyOrInit as any) ?? new Uint8Array(0),
        undefined,
        createContentDecoder(this.headers.get('content-encoding'))
      );
    this.url = url === undefined ? '' : url;
    this.redirectUrls = redirectUrls;
    this.redirected = redirectUrls.length > 1;
  }

  clone(): FetchResponse {
    return new FetchResponse(
      this.status, this._body.clone(), this.headers, this.url,
      this.redirectUrls.slice(), this.statusText
    );
  }

  static json(data: any, init?: { status?: number; statusText?: string; headers?: any }): FetchResponse {
    const body = new Uint8Array(Buffer.from(JSON.stringify(data), 'utf8'));
    const headers = new FetchHeaders(init?.headers);
    if (headers.get('content-type') === null) headers.set('content-type', 'application/json');
    return new FetchResponse(
      init?.status === undefined ? 200 : init.status,
      body, headers, '', [], init?.statusText
    );
  }

  async text(): Promise<string> {
    return this._body.text();
  }

  async json(): Promise<any> {
    return this._body.json();
  }

  async blob(): Promise<Blob> {
    return this._body.blob(this.headers.get('content-type') || 'text/plain');
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    return this._body.arrayBuffer();
  }

  destroy(err?: Error): void {
    this._body.destroy(err);
  }
}

// RequestInit 类型定义（与 fetch 兼容）
interface RequestInit {
  method?: string;
  // 放宽到 any：普通对象 / FetchHeaders 实例 / 数组对 / Map 都要能进来
  // （`fetch(url, { headers: new Headers(...) })` 是常见写法）
  headers?: any;
  body?: string | Uint8Array | ArrayBuffer;
  signal?: any;
  timeout?: number;
  rejectUnauthorized?: boolean;
  redirect?: 'follow' | 'manual' | 'error';
  proxy?: string;
  /** `https://` 代理这一跳的 TLS 配置。 */
  proxyTls?: ProxyTlsOptions;
  /** Chrome 指纹（库的扩展；Node 工具不传时读全局 configure()）。 */
  impersonate?: boolean | 'chrome';
  profile?: string;
  forceHttp1?: boolean;
  _redirectCount?: number; // 内部使用，防止无限重定向
  _redirectUrls?: string[]; // 内部使用，记录所有重定向 URL
}

// fetch 能接受的 input 形态。
// 第三个形态（Request-like）是**全局 `Request` 可用的前提**：
// `fetch(new Request(url, {method, headers, body}))` 必须能读到那四个字段，
// 否则会退化成 `String(input)` → "[object Object]" → 拆 URL 直接抛。
// 用 duck-typing（有 `url` 字符串即可）而不是 `instanceof Request`：模块不该
// 依赖宿主是否提供了全局 Request。
type FetchInput = string | URL | {
  url: string;
  method?: string;
  headers?: any;
  body?: any;
  _body?: any;
  signal?: any;
  redirect?: any;
};

// 按照 fetch Web API 标准封装的请求函数
export const fetch = (
  input: FetchInput,
  init?: RequestInit
): Promise<FetchResponse> => {
  const base = (input !== null && typeof input === 'object' &&
                typeof (input as any).url === 'string') ? (input as any) : null;
  const url = base ? String(base.url) : String(input);
  const method = init?.method || (base && base.method) || 'GET';
  const timeout = init?.timeout || 15000;
  const signal = init?.signal || (base && base.signal) || undefined;
  const redirect = init?.redirect || (base && base.redirect) || 'follow';
  const redirectCount = init?._redirectCount || 0;
  const redirectUrls = init?._redirectUrls || [url];
  // body 优先级：init.body > Request 的 body（本仓的 Request 存在 `_body`，
  // 规范里的 `body` 是 ReadableStream，两者都认）
  const body = init?.body !== undefined
    ? init.body
    : (base ? (base._body !== undefined ? base._body : base.body) : undefined);

  return new Promise((resolve, reject) => {
    // 自己拆 URL（宿主可能没有全局 `URL`）。**在 Promise 执行器里拆**：
    // 拆不动时抛的错会被 Promise 构造器转成 reject —— 与 Node 的 fetch 一致，
    // 不是同步抛。见 parseRequestUrl() 的注释。
    const parsed = parseRequestUrl(url);
    const netClient = parsed.protocol === 'https:' ? https : http;

    // 先声明，供超时/中止回调取消底层请求（下方在 try 内赋值）
    let req: any;
    // 响应头到达后，abort 需要销毁响应流本身；此时 req 可能已经完成。
    let activeRes: any;

    // 处理超时
    const timeoutId = setTimeout(() => {
      // 不取消底层请求的话，它会在超时后继续跑完并一直持有 socket（TS-M15）
      try { req?.destroy(); } catch {}
      reject(new Error('Request timeout'));
    }, timeout);

    // 处理 AbortSignal
    //
    // 拒绝值取 `signal.reason`（Node 的 fetch 就是这么做的：`abort()` 不带参数时
    // reason 是 `DOMException [AbortError]: This operation was aborted`，带参数时
    // 就是那个参数）。宿主没有 `reason`（vendored abort-controller@3.0.0 早于该
    // 特性）时退回一个 `name === 'AbortError'` 的 Error —— 调用方普遍靠
    // `err.name === 'AbortError'` 判别，所以 **name 是关键**，
    // 旧实现给的 `Error('Request aborted')`（name 为 'Error'）会让这类判断全部落空。
    const abortError = (): any => {
      const reason = signal && signal.reason;
      if (reason !== undefined) return reason;
      const e: any = new Error('This operation was aborted');
      e.name = 'AbortError';
      return e;
    };
    const onAbort = () => {
      clearTimeout(timeoutId);
      const err = abortError();
      if (activeRes && typeof activeRes.destroy === 'function') {
        try { activeRes.destroy(err); } catch {}
      } else {
        try { req?.destroy(); } catch {}
      }
      reject(err);
    };

    if (signal) {
      signal.addEventListener('abort', onAbort);
      if (signal.aborted) {
        onAbort();
        return;
      }
    }

    // 合并默认 headers。
    // ⚠️ 必须经 headersToObject 归一：`init.headers` / `Request.headers` 都可能是
    // Headers 实例（类实例直接 `{...}` 展开只会得到私有字段 → 空对象，请求头静默丢失）。
    const defaultHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': '*/*',
    };
    const requestHeaders: Record<string, string> = {
      ...defaultHeaders,
      ...(base && base.headers ? headersToObject(base.headers) : {}),
      ...headersToObject(init?.headers),
    };

    // 只有注入了 zlib provider 才声明可解码的编码，而且**按 provider 真有的能力**
    // 来列：声明了解不了的编码等于让服务端送来我们解不了的 body。
    const hasAcceptEncoding = Object.keys(requestHeaders)
      .some((name) => name.toLowerCase() === 'accept-encoding');
    const supported = supportedEncodings(getZlibProvider());
    if (!hasAcceptEncoding && supported.length > 0) {
      requestHeaders['accept-encoding'] = supported.join(', ');
    }

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
      proxy: init?.proxy,
      proxyTls: init?.proxyTls,
      impersonate: init?.impersonate,
      profile: init?.profile,
      forceHttp1: init?.forceHttp1,
      // 不传 agent：交给 ClientRequest 使用协议对应的全局 Agent
      // （http.globalAgent / https.globalAgent）。agent:false 会为每次 fetch
      // 新建一条连接和一套池，keep-alive / H2 session 都无法复用。
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

            // 执行下一次请求。
            // ⚠️ 显式带上 method/headers/body：`{...init}` 在「input 是 Request
            // 对象」时是空的（参数在 Request 里，不在 init 里）⇒ 不带就会静默
            // 退化成无头的 GET。既有行为本来就是「重定向保留 method」，这里只是
            // 把它对新形态也补齐。⚠️ 未实现 301/302/303 的 POST→GET 语义。
            fetch(nextUrl, {
              ...init,
              method,
              headers: requestHeaders,
              body: body as any,
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

        // 响应头已到：立即 resolve，body 由 FetchBody 按需读取。
        activeRes = res;
        clearTimeout(timeoutId);

        const cleanup = () => {
          if (signal) signal.removeEventListener('abort', onAbort);
          if (activeRes === res) activeRes = null;
        };
        res.once('end', cleanup);
        res.once('close', cleanup);

        resolve(new FetchResponse(statusCode, res, res.headers || {}, url, redirectUrls));
      });

      req.on('error', (err: any) => {
        clearTimeout(timeoutId);
        if (signal) {
          signal.removeEventListener('abort', onAbort);
        }
        if (activeRes && typeof activeRes.destroy === 'function') {
          try { activeRes.destroy(err); } catch {}
        }
        reject(err);
      });

      // 发送请求体（如果存在）。body 可能来自 init，也可能来自 Request 对象。
      if (body !== undefined && body !== null) {
        req.write(body);
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