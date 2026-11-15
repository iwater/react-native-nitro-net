import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tlsPoolKeySuffix } from '../../src/tlsPoolKey.ts';

test('没有任何 TLS 材料时不改变池键', () => {
  assert.equal(tlsPoolKeySuffix({ host: 'example.com' }), '');
});

test('ca：不同材料不同键，同等材料（string/Buffer）同键', () => {
  const a = tlsPoolKeySuffix({ ca: '-----BEGIN CERTIFICATE-----\nA\n-----END CERTIFICATE-----' });
  const b = tlsPoolKeySuffix({ ca: '-----BEGIN CERTIFICATE-----\nB\n-----END CERTIFICATE-----' });
  const aBuf = tlsPoolKeySuffix({
    ca: Buffer.from('-----BEGIN CERTIFICATE-----\nA\n-----END CERTIFICATE-----'),
  });
  assert.notEqual(a, b);
  assert.equal(a, aBuf);
  assert.match(a, /:ca:/);
});

test('cert / key / pfx 进入池键；passphrase 不进入（Node 同款，避免口令进键串）', () => {
  const base = tlsPoolKeySuffix({});
  assert.notEqual(tlsPoolKeySuffix({ cert: 'C' }), base);
  assert.notEqual(tlsPoolKeySuffix({ key: 'K' }), base);
  assert.notEqual(tlsPoolKeySuffix({ pfx: 'P' }), base);
  assert.equal(tlsPoolKeySuffix({ passphrase: 'x' }), base);
  assert.notEqual(tlsPoolKeySuffix({ cert: ['C1', 'C2'] }), tlsPoolKeySuffix({ cert: 'C1' }));
});

test('rejectUnauthorized 仅在显式给出时进入池键（Node 同款）', () => {
  assert.equal(tlsPoolKeySuffix({ rejectUnauthorized: undefined }), '');
  assert.match(tlsPoolKeySuffix({ rejectUnauthorized: true }), /:rejectUnauthorized:true/);
  assert.notEqual(
    tlsPoolKeySuffix({ rejectUnauthorized: true }),
    tlsPoolKeySuffix({ rejectUnauthorized: false })
  );
});

test('servername 与 host 相同时不进入池键，不同时进入', () => {
  assert.equal(tlsPoolKeySuffix({ host: 'a.example', servername: 'a.example' }), '');
  assert.match(tlsPoolKeySuffix({ host: 'a.example', servername: 'b.example' }), /:servername:b\.example/);
});

test('impersonate：模式/profile/ALPN 进入池键', () => {
  assert.equal(
    tlsPoolKeySuffix({ impersonate: 'chrome', profile: 'chrome' }),
    tlsPoolKeySuffix({ impersonate: 'chrome', profile: 'chrome' })
  );
  assert.notEqual(
    tlsPoolKeySuffix({ impersonate: 'chrome', profile: 'chrome' }),
    tlsPoolKeySuffix({ impersonate: 'chrome', profile: 'other' })
  );
  assert.notEqual(
    tlsPoolKeySuffix({ impersonate: 'chrome', profile: 'chrome' }),
    tlsPoolKeySuffix({ impersonate: 'chrome', profile: 'chrome', forceHttp1: true })
  );
  assert.equal(
    tlsPoolKeySuffix({ impersonate: 'chrome', profile: 'chrome', forceHttp1: true }),
    tlsPoolKeySuffix({
      impersonate: 'chrome',
      profile: 'chrome',
      alpnProtocols: ['http/1.1'],
    })
  );
  assert.equal(tlsPoolKeySuffix({ impersonate: false }), '');
});

test('proxyTls 的材料与开关进入池键', () => {
  const one = tlsPoolKeySuffix({ proxyTls: { ca: 'CA1', servername: 'p1' } });
  const two = tlsPoolKeySuffix({ proxyTls: { ca: 'CA2', servername: 'p1' } });
  const off = tlsPoolKeySuffix({ proxyTls: { rejectUnauthorized: false } });
  assert.match(one, /:proxyTls:/);
  assert.notEqual(one, two);
  assert.notEqual(off, tlsPoolKeySuffix({ proxyTls: {} }));
  assert.notEqual(tlsPoolKeySuffix({ proxyTls: {} }), '');
});
