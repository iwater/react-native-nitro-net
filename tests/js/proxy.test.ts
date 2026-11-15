import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHttpProxy, parseProxy, resolveProxyTls } from '../../src/proxy.ts';

test('http proxy 带端口', () => {
  assert.deepEqual(parseHttpProxy('http://127.0.0.1:8080'), {
    host: '127.0.0.1',
    port: 8080,
  });
});

test('默认端口 80，接受裸 host:port', () => {
  assert.deepEqual(parseHttpProxy('http://proxy.local'), {
    host: 'proxy.local',
    port: 80,
  });
  assert.deepEqual(parseHttpProxy('proxy.local:3128'), {
    host: 'proxy.local',
    port: 3128,
  });
});

test('userinfo 转成 Basic Proxy-Authorization', () => {
  assert.deepEqual(parseHttpProxy('http://user:pass@proxy.local:3128'), {
    host: 'proxy.local',
    port: 3128,
    authorization: 'Basic dXNlcjpwYXNz',
  });
});

test('userinfo 支持百分号编码', () => {
  assert.deepEqual(parseHttpProxy('http://u%40x:p%3Ass@proxy.local:8080'), {
    host: 'proxy.local',
    port: 8080,
    authorization: `Basic ${Buffer.from('u@x:p:ss').toString('base64')}`,
  });
});

test('IPv6 literal', () => {
  assert.deepEqual(parseHttpProxy('http://[::1]:8080'), {
    host: '::1',
    port: 8080,
  });
});

test('不支持 https/socks proxy', () => {
  assert.throws(() => parseHttpProxy('https://proxy.local:443'), /Unsupported proxy scheme: https/);
  assert.throws(() => parseHttpProxy('socks5://proxy.local:1080'), /Unsupported proxy scheme: socks5/);
});

test('非法端口报错', () => {
  assert.throws(() => parseHttpProxy('http://proxy.local:0'), /Invalid proxy port/);
  assert.throws(() => parseHttpProxy('http://proxy.local:70000'), /Invalid proxy port/);
  assert.throws(() => parseHttpProxy('http://proxy.local:abc'), /Invalid proxy port/);
});

test('parseProxy: HTTP', () => {
  assert.deepEqual(parseProxy('http://u:p@proxy.local:8080'), {
    kind: 'http',
    host: 'proxy.local',
    port: 8080,
    authorization: `Basic ${Buffer.from('u:p').toString('base64')}`,
  });
});

test('parseProxy: socks5 带认证', () => {
  assert.deepEqual(parseProxy('socks5://user:pass@proxy.local:1080'), {
    kind: 'socks5',
    host: 'proxy.local',
    port: 1080,
    username: 'user',
    password: 'pass',
  });
});

test('parseProxy: socks5h 默认端口 1080', () => {
  assert.deepEqual(parseProxy('socks5h://proxy.local'), {
    kind: 'socks5',
    host: 'proxy.local',
    port: 1080,
  });
});

test('parseProxy: socks4a userid', () => {
  assert.deepEqual(parseProxy('socks4a://user@proxy.local:1080'), {
    kind: 'socks4',
    host: 'proxy.local',
    port: 1080,
    userId: 'user',
  });
});

test('parseProxy: 接受 https 代理（默认端口 443、Basic、kind 区分）', () => {
  assert.deepEqual(parseProxy('https://proxy.local'), {
    kind: 'https',
    host: 'proxy.local',
    port: 443,
  });
  assert.deepEqual(parseProxy('https://user:p%40ss@proxy.local:8443'), {
    kind: 'https',
    host: 'proxy.local',
    port: 8443,
    authorization: `Basic ${Buffer.from('user:p@ss').toString('base64')}`,
  });
  assert.equal(parseProxy('http://proxy.local').kind, 'http');
});

test('parseHttpProxy 仍只接受 http', () => {
  assert.throws(
    () => parseHttpProxy('https://proxy.local'),
    /Unsupported proxy scheme: https/
  );
});

test('resolveProxyTls: 默认值、材料判定与 cert/key 配对校验', () => {
  const p = parseProxy('https://proxy.local') as { kind: 'https'; host: string };
  assert.deepEqual(resolveProxyTls(p), {
    servername: 'proxy.local',
    rejectUnauthorized: true,
    hasMaterials: false,
  });
  assert.deepEqual(resolveProxyTls(p, { servername: 'sni.corp', rejectUnauthorized: false }), {
    servername: 'sni.corp',
    rejectUnauthorized: false,
    hasMaterials: false,
  });
  assert.equal(resolveProxyTls(p, { ca: 'X' }).hasMaterials, true);
  assert.equal(resolveProxyTls(p, { key: 'K', cert: 'C' }).hasMaterials, true);
  assert.throws(
    () => resolveProxyTls(p, { cert: 'C' }),
    /cert.*key|key.*cert/
  );
  assert.throws(
    () => resolveProxyTls(p, { key: 'K' }),
    /cert.*key|key.*cert/
  );
});
