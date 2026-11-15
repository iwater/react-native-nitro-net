/**
 * TLS 证书材料的边界归一化。
 *
 * Node 的 `tls` / `https` 接受 string、Buffer、TypedArray 和 ArrayBuffer；
 * 本包的 native `createSecureContext` 只收 string，PFX 只收 ArrayBuffer。
 * 用户照抄 `fs.readFileSync(...)` 时拿到的是 Buffer，必须在 JS 边界转换，
 * 否则会在 Nitro 调用处抛 “Value is an object, expected a String”。
 */

export type PemInput = string | ArrayBuffer | Uint8Array;

export function normalizePem(value: PemInput, label = 'PEM'): string {
    if (typeof value === 'string') return value;
    if (value instanceof ArrayBuffer) {
        return Buffer.from(value).toString('utf8');
    }
    if (ArrayBuffer.isView(value)) {
        return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('utf8');
    }
    throw new TypeError(`${label} must be a string, Buffer, TypedArray, or ArrayBuffer`);
}

export function toBinaryArrayBuffer(value: PemInput): ArrayBuffer {
    if (typeof value === 'string') {
        const buffer = Buffer.from(value);
        return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    }
    if (value instanceof ArrayBuffer) return value;
    if (ArrayBuffer.isView(value)) {
        return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
    }
    throw new TypeError('PFX must be a string, Buffer, TypedArray, or ArrayBuffer');
}
