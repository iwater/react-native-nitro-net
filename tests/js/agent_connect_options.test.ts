import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    applyAgentConnectOverrides,
    HTTP_CONNECT_FIELDS,
    TLS_CONNECT_FIELDS,
} from '../../src/agentConnectOptions.ts';

test('agent 级字段覆盖请求级（Node 的 {...options, ...this.options} 语义）', () => {
  const eff = applyAgentConnectOverrides({ ca: 'REQ' }, { ca: 'AGENT' }, TLS_CONNECT_FIELDS);
  assert.equal(eff.ca, 'AGENT');
});

test('agent 没给该字段时请求级原样保留', () => {
  const eff = applyAgentConnectOverrides({ ca: 'REQ', servername: 'a.example' }, { cert: 'C' }, TLS_CONNECT_FIELDS);
  assert.equal(eff.ca, 'REQ');
  assert.equal(eff.servername, 'a.example');
  assert.equal(eff.cert, 'C');
});

test('agent 显式传 undefined 也会冲掉请求级 —— 与 Node 的 spread 一致（hasOwnProperty 判定）', () => {
  const eff = applyAgentConnectOverrides({ ca: 'REQ' }, { ca: undefined }, TLS_CONNECT_FIELDS);
  assert.equal(eff.ca, undefined);
  assert.ok(Object.prototype.hasOwnProperty.call(eff, 'ca'));
});

test('不修改传入的请求对象', () => {
  const req = { ca: 'REQ' };
  applyAgentConnectOverrides(req, { ca: 'AGENT' }, TLS_CONNECT_FIELDS);
  assert.equal(req.ca, 'REQ');
});

test('名单外的字段一律不进（池元数据不是建连参数）', () => {
  const eff = applyAgentConnectOverrides(
    { host: 'h' },
    { maxSockets: 5, scheduling: 'fifo', h2MaxSessions: 3, keepAlive: true, path: '/should-not-leak', ca: 'AGENT' },
    [...HTTP_CONNECT_FIELDS, ...TLS_CONNECT_FIELDS],
  );
  assert.equal(eff.ca, 'AGENT');
  assert.equal(eff.maxSockets, undefined);
  assert.equal(eff.scheduling, undefined);
  assert.equal(eff.h2MaxSessions, undefined);
  assert.equal(eff.keepAlive, undefined);
  // node 在构造器里专门写 `this.options.path = null` 就是怕 path 被 net 当成 Unix 路径；
  // 本包的 createConnection 索性不传 path，名单也不收。
  assert.equal(eff.path, undefined);
});

test('agent.options 缺失 / 非对象时退化为请求级副本', () => {
  assert.deepEqual(applyAgentConnectOverrides({ ca: 'REQ' }, undefined, TLS_CONNECT_FIELDS), { ca: 'REQ' });
  assert.deepEqual(applyAgentConnectOverrides({ ca: 'REQ' }, null as any, TLS_CONNECT_FIELDS), { ca: 'REQ' });
});

test('impersonate/profile/ALPN/forceHttp1 刻意不在名单内（保持本包既有的请求级优先）', () => {
  for (const field of ['impersonate', 'profile', 'ALPNProtocols', 'forceHttp1', 'proxy', 'proxyTls']) {
    assert.ok(!HTTP_CONNECT_FIELDS.includes(field), field);
    assert.ok(!TLS_CONNECT_FIELDS.includes(field), field);
  }
});
