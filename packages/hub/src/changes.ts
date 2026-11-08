/**
 * Reviewable file changes.
 *
 * An agent edit reaches the hub in up to two shapes: an ACP `diff` block in a
 * tool call (a proposal, or a report of what the agent did), and the write the
 * agent asks the hub to perform through `fs/write_text_file`. Many agents send
 * both for the same edit, so the two are folded into one change instead of
 * being shown twice.
 *
 * Reverting trusts the disk, not the record: a file is restored only while it
 * still holds what the change produced (or holds that region unchanged).
 * Anything else is a conflict, never a silent overwrite.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import { isToolCallDiff } from './types.js';

/** Where the hub learned of a change: an agent diff, its own write, or a disk comparison. */
export type ChangeOrigin = 'tool_call' | 'fs_write' | 'snapshot';
export type ChangeDecision = 'kept' | 'reverted';
/** Why the hub will not restore a change. */
export type RevertBlock = 'outside_root' | 'not_utf8';

export interface FileChange {
  changeId: string;
  /** Absolute path, as resolved by the hub. */
  path: string;
  /** Path relative to the session root when inside it (forward slashes), else absolute. */
  displayPath: string;
  /** `null`: the file did not exist before the change. */
  oldText: string | null;
  newText: string;
  origin: ChangeOrigin;
  toolCallId: string | null;
  /**
   * The texts are the exact file contents the hub read and wrote. Otherwise
   * they are what the agent reported, which may be a snippet of the file.
   */
  exact: boolean;
  /** The edit is known to have landed: the hub wrote it, or its tool call completed. */
  applied: boolean;
  /** The edit removed the file (`newText` is empty). Reverting recreates it. */
  deleted: boolean;
  /** The hub is willing to restore it: inside the session root, and real text. */
  revertable: boolean;
  /** Set when `revertable` is false. */
  revertBlock: RevertBlock | null;
  decision: ChangeDecision | null;
  createdAt: number;
  updatedAt: number;
}

export interface ToolCallLike {
  toolCallId?: unknown;
  status?: unknown;
  content?: unknown;
}

export type RevertResult = 'reverted' | 'already-original' | 'already-reverted';

export class ChangeError extends Error {
  constructor(
    message: string,
    readonly code: 'not_found' | 'conflict' | 'not_revertable' | 'not_utf8',
  ) {
    super(message);
  }
}

/** Texts above this size are not tracked: no diff, no revert. */
export const MAX_TRACKED_CHARS = 4 * 1024 * 1024;

/** Context lines kept around a changed region when it is reverted in place. */
const REGION_CONTEXT = 3;

export class ChangeTracker {
  private readonly changes = new Map<string, FileChange>();
  private readonly base: string;
  private readonly roots: string[];
  private counter = 0;

  constructor(options: { cwd: string; roots?: string[] }) {
    this.base = resolve(options.cwd);
    this.roots = (options.roots ?? [options.cwd]).map((root) => resolve(root));
  }

  list(): FileChange[] {
    return [...this.changes.values()];
  }

  get(changeId: string): FileChange | undefined {
    return this.changes.get(changeId);
  }

  /** Applied changes the user has neither kept nor reverted. */
  get undecided(): number {
    let count = 0;
    for (const change of this.changes.values()) if (change.applied && !change.decision) count++;
    return count;
  }

  /**
   * Fold in the diff blocks of a tool call, a tool-call update, or the tool
   * call attached to a permission request. Returns every change it created or
   * modified.
   */
  observeToolCall(toolCall: ToolCallLike): FileChange[] {
    const toolCallId =
      typeof toolCall.toolCallId === 'string' && toolCall.toolCallId ? toolCall.toolCallId : null;
    const touched = new Set<FileChange>();

    if (Array.isArray(toolCall.content)) {
      for (const item of toolCall.content) {
        if (!isToolCallDiff(item)) continue;
        const change = this.foldToolDiff(toolCallId, item.path, item.oldText ?? null, item.newText, reportsExact(item));
        if (change) touched.add(change);
      }
    }

    if (toolCallId && toolCall.status === 'completed') {
      for (const change of this.changes.values()) {
        if (change.toolCallId === toolCallId && !change.applied) {
          change.applied = true;
          change.updatedAt = Date.now();
          touched.add(change);
        }
      }
    }

    return [...touched];
  }

