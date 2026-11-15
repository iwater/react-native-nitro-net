import type { PemInput } from './pem';

export interface ParsedHttpProxy {
  host: string;
  port: number;
  authorization?: string;
}

/**
 * `https://` 代理这一跳的 TLS 配置。
 *
 * ⚠️ 与源站的 `ca/cert/key` **互不影响**：代理跳的信任材料只作用于代理。
 * ⚠️ `ca` 是**替换**语义（与 Node 的 `ca` 一致）：给了它就不再使用系统根。
 */
export interface ProxyTlsOptions {
  /** 代理跳的 SNI/校验名；缺省 = URL 里的 host。 */
  servername?: string;
  /** 默认 true。false = 明确关闭这一跳的证书校验（仅调试/自签代理）。 */
  rejectUnauthorized?: boolean;
  /** 代理跳的信任锚（替换系统根）。 */
  ca?: PemInput | PemInput[];
  /** 对代理做 mTLS 时使用；必须与 `key` 成对，且应同时给 `ca`。 */
  cert?: PemInput | PemInput[];
  key?: PemInput | PemInput[];
  passphrase?: string;
}

export type ParsedProxy =
  | { kind: 'http'; host: string; port: number; authorization?: string }
  | { kind: 'https'; host: string; port: number; authorization?: string }
  | { kind: 'socks5'; host: string; port: number; username?: string; password?: string }
  | { kind: 'socks4'; host: string; port: number; userId?: string };

/**
 * 把可选的 `proxyTls` 归一成连接参数。
 *
 * cert/key 任一缺失都直接抛：`SecureContext` 只在**两者都有**时才挂客户端证书
 * （`src/tls.ts` 的构造器），单给一个会被静默忽略 —— 那比报错更难查。
 */
export function resolveProxyTls(
  proxy: { kind: 'https'; host: string },
  proxyTls?: ProxyTlsOptions
): { servername: string; rejectUnauthorized: boolean; hasMaterials: boolean } {
  if (!!proxyTls?.cert !== !!proxyTls?.key) {
    throw new Error('proxyTls.cert and proxyTls.key must be provided together');
  }
  return {
    servername: proxyTls?.servername || proxy.host,
    rejectUnauthorized: proxyTls?.rejectUnauthorized !== false,
    hasMaterials: !!(proxyTls?.ca || proxyTls?.cert || proxyTls?.key),
  };
}

interface ParsedAuthority {
  scheme: string;
  host: string;
  port: number;
  userinfo: string;
}

function decodeUserinfo(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseAuthority(proxy: string): ParsedAuthority {
  const raw = proxy.trim();
  if (!raw) throw new Error('Invalid proxy URL: empty');

  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)
    ? raw
    : `http://${raw}`;

  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)/.exec(withScheme);
  if (!match) throw new Error(`Invalid proxy URL: ${proxy}`);

  const scheme = match[1].toLowerCase();
  let authority = match[2] || '';
  let userinfo = '';
  const at = authority.lastIndexOf('@');
  if (at >= 0) {
    userinfo = authority.slice(0, at);
    authority = authority.slice(at + 1);
  }

  let host: string;
  let portText = '';
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']');
    if (end < 0) throw new Error(`Invalid proxy URL: ${proxy}`);
    host = authority.slice(1, end);
    const rest = authority.slice(end + 1);
    if (rest.startsWith(':')) portText = rest.slice(1);
  } else {
    const colon = authority.lastIndexOf(':');
    if (colon >= 0) {
      host = authority.slice(0, colon);
      portText = authority.slice(colon + 1);
    } else {
      host = authority;
    }
  }

  if (!host) throw new Error(`Invalid proxy URL: ${proxy}`);

  const defaultPort = scheme === 'http'
    ? 80
    : scheme === 'https'
      ? 443
      : 1080;
  let port = defaultPort;
  if (portText !== '') {
    if (!/^\d+$/.test(portText)) {
      throw new Error(`Invalid proxy port: ${portText}`);
    }
    port = Number(portText);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`Invalid proxy port: ${portText}`);
    }
  }

  return { scheme, host, port, userinfo };
}

export function parseProxy(proxy: string): ParsedProxy {
  const parsed = parseAuthority(proxy);

  if (parsed.scheme === 'http' || parsed.scheme === 'https') {
    const authorization = parsed.userinfo
      ? `Basic ${Buffer.from(decodeUserinfo(parsed.userinfo)).toString('base64')}`
      : undefined;
    return parsed.scheme === 'https'
      ? { kind: 'https', host: parsed.host, port: parsed.port, ...(authorization ? { authorization } : {}) }
      : { kind: 'http', host: parsed.host, port: parsed.port, ...(authorization ? { authorization } : {}) };
  }

  if (parsed.scheme === 'socks5' || parsed.scheme === 'socks5h') {
    let username: string | undefined;
    let password: string | undefined;
    if (parsed.userinfo) {
      const colon = parsed.userinfo.indexOf(':');
      if (colon >= 0) {
        username = decodeUserinfo(parsed.userinfo.slice(0, colon));
        password = decodeUserinfo(parsed.userinfo.slice(colon + 1));
      } else {
        username = decodeUserinfo(parsed.userinfo);
      }
    }
    const result: ParsedProxy = {
      kind: 'socks5',
      host: parsed.host,
      port: parsed.port,
    };
    if (username !== undefined) result.username = username;
    if (password !== undefined) result.password = password;
    return result;
  }

  if (parsed.scheme === 'socks4' || parsed.scheme === 'socks4a') {
    const result: ParsedProxy = {
      kind: 'socks4',
      host: parsed.host,
      port: parsed.port,
    };
    if (parsed.userinfo) result.userId = decodeUserinfo(parsed.userinfo);
    return result;
  }

  throw new Error(
    `Unsupported proxy scheme: ${parsed.scheme} (supported: http, https, socks5, socks4)`
  );
}

/**
 * 解析 HTTP CONNECT 代理 URL。保留给只支持 HTTP 代理的调用方。
 */
export function parseHttpProxy(proxy: string): ParsedHttpProxy {
  const parsed = parseProxy(proxy);
  if (parsed.kind !== 'http') {
    throw new Error(`Unsupported proxy scheme: ${parsed.kind}`);
  }
  const result: ParsedHttpProxy = { host: parsed.host, port: parsed.port };
  if (parsed.authorization) result.authorization = parsed.authorization;
  return result;
}
