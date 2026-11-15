import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkServerIdentity } from '../../src/checkServerIdentity.ts';

test('SAN 覆盖时忽略不匹配的 CN', () => {
    // 真实墙的证书：CN=readinga-z.com，SAN 才包含目标主机
    const cert = {
        subject: { CN: 'readinga-z.com' },
        subjectaltname:
            'DNS:readinga-z.com, DNS:*.content.raz-plus.com, DNS:*.raz-plus.com, IP Address:127.0.0.1',
    };
    assert.equal(checkServerIdentity('mi.content.raz-plus.com', cert), undefined);
});

test('通配符只跨一个标签', () => {
    const cert = { subjectaltname: 'DNS:*.example.com' };
    assert.equal(checkServerIdentity('a.example.com', cert), undefined);
    assert.notEqual(checkServerIdentity('a.b.example.com', cert), undefined);
    assert.notEqual(checkServerIdentity('example.com', cert), undefined);
});

test('没有 SAN 时回退 CN', () => {
    assert.equal(checkServerIdentity('example.com', { subject: { CN: 'example.com' } }), undefined);
    assert.notEqual(
        checkServerIdentity('other.example.com', { subject: { CN: 'example.com' } }),
        undefined
    );
});

test('IP 主机只匹配 IP SAN', () => {
    const cert = { subject: { CN: 'localhost' }, subjectaltname: 'DNS:localhost, IP Address:127.0.0.1' };
    assert.equal(checkServerIdentity('127.0.0.1', cert), undefined);
    assert.notEqual(checkServerIdentity('127.0.0.2', cert), undefined);
});

test('不匹配时的错误形状与 node 逐字一致（code/reason/host/cert + 三种 reason）', () => {
    // 期望值来自 node v22.11 的 `tls.checkServerIdentity` 实测（不是猜的）：
    //   · 有 SAN、主机是 DNS：`Host: <host>. is not in the cert's altnames: <整条 SAN>`
    //   · 有 SAN、主机是 IP：`IP: <ip> is not in the cert's list: <ips>`
    //   · 无 SAN、回退 CN：  `Host: <host>. is not cert's CN: <CN>`
    // 三者都包在 `Hostname/IP does not match certificate's altnames: ` 之后，
    // code 一律 ERR_TLS_CERT_ALTNAME_INVALID，并带 reason/host/cert 属性。
    const dnsCert = { subjectaltname: 'DNS:example.com' };
    const dnsErr = checkServerIdentity('nope.example', dnsCert) as any;
    assert.equal(dnsErr.code, 'ERR_TLS_CERT_ALTNAME_INVALID');
    assert.equal(dnsErr.reason, 'Host: nope.example. is not in the cert\'s altnames: DNS:example.com');
    assert.equal(dnsErr.message,
        'Hostname/IP does not match certificate\'s altnames: Host: nope.example. is not in the cert\'s altnames: DNS:example.com');
    assert.equal(dnsErr.host, 'nope.example');
    assert.equal(dnsErr.cert, dnsCert);

    const ipCert = { subjectaltname: 'DNS:localhost, IP Address:127.0.0.1' };
    const ipErr = checkServerIdentity('127.0.0.2', ipCert) as any;
    assert.equal(ipErr.reason, 'IP: 127.0.0.2 is not in the cert\'s list: 127.0.0.1');

    const cnCert = { subject: { CN: 'localhost' } };
    const cnErr = checkServerIdentity('other.invalid', cnCert) as any;
    assert.equal(cnErr.reason, 'Host: other.invalid. is not cert\'s CN: localhost');

    // node：两者都没有时 reason 是固定句
    const emptyErr = checkServerIdentity('x.example', {}) as any;
    assert.equal(emptyErr.reason, 'Cert does not contain a DNS name');
});

test('FQDN 末尾的点在比较与错误文本里都被去掉（node 的 unfqdn）', () => {
    const cert = { subjectaltname: 'DNS:example.com' };
    assert.equal(checkServerIdentity('example.com.', cert), undefined);
    const err = checkServerIdentity('nope.example.', cert) as any;
    assert.equal(err.host, 'nope.example');
});
