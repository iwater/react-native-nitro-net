/**
 * 证书主机名校验（纯函数，无内部 value import）。
 *
 * 之前只看 `subject.CN`，于是 CN 与主机名不同、靠 SAN 覆盖的证书（例如
 * `CN=readinga-z.com` 但 SAN 含 `*.content.raz-plus.com`）会被误拒。
 * 规则与 Node 对齐：有 SAN 时用 SAN；没有 SAN 才回退 CN；IP 主机只匹配 IP SAN。
 */

export interface PeerCertificateLike {
    subject?: Record<string, string>
    subjectaltname?: string
    [key: string]: any
}

interface SanEntry {
    type: string
    value: string
}

function parseSubjectAltName(value: string | undefined): SanEntry[] {
    if (!value) return []
    return value
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => {
            const colon = entry.indexOf(':')
            return colon < 0
                ? { type: 'DNS', value: entry }
                : { type: entry.slice(0, colon).trim(), value: entry.slice(colon + 1).trim() }
        })
}

function isIpAddress(host: string): boolean {
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
        return host.split('.').every((part) => Number(part) <= 255)
    }
    return host.includes(':')
}

function wildcardMatch(hostname: string, pattern: string): boolean {
    const host = hostname.toLowerCase().replace(/\.$/, '')
    const name = pattern.toLowerCase().replace(/\.$/, '')
    if (!name.includes('*')) return host === name
    const nameParts = name.split('.')
    const hostParts = host.split('.')
    // Node/RFC 6125：只允许最左标签是一个完整的 `*`，且只跨一个标签
    if (nameParts.length !== hostParts.length) return false
    if (nameParts[0] !== '*') return false
    if (nameParts.slice(1).some((part) => part.includes('*'))) return false
    return nameParts.slice(1).every((part, i) => part === hostParts[i + 1])
}

/** node 的比较用规范化：去空白、去 FQDN 末尾的点（node 的 `unfqdn`）。 */
function canonicalHost(value: string): string {
    return String(value).trim().replace(/\.$/, '')
}

/**
 * IP 的规范化（node 的 `canonicalizeIP` 的**常用子集**）：小写、去方括号。
 * ⚠️ 残余差异：node 还会把 IPv4-mapped IPv6（`::ffff:1.2.3.4`）折成 IPv4、
 * 以及展开零压缩形式；这两类极端写法在本实现里按字面比较。已登记在差异文档。
 */
function canonicalIp(value: string): string {
    return value.trim().replace(/^\[|\]$/g, '').toLowerCase()
}

export function checkServerIdentity(
    hostname: string,
    cert: PeerCertificateLike
): Error | undefined {
    // 规则与**错误文本**都照抄 node 的 `checkServerIdentity`（从内置源码读出，v22.11）：
    //   · 先解析 SAN（只认 `DNS:` / `IP Address:`）与 CN；
    //   · 主机是 IP ⇒ 只比 IP SAN；否则有 SAN 用 SAN，没有才回退 CN；
    //   · 都没有 ⇒ reason = 'Cert does not contain a DNS name'；
    //   · 失败一律 `ERR_TLS_CERT_ALTNAME_INVALID`，消息是
    //     `Hostname/IP does not match certificate's altnames: <reason>`，
    //     并带 `reason` / `host` / `cert` 三个属性（node 的构造器如此）。
    const san = parseSubjectAltName(cert.subjectaltname)
    const dnsNames = san
        .filter((entry) => entry.type === 'DNS' || entry.type === 'DNS Name')
        .map((entry) => entry.value)
    const ipNames = san.filter((entry) => entry.type === 'IP Address').map((entry) => canonicalIp(entry.value))

    const host = canonicalHost(hostname)
    const cn = cert.subject?.CN
    let valid = false
    let reason = 'Unknown reason'

    if (isIpAddress(host)) {
        valid = ipNames.includes(canonicalIp(host))
        if (!valid) reason = `IP: ${host} is not in the cert's list: ${ipNames.join(', ')}`
    } else if (dnsNames.length > 0 || cn) {
        if (dnsNames.length > 0) {
            valid = dnsNames.some((name) => wildcardMatch(host, name))
            // node 在这里回显**整条 SAN 字符串**，不是只列 DNS 项
            if (!valid) reason = `Host: ${host}. is not in the cert's altnames: ${cert.subjectaltname}`
        } else {
            valid = wildcardMatch(host, String(cn))
            if (!valid) reason = `Host: ${host}. is not cert's CN: ${cn}`
        }
    } else {
        reason = 'Cert does not contain a DNS name'
    }

    if (valid) return undefined
    const err = new Error(`Hostname/IP does not match certificate's altnames: ${reason}`) as Error & {
        code?: string
        reason?: string
        host?: string
        cert?: PeerCertificateLike
    }
    err.code = 'ERR_TLS_CERT_ALTNAME_INVALID'
    err.reason = reason
    err.host = host
    err.cert = cert
    return err
}
