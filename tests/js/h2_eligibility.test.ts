import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHROME_DESKTOP } from '../../src/profiles/chrome.ts';
import type { ImpersonationConnectOptions } from '../../src/impersonation.ts';
import { canUseHttp2, canRetryH2Request } from '../../src/h2Eligibility.ts';

const resolved: ImpersonationConnectOptions = {
    impersonate: 'chrome',
    profile: 'chrome',
    profileData: CHROME_DESKTOP,
    forceHttp1: false,
    headerPolicy: 'profile-first',
    overrideHeaders: false,
};

test('默认匹配的 HTTPS 请求走 H2', () => {
    assert.equal(canUseHttp2('GET', resolved, {}, true), true);
});

test('ALPN 不含 h2 / forceHttp1 时留在 H1', () => {
    assert.equal(canUseHttp2('GET', { ...resolved, forceHttp1: true }, {}, true), false);
    assert.equal(
        canUseHttp2(
            'GET',
            {
                ...resolved,
                profileData: { ...CHROME_DESKTOP, tls: { ...CHROME_DESKTOP.tls, alpn: ['http/1.1'] } },
            },
            {},
            true
        ),
        false
    );
});

test('原生无 H2 引擎时留在 H1', () => {
    assert.equal(canUseHttp2('GET', resolved, {}, false), false);
});

test('H2 无法映射的回调与 CONNECT 强制 H1', () => {
    assert.equal(canUseHttp2('GET', resolved, { lookup: () => {} }, true), false);
    assert.equal(canUseHttp2('GET', resolved, { createConnection: () => {} }, true), false);
    assert.equal(canUseHttp2('GET', resolved, { checkServerIdentity: () => {} }, true), false);
    assert.equal(canUseHttp2('GET', resolved, { socketPath: '/tmp/x' }, true), false);
    assert.equal(canUseHttp2('CONNECT', resolved, {}, true), false);
});


test('REFUSED_STREAM 只重试一次，且仅限幂等无 body 请求', () => {
    assert.equal(canRetryH2Request('GET', 'ERR_HTTP2_REFUSED_STREAM', 0, false), true);
    assert.equal(canRetryH2Request('get', 'ERR_HTTP2_REFUSED_STREAM', 0, false), true);
    assert.equal(canRetryH2Request('GET', 'ERR_HTTP2_REFUSED_STREAM', 1, false), false);
    assert.equal(canRetryH2Request('POST', 'ERR_HTTP2_REFUSED_STREAM', 0, false), false);
    assert.equal(canRetryH2Request('GET', 'ERR_HTTP2_REFUSED_STREAM', 0, true), false);
    assert.equal(canRetryH2Request('GET', 'ERR_HTTP2_STREAM_ERROR', 0, false), false);
});
