import * as net from './net'
import * as tls from './tls'
import * as http from './http'
import * as https from './https'
import { fetch } from './fetch'

export * from './net'
export {
    tls,
    http,
    https,
    fetch
}

// `fetch` 在具名导出里有，default 里漏了 → `import net from '...'; net.fetch` 是 undefined。
// 其余具名导出（`export * from './net'`）已经进了 default 的展开，不用再列。
//
// 这里必须**显式写类型**：直接 `export default { ...net, tls, http, https, fetch }`
// 会让 TS 为这个对象字面量推一个匿名类型，而 `fetch` 返回的 `FetchResponse` 是
// fetch.ts 里未导出的类且带 private 成员 —— 声明产物写不出来，报
// TS4082 / TS4094（`_body`、`headers` 不可见于 .d.ts）。改用 `typeof` 组合出的
// 具名类型后，.d.ts 里引用的是 `typeof import('./fetch').fetch`，不再内联匿名类。
type NitroNet = typeof net & {
    tls: typeof tls;
    http: typeof http;
    https: typeof https;
    fetch: typeof fetch;
};

const nitroNet: NitroNet = {
    ...net,
    tls,
    http,
    https,
    fetch,
};

export default nitroNet;
