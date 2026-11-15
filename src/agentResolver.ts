/**
 * 协议 → 全局 Agent 的解析。
 *
 * Node 的 `http.request` / `https.request` 在没有显式 `agent` 时分别使用
 * `http.globalAgent` / `https.globalAgent`。本包此前两者都落到 `http.globalAgent`，
 * 导致 `https.globalAgent` 的配置（keepAlive、proxy、自定义 Agent）永远不会生效。
 *
 * 这里把“选择哪一个”抽成不依赖原生模块的纯逻辑，便于单测。
 */

export function normalizeProtocol(protocol?: string): string {
    const value = protocol || 'http:';
    return value.endsWith(':') ? value.toLowerCase() : `${value.toLowerCase()}:`;
}

export class GlobalAgentRegistry<T> {
    private readonly agents = new Map<string, T>();
    private fallbackAgent?: T;

    setFallback(agent: T): void {
        this.fallbackAgent = agent;
    }

    set(protocol: string, agent: T): void {
        this.agents.set(normalizeProtocol(protocol), agent);
    }

    get(protocol?: string): T | undefined {
        return this.agents.get(normalizeProtocol(protocol)) ?? this.fallbackAgent;
    }

    resolve(
        protocol: string | undefined,
        agentOption: T | false | undefined,
        isAgent: (value: unknown) => value is T,
        createAgent: () => T
    ): T {
        if (agentOption === false) return createAgent();
        if (agentOption !== undefined && isAgent(agentOption)) return agentOption;

        const agent = this.get(protocol);
        if (agent === undefined) {
            throw new Error(`No global agent registered for protocol "${normalizeProtocol(protocol)}"`);
        }
        return agent;
    }
}
