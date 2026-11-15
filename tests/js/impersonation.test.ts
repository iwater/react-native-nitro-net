import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONFIG,
  matchHost,
  resolveImpersonation,
  buildImpersonationConnectOptions,
} from '../../src/impersonation.ts';
import { CHROME_DESKTOP } from '../../src/profiles/chrome.ts';

const lookup = (id: string) => (id === 'chrome' ? CHROME_DESKTOP : undefined);

test('matchHost: 通配、端口与 exclude 的匹配口径', () => {
  assert.equal(matchHost('*.example.com', 'api.example.com'), true);
  assert.equal(matchHost('*.example.com', 'example.com'), true);
  assert.equal(matchHost('*.example.com', 'evil-example.com'), false);
  assert.equal(matchHost('api.example.com:8443', 'api.example.com:8443'), true);
  assert.equal(matchHost('api.example.com:8443', 'api.example.com:443'), false);
  assert.equal(matchHost('internal.corp', 'internal.corp:443'), true);
});

test('默认关闭；全局开启后按 match/exclude 过滤', () => {
  const off = resolveImpersonation(DEFAULT_CONFIG, 'api.example.com', {}, lookup, true);
  assert.equal(off.enabled, false);

  const cfg = { ...DEFAULT_CONFIG, impersonate: 'chrome' as const, match: ['*.example.com'] };
  assert.equal(resolveImpersonation(cfg, 'api.example.com', {}, lookup, true).enabled, true);
  assert.equal(resolveImpersonation(cfg, 'other.test', {}, lookup, true).enabled, false);

  const excluded = { ...cfg, exclude: ['secret.example.com'] };
  assert.equal(resolveImpersonation(excluded, 'secret.example.com', {}, lookup, true).enabled, false);
});

test('单请求覆盖全局；显式开启绕过 match，但 exclude 仍优先', () => {
  const cfg = { ...DEFAULT_CONFIG, impersonate: 'chrome' as const, match: ['*.example.com'] };
  assert.equal(resolveImpersonation(cfg, 'api.example.com', { impersonate: false }, lookup, true).enabled, false);

  const off = DEFAULT_CONFIG;
  assert.equal(resolveImpersonation(off, 'other.test', { impersonate: 'chrome' }, lookup, true).enabled, true);

  const excluded = { ...off, exclude: ['other.test'] };
  assert.throws(
    () => resolveImpersonation(excluded, 'other.test', { impersonate: 'chrome' }, lookup, true),
    /excluded/i
  );
});

test('未知 profile 与 native 不可用时给出明确错误码', () => {
  const cfg = { ...DEFAULT_CONFIG, impersonate: 'chrome' as const };
  assert.throws(
    () => resolveImpersonation(cfg, 'a.test', { profile: 'nope' }, lookup, true),
    (e: any) => e.code === 'ERR_UNKNOWN_PROFILE'
  );
  assert.throws(
    () => resolveImpersonation(cfg, 'a.test', {}, lookup, false),
    (e: any) => e.code === 'ERR_IMPERSONATION_UNAVAILABLE'
  );
});

test('forceHttp1：显式、ALPN 不含 h2、或带 Upgrade 头', () => {
  const cfg = { ...DEFAULT_CONFIG, impersonate: 'chrome' as const };
  assert.equal(resolveImpersonation(cfg, 'a.test', {}, lookup, true).forceHttp1, false);
  assert.equal(resolveImpersonation(cfg, 'a.test', { forceHttp1: true }, lookup, true).forceHttp1, true);
  assert.equal(
    resolveImpersonation(cfg, 'a.test', { alpnProtocols: ['http/1.1'] }, lookup, true).forceHttp1,
    true
  );
  assert.equal(
    resolveImpersonation(cfg, 'a.test', { headers: { Connection: 'Upgrade' } }, lookup, true).forceHttp1,
    true
  );
});

test('Agent 级与请求级的合并：请求级优先，未给则用 Agent 级', () => {
  const cfg = { ...DEFAULT_CONFIG, impersonate: 'chrome' as const };
  const fromAgent = buildImpersonationConnectOptions(
    { impersonate: 'chrome', profile: 'chrome', forceHttp1: true },
    {},
    'a.test',
    cfg,
    lookup,
    true
  );
  assert.equal(fromAgent?.forceHttp1, true);
  const fromRequest = buildImpersonationConnectOptions(
    { impersonate: 'chrome', forceHttp1: true },
    { forceHttp1: false },
    'a.test',
    cfg,
    lookup,
    true
  );
  assert.equal(fromRequest?.forceHttp1, false);
});
