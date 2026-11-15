/**
 * 运行时选 `EventEmitter` 基类：宿主有 `events` 就用宿主那份，没有才回退 `eventemitter3`。
 *
 * 动机：React Native 的运行时**没有** `events`（所以本包才带 eventemitter3），
 * 而某些无头宿主把 `events` 注册成了内建（vendored `events@3.3.0`）。
 * 后者下继续用 eventemitter3 是多余的，而且会带来一批实打实的问题：
 * `server instanceof require('events').EventEmitter` 为 false，
 * `setMaxListeners` / `getMaxListeners` / `prependListener` /
 * `prependOnceListener` / `rawListeners` 五个方法直接缺失（硬 `TypeError`）。
 *
 * ⚠️ 本文件**必须保持 CJS**（`module.exports` + `require`），不要改写成 ESM。
 * 在某些双模块机制宿主里 `import 'events'` 与 `require('events')` 可能是两个模块实例
 * （宿主有 `require` 与 ESM 两套模块缓存），改用 ESM import 后
 * `instanceof require('events').EventEmitter` **仍然是 false** ——
 * 等于修了个假。垫片之所以可行，正是因为它走 `require` 缓存，
 * 与用户代码 `require('events')` 命中同一份。
 *
 * ⚠️ 两层判定都要保留，缺一不可：
 *   - `try/catch`：宿主或打包器让 `require` 直接抛（Node、无头宿主、
 *     Metro 未开启 allowOptionalDependencies 时）。
 *   - `typeof EE !== 'function'` 兜底：Metro 的 `allowOptionalDependencies`
 *     会把**解析不到的可选依赖换成空模块**（`{}`），此时 `require` **不抛**，
 *     只是 `.EventEmitter` 是 `undefined`。只看 `catch` 会漏掉这一路。
 *
 * ⚠️ 导出的是**对象**而不是裸类：Metro 对 CJS 的具名导入取的是
 * `module.exports.<name>`（`_mod.EventEmitter`），导出裸类会取到 `undefined`。
 */
'use strict'

// 类型以宿主 `events` 的 EventEmitter 为准（`@types/node` 提供）：
// 这里**必须**有 JSDoc，否则 tsc 会把 EE 推断成 `null`，
// `class Server extends EventEmitter` 就丢掉整条方法面
// （实测：`Property 'emit' does not exist on type 'Server'` × 41）。
// 本文件是 .js，未开 checkJs ⇒ 下面这行不会因 null 赋值被报错，只用于推断。
/** @type {typeof import('events').EventEmitter} */
var EE = null

try {
  var hostEvents = require('events')
  // Node / events@3.x：`module.exports` 本身就是 EventEmitter，
  // 且 `EventEmitter.EventEmitter === EventEmitter`；这里两种形态都兼容。
  EE = hostEvents && (hostEvents.EventEmitter || hostEvents)
} catch (e) {
  EE = null
}

if (typeof EE !== 'function') {
  // 走到这里有两种情况：宿主没有 `events`（真回退），
  // 或宿主给了一个不含 EventEmitter 的空模块（Metro 可选依赖）。
  EE = require('eventemitter3').EventEmitter
}

module.exports = { EventEmitter: EE, default: EE }
