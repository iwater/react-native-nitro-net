import * as net from './net'
import * as tls from './tls'
import * as http from './http'
import * as https from './https'
import * as http2 from './http2'
import { fetch, FetchHeaders, FetchResponse } from './fetch'
import { setZlibProvider, getZlibProvider } from './contentDecoder'
import { Http2Session, Http2SessionError } from './http2Session'
import {
    configure,
    defineProfile,
    listProfiles,
    isImpersonationAvailable,
    isHttp2Available,
} from './profiles/registry'

export * from './net'
export {
    tls,
    http,
    https,
    http2,
    fetch,
    // ⚠️ 这两个类**必须**从包入口导出：宿主要把它们挂成全局 `Headers`/`Response`
    // （供无头宿主环境在启动期挂载全局），而 `fetch()` 返回的 `res.headers` /
    // `res` 就是这两个类的实例。若全局用另一份实现，
    // `res instanceof Response` / `res.headers instanceof Headers` 会是 false。
    FetchHeaders,
    FetchResponse,
    setZlibProvider,
    getZlibProvider,
    configure,
    defineProfile,
    listProfiles,
    isImpersonationAvailable,
    isHttp2Available,
    Http2Session,
    Http2SessionError,
}

// `fetch` 在具名导出里有，default 里漏了 → `import net from '...'; net.fetch` 是 undefined。
// 其余具名导出（`export * from './net'`）已经进了 default 的展开，不用再列。
//
// 这里必须**显式写类型**：直接 `export default { ...net, tls, http, https, fetch }`
// 会让 TS 为这个对象字面量推一个匿名类型，而 `fetch` 返回的 `FetchResponse` 带
// private 成员 —— 匿名类型在 .d.ts 里写不出来，报 TS4082 / TS4094。
// （`FetchResponse` 已改成具名导出，理论上匿名类型也能引用它；但显式写类型更稳，
// 也顺带把 default 的形状钉死，不随实现漂移。）
type NitroNet = typeof net & {
    tls: typeof tls;
    http: typeof http;
    https: typeof https;
    http2: typeof http2;
    fetch: typeof fetch;
    FetchHeaders: typeof FetchHeaders;
    FetchResponse: typeof FetchResponse;
    configure: typeof configure;
    defineProfile: typeof defineProfile;
    listProfiles: typeof listProfiles;
    isImpersonationAvailable: typeof isImpersonationAvailable;
    isHttp2Available: typeof isHttp2Available;
    Http2Session: typeof Http2Session;
    Http2SessionError: typeof Http2SessionError;
};

const nitroNet: NitroNet = {
    ...net,
    tls,
    http,
    https,
    http2,
    fetch,
    FetchHeaders,
    FetchResponse,
    configure,
    defineProfile,
    listProfiles,
    isImpersonationAvailable,
    isHttp2Available,
    Http2Session,
    Http2SessionError,
};

export default nitroNet;
