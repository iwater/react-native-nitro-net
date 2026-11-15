import type { ImpersonationConnectOptions } from './impersonation'

/**
 * 一次请求能否走 H2（纯函数，无内部 value import）。
 *
 * 设计 §4.2/§5.4：显式 forceHttp1、ALPN 排除 h2、Upgrade/CONNECT，以及 H2 无法
 * 映射的 JS 回调（lookup/createConnection/checkServerIdentity）都必须留在 H1。
 */
export interface H2EligibilityRequestOptions {
    socketPath?: unknown
    createConnection?: unknown
    lookup?: unknown
    checkServerIdentity?: unknown
}

export function canUseHttp2(
    method: string,
    impersonation: ImpersonationConnectOptions | null,
    options: H2EligibilityRequestOptions,
    available: boolean
): boolean {
    if (!impersonation || !available) return false
    if (impersonation.forceHttp1) return false
    if (!impersonation.profileData.tls.alpn.includes('h2')) return false
    if (method.toUpperCase() === 'CONNECT') return false
    if (options.socketPath) return false
    if (options.createConnection) return false
    if (options.lookup) return false
    if (options.checkServerIdentity) return false
    return true
}


const H2_RETRYABLE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE'])

/**
 * `REFUSED_STREAM` 只允许幂等且未发送 body 的请求重试一次（设计 §5.3）。
 * 有 body 的请求没有缓冲，无法安全重放。
 */
export function canRetryH2Request(
    method: string,
    code: string | undefined,
    retries: number,
    bodySent: boolean
): boolean {
    return (
        code === 'ERR_HTTP2_REFUSED_STREAM' &&
        retries < 1 &&
        !bodySent &&
        H2_RETRYABLE_METHODS.has(method.toUpperCase())
    )
}
