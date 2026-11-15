import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveListenTarget } from '../../src/socketPort.ts';

// 判据来自 node v22 的 `Server.prototype.listen`（`process.binding('natives').net` 里读到的
// normalizeArgs + 三段 fallthrough），逐格实跑对照。
// 这里钉的是闸门本身。

type Input = Parameters<typeof resolveListenTarget>[0];

function target(port: unknown, extra: Partial<Input> = {}): Input {
    // 位置参数形式在 node 的 normalizeArgs 里**总是**产出 `{ port: <首参> }`（哪怕首参是
    // undefined），所以 `hasPort` 默认为真；`{}` 只有对象形式才可能造出来。
    const options = extra.options !== undefined ? extra.options : { port };
    return {
        port,
        path: undefined,
        hasPort: 'port' in (options as object),
        hasPath: 'path' in (options as object),
        omitted: false,
        options,
        ...extra,
    };
}

test('① 缺省输入归到任意端口：listen() / listen(cb) / port 显式 undefined / port null', () => {
    assert.deepEqual(resolveListenTarget(target(undefined, { omitted: true, options: {} })), { port: 0 });
    assert.deepEqual(resolveListenTarget(target(undefined, { omitted: true })), { port: 0 });
    assert.deepEqual(resolveListenTarget(target(undefined)), { port: 0 });
    assert.deepEqual(resolveListenTarget(target(null)), { port: 0 });
    // 位置参数形式的回调：node 把首参写成 options.port，再由 omitted 规则归 0
    assert.deepEqual(resolveListenTarget(target(function cb() {}, { omitted: true })), { port: 0 });
});

test('② 端口范围：node 的前缀是 options.port（connect 用的是 Port）', () => {
    assert.deepEqual(resolveListenTarget(target(0)), { port: 0 });
    assert.deepEqual(resolveListenTarget(target(65535)), { port: 65535 });
    assert.deepEqual(resolveListenTarget(target('0')), { port: 0 });
    assert.deepEqual(resolveListenTarget(target(' 45831 ')), { port: 45831 });
    assert.deepEqual(resolveListenTarget(target('0xB2F7')), { port: 45815 });

    const rejected: Array<[unknown, string]> = [
        [70000, 'options.port should be >= 0 and < 65536. Received type number (70000).'],
        ['70000', "options.port should be >= 0 and < 65536. Received type string ('70000')."],
        [-1, 'options.port should be >= 0 and < 65536. Received type number (-1).'],
        ['-1', "options.port should be >= 0 and < 65536. Received type string ('-1')."],
        [NaN, 'options.port should be >= 0 and < 65536. Received type number (NaN).'],
        [Infinity, 'options.port should be >= 0 and < 65536. Received type number (Infinity).'],
        [80.5, 'options.port should be >= 0 and < 65536. Received type number (80.5).'],
        ['', "options.port should be >= 0 and < 65536. Received type string ('')."],
        ['abc', "options.port should be >= 0 and < 65536. Received type string ('abc')."],
    ];
    for (const [port, message] of rejected) {
        assert.throws(() => resolveListenTarget(target(port)), (err: any) => {
            assert.equal(err.name, 'RangeError');
            assert.equal(err.code, 'ERR_SOCKET_BAD_PORT');
            assert.equal(err.message, message);
            return true;
        }, `port=${String(port)}`);
    }
});

test('③ port 非法但 path 是 pipe 名 ⇒ 走 path 分支（node 的顺序：②之后才看 path）', () => {
    assert.deepEqual(resolveListenTarget(target({}, { path: '/tmp/x.sock', options: { port: {}, path: '/tmp/x.sock' } })), { path: '/tmp/x.sock' });
    // 数字串不是 pipe 名：`'-1'` 与 `'5'` 在 node 那里按端口看，path 分支不收它们
    assert.throws(() => resolveListenTarget({
        port: undefined, path: '5', hasPort: false, hasPath: true, omitted: false, options: { path: '5' },
    }), (err: any) => {
        assert.equal(err.code, 'ERR_INVALID_ARG_VALUE');
        assert.equal(err.message, "The argument 'options' is invalid. Received { path: '5' }");
        return true;
    });
});

test('④ 既没有 port 键也没有 path 键 ⇒ ERR_INVALID_ARG_VALUE（must have the property …）', () => {
    for (const options of [{}, { host: '127.0.0.1' }]) {
        assert.throws(() => resolveListenTarget({
            port: undefined, path: undefined, hasPort: false, hasPath: false, omitted: false, options,
        }), (err: any) => {
            assert.equal(err.name, 'TypeError');
            assert.equal(err.code, 'ERR_INVALID_ARG_VALUE');
            assert.ok(err.message.startsWith(
                'The argument \'options\' must have the property "port" or "path". Received '), err.message);
            return true;
        });
    }
});

test('⑤ 其余非法 port ⇒ ERR_INVALID_ARG_VALUE（is invalid），Received 段与 node 的 inspect 逐字一致', () => {
    const cases: Array<[unknown, string]> = [
        [{}, '{ port: {} }'],
        [[], '{ port: [] }'],
        [true, '{ port: true }'],
        [Symbol('p'), '{ port: Symbol(p) }'],
        [10n, '{ port: 10n }'],
        [new Date(0), '{ port: 1970-01-01T00:00:00.000Z }'],
        [{ nested: [1, 'x'] }, "{ port: { nested: [ 1, 'x' ] } }"],
    ];
    for (const [port, received] of cases) {
        assert.throws(() => resolveListenTarget(target(port)), (err: any) => {
            assert.equal(err.name, 'TypeError');
            assert.equal(err.code, 'ERR_INVALID_ARG_VALUE');
            assert.equal(err.message, `The argument 'options' is invalid. Received ${received}`);
            return true;
        }, `port=${String(port)}`);
    }
    // 具名函数取函数名；匿名函数 node 在属性位上拿到的是键名（引擎的 NamedEvaluation）
    assert.throws(() => resolveListenTarget(target(function namedIt() {})), /Received \{ port: \[Function: namedIt] \}$/);
});

test('Received 段的深度语义：容器展开到 depth 2，越界成 [Object] / [Array]', () => {
    const deep = { port: {}, a: { b: { c: { d: 1 } } } };
    assert.throws(() => resolveListenTarget({
        port: deep.port, path: undefined, hasPort: true, hasPath: false, omitted: false, options: deep,
    }), (err: any) => {
      assert.equal(err.message,
          "The argument 'options' is invalid. Received { port: {}, a: { b: { c: [Object] } } }");
      return true;
    });
});
