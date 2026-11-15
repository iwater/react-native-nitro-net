/**
 * Agent 级建连参数合并（#50 / F10）。
 *
 * Node 的 `Agent.prototype.createSocket` 第一件事就是
 * `options = { __proto__: null, ...options, ...this.options }` —— 然后才用这份合并结果
 * 去算池键（`getName`）和建连（`createConnection`）。**agent 级字段覆盖请求级**，
 * 与直觉相反，node v24 实测：
 *   `agent.ca` 有效 + `req.ca` 无效 ⇒ 握手成功
 *   `agent.ca` 无效 + `req.ca` 有效 ⇒ 握手失败
 * 本包此前只在 `createConnection` 里读请求级字段，`new https.Agent({ ca })` 上的材料
 * 从未生效（axios 的 `httpsAgent` / node-fetch 的 `agent` 恰好只走这一条路）。
 *
 * 为什么不照抄那个 spread：`agent.options` 里还有 `maxSockets` / `scheduling` /
 * `h2MaxSessions` 这类**池的元数据**，整份塞进 connectOptions 会污染 native 建连参数
 * （node 自己为此专门在构造器里写 `this.options.path = null`，就是怕 `path` 被 net 当成
 * Unix socket 路径 —— 本包的 createConnection 索性不传 path，见 http.ts）。
 * 所以这里按**白名单**合并，白名单由 Agent 子类自己扩展。
 *
 * ⚠️ 语义细节：用 `hasOwnProperty` 而不是 `!== undefined` 判定「agent 显式给了这个字段」，
 * 这样 `new https.Agent({ ca: undefined })` 会把请求级 `ca` 冲掉 —— 与 node 的 spread 一致。
 */

/** `http.Agent` 也生效的字段：它们同时是池键的输入（node 的 getName 会读）。 */
export const HTTP_CONNECT_FIELDS: readonly string[] = ['localAddress', 'family'];

/**
 * `https.Agent` 追加的字段：纯 **TLS 信任/身份材料**，与 `tls.ConnectionOptions` 的
 * 消费面一致。
 *
 * 刻意**不含** `ALPNProtocols` / `forceHttp1` / `impersonate` / `profile` / `proxy`：
 * 前两个还牵动 H2 资格判定（`canUseHttp2` 读的是请求级 options），后两个本包已经有
 * 「请求级覆盖 agent 级」的既有优先级（有测试与文档锚定）。把它们一并翻转成 agent 胜出
 * 会连带改 H2 决策链，不属于本条缺陷的范围。
 */
export const TLS_CONNECT_FIELDS: readonly string[] = [
    'ca',
    'cert',
    'key',
    'pfx',
    'passphrase',
    'rejectUnauthorized',
    'servername',
    'checkServerIdentity',
];

/**
 * 返回「请求级 ⊕ agent 级」的有效建连参数；agent 级胜出（Node 语义）。
 * 不修改传入对象。返回值刻意是宽松的 `Record<string, any>`：调用方（http.ts）本来就以
 * `(options as any).ca` 的方式读这些字段，接口之间不做隐式索引签名转换。
 */
export function applyAgentConnectOverrides<T extends object>(
    requestOptions: T,
    agentOptions: object | undefined,
    fields: readonly string[],
): Record<string, any> {
    const out: Record<string, any> = { ...requestOptions };
    if (!agentOptions || typeof agentOptions !== 'object') return out;
    const bag = agentOptions as Record<string, any>;
    for (const field of fields) {
        if (Object.prototype.hasOwnProperty.call(bag, field)) {
            out[field] = bag[field];
        }
    }
    return out;
}
