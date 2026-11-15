import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextTick, __setNextTickHostForTest } from '../../src/nextTick.ts';

// RN 的 `process` 只注入 `env`（没有 nextTick）；T4 设备页实测在 tls.ts 的
// secureConnect 延迟上崩过一次。这里钉住两条路径：宿主原样走 nextTick；
// 模拟 RN 形态时退回微任务，且参数照常透传。

test('宿主有 process.nextTick 时原样使用，参数透传', async () => {
  const order: string[] = [];
  nextTick((a: number, b: string) => order.push(`${a}:${b}`), 7, 'x');
  order.push('sync');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['sync', '7:x']);
});

test('没有 process.nextTick 时退回微任务（RN 形态），仍晚于当前栈', async () => {
  // 注入一个「像 RN 的 process」：有 env、没有 nextTick。
  __setNextTickHostForTest({});
  const order: string[] = [];
  try {
    nextTick((a: number) => order.push(`tick:${a}`), 42);
    order.push('sync');
    assert.deepEqual(order, ['sync']); // 尚未执行
    await Promise.resolve();
    assert.deepEqual(order, ['sync', 'tick:42']);
  } finally {
    __setNextTickHostForTest(undefined);
  }
});
