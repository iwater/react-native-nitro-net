import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeZlib from 'node:zlib';
import {
  setZlibProvider,
  decodeContentEncoding,
  supportedEncodings,
  type ZlibProvider,
} from '../../src/contentDecoder.ts';

const encode = (value: string) => new TextEncoder().encode(value);
const decode = (value: Uint8Array) => new TextDecoder().decode(value);

function withProvider<T>(fn: () => T): T {
  setZlibProvider(nodeZlib as unknown as ZlibProvider);
  try {
    return fn();
  } finally {
    setZlibProvider(null);
  }
}

test('gzip', () => {
  withProvider(() => {
    const compressed = nodeZlib.gzipSync(encode('hello'));
    assert.equal(decode(decodeContentEncoding(compressed, 'gzip')), 'hello');
    assert.equal(decode(decodeContentEncoding(compressed, 'GZip')), 'hello');
    assert.equal(decode(decodeContentEncoding(compressed, 'x-gzip')), 'hello');
  });
});

test('deflate', () => {
  withProvider(() => {
    const compressed = nodeZlib.deflateSync(encode('hello'));
    assert.equal(decode(decodeContentEncoding(compressed, 'deflate')), 'hello');
  });
});

test('br', () => {
  withProvider(() => {
    const compressed = nodeZlib.brotliCompressSync(encode('hello'));
    assert.equal(decode(decodeContentEncoding(compressed, 'br')), 'hello');
  });
});

test('多个 content-encoding 按逆序解码', () => {
  withProvider(() => {
    const compressed = nodeZlib.brotliCompressSync(nodeZlib.gzipSync(encode('hello')));
    assert.equal(decode(decodeContentEncoding(compressed, 'gzip, br')), 'hello');
  });
});

test('identity 原样返回', () => {
  withProvider(() => {
    const input = encode('plain');
    assert.equal(decode(decodeContentEncoding(input, 'identity')), 'plain');
    assert.equal(decode(decodeContentEncoding(input, '')), 'plain');
  });
});

test('没有 provider 时对压缩体明确报错（不再静默返回压缩字节）', () => {
  setZlibProvider(null);
  const input = encode('raw');
  assert.throws(
    () => decodeContentEncoding(input, 'gzip'),
    (err: any) => err.code === 'ERR_ZLIB_PROVIDER_MISSING'
      && /no zlib provider is installed/.test(err.message),
  );
  // identity/空 编码不需要 provider：未接线 zlib 的宿主不能被这个改动炸掉。
  assert.deepEqual(decodeContentEncoding(input, 'identity'), input);
  assert.deepEqual(decodeContentEncoding(input, ''), input);
  assert.deepEqual(decodeContentEncoding(input, undefined), input);
});

test('未知 content-encoding 明确报错', () => {
  withProvider(() => {
    assert.throws(
      () => decodeContentEncoding(encode('x'), 'compress'),
      /Unsupported content-encoding: compress/
    );
  });
});

test('zstd 通过 fzstd fallback 解码（provider 没有 zstd 时）', () => {
  withProvider(() => {
    const compressed = Buffer.from('KLUv/QRYUQAAaGVsbG8tenN0ZGaH008=', 'base64');
    assert.equal(decode(decodeContentEncoding(compressed, 'zstd')), 'hello-zstd');
  });
});

test('provider 缺某个能力时报错指向缺失的函数，不是 not a function', () => {
  setZlibProvider({
    gunzipSync: nodeZlib.gunzipSync,
    inflateSync: nodeZlib.inflateSync,
  } as unknown as ZlibProvider);
  try {
    assert.throws(
      () => decodeContentEncoding(nodeZlib.brotliCompressSync(encode('hello')), 'br'),
      (err: any) => err.code === 'ERR_ZLIB_PROVIDER_INCOMPLETE'
        && /has no brotliDecompressSync/.test(err.message),
    );
  } finally {
    setZlibProvider(null);
  }
});

test('accept-encoding 按 provider 能力声明（不承诺解不了的东西）', () => {
  assert.deepEqual(supportedEncodings(null), []);
  assert.deepEqual(
    supportedEncodings({
      gunzipSync: nodeZlib.gunzipSync,
      inflateSync: nodeZlib.inflateSync,
    } as unknown as ZlibProvider),
    ['gzip', 'deflate', 'zstd']
  );
  assert.deepEqual(
    supportedEncodings(nodeZlib as unknown as ZlibProvider),
    ['gzip', 'deflate', 'br', 'zstd']
  );
});
