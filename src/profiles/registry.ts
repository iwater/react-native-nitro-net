import { validateProfile } from './validate';
import { BUILTIN_PROFILES } from './chrome';
import type { ChromeTlsProfile } from './types';
import {
    DEFAULT_CONFIG,
    type ImpersonationConfig,
    type ImpersonationRequestOptions,
    type ProfileLookup,
} from '../impersonation';

/**
 * impersonate 的**有状态**部分：全局配置、profile 注册表、原生能力探测。
 * 纯逻辑在 `src/impersonation.ts`（这样纯 node 单测能直接 import）。
 */

const profiles = new Map<string, ChromeTlsProfile>(Object.entries(BUILTIN_PROFILES));
let config: ImpersonationConfig = { ...DEFAULT_CONFIG };
let availabilityProbe: (() => boolean) | null = null;
let http2Probe: (() => boolean) | null = null;

function errWithCode(code: string, message: string): Error {
    const err = new Error(message) as Error & { code?: string };
    err.code = code;
    return err;
}

/** 由 tls.ts 在 import 时注入：读取原生是否编译了 impersonate feature。 */
export function setImpersonationAvailabilityProbe(probe: (() => boolean) | null): void {
    availabilityProbe = probe;
}

export function isImpersonationAvailable(): boolean {
    if (!availabilityProbe) return false;
    try {
        return !!availabilityProbe();
    } catch {
        return false;
    }
}

/** 由 http2Session.ts 在 import 时注入。 */
export function setHttp2AvailabilityProbe(probe: (() => boolean) | null): void {
    http2Probe = probe;
}

/** 原生是否带 HTTP/2 引擎；false 时所有请求保持 M1 的 H1 行为。 */
export function isHttp2Available(): boolean {
    if (!http2Probe) return false;
    try {
        return !!http2Probe();
    } catch {
        return false;
    }
}

function validatePatterns(value: unknown, field: string): string[] {
    if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || v.length === 0)) {
        throw errWithCode('ERR_INVALID_ARG_VALUE', `${field} must be an array of non-empty strings`);
    }
    return value.slice();
}

export interface ConfigureOptions {
    impersonate?: false | true | 'chrome';
    profile?: string;
    match?: string[];
    exclude?: string[];
    headerPolicy?: 'profile-first' | 'user-first';
    overrideHeaders?: boolean;
}

export function configure(options: ConfigureOptions = {}): void {
    const next: ImpersonationConfig = { ...config };

    if (options.impersonate !== undefined) {
        if (options.impersonate !== false && options.impersonate !== true && options.impersonate !== 'chrome') {
            throw errWithCode('ERR_INVALID_ARG_VALUE', `unsupported impersonate value: ${String(options.impersonate)}`);
        }
        next.impersonate = options.impersonate === false ? false : 'chrome';
    }
    if (options.profile !== undefined) {
        if (typeof options.profile !== 'string' || !profiles.has(options.profile)) {
            throw errWithCode('ERR_UNKNOWN_PROFILE', `unknown impersonation profile: ${String(options.profile)}`);
        }
        next.profile = options.profile;
    }
    if (options.match !== undefined) next.match = validatePatterns(options.match, 'match');
    if (options.exclude !== undefined) next.exclude = validatePatterns(options.exclude, 'exclude');
    if (options.headerPolicy !== undefined) {
        if (options.headerPolicy !== 'profile-first' && options.headerPolicy !== 'user-first') {
            throw errWithCode('ERR_INVALID_ARG_VALUE', `unsupported headerPolicy: ${String(options.headerPolicy)}`);
        }
        next.headerPolicy = options.headerPolicy;
    }
    if (options.overrideHeaders !== undefined) next.overrideHeaders = !!options.overrideHeaders;

    config = next;
}

/** 供 tls.ts / Agent 读取（不要在应用代码里直接改返回对象）。 */
export function getImpersonationConfig(): ImpersonationConfig {
    return config;
}

export function listProfiles(): string[] {
    return [...profiles.keys()];
}

/** 注册自定义 profile（会走与内置 profile 相同的校验）。 */
export function defineProfile(json: unknown): ChromeTlsProfile {
    const profile = validateProfile(json);
    profiles.set(profile.id, profile);
    return profile;
}

export const lookupProfile: ProfileLookup = (id) => profiles.get(id);

export type { ImpersonationRequestOptions };
