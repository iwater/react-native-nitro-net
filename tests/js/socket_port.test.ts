import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertConnectTarget, normalizeSocketPort } from '../../src/socketPort.ts';

// 判据全部来自 node v24 实跑（`net.connect({port:P, host:'127.0.0.1'})`，见 socketPort.ts 顶部）：
// 这里不是「挑一个看着合理的规则」，而是逐条对齐 node 的接受/拒绝集与错误文案。

test('数字端口原样返回', () => {
  assert.equal(normalizeSocketPort(443), 443);
  assert.equal(normalizeSocketPort(0), 0);
});

test('字符串端口归一为数字（node-fetch / url.parse 交出来的正是字符串）', () => {
  assert.equal(normalizeSocketPort('52061'), 52061);
  assert.equal(normalizeSocketPort(' 443 '), 443);
  assert.equal(normalizeSocketPort('443.0'), 443);
  assert.equal(normalizeSocketPort('0x10'), 16); // node 也接受（Number() 语义）
  assert.equal(normalizeSocketPort('1e3'), 1000);
  assert.equal(normalizeSocketPort('+443'), 443);
  assert.equal(normalizeSocketPort('0'), 0);
});

test('非法端口抛 ERR_SOCKET_BAD_PORT，文案与 node 逐字一致', () => {
  const cases: Array<[unknown, string]> = [
    ['', "Port should be >= 0 and < 65536. Received type string ('')."],
    ['443abc', "Port should be >= 0 and < 65536. Received type string ('443abc')."],
    ['4_4', "Port should be >= 0 and < 65536. Received type string ('4_4')."],
    ['８０', "Port should be >= 0 and < 65536. Received type string ('８０')."],
    ['70000', 'Port should be >= 0 and < 65536. Received type string (\'70000\').'],
    [-1, 'Port should be >= 0 and < 65536. Received type number (-1).'],
    [70000, 'Port should be >= 0 and < 65536. Received type number (70000).'],
    [65535.5, 'Port should be >= 0 and < 65536. Received type number (65535.5).'],
  ];
  for (const [port, message] of cases) {
    assert.throws(() => normalizeSocketPort(port), (err: any) => {
      assert.ok(err instanceof RangeError, `RangeError: ${String(err)}`);
      assert.equal(err.code, 'ERR_SOCKET_BAD_PORT');
      assert.equal(err.message, message);
      return true;
    }, `port=${JSON.stringify(port)}`);
  }
});

test('上限边界：65535 收、65536 抛（node 的判据是 < 65536）', () => {
  assert.equal(normalizeSocketPort(65535), 65535);
  assert.throws(() => normalizeSocketPort(65536), RangeError);
});

test('undefined / null 归 0 —— 只在**内部**路径，公开入口由闸门拦下', () => {
  // 本包内部（Unix socket 分支、代理隧道、已建连的 handle）会带着「没有端口」走到这里，
  // 照抄抛出会把正常路径变成崩溃 ⇒ 归 0。node 的 `net.connect({host})` / `port:null`
  // 那两个抛出改由公开入口的 `assertConnectTarget` 负责，见下面的闸门用例。
  assert.equal(normalizeSocketPort(undefined), 0);
  assert.equal(normalizeSocketPort(null), 0);
});

// ---------------------------------------------------------------------------
// assertConnectTarget —— 公开入口的闸门。node v24 实测 net.connect 与 tls.connect
// 在这一层是同一套规则，且**裸值**（true / Symbol / 函数）报的也是 "options.port"。
// ---------------------------------------------------------------------------

type Expectation = [unknown, string, string, string];

