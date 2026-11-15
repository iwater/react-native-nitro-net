import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodePeerCertificate, decodePeerCertificateChain } from '../../src/peerCertificate.ts';

const decode = (value: string) => Buffer.from(value, 'base64');

test('raw/pubkey 从 base64 还原成字节，递归处理 issuerCertificate', () => {
    const json = JSON.stringify({
        subject: { CN: 'example.com' },
        serialNumber: '01EE',
        valid_from: 'Sep 26 22:49:11 2026 GMT',
        raw: Buffer.from('leaf').toString('base64'),
        pubkey: Buffer.from('spki').toString('base64'),
        issuerCertificate: {
            subject: { CN: 'CA' },
            raw: Buffer.from('ca').toString('base64'),
        },
    });
    const cert = decodePeerCertificate(json, decode) as any;
    assert.equal(cert.serialNumber, '01EE');
    assert.equal(Buffer.from(cert.raw).toString(), 'leaf');
    assert.equal(Buffer.from(cert.pubkey).toString(), 'spki');
    assert.equal(Buffer.from(cert.issuerCertificate.raw).toString(), 'ca');
});

test('坏 JSON 返回空对象，不抛', () => {
    assert.deepEqual(decodePeerCertificate('{not json', decode), {});
});

test('链解码：多级时逐级链接、最后一级自引用（node 实测形状）', () => {
    const json = JSON.stringify([
        { subject: { CN: 'leaf' } },
        { subject: { CN: 'root' } },
    ]);
    const leaf = decodePeerCertificateChain(json, decode, true, true) as any;
    assert.equal(leaf.subject.CN, 'leaf');
    assert.equal(leaf.issuerCertificate.subject.CN, 'root');
    assert.equal(leaf.issuerCertificate.issuerCertificate, leaf.issuerCertificate);
});

test('链解码：单证书 + 验证成功 ⇒ 自引用；验证失败 ⇒ 不带该键（node 实测）', () => {
    const json = JSON.stringify([{ subject: { CN: 'localhost' } }]);
    const verified = decodePeerCertificateChain(json, decode, true, true) as any;
    assert.equal(verified.issuerCertificate, verified);

    const unverified = decodePeerCertificateChain(json, decode, true, false) as any;
    assert.equal('issuerCertificate' in unverified, false);
});

test('链解码：detailed=false 时不添加 issuerCertificate', () => {
    const json = JSON.stringify([{ subject: { CN: 'leaf' } }, { subject: { CN: 'root' } }]);
    const leaf = decodePeerCertificateChain(json, decode, false, true) as any;
    assert.equal('issuerCertificate' in leaf, false);
});
