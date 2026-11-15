import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import {
  defaultSettings,
  packSettings,
  unpackSettings,
} from '../../src/http2Settings.ts';

// 期望值全部来自 node v22.12 实测（`require('http2').getPackedSettings/...` 逐型跑），
// 不是文档。有意偏差（node 返回 undefined 的两处）在文件末尾单独测，并登记在
// docs/m5_http2_module_plan.md。

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

test('默认 SETTINGS 与 node 逐项一致，且每次返回新对象', () => {
  const expected = {
    headerTableSize: 4096,
    enablePush: true,
    initialWindowSize: 65535,
    maxFrameSize: 16384,
    maxConcurrentStreams: 4294967295,
    maxHeaderSize: 65535,
    maxHeaderListSize: 65535,
    enableConnectProtocol: false,
  };
  assert.deepEqual(defaultSettings(), expected);
  assert.notEqual(defaultSettings(), defaultSettings());
});

test('打包：空对象 0 字节，未知键忽略', () => {
  assert.equal(packSettings({}).length, 0);
  assert.equal(packSettings({ foo: 1 } as any).length, 0);
  assert.equal(packSettings(undefined).length, 0);
});

test('打包：字节与 node 实测逐字节相同', () => {
  assert.equal(
    hex(packSettings({ maxConcurrentStreams: 100, initialWindowSize: 1048576 })),
    '000300000064000400100000'
  );
  // 全部具名项 + 布尔 + custom：顺序按 id，custom 在最后（node 实测）
  assert.equal(
    hex(
      packSettings({
        enableConnectProtocol: true,
        customSettings: { 255: 1 },
        maxFrameSize: 16384,
        enablePush: false,
        maxConcurrentStreams: 5,
        headerTableSize: 1,
        initialWindowSize: 2,
        maxHeaderListSize: 3,
      })
    ),
    '00010000000100020000000000030000000500040000000200050000400000060000000300080000000100ff00000001'
  );
  // custom 的两个 id 按升序（与插入顺序无关）
  assert.equal(
    hex(packSettings({ customSettings: { 300: 1, 250: 2 } })),
    '00fa00000002012c00000001'
  );
});

test('打包：maxHeaderSize 与 maxHeaderListSize 落到同一个 id，前者胜', () => {
  assert.equal(hex(packSettings({ maxHeaderListSize: 100 })), '000600000064');
  assert.equal(hex(packSettings({ maxHeaderSize: 77 })), '00060000004d');
  assert.equal(
    hex(packSettings({ maxHeaderSize: 100, maxHeaderListSize: 200 })),
    '000600000064'
  );
});

test('打包：u32 边界与 maxFrameSize 区间（node 实测）', () => {
  assert.equal(hex(packSettings({ headerTableSize: 4294967295 })), '0001ffffffff');
  assert.equal(hex(packSettings({ maxConcurrentStreams: 2147483648 })), '000380000000');
  assert.equal(hex(packSettings({ maxFrameSize: 16384 })), '000500004000');
  assert.equal(hex(packSettings({ maxFrameSize: 16777215 })), '000500ffffff');
  assert.equal(hex(packSettings({ initialWindowSize: 2147483647 })), '00047fffffff');

  for (const bad of [
    { headerTableSize: -1 },
    { headerTableSize: 4294967296 },
    { maxFrameSize: 16383 },
    { maxFrameSize: 16777216 },
    { initialWindowSize: -1 },
  ]) {
    assert.throws(
      () => packSettings(bad as any),
      (e: any) =>
        e.code === 'ERR_HTTP2_INVALID_SETTING_VALUE' &&
        /^Invalid value for setting "/.test(e.message),
      JSON.stringify(bad)
    );
  }
});

test('打包：两个布尔项只收 boolean（node 实测 0/1 也抛）', () => {
  assert.equal(hex(packSettings({ enablePush: false })), '000200000000');
  assert.equal(hex(packSettings({ enablePush: true })), '000200000001');
  for (const bad of [{ enablePush: 1 }, { enablePush: 2 }, { enableConnectProtocol: 'true' }]) {
    assert.throws(() => packSettings(bad as any), (e: any) => e.code === 'ERR_HTTP2_INVALID_SETTING_VALUE');
  }
});