  /**
   * Record a write the hub performed for the agent. `oldText` is the file's
   * previous content, `null` when it did not exist; `lossy` means it was not
   * valid UTF-8, so restoring it would damage the file. Returns the change it
   * created or completed, or `null` when the write cannot be tracked.
   */
  recordWrite(
    path: string,
    oldText: string | null,
    newText: string,
    options: { lossy?: boolean } = {},
  ): FileChange | null {
    return this.recordExact(path, oldText, newText, { origin: 'fs_write', toolCallId: null, ...options });
  }

  /**
   * Record an edit found on disk by a snapshot comparison: exact texts, already
   * applied. `newText` null means the file was deleted. `toolCallId` is the tool
   * call that named the file, when one did.
   */
  recordObserved(
    path: string,
    oldText: string | null,
    newText: string | null,
    toolCallId: string | null,
  ): FileChange | null {
    return this.recordExact(path, oldText, newText ?? '', {
      origin: 'snapshot',
      toolCallId,
      deleted: newText === null,
    });
  }

  keep(changeId: string): FileChange {
    const change = this.require(changeId);
    if (change.decision !== 'reverted') {
      change.decision = 'kept';
      change.updatedAt = Date.now();
    }
    return change;
  }

  async revert(changeId: string): Promise<{ change: FileChange; result: RevertResult }> {
    const change = this.require(changeId);
    if (change.decision === 'reverted') return { change, result: 'already-reverted' };
    if (change.revertBlock === 'outside_root') {
      throw new ChangeError(`${change.displayPath} is outside the session root`, 'not_revertable');
    }
    if (change.revertBlock === 'not_utf8') {
      throw new ChangeError(`${change.displayPath} was not UTF-8 text; restoring it would damage it`, 'not_utf8');
    }

    const raw = await readOrNull(change.path);
    const disk = raw === null ? null : decodeUtf8(raw);
    if (raw !== null && disk === null) {
      throw new ChangeError(`${change.displayPath} is not UTF-8 text now; refusing to rewrite it`, 'not_utf8');
    }
    const plan = planRestore(change, disk);
    if (plan.kind === 'conflict') throw new ChangeError(plan.message, 'conflict');
    if (plan.kind === 'write') {
      if (raw === null) await mkdir(dirname(change.path), { recursive: true });
      await writeFile(change.path, plan.text, 'utf8');
    }
    if (plan.kind === 'delete') await unlink(change.path);

    change.decision = 'reverted';
    change.updatedAt = Date.now();
    return { change, result: plan.kind === 'noop' ? 'already-original' : 'reverted' };
  }

  // -------------------------------------------------------------------------

  private recordExact(
    path: string,
    oldText: string | null,
    newText: string,
    options: { origin: ChangeOrigin; toolCallId: string | null; lossy?: boolean; deleted?: boolean },
  ): FileChange | null {
    if (tooLarge(oldText) || tooLarge(newText)) return null;
    const abs = this.resolvePath(path);
    const key = pathKey(abs);
    const deleted = options.deleted ?? false;

    // The same edit, already known: an agent's announced diff (upgrade it to the
    // exact texts), or the hub's own write seen again by a disk comparison.
    const known = deleted
      ? undefined
      : this.findLast(
          (c) =>
            c.decision === null &&
            !c.deleted &&
            pathKey(c.path) === key &&
            ((c.origin === 'tool_call' && !c.exact && sameEdit({ oldText, newText }, c)) ||
              (c.exact && c.applied && norm(c.newText) === norm(newText))),
        );
    if (known) {
      if (!known.exact) {
        known.oldText = oldText;
        known.newText = newText;
        known.exact = true;
      }
      known.applied = true;
      if (!known.toolCallId && options.toolCallId) known.toolCallId = options.toolCallId;
      known.updatedAt = Date.now();
      if (options.lossy) block(known, 'not_utf8');
      return known;
    }

    const change = this.add({
      path: abs,
      oldText,
      newText,
      origin: options.origin,
      toolCallId: options.toolCallId,
      exact: true,
      applied: true,
      deleted,
    });
    if (options.lossy) block(change, 'not_utf8');
    return change;
  }

