import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { GtmError } from '../core/types';

/** One Chrome DevTools Protocol connection (browser or page target) over a WebSocket. */
export class CdpConnection extends EventEmitter {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; method: string }>();
  private closed = false;

  private constructor(private readonly socket: WebSocket) {
    super();
    socket.on('message', (data) => this.onMessage(String(data)));
    socket.on('close', () => this.onClose());
    socket.on('error', (error) => this.emit('error', error));
  }

  static async connect(url: string): Promise<CdpConnection> {
    const socket = new WebSocket(url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', (error) => reject(new GtmError(`Could not connect to the browser at ${url}: ${error.message}`)));
    });
    return new CdpConnection(socket);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Send a command, optionally to a flattened session (`Target.attachToTarget` with `flatten: true`). */
  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    if (this.closed) return Promise.reject(new GtmError('The browser connection is closed.'));
    const id = this.nextId++;
    const message = JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) });
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: Record<string, unknown>) => void, reject, method });
      this.socket.send(message, (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  close(): void {
    if (this.closed) return;
    this.socket.close();
    this.onClose();
  }

  private onMessage(text: string): void {
    let message: { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { message?: string }; sessionId?: string };
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new GtmError(`${waiter.method}: ${message.error.message ?? 'CDP error'}`));
      else waiter.resolve(message.result ?? {});
      return;
    }
    if (message.method) this.emit('event', { method: message.method, params: message.params ?? {}, sessionId: message.sessionId });
  }

  private onClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.pending.values()) waiter.reject(new GtmError('The browser connection closed.'));
    this.pending.clear();
    this.emit('close');
  }
}

export interface CdpEvent {
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly sessionId?: string;
}
