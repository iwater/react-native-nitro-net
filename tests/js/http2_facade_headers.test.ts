import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareFacadeHeaders } from '../../src/http2Headers.ts';

// node v22.12 实测（见 docs/m5_http2_module_plan.md §2）：
//  · 名字大小写不敏感；默认 method=GET、path=/、scheme=https、authority=连接目标；
//  · connection/keep-alive/proxy-connection/transfer-encoding/upgrade 禁；
//  · te 只允许 trailers；host 走 :authority；expect 是普通头；
//  · 伪头只收 method/scheme/authority/path，且只允许单值。
// 有意更严（已登记）：空名字 / CRLF 值在 node 里会发出去，这里直接拒绝。

const defaults = { authority: 'example.test:8443' };

test('默认伪头来自连接目标', () => {
  assert.deepEqual(prepareFacadeHeaders({}, defaults), {
    method: 'GET',
    scheme: 'https',
    authority: 'example.test:8443',
    path: '/',
    headers: [],
  });
});

test('用户伪头覆盖 + 名字小写 + 值字符串化', () => {
  assert.deepEqual(
    prepareFacadeHeaders(
      {
        ':method': 'POST',
        ':path': '/x?y=1',
        ':scheme': 'https',
        ':authority': 'a.test',
        'X-N': 1,
        'X-B': true,
        'X-Arr': ['1', '2'],
      },
      defaults
    ),
    {
      method: 'POST',
      scheme: 'https',
      authority: 'a.test',
      path: '/x?y=1',
      headers: [
        ['x-n', '1'],
        ['x-b', 'true'],
        ['x-arr', '1'],
        ['x-arr', '2'],
      ],
    }
  );
});

test('host 头映射为 :authority（显式 :authority 胜）', () => {
  const mapped = prepareFacadeHeaders({ host: 'h.test' }, defaults);
  assert.equal(mapped.authority, 'h.test');
  assert.deepEqual(mapped.headers, []);
  assert.equal(
    prepareFacadeHeaders({ host: 'h.test', ':authority': 'a.test' }, defaults).authority,
    'a.test'
  );
});

test('te 只放行 trailers（大小写不敏感），expect 是普通头', () => {
  assert.deepEqual(prepareFacadeHeaders({ te: 'trailers' }, defaults).headers, [
    ['te', 'trailers'],
  ]);
  assert.throws(
    () => prepareFacadeHeaders({ te: 'gzip' }, defaults),
    (e: any) =>
      e.code === 'ERR_HTTP2_INVALID_CONNECTION_HEADERS' &&
      e.message === 'HTTP/1 Connection specific headers are forbidden: "te"'
  );
  assert.deepEqual(prepareFacadeHeaders({ expect: '100-continue' }, defaults).headers, [
    ['expect', '100-continue'],
  ]);
});

test('连接级头一律拒绝（名字大小写不敏感）', () => {
  for (const name of [
    'connection',
    'Connection',
    'keep-alive',
    'proxy-connection',
    'transfer-encoding',
    'upgrade',
  ]) {
    assert.throws(
      () => prepareFacadeHeaders({ [name]: 'x' }, defaults),
      (e: any) =>
        e.code === 'ERR_HTTP2_INVALID_CONNECTION_HEADERS' &&
        e.message ===
          `HTTP/1 Connection specific headers are forbidden: "${name.toLowerCase()}"`,
      name
    );
  }
});

test('伪头：只认四个、只允许单值', () => {
  assert.throws(
    () => prepareFacadeHeaders({ ':foo': '1' }, defaults),
    (e: any) =>
      e.code === 'ERR_HTTP2_INVALID_PSEUDOHEADER' &&
      e.message === '":foo" is an invalid pseudoheader or is used incorrectly'
  );
  assert.throws(
    () => prepareFacadeHeaders({ ':status': 200 }, defaults),
    (e: any) => e.code === 'ERR_HTTP2_INVALID_PSEUDOHEADER'
  );
  assert.throws(
    () => prepareFacadeHeaders({ ':path': ['/a', '/b'] }, defaults),
    (e: any) =>
      e.code === 'ERR_HTTP2_HEADER_SINGLE_VALUE' &&
      e.message === 'Header field ":path" must only have a single value'
  );
  assert.deepEqual(prepareFacadeHeaders({ ':path': ['/only'] }, defaults).path, '/only');
});

test('非法名字 / CRLF 值：本地拒绝（比 node 更严，已登记）', () => {
  assert.throws(
    () => prepareFacadeHeaders({ 'x y': '1' }, defaults),
    (e: any) =>
      e.code === 'ERR_INVALID_HTTP_TOKEN' &&
      e.message === 'Header name must be a valid HTTP token ["x y"]'
  );
  assert.throws(
    () => prepareFacadeHeaders({ '': '1' }, defaults),
    (e: any) => e.code === 'ERR_INVALID_HTTP_TOKEN'
  );
  assert.throws(
    () => prepareFacadeHeaders({ 'x-a': 'a\r\nb' }, defaults),
    (e: any) => e.code === 'ERR_HTTP2_INVALID_HEADER_VALUE'
  );
});

test('headers 必须是对象（node 的 Received 文案）', () => {
  assert.throws(
    () => prepareFacadeHeaders(null, defaults),
    (e: any) =>
      e.code === 'ERR_INVALID_ARG_TYPE' &&
      e.message === 'The "headers" argument must be of type object. Received null'
  );
  assert.throws(
    () => prepareFacadeHeaders([], defaults),
    (e: any) => e.code === 'ERR_INVALID_ARG_TYPE'
  );
  assert.throws(
    () => prepareFacadeHeaders('x', defaults),
    (e: any) =>
      e.code === 'ERR_INVALID_ARG_TYPE' &&
      e.message === "The \"headers\" argument must be of type object. Received type string ('x')"
  );
});
