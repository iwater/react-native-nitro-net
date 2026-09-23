/**
 * Global verbosity state for debugging.
 */
let _isVerbose = false;

/**
 * Checks if verbose debugging is enabled.
 */
export function isVerbose(): boolean {
    return _isVerbose;
}

/**
 * Enables or disables verbose debugging.
 */
export function setVerbose(enabled: boolean): void {
    _isVerbose = enabled;
}

/**
 * Logs a debug message with a timestamp and tag if verbosity is enabled.
 *
 * `message` 可以是字符串，也可以是一个 **thunk**（`() => string`）。
 * 热路径（每个数据包／每次写）必须传 thunk：`debugLog('NET', \`len=${n}\`)` 这种写法
 * 即使 verbose 关闭也会**每次都拼出字符串**（模板字面量的求值发生在调用之前），
 * 在高频路径上就是纯粹的垃圾。
 *
 * @param tag The tag to identify the source (e.g., 'HTTP', 'NET', 'TLS')
 * @param message The message to log, or a function that builds it lazily
 */
export function debugLog(tag: string, message: string | (() => string)) {
    if (_isVerbose) {
        const timestamp = new Date().toISOString().split('T')[1].split('Z')[0];
        console.log(`[${tag} DEBUG ${timestamp}] ${typeof message === 'function' ? message() : message}`);
    }
}
