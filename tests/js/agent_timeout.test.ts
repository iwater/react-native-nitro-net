import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  armAgentSocketTimeout,
  validateAgentTimeout,
  type AgentTimeoutSocket,
} from '../../src/agentTimeout.ts';

/**
 * 假 socket：只记录 agent 用到的三个动作（setTimeout / on('timeout') / destroy）。
 */
function fakeSocket(): AgentTimeoutSocket & { calls: any[]; destroyed: boolean; fireTimeout(): void } {
  const listeners: Array<() => void> = [];
  const calls: any[] = [];
  return {
    calls,
    destroyed: false,
    setTimeout(msecs: number) {
      calls.push(['setTimeout', msecs]);
      return this;
    },
    on(event: string, listener: () => void) {
      calls.push(['on', event]);
      if (event === 'timeout') listeners.push(listener);
      return this;
    },
    destroy() {
      this.destroyed = true;
      calls.push(['destroy']);
      return this;
    },
    fireTimeout() {
      for (const l of listeners) l();
    },
  };
}

test('timeout 缺省或 0 表示不武装', () => {
  assert.equal(validateAgentTimeout(undefined), undefined);
  assert.equal(validateAgentTimeout(0), undefined);
});

test('正数原样保留（Node 实测 1234.7 不截断）', () => {
  assert.equal(validateAgentTimeout(5000), 5000);
  assert.equal(validateAgentTimeout(1234.7), 1234.7);
});

test('负数 / NaN / Infinity 抛 ERR_OUT_OF_RANGE', () => {
  for (const bad of [-5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => validateAgentTimeout(bad),
      (err: any) => err instanceof RangeError && err.code === 'ERR_OUT_OF_RANGE',
      `expected throw for ${bad}`,
    );
  }
});

test('不武装时完全不碰 socket', () => {
  const socket = fakeSocket();
  armAgentSocketTimeout(socket, undefined, () => true);
  assert.deepEqual(socket.calls, []);
});

test('武装时设置超时并挂一个 timeout 监听', () => {
  const socket = fakeSocket();
  armAgentSocketTimeout(socket, 400, () => true);
  assert.deepEqual(socket.calls, [['setTimeout', 400], ['on', 'timeout']]);
});

test('空闲 socket 超时后被销毁（Node 的 onSocketCloseTimeout）', () => {
  const socket = fakeSocket();
  armAgentSocketTimeout(socket, 400, () => true);
  socket.fireTimeout();
  assert.equal(socket.destroyed, true);
});

test('在途请求的 socket 只收事件、不销毁', () => {
  const socket = fakeSocket();
  let idle = false;
  armAgentSocketTimeout(socket, 400, () => idle);
  socket.fireTimeout();
  assert.equal(socket.destroyed, false, 'idle=false 时不应销毁');

  idle = true;
  socket.fireTimeout();
  assert.equal(socket.destroyed, true, '转空闲后再超时应当销毁');
});
