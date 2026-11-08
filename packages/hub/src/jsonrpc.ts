/**
 * Newline-delimited JSON-RPC 2.0 over a pair of streams.
 *
 * ACP transports messages as one JSON object per line on stdin/stdout
 * (not LSP's Content-Length framing). This class owns the correlation of
 * requests to responses, dispatching of inbound notifications, and serving
 * inbound requests that the agent sends back to the client.
 */
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type {
  JsonRpcError,
  JsonRpcId,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
} from './types.js';

export type RequestHandler = (
  method: string,
  params: unknown,
) => Promise<unknown> | unknown;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

export interface JsonRpcOptions {
  /** Default timeout for outbound requests. 0 disables. */
  requestTimeoutMs?: number;
  /** Called for every malformed line, for diagnostics. */
  onParseError?: (line: string, error: Error) => void;
}

export class JsonRpcConnection extends EventEmitter {
  private readonly input: Readable;
  private readonly output: Writable;
  private readonly pending = new Map<JsonRpcId, Pending>();
  private readonly requestHandler: RequestHandler;
  private nextId = 1;
  private closed = false;
  private readonly timeoutMs: number;
  private readonly onParseError?: (line: string, error: Error) => void;

  constructor(
    input: Readable,
    output: Writable,
    requestHandler: RequestHandler,
    options: JsonRpcOptions = {},
  ) {
    super();
    this.input = input;
    this.output = output;
    this.requestHandler = requestHandler;
    this.timeoutMs = options.requestTimeoutMs ?? 0;
    if (options.onParseError) this.onParseError = options.onParseError;

    const rl = createInterface({ input, crlfDelay: Infinity });
    rl.on('line', (line) => this.onLine(line));
    rl.on('close', () => this.onClose('stdin closed'));
    input.on('error', (err) => this.onClose(err.message));
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Send a request and wait for its response. */
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    if (this.closed) return Promise.reject(new Error(`connection closed (${method})`));

    const id = this.nextId++;
    const effectiveTimeout = timeoutMs ?? this.timeoutMs;

    return new Promise<T>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      if (effectiveTimeout > 0) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`timeout after ${effectiveTimeout}ms: ${method}`));
        }, effectiveTimeout);
        // Don't keep the process alive just for a pending RPC.
        timer.unref?.();
      }

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer: timer as NodeJS.Timeout,
        method,
      });

      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  /** Send a notification (no response expected). */
  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    this.write({ jsonrpc: '2.0', method, params });
  }

  close(reason = 'closed by client'): void {
    if (this.closed) return;
    this.onClose(reason);
  }

  // -------------------------------------------------------------------------

  private write(message: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse): void {
    if (this.closed) return;
    try {
      this.output.write(JSON.stringify(message) + '\n');
    } catch (err) {
      this.onClose(`write failed: ${(err as Error).message}`);
    }
  }

  private onLine(rawLine: string): void {
    const line = rawLine.trim();
    if (!line) return;

    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch (err) {
      this.onParseError?.(line, err as Error);
      this.emit('parse-error', line, err);
      return;
    }

    if (!message || typeof message !== 'object') return;
    const msg = message as Record<string, unknown>;

    // Response to one of our requests.
    if ('id' in msg && !('method' in msg)) {
      this.onResponse(msg as unknown as JsonRpcResponse);
      return;
    }

    // Request from the agent.
    if ('id' in msg && typeof msg.method === 'string') {
      void this.onRequest(msg as unknown as JsonRpcRequest);
      return;
    }

    // Notification from the agent.
    if (typeof msg.method === 'string') {
      this.onNotification(msg as unknown as JsonRpcNotification);
    }
  }

  private onResponse(msg: JsonRpcResponse): void {
    const entry = this.pending.get(msg.id);
    if (!entry) return; // late response after timeout — ignore
    this.pending.delete(msg.id);
    if (entry.timer) clearTimeout(entry.timer);

    if (msg.error) {
      entry.reject(new RpcCallError(entry.method, msg.error));
    } else {
      entry.resolve(msg.result);
    }
  }

  private async onRequest(msg: JsonRpcRequest): Promise<void> {
    try {
      const result = await this.requestHandler(msg.method, msg.params);
      this.write({ jsonrpc: '2.0', id: msg.id, result: result ?? null });
    } catch (err) {
      const error: JsonRpcError = {
        code: -32603,
        message: (err as Error).message ?? 'internal error',
      };
      this.write({ jsonrpc: '2.0', id: msg.id, error });
    }
  }

  private onNotification(msg: JsonRpcNotification): void {
    this.emit('notification', msg.method, msg.params);
    this.emit(msg.method, msg.params);
  }

  private onClose(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(new Error(`connection closed during ${entry.method}: ${reason}`));
    }
    this.pending.clear();
    this.emit('close', reason);
  }
}

export class RpcCallError extends Error {
  readonly code: number;
  readonly data?: unknown;
  readonly method: string;

  constructor(method: string, error: JsonRpcError) {
    super(`${method} failed (${error.code}): ${error.message}`);
    this.name = 'RpcCallError';
    this.method = method;
    this.code = error.code;
    if (error.data !== undefined) this.data = error.data;
  }
}