test('打包：settings 必须是对象（node 的 Received 文案）', () => {
  for (const [value, received] of [
    [null, 'null'],
    ['x', "type string ('x')"],
    [[], 'an instance of Array'],
  ] as const) {
    assert.throws(
      () => packSettings(value as any),
      (e: any) =>
        e.code === 'ERR_INVALID_ARG_TYPE' &&
        e.message === `The "settings" argument must be of type object. Received ${received}`
    );
  }
});

test('解包：只返回出现的项；未知 id 进 customSettings', () => {
  assert.deepEqual(unpackSettings(Buffer.from('000300000064', 'hex')), {
    maxConcurrentStreams: 100,
  });
  assert.deepEqual(unpackSettings(Buffer.from('00ff00000001', 'hex')), {
    customSettings: { 255: 1 },
  });
  assert.deepEqual(unpackSettings(Buffer.from('000200000000', 'hex')), { enablePush: false });
  assert.deepEqual(unpackSettings(Buffer.from('000800000002', 'hex')), {
    enableConnectProtocol: true,
  });
  assert.deepEqual(
    unpackSettings(Buffer.from('000300000001000300000002', 'hex')),
    { maxConcurrentStreams: 2 },
    '重复 id 后者胜'
  );
  assert.deepEqual(unpackSettings(Buffer.from('000600000064', 'hex')), {
    maxHeaderSize: 100,
    maxHeaderListSize: 100,
  });
});

test('解包：长度必须 6 的倍数；只收 Buffer/TypedArray', () => {
  assert.throws(
    () => unpackSettings(Buffer.from('0003', 'hex')),
    (e: any) =>
      e.code === 'ERR_HTTP2_INVALID_PACKED_SETTINGS_LENGTH' &&
      e.message === 'Packed settings length must be a multiple of six'
  );
  assert.throws(
    () => unpackSettings('abcd' as any),
    (e: any) =>
      e.code === 'ERR_INVALID_ARG_TYPE' &&
      e.message ===
        'The "buf" argument must be an instance of Buffer or TypedArray. Received type string (\'abcd\')'
  );
});

test('解包：validate 选项按打包规则复核', () => {
  // maxFrameSize = 16383（低于下限）
  const bad = Buffer.from('000500003fff', 'hex');
  assert.deepEqual(unpackSettings(bad), { maxFrameSize: 16383 });
  assert.throws(
    () => unpackSettings(bad, { validate: true }),
    (e: any) => e.code === 'ERR_HTTP2_INVALID_SETTING_VALUE'
  );
});

test('往返：pack → unpack 保留全部具名项与 custom', () => {
  const original = {
    headerTableSize: 8192,
    enablePush: false,
    maxConcurrentStreams: 200,
    initialWindowSize: 1048576,
    maxFrameSize: 32768,
    maxHeaderListSize: 65536,
    enableConnectProtocol: true,
    customSettings: { 250: 1, 300: 2 },
  };
  assert.deepEqual(unpackSettings(packSettings(original)), {
    ...original,
    maxHeaderSize: 65536,
  });
});

test('有意偏差：node 返回 undefined 的两处在这里是确定的', () => {
  // node 实测：initialWindowSize > 0x7fffffff ⇒ getPackedSettings() 返回 undefined
  assert.throws(
    () => packSettings({ initialWindowSize: 2147483648 }),
    (e: any) => e.code === 'ERR_HTTP2_INVALID_SETTING_VALUE'
  );
  // node 实测：customSettings 写具名 id（< 8）⇒ 返回 undefined；这里写进具名槽。
  assert.equal(hex(packSettings({ customSettings: { 3: 7 } })), '000300000007');
  // node 实测：NaN 静默打成 0；这里拒绝。
  assert.throws(
    () => packSettings({ initialWindowSize: NaN }),
    (e: any) => e.code === 'ERR_HTTP2_INVALID_SETTING_VALUE'
  );
});
