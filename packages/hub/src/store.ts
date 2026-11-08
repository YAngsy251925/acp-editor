/**
 * Append-only session transcripts.
 *
 * Every session survives the editor (and the hub) dying, because both the
 * editor panel and the agent process are disposable — the conversation is not.
 * One JSONL file per session keeps writes O(1) and reads trivially resumable.
 */
import { appendFile, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type StoredEventType =
  | 'meta'
  | 'user'
  | 'assistant'
  | 'thought'
  | 'tool'
  /** A reviewable file change. Later records for the same changeId update earlier ones. */
  | 'file_change'
  | 'turn_start'
  | 'turn_end'
  | 'error';

export interface StoredEvent {
  t: number;
  type: StoredEventType;
  [key: string]: unknown;
}

export interface SessionSummary {
  sessionId: string;
  agentId: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  /** First user message, truncated — the session title. */
  title: string;
  turns: number;
}

const DEFAULT_ROOT = join(homedir(), '.acp-editor', 'sessions');

export class SessionStore {
  private readonly root: string;
  private ready: Promise<void> | null = null;
  /**
   * Pending appends per session. Independent appendFile calls may complete out
   * of order under a burst of events, so writes to one file are chained.
   */
  private readonly queues = new Map<string, Promise<void>>();

  constructor(root: string = DEFAULT_ROOT) {
    this.root = root;
  }

  private async ensure(): Promise<void> {
    if (!this.ready) this.ready = mkdir(this.root, { recursive: true }).then(() => undefined);
    await this.ready;
  }

  private path(sessionId: string): string {
    // Session ids come from agents; keep them filesystem-safe.
    const safe = sessionId.replace(/[^a-zA-Z0-9._-]/g, '_');
    return join(this.root, `${safe}.jsonl`);
  }

  append(sessionId: string, event: StoredEvent): Promise<void> {
    // Serialise now: callers may mutate the objects they passed in later.
    const line = JSON.stringify(event) + '\n';
    const previous = this.queues.get(sessionId) ?? Promise.resolve();
    const next = previous.then(async () => {
      try {
        await this.ensure();
        await appendFile(this.path(sessionId), line, 'utf8');
      } catch {
        // Persistence must never break a live turn.
      }
    });
    this.queues.set(sessionId, next);
    void next.then(() => {
      if (this.queues.get(sessionId) === next) this.queues.delete(sessionId);
    });
    return next;
  }

  async read(sessionId: string): Promise<StoredEvent[]> {
    // Include everything already appended, even if it is still being flushed.
    await this.queues.get(sessionId);
    try {
      const raw = await readFile(this.path(sessionId), 'utf8');
      return raw
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line) as StoredEvent;
          } catch {
            return null;
          }
        })
        .filter((e): e is StoredEvent => e !== null);
    } catch {
      return [];
    }
  }

  async list(limit = 100): Promise<SessionSummary[]> {
    try {
      await this.ensure();
      const files = await readdir(this.root);
      const summaries: SessionSummary[] = [];

      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        const full = join(this.root, file);
        let mtime = 0;
        try {
          mtime = (await stat(full)).mtimeMs;
        } catch {
          continue;
        }

        const events = await this.read(file.replace(/\.jsonl$/, ''));
        const meta = events.find((e) => e.type === 'meta');
        if (!meta) continue;

        const firstUser = events.find((e) => e.type === 'user');
        const turns = events.filter((e) => e.type === 'user').length;

        summaries.push({
          sessionId: String(meta.sessionId ?? file.replace(/\.jsonl$/, '')),
          agentId: String(meta.agentId ?? 'unknown'),
          cwd: String(meta.cwd ?? ''),
          createdAt: Number(meta.createdAt ?? mtime),
          updatedAt: mtime,
          title: firstUser ? String(firstUser.text ?? '').slice(0, 60) : '(空会话)',
          turns,
        });
      }

      // Sessions nobody ever messaged in are panel-boot noise, not history.
      const withTurns = summaries.filter((summary) => summary.turns > 0);
      withTurns.sort((a, b) => b.updatedAt - a.updatedAt);
      return withTurns.slice(0, limit);
    } catch {
      return [];
    }
  }

  async delete(sessionId: string): Promise<void> {
    try {
      await rm(this.path(sessionId), { force: true });
    } catch {
      /* ignore */
    }
  }
}
