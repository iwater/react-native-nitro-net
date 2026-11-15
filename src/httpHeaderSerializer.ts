type HeaderMap = Record<string, any>;
type HeaderNames = Record<string, string>;

/**
 * impersonate 模式下要叠加的浏览器控制头（设计 §9.1/§9.2）。
 * 值来自 profile；用户值默认被覆盖，`overrideHeaders` 才允许用户覆盖；
 * `accept-encoding` 例外（https.request 保持调用方优先）。
 */
export interface ProfileHeaderPolicy {
  headers: Array<[string, string]>;
  overrideHeaders: boolean;
}

const IMPLICIT_MANAGED = new Set(['host', 'connection', 'content-length', 'transfer-encoding']);

function renderHeader(name: string, value: any): string {
  if (Array.isArray(value)) {
    let out = '';
    for (const item of value) out += `${name}: ${item}\r\n`;
    return out;
  }
  return `${name}: ${value}\r\n`;
}

/**
 * 渲染 HTTP/1.1 头块（不含请求/状态行，也不含结尾空行）。
 *
 * `hostFirst` 只对 ClientRequest 打开：Node 的客户端请求把 Host 放在第一行；
 * ServerResponse 仍按用户插入顺序渲染，避免影响响应头。
 */
export function renderHeaderLines(
  headers: HeaderMap,
  headerNames: HeaderNames,
  implicitLines: string,
  onTransferEncoding?: (value: string) => void,
  hostFirst = false,
  profile?: ProfileHeaderPolicy
): string {
  let out = '';

  if (hostFirst && headers['host'] !== undefined) {
    out += renderHeader(headerNames['host'] || 'Host', headers['host']);
  }

  if (profile) {
    // impersonate：Host → 隐式头（Connection/CL/TE）→ 控制头（profile 顺序）→ 业务头
    out += implicitLines;
    const emitted = new Set<string>(['host']);
    for (const [name, profileValue] of profile.headers) {
      const key = name.toLowerCase();
      if (IMPLICIT_MANAGED.has(key)) continue;
      const userValue = headers[key];
      const useUser = userValue !== undefined && (profile.overrideHeaders || key === 'accept-encoding');
      out += renderHeader(key, useUser ? userValue : profileValue);
      emitted.add(key);
    }
    for (const key in headers) {
      if (emitted.has(key)) continue;
      if (hostFirst && key === 'host') continue;
      const value = headers[key];
      if (key === 'transfer-encoding' && onTransferEncoding) {
        onTransferEncoding(Array.isArray(value) ? value.join('; ') : String(value));
      }
      out += renderHeader(headerNames[key] || key, value);
    }
    return out;
  }

  for (const key in headers) {
    if (hostFirst && key === 'host') continue;
    const value = headers[key];
    if (key === 'transfer-encoding' && onTransferEncoding) {
      onTransferEncoding(Array.isArray(value) ? value.join('; ') : String(value));
    }
    out += renderHeader(headerNames[key] || key, value);
  }

  out += implicitLines;
  return out;
}
