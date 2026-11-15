import { test } from 'node:test';
import assert from 'node:assert/strict';
// 与 `src/fetchBody.ts` 用**同一个**说明符（#51 方案 A：库侧统一 core 名 `stream`），
// 否则这里的 `instanceof Readable` 判的是另一个家族，测试会假绿。
import { Readable } from 'stream';
import { FetchBody } from '../../src/fetchBody.ts';

function streamOf(...chunks: string[]): Readable {
  let index = 0;
  return new Readable({
    read() {
      if (index < chunks.length) {
        this.push(Buffer.from(chunks[index++]));
      } else {
        this.push(null);
      }
    },
  });
}

test('text() 读取流并拼接，首次读取后 bodyUsed 为 true', async () => {
  const body = new FetchBody(streamOf('he', 'llo'));
  assert.equal(body.bodyUsed, false);
  assert.equal(await body.text(), 'hello');
  assert.equal(body.bodyUsed, true);
});

test('Uint8Array 直接作为 body 源', async () => {
  const body = new FetchBody(new Uint8Array([104, 105]));
  assert.equal(await body.text(), 'hi');
});

test('json() 从流式 body 解析', async () => {
  const body = new FetchBody(streamOf('{"a":', '1}'));
  assert.deepEqual(await body.json(), { a: 1 });
});

test('第二次读取抛 TypeError', async () => {
  const body = new FetchBody(streamOf('x'));
  await body.text();
  await assert.rejects(() => body.text(), TypeError);
});

test('clone 后两个 body 都能读取同一份内容', async () => {
  const body = new FetchBody(streamOf('he', 'llo'));
  const clone = body.clone();
  assert.equal(await clone.text(), 'hello');
  assert.equal(await body.text(), 'hello');
});

test('流错误传播到 text()', async () => {
  const body = new FetchBody(new Readable({
    read() {
      this.destroy(new Error('boom'));
    },
  }));
  await assert.rejects(() => body.text(), /boom/);
});

test('destroy() 使进行中的读取拒绝', async () => {
  const body = new FetchBody(streamOf('a', 'b'));
  const pending = body.text();
  body.destroy(new Error('aborted'));
  await assert.rejects(pending, /aborted/);
});

test('blob() 使用传入的 mimeType', async () => {
  const body = new FetchBody(streamOf('hi'));
  const blob = await body.blob('text/plain');
  assert.equal(blob.type, 'text/plain');
});

test('decoder 只执行一次并被 clone 共享', async () => {
  let calls = 0;
  const body = new FetchBody(streamOf('x'), undefined, (bytes: Uint8Array) => {
    calls++;
    const out = new Uint8Array(bytes.length + 1);
    out.set(bytes);
    out[bytes.length] = 33;
    return out;
  });
  const clone = body.clone();
  assert.equal(await clone.text(), 'x!');
  assert.equal(await body.text(), 'x!');
  assert.equal(calls, 1);
});

test('空 body 不调用 decoder（HEAD/204 带 content-encoding 时也不会误解码）', async () => {
  let calls = 0;
  const body = new FetchBody(new Uint8Array(0), undefined, (bytes: Uint8Array) => {
    calls++;
    return bytes;
  });
  assert.equal(await body.text(), '');
  assert.equal(calls, 0);
});
