/**
 * Find the files an agent changed by looking at the disk.
 *
 * Some agents write files themselves and report only generic tool calls: no
 * `diff` block, no `fs/write_text_file` through the hub (dsh --profile acp is
 * one). For those the hub takes a snapshot of the session directory before
 * each turn and compares while the turn runs: a tool that names a file is
 * checked as soon as it completes (so the change lands under that tool call),
 * and a full comparison at the end of the turn catches the rest.
 *
 * Tracked: text files by extension, valid UTF-8 (a BOM is kept), at most
 * 1 MiB, inside the session directory. Skipped: VCS, dependencies, Unreal
 * build output and assets. Between turns the snapshot catches up with the disk
 * silently, so edits made in the IDE are not blamed on the agent — only what
 * changes while a turn runs is reported.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';

const TEXT_EXTENSIONS = new Set([
  '.h', '.hh', '.hpp', '.hxx', '.inl', '.c', '.cc', '.cpp', '.cxx', '.cs',
  '.ini', '.json', '.jsonc', '.md', '.txt', '.uproject', '.uplugin',
  '.py', '.lua', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.html', '.css',
  '.xml', '.yml', '.yaml', '.toml', '.cfg', '.usf', '.ush', '.hlsl', '.glsl',
  '.bat', '.cmd', '.ps1', '.sh', '.gitignore', '.editorconfig',
]);

/** Directory names (compared lower-case) never descended into. */
const SKIP_DIRS = new Set([
  '.git', '.svn', '.hg', 'node_modules', '__pycache__', '.vs', '.idea', '.vscode',
  // Unreal: generated, cached, binary
  'intermediate', 'saved', 'binaries', 'deriveddatacache', 'content', 'build',
  // JavaScript build output
  'dist',
]);

export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_FILES = 20_000;

export interface FileEdit {
  /** Absolute path. */
  path: string;
  /** `null`: the file did not exist before. */
  oldText: string | null;
  /** `null`: the file was deleted. */
  newText: string | null;
}

interface Entry {
  /** The real path; map keys are case-folded on Windows. */
  path: string;
  mtimeMs: number;
  size: number;
  /** `null`: not UTF-8 text, so never reported. */
  text: string | null;
}

interface Scanned {
  path: string;
  mtimeMs: number;
  size: number;
}

export class WorkspaceSnapshot {
  readonly root: string;
  private readonly entries = new Map<string, Entry>();
  /** The last scan stopped at MAX_FILES, so coverage is partial. */
  truncated = false;

  constructor(root: string) {
    this.root = resolve(root);
  }

  /** Catch up with the disk without reporting anything: the baseline for the next comparison. */
  async prime(): Promise<void> {
    const seen = new Set<string>();
    for (const file of await this.scan()) {
      seen.add(key(file.path));
      const known = this.entries.get(key(file.path));
      if (known && known.mtimeMs === file.mtimeMs && known.size === file.size) continue;
      this.entries.set(key(file.path), {
        path: file.path,
        mtimeMs: file.mtimeMs,
        size: file.size,
        text: await readText(file.path),
      });
    }
    for (const k of [...this.entries.keys()]) if (!seen.has(k)) this.entries.delete(k);
  }

  /** True when `path` is a file this snapshot tracks (inside the root, text, not skipped). */
  tracks(path: string): boolean {
    const abs = resolve(this.root, path);
    const rel = relative(this.root, abs);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return false;
    const parts = rel.split(sep);
    if (parts.slice(0, -1).some((part) => SKIP_DIRS.has(part.toLowerCase()))) return false;
    return isTextName(parts.at(-1)!);
  }

  /** Compare one file now (after a tool that names it completed). The snapshot then holds its new state. */
  async checkFile(path: string): Promise<FileEdit | null> {
    if (!this.tracks(path)) return null;
    const abs = resolve(this.root, path);
    const known = this.entries.get(key(abs));

    let info;
    try {
      info = await stat(abs);
    } catch {
      info = null;
    }
    if (!info || !info.isFile() || info.size > MAX_FILE_BYTES) {
      if (!known) return null;
      this.entries.delete(key(abs));
      return !info && known.text !== null ? { path: abs, oldText: known.text, newText: null } : null;
    }
    return this.compare(abs, info.mtimeMs, info.size, known);
  }

  /** Everything that changed since the snapshot was last updated. */
  async collect(): Promise<FileEdit[]> {
    const edits: FileEdit[] = [];
    const seen = new Set<string>();

    for (const file of await this.scan()) {
      seen.add(key(file.path));
      const edit = await this.compare(file.path, file.mtimeMs, file.size, this.entries.get(key(file.path)));
      if (edit) edits.push(edit);
    }
    for (const [k, entry] of [...this.entries]) {
      if (seen.has(k)) continue;
      this.entries.delete(k);
      if (entry.text !== null) edits.push({ path: entry.path, oldText: entry.text, newText: null });
    }

    edits.sort((a, b) => a.path.localeCompare(b.path));
    return edits;
  }

  private async compare(path: string, mtimeMs: number, size: number, known: Entry | undefined): Promise<FileEdit | null> {
    if (known && known.mtimeMs === mtimeMs && known.size === size) return null;
    const text = await readText(path);
    this.entries.set(key(path), { path, mtimeMs, size, text });
    if (text === null) return null;
    if (!known) return { path, oldText: null, newText: text };
    if (known.text !== null && known.text !== text) return { path, oldText: known.text, newText: text };
    return null;
  }

  private async scan(): Promise<Scanned[]> {
    const found: Scanned[] = [];
    const stack = [this.root];
    this.truncated = false;

    while (stack.length > 0) {
      const dir = stack.pop()!;
      let names;
      try {
        names = await readdir(dir, { withFileTypes: true });
      } catch {
        continue; // unreadable directory: skip, never fail the turn
      }
      for (const entry of names) {
        if (entry.isSymbolicLink()) continue;
        const full = resolve(dir, entry.name);
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name.toLowerCase())) stack.push(full);
          continue;
        }
        if (!entry.isFile() || !isTextName(entry.name)) continue;
        if (found.length >= MAX_FILES) {
          this.truncated = true;
          return found;
        }
        try {
          const info = await stat(full);
          if (info.size <= MAX_FILE_BYTES) found.push({ path: full, mtimeMs: info.mtimeMs, size: info.size });
        } catch {
          /* vanished between readdir and stat */
        }
      }
    }
    return found;
  }
}

/** Map key for a path: Windows paths are case-insensitive. */
function key(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

function isTextName(name: string): boolean {
  const lower = name.toLowerCase();
  return TEXT_EXTENSIONS.has(extname(lower)) || TEXT_EXTENSIONS.has(lower);
}

/** The file as UTF-8 text (BOM kept), or `null` when it is not. */
async function readText(path: string): Promise<string | null> {
  try {
    const bytes = await readFile(path);
    if (bytes.includes(0)) return null;
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}