  private foldToolDiff(
    toolCallId: string | null,
    rawPath: string,
    oldText: string | null,
    newText: string,
    exact: boolean,
  ): FileChange | null {
    if (tooLarge(oldText) || tooLarge(newText)) return null;
    const path = this.resolvePath(rawPath);
    const key = pathKey(path);

    // Same tool call, same file: a content update replaces the earlier report.
    if (toolCallId) {
      const existing = this.findLast((c) => c.toolCallId === toolCallId && pathKey(c.path) === key);
      if (existing) {
        // Texts the hub read and wrote itself outrank any later report.
        if (existing.exact || (existing.oldText === oldText && existing.newText === newText)) return null;
        existing.oldText = oldText;
        existing.newText = newText;
        existing.exact = exact;
        existing.updatedAt = Date.now();
        return existing;
      }
    }

    // The write already went through the hub: give it the tool call's identity.
    const written = this.findLast(
      (c) =>
        c.origin === 'fs_write' &&
        c.toolCallId === null &&
        c.decision === null &&
        pathKey(c.path) === key &&
        sameEdit(c, { oldText, newText }),
    );
    if (written) {
      if (!toolCallId) return null;
      written.toolCallId = toolCallId;
      written.updatedAt = Date.now();
      return written;
    }

    return this.add({ path, oldText, newText, origin: 'tool_call', toolCallId, exact, applied: false });
  }

  private add(init: {
    path: string;
    oldText: string | null;
    newText: string;
    origin: ChangeOrigin;
    toolCallId: string | null;
    exact: boolean;
    applied: boolean;
    deleted?: boolean;
  }): FileChange {
    const now = Date.now();
    const inside = this.isInside(init.path);
    const change: FileChange = {
      changeId: `c${++this.counter}-${randomUUID().slice(0, 6)}`,
      path: init.path,
      displayPath: this.display(init.path),
      oldText: init.oldText,
      newText: init.newText,
      origin: init.origin,
      toolCallId: init.toolCallId,
      exact: init.exact,
      applied: init.applied,
      deleted: init.deleted ?? false,
      revertable: inside,
      revertBlock: inside ? null : 'outside_root',
      decision: null,
      createdAt: now,
      updatedAt: now,
    };
    this.changes.set(change.changeId, change);
    return change;
  }

  private require(changeId: string): FileChange {
    const change = this.changes.get(changeId);
    if (!change) throw new ChangeError(`unknown change: ${changeId}`, 'not_found');
    return change;
  }

  private findLast(predicate: (change: FileChange) => boolean): FileChange | undefined {
    const all = [...this.changes.values()];
    for (let i = all.length - 1; i >= 0; i--) if (predicate(all[i]!)) return all[i];
    return undefined;
  }

  private resolvePath(path: string): string {
    return isAbsolute(path) ? resolve(path) : resolve(this.base, path);
  }

  private isInside(path: string): boolean {
    return this.roots.some((root) => {
      const rel = relative(root, path);
      return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
    });
  }

  private display(path: string): string {
    const rel = relative(this.base, path);
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel.split(sep).join('/');
    return path;
  }
}

// ---------------------------------------------------------------------------
// restore planning (pure, unit-tested)
// ---------------------------------------------------------------------------

export type RestorePlan =
  | { kind: 'write'; text: string }
  | { kind: 'delete' }
  | { kind: 'noop' }
  | { kind: 'conflict'; message: string };

/**
 * Decide how to undo `change` given the file's current content (`null` when
 * the file is missing). Tried in order: the whole file still matches; the
 * file is already back to the original; the changed region (with context) is
 * still present exactly once and can be swapped back in place.
 */
