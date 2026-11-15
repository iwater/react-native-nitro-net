// 全局 `URL` 的存在性守卫 —— 所有需要 `instanceof URL` / `new URL()` 的地方共用。
//
// 【为什么需要】
// 有些宿主没有全局 `URL`（例如无头 JS 宿主：URL polyfill 未在宿主侧提供）。
// 此时裸写 `x instanceof URL` 会在**判断本身**抛 ReferenceError —— 连"传 options 对象"
// 这种完全不需要 URL 的用法都会炸。
//
// 【为什么不能内联成 `typeof URL !== 'undefined' && x instanceof URL`】
// 那会让 TS 在 else 分支无法把 `URL` 从联合类型里收窄掉（实测报 TS2322）。
// 类型谓词函数两边都成立。
//
// 【RN 环境】恒有全局 `URL`，且只有一个实现，`requireGlobalURL` 直接返回它；`isURLLike`
// 的全局分支就够用（跨 realm 传进来的 URL 实例走第二条判据，行为与 node 一致）。
//
// 【教训：两个客户端都要改】
// 本文件是"一处收口"的原因：`http.ts` 与 `https.ts` 各有一份 `new URL` / `instanceof URL`
// 的拷贝。2026-09-20 只修了 http 侧，`https.request({...})` 便一直以
// `URL is not defined` 同步失败（在无全局 URL 宿主下实测）。改这类判断时**两个文件一起查**
// （`grep -n '\bURL\b' src/*.ts`）。
//
// 【已知未覆盖】`fetch.ts` 的**重定向**分支用 `new URL(location, url)` 做相对地址解析，
// 在无 URL 宿主下仍会抛。走重定向才触发，暂未处理。

/**
 * `x` 是不是 URL 实例，但在没有全局 `URL` 的宿主上安全返回 false。
 *
 * 【为什么不能只 `instanceof URL`】某些宿主上有**两个** URL 类：`require('url').URL !== globalThis.URL`
 * （实测两个类的实例 own 键都是 `_p`/`_sp`）。只认全局那个时，url 模块的实例会掉进
 * 「options 对象」分支，紧接着 `{ ...urlOrOptions, ...options }` 的展开**只拷 own  enumerable 键**
 * （`_p`/`_sp`）⇒ hostname/port 全丢，请求打到 `127.0.0.1:80`，症状是 ECONNREFUSED 而不是「端口不对」。
 *
 * 【判据边界（node v22.11 实跑）】`new URL()` ⇒ 按 URL 解析；`url.parse()` 的老式对象 ⇒ 按
 * options 解析（它的 `hostname/port/path` 本来就是合法 options）；裸 `{href}` ⇒ 按 options 解析
 * （ECONNREFUSED，不会去读 href）。所以补的鸭子判据必须带 `searchParams`，只看 `href` 会放行后两者。
 */
export function isURLLike(x: unknown): x is URL {
    if (typeof URL !== 'undefined' && x instanceof URL) {
        return true
    }
    if (x === null || typeof x !== 'object') {
        return false
    }
    const candidate = x as Record<PropertyKey, unknown>
    return candidate[Symbol.toStringTag] === 'URL'
        && typeof candidate.href === 'string'
        && candidate.searchParams !== undefined
}

/** 取全局 `URL` 构造器；没有就抛带明确信息的 TypeError（而不是 ReferenceError）。 */
export function requireGlobalURL(caller: string = 'URL'): typeof URL {
    if (typeof URL === 'undefined') {
        throw new TypeError(
            `${caller}: the global \`URL\` is not available in this host, `
            + 'so a string URL cannot be parsed — pass an options object instead',
        )
    }
    return URL
}

/**
 * 从 URL 的 username/password 组出 `options.auth`（Node 的 `urlToHttpOptions` 同款）。
 *
 * 【为什么必须显式做】实测 Node：`http.request('http://u:p@host/')` 会发
 * `Authorization: Basic dTpw`。而那条头只在 `options.auth` 有值时才生成 ——
 * URL→options 的展开里不写这一行，凭据就**整段丢掉**（表现是 401，看不出根因）。
 * `http.ts` 有「字符串 URL」「URL 对象」两处、`https.ts` 同样两处，
 * 少任何一处都会出现「同一个库换个写法就掉凭据」，所以收在这里。
 *
 * 【规则（node 实测）】username / password 任一非空才拼；两段各做 `decodeURIComponent`
 * （`http://u%40x:p%3Fss@h/` → `auth: "u@x:p?ss"`）；password 为空时**保留冒号**（`"u:"`）。
 */
export function urlBasicAuth(u: { username?: string; password?: string }): string | undefined {
    const username = u.username || ''
    const password = u.password || ''
    if (username === '' && password === '') return undefined
    return `${decodeURIComponent(username)}:${decodeURIComponent(password)}`
}
