/**
 * Server-Sent Events plumbing.
 *
 * The hub deliberately uses SSE (not WebSocket) for the downstream direction:
 * it is one HTTP request, survives proxies, auto-reconnects in browsers, and
 * the editor's embedded web view already speaks it.
 */
import type { ServerResponse } from 'node:http';

export interface SseMessage {
  /** Monotonic per-session sequence, used as the SSE `id:` for replay. */
  seq: number;
  event: string;
  data: unknown;
  at: number;
}

export class SseChannel {
  private readonly res: ServerResponse;
  private closed = false;

  constructor(res: ServerResponse) {
    this.res = res;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
    });
    // Establish the stream immediately so clients fire `onopen`.
    res.write(': connected\n\n');
  }

  get isClosed(): boolean {
    return this.closed;
  }

  send(message: SseMessage): void {
    if (this.closed) return;
    const payload = JSON.stringify(message.data);
    this.res.write(`id: ${message.seq}\nevent: ${message.event}\ndata: ${payload}\n\n`);
  }

  comment(text: string): void {
    if (this.closed) return;
    this.res.write(`: ${text}\n\n`);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.res.end();
    } catch {
      /* peer already gone */
    }
  }
}

/**
 * Bounded replay log. When a client reconnects with `Last-Event-ID`, the missed
 * frames are replayed so the editor does not lose tool-call output on a reload.
 */
export class EventLog {
  private readonly buffer: SseMessage[] = [];
  private counter = 0;

  constructor(private readonly capacity = 2000) {}

  get lastSeq(): number {
    return this.counter;
  }

  append(event: string, data: unknown): SseMessage {
    const message: SseMessage = {
      seq: ++this.counter,
      event,
      data,
      at: Date.now(),
    };
    this.buffer.push(message);
    if (this.buffer.length > this.capacity) this.buffer.shift();
    return message;
  }

  since(seq: number): SseMessage[] {
    return this.buffer.filter((m) => m.seq > seq);
  }

  all(): SseMessage[] {
    return [...this.buffer];
  }
}
