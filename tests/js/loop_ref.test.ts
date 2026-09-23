import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LoopRef, __setHostHandleRefForTest } from '../../src/loopRef.ts';

test('宿主无能力时全部 no-op，不抛', () => {
  __setHostHandleRefForTest(undefined);
  const r = new LoopRef('net.Server');
  r.acquire(); r.acquire(); r.release(); r.release();  // 全 no-op
  assert.equal(r.refed, false);
});

test('幂等：重复 acquire 只计一次，重复 release 不双减', () => {
  let count = 0;
  let issued: number | null = null;
  let releasedWith: number | null = null;
  __setHostHandleRefForTest({
    acquire: () => { count++; issued = count; return count; },
    release: (t: number) => { count--; releasedWith = t; },
  });
  const r = new LoopRef('net.Socket');
  r.acquire(); r.acquire();
  assert.equal(count, 1);
  r.release(); r.release();
  assert.equal(count, 0);
  // token 往返：release 收到的必须正是 acquire 签发的那枚
  assert.equal(issued, 1);
  assert.equal(releasedWith, issued);
});

test('release 后可重新 acquire', () => {
  let count = 0;
  __setHostHandleRefForTest({ acquire: () => { count++; return 1; }, release: () => { count--; } });
  const r = new LoopRef('x');
  r.acquire(); r.release(); r.acquire();
  assert.equal(count, 1);
});
