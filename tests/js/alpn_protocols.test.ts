import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { convertALPNProtocols } from '../../src/alpnProtocols.ts';

// #84 的 JS 侧闸门。期望值全部来自 node v22.11 实测
// （`tls.createServer({ALPNProtocols}).ALPNProtocols` 逐型跑一遍），不是文档：
//   · `['http/1.1']` ⇒ `<Buffer 08 http/1.1>`（每项 1 字节长度 + 内容）
//   · 整个选项给 Uint8Array/Buffer ⇒ **复制**后原样使用
//   · 给字符串/数字 ⇒ node **完全忽略**（属性为 undefined、协商为 false）
//   · `[Buffer]` ⇒ 到 write 那步才抛 `argument must be a string`
//   · `[123]/[null]/[[]]/[{}]` ⇒ Buffer.byteLength 那步抛 ERR_INVALID_ARG_TYPE（文案含 Received …）
//   · 单项 >255 字节 ⇒ ERR_OUT_OF_RANGE，带下标与字节数
// ⚠️ 第 11 格是**两趟顺序**的判据：300 字节的 Buffer 项先过长度趟（OUT_OF_RANGE），
//    不会走到「必须是字符串」那一趟。合并成单趟就会报成后者。

const wire = (bytes: number[]) => Array.from(Buffer.from(bytes));

test('数组 → node 的线缆形态', () => {
  assert.deepEqual(
      Array.from(convertALPNProtocols(['http/1.1']) as any),
      [8, ...'http/1.1'.split('').map((c) => c.charCodeAt(0))]);
  assert.deepEqual(
      Array.from(convertALPNProtocols(['h2', 'http/1.1']) as any),
      [2, 104, 50, 8, 104, 116, 116, 112, 47, 49, 46, 49]);
});

test('空数组仍是 Buffer（node 实测属性 = 空 Buffer，不是 undefined）', () => {
  const out = convertALPNProtocols([]);
  assert.ok(out, '空数组不该退化成 undefined');
  assert.equal(out!.length, 0);
});

test('整个选项给 Buffer/Uint8Array ⇒ 复制后原样使用', () => {
  const src = Buffer.from([2, 104, 50]);
  const out = convertALPNProtocols(src) as Buffer;
  assert.deepEqual(Array.from(out), [2, 104, 50]);
  src[0] = 9; // node 注释就是「Copy new buffer not to be modified」
  assert.deepEqual(Array.from(out), [2, 104, 50]);
});

test('给字符串/数字 ⇒ 与 node 一样整个忽略（undefined ⇒ 不落原生）', () => {
  assert.equal(convertALPNProtocols('h2'), undefined);
  assert.equal(convertALPNProtocols(123 as any), undefined);
});

test('数组里的 Buffer 项 ⇒ 到写入那步才报 argument must be a string', () => {
  assert.throws(
      () => convertALPNProtocols([Buffer.from('h2')]),
      (e: any) => e.code === 'ERR_INVALID_ARG_TYPE' && e.message === 'argument must be a string');
});

test('数组里的非字符串非二进制项 ⇒ Buffer.byteLength 的文案', () => {
  assert.throws(
      () => convertALPNProtocols([123]),
      (e: any) => e.code === 'ERR_INVALID_ARG_TYPE' &&
          e.message === 'The "string" argument must be of type string or an instance of ' +
              'Buffer or ArrayBuffer. Received type number (123)');
  assert.throws(
      () => convertALPNProtocols([null]),
      (e: any) => e.message.endsWith('Received null'));
  assert.throws(
      () => convertALPNProtocols([['h2']]),
      (e: any) => e.message.endsWith('Received an instance of Array'));
  assert.throws(
      () => convertALPNProtocols([{ a: 1 }]),
      (e: any) => e.message.endsWith('Received an instance of Object'));
});

test('单项超过 255 字节 ⇒ ERR_OUT_OF_RANGE，带下标与字节数', () => {
  assert.throws(
      () => convertALPNProtocols(['x'.repeat(256)]),
      (e: any) => e.code === 'ERR_OUT_OF_RANGE' &&
          e.message === 'The byte length of the protocol at index 0 exceeds the maximum length. ' +
              'It must be <= 255. Received 256');
  assert.throws(
      () => convertALPNProtocols(['h2', 'y'.repeat(300)]),
      (e: any) => e.message.includes('at index 1') && e.message.endsWith('Received 300'));
});

test('300 字节的 Buffer 项报的是长度错，不是类型错（两趟顺序的判据）', () => {
  assert.throws(
      () => convertALPNProtocols([Buffer.alloc(300)]),
      (e: any) => e.code === 'ERR_OUT_OF_RANGE',
      '长度趟必须先于写入趟');
});
