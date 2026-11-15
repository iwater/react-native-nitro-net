import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateProfile } from '../../src/profiles/validate.ts';
import { CHROME_DESKTOP } from '../../src/profiles/chrome.ts';

test('内置 chrome profile 合法，且关键值来自抓包', () => {
  const p = validateProfile(CHROME_DESKTOP);
  assert.equal(p.id, 'chrome');
  assert.deepEqual(p.http2.settings, [
    { id: 1, value: 65536 },
    { id: 2, value: 0 },
    { id: 4, value: 6291456 },
    { id: 6, value: 262144 },
  ]);
  assert.deepEqual(p.http2.settingsOrder, [1, 2, 4, 6]);
  assert.equal(p.http2.windowUpdate, 15663105);
  assert.deepEqual(p.http2.pseudoHeaderOrder, [':method', ':authority', ':scheme', ':path']);
  assert.deepEqual(p.tls.alpn, ['h2', 'http/1.1']);
  assert.deepEqual(p.tls.certificateCompression, ['brotli']);
  // 12 个可设置的 TLS1.2 cipher（TLS1.3 由 BoringSSL 固定）
  assert.equal(p.tls.cipherList.split(':').length, 12);
  // header 值与 chrome_accepted.json 一致
  const ua = p.headers.find(([k]) => k === 'user-agent')?.[1] ?? '';
  assert.match(ua, /Chrome\/150\.0\.0\.0/);
});

test('拒绝缺 http/1.1 的 ALPN', () => {
  assert.throws(
    () => validateProfile({ ...CHROME_DESKTOP, tls: { ...CHROME_DESKTOP.tls, alpn: ['h2'] } }),
    /http\/1\.1/
  );
});

test('拒绝与 http2.settings 不一致的 ALPS payload', () => {
  assert.throws(
    () =>
      validateProfile({
        ...CHROME_DESKTOP,
        tls: {
          ...CHROME_DESKTOP.tls,
          alps: { protocol: 'h2', settingsPayload: Buffer.from([0, 0]).toString('base64') },
        },
      }),
    /settings/i
  );
});

test('拒绝未知 H2 setting id、重复 pseudo-header 与 CRLF 头', () => {
  assert.throws(
    () =>
      validateProfile({
        ...CHROME_DESKTOP,
        http2: {
          ...CHROME_DESKTOP.http2,
          settings: [...CHROME_DESKTOP.http2.settings, { id: 0x42, value: 1 }],
        },
      }),
    /setting/i
  );
  assert.throws(
    () =>
      validateProfile({
        ...CHROME_DESKTOP,
        http2: {
          ...CHROME_DESKTOP.http2,
          pseudoHeaderOrder: [':method', ':method', ':scheme', ':path'],
        },
      }),
    /pseudo/i
  );
  assert.throws(
    () => validateProfile({ ...CHROME_DESKTOP, headers: [['x-test', 'a\r\nb']] }),
    /CRLF|header/i
  );
});
