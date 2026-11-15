import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePem, toBinaryArrayBuffer } from '../../src/pem.ts';

const PEM = '-----BEGIN CERTIFICATE-----\nAA==\n-----END CERTIFICATE-----\n';

test('normalizePem 接受 string / Buffer / TypedArray / ArrayBuffer', () => {
  assert.equal(normalizePem(PEM), PEM);
  assert.equal(normalizePem(Buffer.from(PEM)), PEM);
  assert.equal(normalizePem(new Uint8Array(Buffer.from(PEM))), PEM);
  assert.equal(normalizePem(new TextEncoder().encode(PEM).buffer), PEM);
});

test('normalizePem 对非法类型抛出明确错误', () => {
  assert.throws(
    () => normalizePem(123 as any, 'cert'),
    /cert must be a string, Buffer, TypedArray, or ArrayBuffer/
  );
});

test('toBinaryArrayBuffer 保留原始字节', () => {
  const bytes = [1, 2, 3, 255];
  assert.deepEqual(
    [...new Uint8Array(toBinaryArrayBuffer('abc'))],
    [...Buffer.from('abc')]
  );
  assert.deepEqual(
    [...new Uint8Array(toBinaryArrayBuffer(Buffer.from(bytes)))],
    bytes
  );

  const arrayBuffer = new Uint8Array(bytes).buffer;
  assert.equal(toBinaryArrayBuffer(arrayBuffer), arrayBuffer);
});

test('toBinaryArrayBuffer 对非法类型抛出明确错误', () => {
  assert.throws(
    () => toBinaryArrayBuffer(123 as any),
    /PFX must be a string, Buffer, TypedArray, or ArrayBuffer/
  );
});
