/**
 * `AgentOptions.timeout` 的语义（对照 Node v22.11 实测，见
 * 针对 Agent 空闲 socket 超时的精确控制（实测与 Node.js 行为对齐）：
 *
 * 1. `new Agent({ timeout: N })` ⇒ agent 新建的**每条** socket 都被 `setTimeout(N)`；
 *    `agent.timeout` 本身在 Node 里读不回（构造选项只进内部符号槽），本库保留可读，
 *    是 Node 面的超集。
 * 2. 超时只对**空闲** socket 销毁连接（Node 的 `onSocketCloseTimeout`）。在途请求
 *    只会收到 `'timeout'` 事件，socket **不**被销毁 —— 这是 Node 的著名坑：
 *    `http.get(url, { timeout })` 光设超时并不会中止请求。
 * 3. `timeout: 0` 与缺省等价 ⇒ 完全不武装（实测 Node 这种 socket 的
 *    `socket.timeout === undefined`）。小数原样传下去（实测 1234.7 不截断）。
 * 4. 负数 / NaN / Infinity ⇒ `ERR_OUT_OF_RANGE`。Node 是在 `createSocket()` 里由
 *    `socket.setTimeout()` 抛的，而它的 `agent.addRequest()` 就在 `ClientRequest`
 *    构造里同步调用 ⇒ 表面看是 `http.get()` 同步抛。本库的 `addRequest` 走
 *    `nextTick`，同样的抛点会穿过 native→JS 边界变成未捕获异常（无头宿主实测
 *    exit 134），所以校验**提前到 Agent 构造期**。
 */

function errWithCode(Ctor: new (message: string) => Error, code: string, message: string): Error {
    const err = new Ctor(message) as Error & { code?: string };
    err.code = code;
    return err;
}

/** agent 只需要 socket 的这三个动作（真 `net.Socket` / `tls.TLSSocket` 都满足）。 */
export interface AgentTimeoutSocket {
    setTimeout(msecs: number): unknown;
    on(event: string, listener: () => void): unknown;
    destroy(): unknown;
}

/**
 * 归一并校验 `AgentOptions.timeout`。
 * @returns 要下发给 socket 的毫秒数；`undefined` 表示不武装。
 */
export function validateAgentTimeout(timeout: number | undefined): number | undefined {
    if (timeout === undefined || timeout === 0) return undefined;
    if (typeof timeout !== 'number' || !isFinite(timeout) || timeout < 0) {
        throw errWithCode(
            RangeError,
            'ERR_OUT_OF_RANGE',
            `The value of "timeout" is out of range. It must be a non-negative finite number. Received ${String(timeout)}`,
        );
    }
    return timeout;
}

/**
 * 给 agent 新建的 socket 套上超时，并按 Node 语义只在空闲时销毁。
 * `timeout` 未武装时**完全不碰** socket（不多挂监听、不改 socket.timeout）。
 */
export function armAgentSocketTimeout(
    socket: AgentTimeoutSocket,
    timeout: number | undefined,
    isIdle: () => boolean,
): void {
    const msecs = validateAgentTimeout(timeout);
    if (msecs === undefined) return;
    socket.setTimeout(msecs);
    socket.on('timeout', () => {
        if (isIdle()) socket.destroy();
    });
}
