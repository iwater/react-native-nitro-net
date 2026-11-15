import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHROME_DESKTOP } from '../../src/profiles/chrome.ts';
import { buildH2RequestHeaders, buildH2RequestJson } from '../../src/http2Headers.ts';

const base = {
    method: 'GET',
    authority: 'example.com',
    path: '/',
    profile: CHROME_DESKTOP,
};

test('控制头按 profile headerOrder 排列，业务头追加在后', () => {
    const headers = buildH2RequestHeaders({
        ...base,
        userHeaders: { 'x-a': '1', cookie: 'a=b' },
    });
    const names = headers.map(([name]) => name);
    assert.deepEqual(
        names.slice(0, CHROME_DESKTOP.http2.headerOrder.length),
        CHROME_DESKTOP.http2.headerOrder
    );
    assert.deepEqual(names.slice(-2), ['x-a', 'cookie']);
    assert.equal(headers.find(([name]) => name === 'user-agent')![1].includes('Chrome/150'), true);
});

test('overrideHeaders 打开后用户控制头生效；accept-encoding 始终用户优先', () => {
    const overridden = buildH2RequestHeaders({
        ...base,
        overrideHeaders: true,
        userHeaders: { 'User-Agent': 'my-agent', 'Accept-Encoding': 'identity' },
    });
    assert.equal(overridden.find(([name]) => name === 'user-agent')![1], 'my-agent');
    assert.equal(overridden.find(([name]) => name === 'accept-encoding')![1], 'identity');

    const defaults = buildH2RequestHeaders({
        ...base,
        userHeaders: { 'User-Agent': 'my-agent', 'Accept-Encoding': 'identity' },
    });
    assert.equal(defaults.find(([name]) => name === 'user-agent')![1].includes('Chrome/150'), true);
    assert.equal(defaults.find(([name]) => name === 'accept-encoding')![1], 'identity');
});

test('headerPolicy=user-first 时业务头在控制头之前', () => {
    const headers = buildH2RequestHeaders({
        ...base,
        headerPolicy: 'user-first',
        userHeaders: { 'x-a': '1' },
    });
    assert.equal(headers[0][0], 'x-a');
    assert.equal(headers[1][0], CHROME_DESKTOP.http2.headerOrder[0]);
});

test('丢弃 Host 与连接级头，保留业务头', () => {
    const headers = buildH2RequestHeaders({
        ...base,
        userHeaders: {
            Host: 'evil.example',
            Connection: 'keep-alive',
            'Transfer-Encoding': 'chunked',
            Upgrade: 'h2c',
            TE: 'trailers',
            Expect: '100-continue',
            authorization: 'Bearer x',
        },
    });
    const names = headers.map(([name]) => name);
    for (const forbidden of ['host', 'connection', 'transfer-encoding', 'upgrade', 'te', 'expect']) {
        assert.equal(names.includes(forbidden), false, `${forbidden} must be dropped`);
    }
    assert.deepEqual(headers.find(([name]) => name === 'authorization'), [
        'authorization',
        'Bearer x',
    ]);
});

test('数组值展开为多个头；名小写', () => {
    const headers = buildH2RequestHeaders({
        ...base,
        userHeaders: { 'X-Dup': ['1', '2'] },
    });
    assert.deepEqual(
        headers.filter(([name]) => name === 'x-dup'),
        [
            ['x-dup', '1'],
            ['x-dup', '2'],
        ]
    );
});

test('CRLF 头直接抛错', () => {
    assert.throws(
        () => buildH2RequestHeaders({ ...base, userHeaders: { 'x-a': 'a\r\nb' } }),
        /CRLF/
    );
});

test('buildH2RequestJson 带 authority/path/endStream 且不含伪头', () => {
    const json = JSON.parse(
        buildH2RequestJson({ ...base, path: '/a?b=1', userHeaders: { 'x-a': '1' } }, true)
    );
    assert.equal(json.method, 'GET');
    assert.equal(json.scheme, 'https');
    assert.equal(json.authority, 'example.com');
    assert.equal(json.path, '/a?b=1');
    assert.equal(json.endStream, true);
    assert.equal(
        json.headers.some(([name]: [string, string]) => name.startsWith(':')),
        false
    );
    assert.deepEqual(json.headers[json.headers.length - 1], ['x-a', '1']);
});
