/**
 * 把 native 的证书 JSON 解码成 Node `getPeerCertificate()` 的形状。
 *
 * 纯函数：base64 解码器由调用方注入（tls.ts / http2Session.ts 传 Buffer），
 * 这样 node 单测不需要加载 react-native-nitro-buffer。
 * native 把 DER Buffer 编码为 base64 字符串；这里还原 `raw` / `pubkey`，
 * 并递归处理 `issuerCertificate`。
 */

export interface PeerCertificateLike {
    subject?: Record<string, string>
    issuer?: Record<string, string>
    subjectaltname?: string
    raw?: Uint8Array
    pubkey?: Uint8Array
    issuerCertificate?: PeerCertificateLike | Record<string, never>
    [key: string]: any
}

export function decodePeerCertificate(
    json: string,
    decodeBase64: (value: string) => Uint8Array
): PeerCertificateLike | Record<string, never> {
    let parsed: any
    try {
        parsed = JSON.parse(json)
    } catch {
        return {}
    }
    const walk = (node: any): any => {
        if (!node || typeof node !== 'object') return node
        if (typeof node.raw === 'string') node.raw = decodeBase64(node.raw)
        if (typeof node.pubkey === 'string') node.pubkey = decodeBase64(node.pubkey)
        if (node.issuerCertificate && typeof node.issuerCertificate === 'object') {
            walk(node.issuerCertificate)
        }
        return node
    }
    return walk(parsed)
}

/**
 * 解码 native 的证书**链**（JSON 数组，leaf 在前）成 node 的形状。
 *
 * native 给的是**已验证链**（服务端只发 leaf 时也用信任库补根）；验证失败时退回
 * 对端下发的链。`verified` 由调用方从 `authorizationError` 推出（无错 = 验证成功）。
 *
 * node 的 `getPeerCertificate(true)` 形状（实测 v22，四种组合）：
 * - 链长度 > 1：每级都带 `issuerCertificate`，**最后一级自引用**；验证成功与否同形；
 * - 链长度 = 1 且验证成功：自引用（`cert.issuerCertificate === cert`）；
 * - 链长度 = 1 且验证失败：**没有** `issuerCertificate` 键（不是自引用）。
 * `getPeerCertificate()`（不带参数）**不带** `issuerCertificate` 键，与 node 相同。
 */
export function decodePeerCertificateChain(
    json: string,
    decodeBase64: (value: string) => Uint8Array,
    detailed: boolean,
    verified: boolean
): PeerCertificateLike | Record<string, never> {
    let parsed: any
    try {
        parsed = JSON.parse(json)
    } catch {
        return {}
    }
    const entries = Array.isArray(parsed) ? parsed : [parsed]
    const certs = entries.map((entry) => decodePeerCertificate(JSON.stringify(entry), decodeBase64))
    const leaf = certs[0]
    if (!leaf || typeof leaf !== 'object') return {}
    if (detailed && (certs.length > 1 || verified)) {
        for (let i = 0; i < certs.length; i++) {
            const next = i + 1 < certs.length ? certs[i + 1] : certs[i]
            ;(certs[i] as PeerCertificateLike).issuerCertificate = next
        }
    }
    return leaf
}