const rejected: Expectation[] = [
  [undefined, 'TypeError', 'ERR_MISSING_ARGS',
    'The "options" or "port" or "path" argument must be specified'],
  [null, 'TypeError', 'ERR_INVALID_ARG_TYPE',
    'The "options.port" property must be one of type number or string. Received null'],
  [true, 'TypeError', 'ERR_INVALID_ARG_TYPE',
    'The "options.port" property must be one of type number or string. Received type boolean (true)'],
  [false, 'TypeError', 'ERR_INVALID_ARG_TYPE',
    'The "options.port" property must be one of type number or string. Received type boolean (false)'],
  [Symbol('s'), 'TypeError', 'ERR_INVALID_ARG_TYPE',
    'The "options.port" property must be one of type number or string. Received type symbol (Symbol(s))'],
  [10n, 'TypeError', 'ERR_INVALID_ARG_TYPE',
    'The "options.port" property must be one of type number or string. Received type bigint (10n)'],
  // 匿名函数：node 的文案以空格结尾（函数名是空串）。
  [function () {}, 'TypeError', 'ERR_INVALID_ARG_TYPE',
    'The "options.port" property must be one of type number or string. Received function '],
  [['a'], 'TypeError', 'ERR_MISSING_ARGS',
    'The "options" or "port" or "path" argument must be specified'],
  [{}, 'TypeError', 'ERR_MISSING_ARGS',
    'The "options" or "port" or "path" argument must be specified'],
  [{ host: '127.0.0.1' }, 'TypeError', 'ERR_MISSING_ARGS',
    'The "options" or "port" or "path" argument must be specified'],
  [{ port: undefined, host: '127.0.0.1' }, 'TypeError', 'ERR_MISSING_ARGS',
    'The "options" or "port" or "path" argument must be specified'],
  [{ port: null }, 'TypeError', 'ERR_INVALID_ARG_TYPE',
    'The "options.port" property must be one of type number or string. Received null'],
  [{ port: true }, 'TypeError', 'ERR_INVALID_ARG_TYPE',
    'The "options.port" property must be one of type number or string. Received type boolean (true)'],
  [{ port: [] }, 'TypeError', 'ERR_INVALID_ARG_TYPE',
    'The "options.port" property must be one of type number or string. Received an instance of Array'],
  [{ port: {} }, 'TypeError', 'ERR_INVALID_ARG_TYPE',
    'The "options.port" property must be one of type number or string. Received an instance of Object'],
  [{ port: new Date() }, 'TypeError', 'ERR_INVALID_ARG_TYPE',
    'The "options.port" property must be one of type number or string. Received an instance of Date'],
];

test('闸门：node 拒绝的入参逐个拒绝，name/code/消息逐字一致', () => {
  for (const [value, name, code, message] of rejected) {
    assert.throws(() => assertConnectTarget(value), (err: any) => {
      assert.equal(err.name, name);
      assert.equal(err.code, code);
      assert.equal(err.message, message);
      return true;
    }, `value=${typeof value === 'symbol' ? 'Symbol(s)' : String(value)}`);
  }
});

test('闸门：node 放行的入参不抛（数字/字符串端口、Unix 路径、以及交给范围校验的值）', () => {
  assert.doesNotThrow(() => assertConnectTarget(443));
  assert.doesNotThrow(() => assertConnectTarget('/tmp/x.sock'));
  assert.doesNotThrow(() => assertConnectTarget({ port: 443 }));
  assert.doesNotThrow(() => assertConnectTarget({ port: '443' }));
  assert.doesNotThrow(() => assertConnectTarget({ path: '/tmp/x.sock' }));
  // 这两个在这一层放行，随后由 normalizeSocketPort 抛 ERR_SOCKET_BAD_PORT（与 node 同）
  assert.doesNotThrow(() => assertConnectTarget({ port: 'abc' }));
  assert.doesNotThrow(() => assertConnectTarget({ port: 70000 }));
});

test('范围校验文案覆盖 NaN / Infinity（node 也是 ERR_SOCKET_BAD_PORT）', () => {
  for (const port of [NaN, Infinity]) {
    assert.throws(() => normalizeSocketPort(port), (err: any) => {
      assert.equal(err.code, 'ERR_SOCKET_BAD_PORT');
      assert.equal(err.message, `Port should be >= 0 and < 65536. Received type number (${port}).`);
      return true;
    });
  }
});
