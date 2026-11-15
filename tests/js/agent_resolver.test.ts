import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GlobalAgentRegistry, normalizeProtocol } from '../../src/agentResolver.ts';

type FakeAgent = { id: string };

function isFakeAgent(value: unknown): value is FakeAgent {
  return typeof value === 'object' && value !== null && typeof (value as FakeAgent).id === 'string';
}

test('protocol 归一化', () => {
  assert.equal(normalizeProtocol(undefined), 'http:');
  assert.equal(normalizeProtocol('http'), 'http:');
  assert.equal(normalizeProtocol('HTTPS:'), 'https:');
  assert.equal(normalizeProtocol('https'), 'https:');
});

test('按协议选择全局 Agent，未注册时回退到默认 Agent', () => {
  const httpAgent: FakeAgent = { id: 'http' };
  const httpsAgent: FakeAgent = { id: 'https' };
  const registry = new GlobalAgentRegistry<FakeAgent>();
  registry.setFallback(httpAgent);

  assert.equal(registry.get('http:'), httpAgent);
  assert.equal(registry.get('https:'), httpAgent); // 尚未注册 https
  registry.set('https:', httpsAgent);
  assert.equal(registry.get('https:'), httpsAgent);
  assert.equal(registry.get('HTTPS'), httpsAgent);
  assert.equal(registry.get(undefined), httpAgent);
});

test('显式 Agent 优先于全局 Agent', () => {
  const httpAgent: FakeAgent = { id: 'http' };
  const httpsAgent: FakeAgent = { id: 'https' };
  const custom: FakeAgent = { id: 'custom' };
  const registry = new GlobalAgentRegistry<FakeAgent>();
  registry.setFallback(httpAgent);
  registry.set('https:', httpsAgent);

  assert.equal(registry.resolve('https:', custom, isFakeAgent, () => ({ id: 'new' })), custom);
});

test('agent:false 创建一次性 Agent', () => {
  const httpAgent: FakeAgent = { id: 'http' };
  let created = 0;
  const registry = new GlobalAgentRegistry<FakeAgent>();
  registry.setFallback(httpAgent);

  const selected = registry.resolve(
    'https:',
    false,
    isFakeAgent,
    () => {
      created++;
      return { id: 'new' };
    }
  );
  assert.equal(selected.id, 'new');
  assert.equal(created, 1);
});

test('未注册协议且没有 fallback 时抛出明确错误', () => {
  const registry = new GlobalAgentRegistry<FakeAgent>();
  assert.throws(
    () => registry.resolve('https:', undefined, isFakeAgent, () => ({ id: 'new' })),
    /No global agent registered/
  );
});
