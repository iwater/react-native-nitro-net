import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderHeaderLines } from '../../src/httpHeaderSerializer.ts';

test('Host 始终排在第一个，即使对象里最后插入', () => {
  const headers = {
    'x-a': '1',
    host: 'example.com',
    'content-type': 'text/plain',
  };
  const names = {
    'x-a': 'X-A',
    host: 'Host',
    'content-type': 'Content-Type',
  };

  assert.equal(
    renderHeaderLines(headers, names, '', undefined, true),
    'Host: example.com\r\nX-A: 1\r\nContent-Type: text/plain\r\n'
  );
});

test('hostFirst=false 时按插入顺序输出', () => {
  assert.equal(
    renderHeaderLines(
      { 'x-a': '1', host: 'example.com' },
      { 'x-a': 'X-A', host: 'Host' },
      '',
      undefined,
      false
    ),
    'X-A: 1\r\nHost: example.com\r\n'
  );
});

test('数组值逐行输出', () => {
  assert.equal(
    renderHeaderLines(
      { 'set-cookie': ['a=1', 'b=2'] },
      { 'set-cookie': 'Set-Cookie' },
      ''
    ),
    'Set-Cookie: a=1\r\nSet-Cookie: b=2\r\n'
  );
});

test('隐式头追加在用户头之后', () => {
  assert.equal(
    renderHeaderLines(
      { host: 'example.com' },
      { host: 'Host' },
      'Transfer-Encoding: chunked\r\n',
      undefined,
      true
    ),
    'Host: example.com\r\nTransfer-Encoding: chunked\r\n'
  );
});

test('Transfer-Encoding 回调收到拼接后的值', () => {
  let observed = '';
  renderHeaderLines(
    { 'transfer-encoding': ['gzip', 'chunked'] },
    { 'transfer-encoding': 'Transfer-Encoding' },
    '',
    (value) => { observed = value; }
  );
  assert.equal(observed, 'gzip; chunked');
});

test('没有 Host 时不凭空生成', () => {
  assert.equal(
    renderHeaderLines({ 'x-a': '1' }, { 'x-a': 'X-A' }, ''),
    'X-A: 1\r\n'
  );
});

test('保留 headerNames 的原始大小写', () => {
  assert.equal(
    renderHeaderLines(
      { 'x-weird-case': 'v' },
      { 'x-weird-case': 'X-Weird-Case' },
      ''
    ),
    'X-Weird-Case: v\r\n'
  );
});

test('impersonate：Host → 隐式头 → 控制头（profile 顺序）→ 业务头', () => {
  assert.equal(
    renderHeaderLines(
      {
        host: 'example.com',
        'user-agent': 'axios/1.0',
        'x-business': '1',
      },
      { host: 'Host', 'user-agent': 'User-Agent', 'x-business': 'X-Business' },
      'Connection: keep-alive\r\n',
      undefined,
      true,
      {
        headers: [
          ['sec-ch-ua', '"Chrome";v="150"'],
          ['user-agent', 'Mozilla/5.0 Chrome/150'],
        ],
        overrideHeaders: false,
      }
    ),
    'Host: example.com\r\n' +
      'Connection: keep-alive\r\n' +
      'sec-ch-ua: "Chrome";v="150"\r\n' +
      'user-agent: Mozilla/5.0 Chrome/150\r\n' +
      'X-Business: 1\r\n'
  );
});

test('impersonate：accept-encoding 保持调用方优先，其余控制头由 profile 覆盖', () => {
  assert.equal(
    renderHeaderLines(
      { 'accept-encoding': 'identity', 'user-agent': 'tool' },
      { 'accept-encoding': 'Accept-Encoding', 'user-agent': 'User-Agent' },
      '',
      undefined,
      true,
      {
        headers: [
          ['accept-encoding', 'gzip, deflate, br, zstd'],
          ['user-agent', 'Mozilla/5.0 Chrome/150'],
        ],
        overrideHeaders: false,
      }
    ),
    'accept-encoding: identity\r\nuser-agent: Mozilla/5.0 Chrome/150\r\n'
  );
});

test('impersonate：overrideHeaders=true 时用户值覆盖控制头；隐式管理的头不进 profile 段', () => {
  assert.equal(
    renderHeaderLines(
      { 'user-agent': 'tool' },
      { 'user-agent': 'User-Agent' },
      '',
      undefined,
      true,
      {
        headers: [
          ['connection', 'keep-alive'],
          ['user-agent', 'Mozilla/5.0 Chrome/150'],
        ],
        overrideHeaders: true,
      }
    ),
    'user-agent: tool\r\n'
  );
});
