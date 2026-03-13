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
 * @param tag The tag to identify the source (e.g., 'HTTP', 'NET', 'TLS')
 * @param message The message to log
 */
export function debugLog(tag: string, message: string) {
    if (_isVerbose) {
        const timestamp = new Date().toISOString().split('T')[1].split('Z')[0];
        console.log(`[${tag} DEBUG ${timestamp}] ${message}`);
    }
}
