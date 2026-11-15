type TickHost = { nextTick?: (...args: any[]) => void } | null;

/**
 * `process.nextTick` 的宿主兼容壳。
 *
 * React Native 的 `process` 只注入 `env`（没有 `nextTick`）；其他无头宿主可能有完整的
 * `process.nextTick`。直接在 RN 里调用会抛 `TypeError: process.nextTick is not a
 * function` —— T4 设备页实测触发点在 `tls.ts` 的 secureConnect 延迟（#79 引入），
 * 同一形态的裸调用在 net/http 里还有几处，所以统一走这里。
 *
 * 语义：Node 的 nextTick 在**当前调用栈结束后、微任务之前**执行。没有它时取
 * `queueMicrotask`（同属微任务，最接近），再退到 Promise（Hermes 一定有）。
 * 每次调用时探测；测试通过 `__setNextTickHostForTest` 模拟 RN 形态（不能去改
 * 全局 `process` —— node 的 test runner 自己也用 nextTick，会被一起打瘫）。
 */

let hostOverride: TickHost | undefined;

export function __setNextTickHostForTest(host: TickHost | undefined): void {
    hostOverride = host;
}

export function nextTick(fn: (...args: any[]) => void, ...args: any[]): void {
    const host = hostOverride !== undefined
        ? hostOverride
        : (typeof process !== 'undefined' ? (process as any) : undefined);
    if (host && typeof host.nextTick === 'function') {
        host.nextTick(fn, ...args);
        return;
    }
    const run = () => fn(...args);
    if (typeof queueMicrotask === 'function') {
        queueMicrotask(run);
        return;
    }
    Promise.resolve().then(run);
}