export function planRestore(
  change: Pick<FileChange, 'oldText' | 'newText' | 'exact'> & { deleted?: boolean },
  disk: string | null,
): RestorePlan {
  const { oldText, newText } = change;

  // A deletion is undone by recreating the file, unless something is there again.
  if (change.deleted) {
    if (disk === null) return oldText === null ? { kind: 'noop' } : { kind: 'write', text: oldText };
    if (oldText !== null && norm(disk) === norm(oldText)) return { kind: 'noop' };
    return { kind: 'conflict', message: 'a file exists at this path again' };
  }

  if (disk !== null && norm(disk) === norm(newText)) {
    if (oldText === null) return { kind: 'delete' };
    // Exact texts are restored byte for byte; reported ones adopt the file's line endings.
    return { kind: 'write', text: change.exact ? oldText : matchEol(oldText, disk) };
  }

  if (oldText === null ? disk === null : disk !== null && norm(disk) === norm(oldText)) {
    return { kind: 'noop' };
  }

  if (disk === null) {
    return { kind: 'conflict', message: 'the file no longer exists' };
  }

  if (oldText !== null) {
    const current = norm(disk);
    const candidates: Array<{ before: string; after: string; lineBounded: boolean }> = [];
    // A snippet report (old_string -> new_string) is its own region.
    if (!change.exact && newText !== '') {
      candidates.push({ before: norm(oldText), after: norm(newText), lineBounded: false });
    }
    const region = changedRegion(oldText, newText, REGION_CONTEXT);
    if (region && region.after !== '') {
      candidates.push({ ...region, lineBounded: change.exact });
    }

    for (const candidate of candidates) {
      const at = uniqueIndex(current, candidate.after, candidate.lineBounded);
      if (at === -1) continue;
      const restored = current.slice(0, at) + candidate.before + current.slice(at + candidate.after.length);
      return { kind: 'write', text: usesCrlf(disk) ? restored.replace(/\n/g, '\r\n') : restored };
    }
  }

  return {
    kind: 'conflict',
    message: 'the file was modified after this edit; revert the later edits first',
  };
}

/**
 * The lines that differ between two texts, widened by `context` unchanged lines
 * on each side. The context is identical in both halves, so swapping `after`
 * back to `before` is safe wherever `after` occurs.
 */
export function changedRegion(
  oldText: string,
  newText: string,
  context: number,
): { before: string; after: string } | null {
  const a = norm(oldText).split('\n');
  const b = norm(newText).split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  if (start === endA && start === endB) return null;

  const from = Math.max(0, start - context);
  const tail = Math.min(a.length - endA, context);
  return {
    before: a.slice(from, endA + tail).join('\n'),
    after: b.slice(from, endB + tail).join('\n'),
  };
}

/** Index of the only occurrence of `needle`, or -1 when it is missing or ambiguous. */
function uniqueIndex(haystack: string, needle: string, lineBounded: boolean): number {
  // An empty needle matches everywhere (and indexOf('', n) clamps, so it would never end).
  if (needle === '') return -1;
  let found = -1;
  let from = 0;
  while (true) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return found;
    const bounded =
      !lineBounded ||
      ((at === 0 || haystack[at - 1] === '\n') &&
        (at + needle.length === haystack.length || haystack[at + needle.length] === '\n'));
    if (bounded) {
      if (found !== -1) return -1;
      found = at;
    }
    from = at + 1;
  }
}

/**
 * True when two descriptions are the same edit: the same resulting text, or a
 * snippet whose both halves sit inside the whole-file texts.
 */
function sameEdit(
  whole: { oldText: string | null; newText: string },
  other: { oldText: string | null; newText: string },
): boolean {
  const wholeNew = norm(whole.newText);
  const otherNew = norm(other.newText);
  if (wholeNew === otherNew) return true;
  if (whole.oldText === null || other.oldText === null || otherNew === '') return false;
  return wholeNew.includes(otherNew) && norm(whole.oldText).includes(norm(other.oldText));
}

function block(change: FileChange, reason: RevertBlock): void {
  if (change.revertBlock === null) change.revertBlock = reason;
  change.revertable = false;
}

/**
 * Agents may mark a diff whose texts are whole files read from disk (so the
 * original is restored byte for byte): `_meta: { acpEditor: { exact: true } }`.
 * The dsh-acp adapter does, for the edits it detects by snapshot.
 */
function reportsExact(diff: unknown): boolean {
  const meta = (diff as { _meta?: { acpEditor?: { exact?: unknown } } | null })._meta;
  return meta?.acpEditor?.exact === true;
}

/** Strict UTF-8 decode (a BOM is kept); `null` when the bytes are not UTF-8 text. */
export function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

function norm(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

function usesCrlf(text: string): boolean {
  return text.includes('\r\n');
}

function matchEol(text: string, like: string): string {
  return usesCrlf(like) && !text.includes('\r\n') ? text.replace(/\n/g, '\r\n') : text;
}

function tooLarge(text: string | null): boolean {
  return text !== null && text.length > MAX_TRACKED_CHARS;
}

/** Comparison key for a path: Windows paths are case-insensitive. */
function pathKey(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

async function readOrNull(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}
