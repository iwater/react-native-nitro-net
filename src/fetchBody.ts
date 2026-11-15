// `stream` 说明符的选择见 `net.ts` 顶部（#51：宿主内建表与 RN 的 npm 别名同一份实现）
import { Readable } from 'stream';

export type FetchBodySource = Uint8Array | Readable;

function isReadable(value: FetchBodySource): value is Readable {
  return typeof (value as any).on === 'function' && typeof (value as any).once === 'function';
}

function toBytes(chunk: any): Uint8Array {
  if (chunk instanceof Uint8Array) return new Uint8Array(chunk);
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  return new Uint8Array(Buffer.from(chunk));
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * 一个可被 clone 共享的 body 源。
 *
 * 多个 FetchBody 共享同一份读取结果：clone 后两个 body 都能读到完整内容，
 * 但底层 Readable 只会被消费一次。真正的多路流式 tee 不在当前范围内。
 */
type ContentDecoder = (data: Uint8Array) => Uint8Array;

class SharedBody {
  private source: FetchBodySource | null;
  private readonly decoder?: ContentDecoder;
  private bytes?: Uint8Array;
  private pending?: Promise<Uint8Array>;
  private error?: Error;
  private closed = false;
  private ended = false;
  private activeReject?: (err: Error) => void;
  private activeSource?: Readable;

  constructor(source: FetchBodySource, decoder?: ContentDecoder) {
    this.source = source;
    this.decoder = decoder;

    if (isReadable(source)) {
      // 提前挂 error 监听，避免响应流在调用方读取前报错时变成未捕获异常。
      source.once('error', (err: Error) => {
        this.error = err;
        this.activeReject?.(err);
      });
      source.once('close', () => {
        this.closed = true;
        if (!this.ended) {
          this.activeReject?.(new Error('Premature close'));
        }
      });
    }
  }

  read(): Promise<Uint8Array> {
    if (this.bytes) return Promise.resolve(this.bytes);
    if (this.pending) return this.pending;
    if (this.error) return Promise.reject(this.error);
    if (this.closed && !this.ended) return Promise.reject(new Error('Premature close'));

    const source = this.source;
    this.source = null;
    if (source === null) return Promise.reject(new Error('Body source already consumed'));

    if (!isReadable(source)) {
      try {
        this.bytes = source.length === 0 || !this.decoder ? source : this.decoder(source);
      } catch (err) {
        this.error = err as Error;
        return Promise.reject(err);
      }
      return Promise.resolve(this.bytes);
    }

    this.activeSource = source;
    this.pending = new Promise<Uint8Array>((resolve, reject) => {
      const chunks: Uint8Array[] = [];
      let settled = false;

      const cleanup = () => {
        source.removeListener('data', onData);
        source.removeListener('end', onEnd);
        source.removeListener('error', onError);
        source.removeListener('close', onClose);
        this.activeReject = undefined;
        this.activeSource = undefined;
      };

      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };

      const onData = (chunk: any) => chunks.push(toBytes(chunk));
      const onEnd = () => settle(() => {
        this.ended = true;
        try {
          const raw = concat(chunks);
          this.bytes = raw.length === 0 || !this.decoder ? raw : this.decoder(raw);
          resolve(this.bytes);
        } catch (err) {
          this.error = err as Error;
          reject(err);
        }
      });
      const onError = (err: Error) => settle(() => {
        this.error = err;
        reject(err);
      });
      const onClose = () => settle(() => reject(new Error('Premature close')));

      this.activeReject = (err: Error) => settle(() => {
        this.error = err;
        reject(err);
      });

      source.on('data', onData);
      source.once('end', onEnd);
      source.once('error', onError);
      source.once('close', onClose);
      if (typeof (source as any).resume === 'function') (source as any).resume();
    });

    return this.pending;
  }

  destroy(err?: Error): void {
    const reason = err ?? new Error('Body destroyed');
    this.error = reason;
    this.activeReject?.(reason);
    if (this.activeSource && typeof (this.activeSource as any).destroy === 'function') {
      (this.activeSource as any).destroy(reason);
    } else if (this.source && isReadable(this.source)) {
      (this.source as any).destroy(reason);
    }
  }
}

export class FetchBody {
  private readonly shared: SharedBody;
  private _bodyUsed = false;

  constructor(source: FetchBodySource, shared?: SharedBody, decoder?: ContentDecoder) {
    this.shared = shared ?? new SharedBody(source, decoder);
  }

  get bodyUsed(): boolean {
    return this._bodyUsed;
  }

  clone(): FetchBody {
    return new FetchBody(new Uint8Array(0), this.shared);
  }

  private consume(): Promise<Uint8Array> {
    if (this._bodyUsed) {
      return Promise.reject(new TypeError('Body is unusable: body has already been read'));
    }
    this._bodyUsed = true;
    return this.shared.read();
  }

  async text(): Promise<string> {
    return new TextDecoder().decode(await this.consume());
  }

  async json(): Promise<any> {
    const text = await this.text();
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    const bytes = await this.consume();
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }

  async blob(mimeType = 'text/plain'): Promise<Blob> {
    const bytes = await this.consume();
    return new Blob([bytes as any], { type: mimeType });
  }

  destroy(err?: Error): void {
    this.shared.destroy(err);
  }
}
