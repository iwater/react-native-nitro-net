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
// 【RN 环境】恒有 `URL`，两个函数等价于 `x instanceof URL` / 直接返回 `URL`，无行为差异。
//
// 【教训：两个客户端都要改】
// 本文件是"一处收口"的原因：`http.ts` 与 `https.ts` 各有一份 `new URL` / `instanceof URL`
// 的拷贝。2026-09-20 只修了 http 侧，`https.request({...})` 便一直以
// `URL is not defined` 同步失败（qjs 实测）。改这类判断时**两个文件一起查**
// （`grep -n '\bURL\b' src/*.ts`）。
//
// 【已知未覆盖】`fetch.ts` 的**重定向**分支用 `new URL(location, url)` 做相对地址解析，
// 在无 URL 宿主下仍会抛。走重定向才触发，暂未处理（fetch 在 qjs 下另有未验证项）。

/** `x instanceof URL`，但在没有全局 `URL` 的宿主上安全返回 false。 */
export function isURLLike(x: unknown): x is URL {
    return typeof URL !== 'undefined' && x instanceof URL
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
