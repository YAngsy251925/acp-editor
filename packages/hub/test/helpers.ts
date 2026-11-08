/** Shared test helpers: a minimal SSE collector. */
export interface SseEvent {
  event: string;
  data: any;
}

export function openSse(url: string) {
  const events: SseEvent[] = [];
  const controller = new AbortController();
  const done = (async () => {
    const res = await fetch(url, { signal: controller.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { done: eof, value } = await reader.read();
        if (eof) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          let event = 'message';
          let data = '';
          for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data += line.slice(5).trim();
          }
          if (data) events.push({ event, data: JSON.parse(data) });
        }
      }
    } catch {
      /* aborted */
    }
  })();
  return {
    events,
    close() {
      controller.abort();
      return done;
    },
  };
}

/** Wait until an event matches, polling the collected list. */
export async function waitFor(
  sse: { events: SseEvent[] },
  match: (e: SseEvent) => boolean,
  timeoutMs = 15_000,
): Promise<SseEvent> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const found = sse.events.find(match);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`SSE wait timed out after ${timeoutMs}ms`);
}
