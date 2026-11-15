import type { ChromeTlsProfile } from './profiles/types';

/**
 * impersonate 的**纯逻辑**：匹配、优先级、forceHttp1 判定。
 *
 * 这里刻意不 import `profiles/validate` / `profiles/chrome` 的**值**：
 * 纯 node 单测要能直接 import 本模块（本仓源码用无扩展名 import，node 解析不了）。
 * profile 的查找通过 `ProfileLookup` 注入；有状态的 `configure/defineProfile`
 * 在 `profiles/registry.ts`。
 */

export type ImpersonateOption = false | 'chrome';

export interface ImpersonationConfig {
    impersonate: ImpersonateOption;
    profile?: string;
    match?: string[];
    exclude?: string[];
    headerPolicy: 'profile-first' | 'user-first';
    overrideHeaders: boolean;
}

export const DEFAULT_CONFIG: ImpersonationConfig = {
    impersonate: false,
    headerPolicy: 'profile-first',
    overrideHeaders: false,
};

export interface ImpersonationRequestOptions {
    impersonate?: boolean | ImpersonateOption;
    profile?: string;
    forceHttp1?: boolean;
    alpnProtocols?: string[];
    headers?: Record<string, string> | Array<[string, string]>;
}

export type ProfileLookup = (id: string) => ChromeTlsProfile | undefined;

export interface ResolvedImpersonation {
    enabled: boolean;
    profileId?: string;
    profile?: ChromeTlsProfile;
    forceHttp1: boolean;
    headerPolicy: 'profile-first' | 'user-first';
    overrideHeaders: boolean;
}

function errWithCode(code: string, message: string): Error {
    const err = new Error(message) as Error & { code?: string };
    err.code = code;
    return err;
}

function splitHostPort(value: string): { host: string; port?: string } {
    const text = value.trim().toLowerCase();
    if (text.startsWith('[')) {
        const end = text.indexOf(']');
        if (end >= 0) {
            const rest = text.slice(end + 1);
            return rest.startsWith(':') ? { host: text.slice(0, end + 1), port: rest.slice(1) } : { host: text };
        }
    }
    const colon = text.lastIndexOf(':');
    if (colon > 0 && /^\d+$/.test(text.slice(colon + 1))) {
        return { host: text.slice(0, colon), port: text.slice(colon + 1) };
    }
    return { host: text };
}

/**
 * `match`/`exclude` 的 host 匹配：`*` 匹配全部；`*.example.com` 同时匹配 apex；
 * pattern 带端口时要求端口一致，否则只比 host。
 */
export function matchHost(pattern: string, host: string): boolean {
    const p = splitHostPort(pattern);
    const h = splitHostPort(host);
    if (p.port !== undefined && p.port !== h.port) return false;
    if (p.host === '*') return true;
    if (p.host.startsWith('*.')) {
        const apex = p.host.slice(2);
        return h.host === apex || h.host.endsWith(`.${apex}`);
    }
    return p.host === h.host;
}

function headerEntries(
    headers: Record<string, string> | Array<[string, string]> | undefined
): Array<[string, string]> {
    if (!headers) return [];
    return Array.isArray(headers) ? headers : Object.entries(headers);
}

function hasUpgradeHeader(headers: ImpersonationRequestOptions['headers']): boolean {
    return headerEntries(headers).some(([name, value]) => {
        const key = String(name).toLowerCase();
        if (key === 'upgrade') return true;
        return key === 'connection' && String(value).toLowerCase().includes('upgrade');
    });
}

/**
 * 解析一次请求是否走 impersonate。
 *
 * 优先级：请求/Agent 显式设置 > 全局开关 > match/exclude > 默认关闭。
 * - 显式开启**绕过** `match`，但仍受 `exclude` 约束（命中即报错，避免误配）。
 * - 全局开启时 `exclude` 直接返回 disabled（静默跳过）。
 */
export function resolveImpersonation(
    config: ImpersonationConfig,
    host: string,
    opts: ImpersonationRequestOptions = {},
    lookup: ProfileLookup,
    available: boolean
): ResolvedImpersonation {
    const base: ResolvedImpersonation = {
        enabled: false,
        forceHttp1: false,
        headerPolicy: config.headerPolicy,
        overrideHeaders: config.overrideHeaders,
    };

    if (opts.impersonate === false) return base;

    const explicit = opts.impersonate === true || opts.impersonate === 'chrome';
    const globallyEnabled = config.impersonate === 'chrome';
    if (!explicit && !globallyEnabled) return base;

    const excluded = (config.exclude ?? []).some((pattern) => matchHost(pattern, host));
    if (excluded) {
        if (explicit) {
            throw errWithCode(
                'ERR_IMPERSONATION_EXCLUDED',
                `host ${host} is excluded from impersonation by config.exclude`
            );
        }
        return base;
    }
    if (!explicit && config.match && config.match.length > 0) {
        if (!config.match.some((pattern) => matchHost(pattern, host))) return base;
    }

    if (!available) {
        throw errWithCode(
            'ERR_IMPERSONATION_UNAVAILABLE',
            'impersonation is not available in this native build (compiled without the impersonate feature)'
        );
    }

    const profileId = opts.profile ?? config.profile ?? 'chrome';
    const profile = lookup(profileId);
    if (!profile) {
        throw errWithCode('ERR_UNKNOWN_PROFILE', `unknown impersonation profile: ${profileId}`);
    }

    const forceHttp1 =
        opts.forceHttp1 === true ||
        (Array.isArray(opts.alpnProtocols) && !opts.alpnProtocols.includes('h2')) ||
        hasUpgradeHeader(opts.headers);

    return {
        enabled: true,
        profileId,
        profile,
        forceHttp1,
        headerPolicy: config.headerPolicy,
        overrideHeaders: config.overrideHeaders,
    };
}

export interface ImpersonationConnectOptions {
    impersonate: 'chrome';
    profile: string;
    profileData: ChromeTlsProfile;
    forceHttp1: boolean;
    headerPolicy: 'profile-first' | 'user-first';
    overrideHeaders: boolean;
}

/**
 * 合并 Agent 级与请求级选项（请求级优先），返回要透传给 native 的连接选项；
 * 不走 impersonate 时返回 null。
 */
export function buildImpersonationConnectOptions(
    agentOptions: ImpersonationRequestOptions | undefined,
    requestOptions: ImpersonationRequestOptions | undefined,
    host: string,
    config: ImpersonationConfig,
    lookup: ProfileLookup,
    available: boolean
): ImpersonationConnectOptions | null {
    const agent = agentOptions ?? {};
    const request = requestOptions ?? {};
    const pick = <K extends keyof ImpersonationRequestOptions>(key: K): ImpersonationRequestOptions[K] =>
        request[key] !== undefined ? request[key] : agent[key];

    const resolved = resolveImpersonation(
        config,
        host,
        {
            impersonate: pick('impersonate'),
            profile: pick('profile'),
            forceHttp1: pick('forceHttp1'),
            alpnProtocols: pick('alpnProtocols'),
            // 两层的头都看（Upgrade 可能来自任意一层）
            headers: [...headerEntries(agent.headers), ...headerEntries(request.headers)],
        },
        lookup,
        available
    );

    if (!resolved.enabled) return null;
    return {
        impersonate: 'chrome',
        profile: resolved.profileId!,
        profileData: resolved.profile!,
        forceHttp1: resolved.forceHttp1,
        headerPolicy: resolved.headerPolicy,
        overrideHeaders: resolved.overrideHeaders,
    };
}
