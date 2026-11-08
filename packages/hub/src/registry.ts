/**
 * Agent registry: what ACP agents this machine can run.
 *
 * Three layers, deliberately:
 *   1. builtin     — a short list of agents that speak ACP out of the box
 *   2. detection   — resolve the executable on PATH / known locations
 *   3. user config — ~/.acp-editor/agents.json overrides and additions
 *
 * The builtin list is data, not code, so adding an agent is a JSON edit.
 */
import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { constants as FS } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, extname, isAbsolute, join, basename } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface AgentDefinition {
  id: string;
  name: string;
  description?: string;
  /** Command that starts the agent in ACP mode. */
  command: string[];
  /** Executable to look for. Defaults to command[0]. */
  bin?: string;
  /** Extra args passed only to the version probe. */
  versionArgs?: string[];
  /** Skip the version probe (e.g. adapters that are scripts, not CLIs). */
  skipVersion?: boolean;
  /** True when running the command triggers a package download (npx / uvx). */
  requiresInstall?: boolean;
  homepage?: string;
  builtin?: boolean;
  /**
   * How the hub learns which files the agent changed, beyond `diff` blocks and
   * `fs/write_text_file`. `snapshot`: compare the session directory before and
   * after each turn, for agents that write files themselves and report only
   * generic tool calls.
   */
  trackEdits?: 'snapshot';
  /**
   * Feature gates. A feature maps to a semver constraint on the resolved binary,
   * e.g. `{ mcp: '>=0.2.2-rc.1' }`. The hub uses them to decide what it may ask the
   * agent to do (and to warn the user) instead of discovering it at runtime.
   */
  features?: Record<string, string>;
  /** Hard floor: below this the agent is reported unavailable, never silently used. */
  minVersion?: string;
  /** Extra directories to search, in order, before the PATH. */
  searchPaths?: string[];
  /**
   * Flag the hub appends with a generated overlay file, for agents that can take
   * extra profile patches (dsh: `--patch <file>`). Used to teach the agent about the
   * editor's `ue-mcp` command, which does not need MCP support on the agent side.
   */
  patchFlag?: string;
}

export interface AgentStatus extends AgentDefinition {
  available: boolean;
  resolvedPath?: string;
  version?: string;
  /** Why it is unavailable, when it is. */
  reason?: string;
  /**
   * Every executable that matched, newest first, with its version when known.
   * Resolution is deterministic: the newest binary that satisfies the declared
   * constraints wins, never merely the first one on PATH.
   */
  candidates?: AgentCandidate[];
  /** Feature name → whether the resolved binary satisfies its constraint. */
  capabilities?: Record<string, boolean>;
  /** Non-fatal problems worth showing the user (old version, ignored features…). */
  warnings?: string[];
}

export interface AgentCandidate {
  path: string;
  version?: string;
  satisfies: boolean;
}

/** Shipped defaults. Order matters: the first available one is the UI default. */
export const BUILTIN_AGENTS: AgentDefinition[] = [
  {
    id: 'opencode',
    name: 'OpenCode',
    description: 'Open-source coding agent. Native ACP. Bring your own providers.',
    command: ['opencode', 'acp'],
    versionArgs: ['--version'],
    homepage: 'https://opencode.ai/docs/acp/',
    builtin: true,
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    description: 'Google Gemini CLI. Native ACP (--acp).',
    command: ['gemini', '--acp'],
    versionArgs: ['--version'],
    builtin: true,
  },
  {
    id: 'cursor',
    name: 'Cursor Agent',
    description: 'Cursor command-line agent. Native ACP.',
    command: ['cursor-agent', 'acp'],
    versionArgs: ['--version'],
    builtin: true,
  },
  {
    id: 'claude',
    name: 'Claude Code',
    description: 'Claude Code via the official ACP adapter.',
    command: ['npx', '-y', '@agentclientprotocol/claude-agent-acp'],
    versionArgs: ['--version'],
    requiresInstall: true,
    builtin: true,
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    description: 'OpenAI Codex via the official ACP adapter.',
    command: ['npx', '-y', '@agentclientprotocol/codex-acp'],
    versionArgs: ['--version'],
    requiresInstall: true,
    builtin: true,
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot CLI',
    description: 'GitHub Copilot CLI in ACP mode.',
    command: ['npx', '-y', '@github/copilot', '--acp'],
    requiresInstall: true,
    builtin: true,
  },
  {
    id: 'qwen',
    name: 'Qwen Code',
    description: 'Qwen Code CLI in ACP mode.',
    command: ['npx', '-y', '@qwen-code/qwen-code', '--acp'],
    requiresInstall: true,
    builtin: true,
  },
  {
    id: 'kimi',
    name: 'Kimi CLI',
    description: 'Moonshot Kimi CLI. Native ACP.',
    command: ['kimi', 'acp'],
    versionArgs: ['--version'],
    builtin: true,
  },
  {
    id: 'dsh',
    name: 'DeepSeek Harness',
    description: 'DeepSeek Harness, native ACP (dsh --profile acp). Writes files itself.',
    command: ['dsh', '--profile', 'acp'],
    versionArgs: ['--version'],
    trackEdits: 'snapshot',
    patchFlag: '--patch',
    // Measured: dsh's ACP mode only surfaces MCP tools at profile level from 0.2.2 on;
    // 0.1.5 connects the server and never gives the agent the tools.
    features: { mcp: '>=0.2.2-rc.1', patch: '>=0.1.5-rc.2' },
    builtin: true,
  },
];

/** How to start an agent: argv for spawn, and whether it needs the shell. */
export interface LaunchPlan {
  command: string[];
  shell: boolean;
}

/**
 * Turn an available agent's command into something `spawn` can start.
 *
 * Windows cannot spawn npm's `.cmd` shims without a shell (Node refuses
 * .cmd/.bat), so `npx`, `dsh` and every npm-installed CLI would fail with
 * ENOENT. A shim that points at a JavaScript entry is run as `node <entry>`;
 * any other batch file falls back to the shell. Elsewhere the resolved
 * absolute path is used as is.
 */
export async function resolveLaunch(status: AgentStatus): Promise<LaunchPlan> {
  const [head, ...args] = status.command;
  // `bin` names the executable to resolve; it may be a bare name (then command[0] must
  // match it) or an absolute pin that *replaces* command[0] entirely.
  const pinned = status.bin;
  const pinnedPath =
    pinned !== undefined && (isAbsolute(pinned) || pinned.includes('/') || pinned.includes('\\'));
  const rewriteHead = pinnedPath || head === (pinned ?? head);
  const resolved = status.resolvedPath && rewriteHead ? status.resolvedPath : undefined;
  if (!resolved) return { command: status.command, shell: false };

  // A pinned JavaScript entry (a CLI shipped inside another package, e.g. the dsh
  // runtime bundled with the desktop app) runs under this hub's node.
  if (/\.(?:c|m)?js$/i.test(resolved)) {
    return { command: [process.execPath, resolved, ...args], shell: false };
  }

  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolved)) {
    const entry = await shimEntry(resolved);
    if (entry) return { command: [process.execPath, entry, ...args], shell: false };
    return { command: [resolved, ...args], shell: true };
  }
  return { command: [resolved, ...args], shell: false };
}

/**
 * The JavaScript file an npm `.cmd` shim runs, or null. Both shim layouts
 * reference it relative to the shim's own directory (`%dp0%\...` in cmd-shim,
 * `%~dp0\...` in node's bundled npx.cmd); the last such reference is the one
 * that is executed.
 */
export async function shimEntry(shimPath: string): Promise<string | null> {
  let text: string;
  try {
    text = await readFile(shimPath, 'utf8');
  } catch {
    return null;
  }
  // \x5c is a backslash: `%dp0%\` / `%~dp0\` followed by the entry path.
  const refs = [...text.matchAll(/%~?dp0%?\x5c([^"%\r\n*?<>|]+?\.[cm]?js)\b/gi)].map((m) => m[1]!);
  const last = refs.at(-1);
  if (!last) return null;
  const entry = join(dirname(shimPath), last);
  return (await isExecutable(entry)) ? entry : null;
}

export interface RegistryPaths {
  /** User overlay file. Defaults to ~/.acp-editor/agents.json */
  userConfigPath?: string;
}

interface ProbeCacheEntry {
  status: AgentStatus;
  at: number;
}

const PROBE_TTL_MS = 30_000;

export class AgentRegistry {
  private readonly userConfigPath: string;
  private definitions: AgentDefinition[] | null = null;
  private readonly probeCache = new Map<string, ProbeCacheEntry>();

  constructor(paths: RegistryPaths = {}) {
    this.userConfigPath =
      paths.userConfigPath ?? join(homedir(), '.acp-editor', 'agents.json');
  }

  /** Builtin + user definitions, user entries overriding by id. */
  async listDefinitions(): Promise<AgentDefinition[]> {
    if (this.definitions) return this.definitions;

    const byId = new Map<string, AgentDefinition>();
    for (const def of BUILTIN_AGENTS) byId.set(def.id, def);

    let userDefs: AgentDefinition[] = [];
    try {
      const raw = await readFile(this.userConfigPath, 'utf8');
      const parsed = JSON.parse(raw) as { agents?: AgentDefinition[] } | AgentDefinition[];
      userDefs = Array.isArray(parsed) ? parsed : (parsed.agents ?? []);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        // A broken user file should not take the hub down.
        console.warn(`[registry] ignoring ${this.userConfigPath}: ${(err as Error).message}`);
      }
    }

    for (const def of userDefs) {
      if (!def?.id) {
        console.warn('[registry] skipping invalid user agent entry', '(no id)');
        continue;
      }
      // A user entry *patches* the builtin of the same id instead of replacing it:
      // pinning `{"id":"dsh","bin":"…"}` must not throw away the ACP command,
      // features or edit-tracking the builtin declares.
      const base = byId.get(def.id);
      const merged: AgentDefinition = base ? { ...base, ...def, builtin: false } : { ...def, builtin: false };
      if (!Array.isArray(merged.command) || merged.command.length === 0) {
        console.warn('[registry] skipping user agent entry without a command', def.id);
        continue;
      }
      byId.set(def.id, merged);
    }

    this.definitions = [...byId.values()];
    return this.definitions;
  }

  async listStatuses(options: { force?: boolean } = {}): Promise<AgentStatus[]> {
    const defs = await this.listDefinitions();
    return Promise.all(defs.map((d) => this.probe(d, options.force === true)));
  }

  async getStatus(id: string, options: { force?: boolean } = {}): Promise<AgentStatus | null> {
    const defs = await this.listDefinitions();
    const def = defs.find((d) => d.id === id);
    if (!def) return null;
    return this.probe(def, options.force === true);
  }

  // -------------------------------------------------------------------------

  private async probe(def: AgentDefinition, force: boolean): Promise<AgentStatus> {
    const cached = this.probeCache.get(def.id);
    if (!force && cached && Date.now() - cached.at < PROBE_TTL_MS) return cached.status;

    const bin = def.bin ?? def.command[0];
    if (!bin) {
      const status: AgentStatus = { ...def, available: false, reason: 'no executable declared' };
      this.probeCache.set(def.id, { status, at: Date.now() });
      return status;
    }

    const paths = await candidatesFor(def, bin);
    const requirements = Object.values(def.features ?? {});
    if (def.minVersion) requirements.push(def.minVersion);
    const constrained = requirements.length > 0;

    if (paths.length === 0) {
      const status: AgentStatus = {
        ...def,
        available: false,
        reason: `${bin} not found on PATH or in the known install locations`,
        candidates: [],
        ...(constrained ? { warnings: [`需要 ${requirements.join(', ')}`] } : {}),
      };
      this.probeCache.set(def.id, { status, at: Date.now() });
      return status;
    }

    // Versions matter only when they decide something: with constraints we must rank
    // every candidate, without them the PATH order is the contract (and one probe is
    // enough). Probing is cached per path so a UI refresh does not re-spawn agents.
    const probeCount = constrained ? paths.length : 1;
    const versions = await Promise.all(
      paths.map((path, index) =>
        index < probeCount && !def.skipVersion && !def.requiresInstall
          ? versionOf(path, def.versionArgs ?? ['--version'])
          : Promise.resolve(undefined),
      ),
    );

    // `satisfies` describes the candidate as a whole (every declared constraint), so
    // the UI never shows "satisfied" for a build that lacks a declared feature.
    const everyNeed = [...Object.values(def.features ?? {}), ...(def.minVersion ? [def.minVersion] : [])];
    const candidates: AgentCandidate[] = paths.map((path, index) => ({
      path,
      ...(versions[index] ? { version: versions[index] } : {}),
      satisfies: everyNeed.length === 0 || everyNeed.every((need) => satisfies(need, versions[index])),
    }));

    // `minVersion` is a hard floor; `features` are soft — they only rank candidates
    // and disable a capability. A user on an old build keeps chatting, minus the
    // features that build cannot provide.
    const eligible = def.minVersion
      ? candidates.filter((c) => satisfies(def.minVersion!, c.version))
      : candidates;

    if (eligible.length === 0) {
      const seen = candidates
        .map((c) => `${c.version ?? 'unknown'} @ ${c.path}`)
        .join('; ');
      const status: AgentStatus = {
        ...def,
        available: false,
        reason:
          `${bin} 已安装但版本不满足要求（需要 ${def.minVersion}）。` +
          `找到：${seen}。请升级，或用 agents.json 的 bin / ACP_` +
          `${def.id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_BIN 指定一个合规的可执行文件。`,
        candidates,
        warnings: [`需要 ${def.minVersion}`],
      };
      this.probeCache.set(def.id, { status, at: Date.now() });
      return status;
    }

    // Most satisfied capabilities first, then newest. Never "first on PATH".
    const featureNeeds = Object.values(def.features ?? {});
    const score = (candidate: AgentCandidate): number =>
      featureNeeds.filter((need) => satisfies(need, candidate.version)).length;
    const chosen = [...eligible].sort(
      (a, b) => score(b) - score(a) || compareVersions(b.version, a.version),
    )[0]!;

    const capabilities: Record<string, boolean> = {};
    const warnings: string[] = [];
    for (const [feature, need] of Object.entries(def.features ?? {})) {
      const ok = satisfies(need, chosen.version);
      capabilities[feature] = ok;
      if (!ok) {
        warnings.push(
          `${feature} 需要 ${need}，当前 ${chosen.version ?? 'unknown'}（${chosen.path}）`,
        );
      }
    }

    const status: AgentStatus = {
      ...def,
      available: true,
      resolvedPath: chosen.path,
      candidates,
      ...(chosen.version ? { version: chosen.version } : {}),
      ...(Object.keys(capabilities).length > 0 ? { capabilities } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    };
    if (def.requiresInstall) status.description = `${def.description ?? ''} (downloads on first run)`;

    this.probeCache.set(def.id, { status, at: Date.now() });
    return status;
  }
}

/** Executable extensions, honouring PATHEXT on Windows. */
function executableExtensions(): string[] {
  return process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
}

/** Resolve `bin` inside one directory, honouring PATHEXT on Windows. */
async function resolveBinaryIn(dir: string, bin: string): Promise<string | null> {
  const base = join(dir, bin);
  const hasExt = process.platform === 'win32' && extname(bin) !== '';
  const candidates =
    process.platform !== 'win32' || hasExt
      ? [base]
      : executableExtensions().map((ext) => base + ext.toLowerCase());
  for (const candidate of candidates) {
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

/**
 * Directories that hold globally installed CLIs but are frequently missing from a
 * GUI process's PATH (this is how a desktop-launched hub misses an npm global bin).
 */
function knownInstallDirs(): string[] {
  if (process.platform === 'win32') {
    return [
      process.env.APPDATA ? join(process.env.APPDATA, 'npm') : '',
      process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'pnpm') : '',
      process.env.USERPROFILE ? join(process.env.USERPROFILE, '.volta', 'bin') : '',
      process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links') : '',
      process.env.ProgramData ? join(process.env.ProgramData, 'chocolatey', 'bin') : '',
      'C:\\Program Files\\nodejs',
    ].filter(Boolean);
  }
  const home = homedir();
  return [
    '/usr/local/bin',
    '/opt/homebrew/bin',
    join(home, '.local', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.npm-global', 'bin'),
    '/usr/bin',
  ];
}

/**
 * Every executable matching `bin`, in PATH order and then in the known install
 * directories, de-duplicated. Resolution must not depend on which directory a GUI
 * process happened to inherit.
 */
export async function whichAll(bin: string): Promise<string[]> {
  if (isAbsolute(bin) || bin.includes('/') || bin.includes('\\')) {
    return (await isExecutable(bin)) ? [bin] : [];
  }
  const dirs = [
    ...(process.env.PATH ?? '').split(delimiter).filter(Boolean),
    ...knownInstallDirs(),
  ];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    const hit = await resolveBinaryIn(dir, bin);
    if (!hit) continue;
    const key = process.platform === 'win32' ? hit.toLowerCase() : hit;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
  }
  return out;
}

/** First match, PATH order. Kept for callers that only need one path. */
export async function which(bin: string): Promise<string | null> {
  return (await whichAll(bin))[0] ?? null;
}

/**
 * Candidate executables for a definition, explicit overrides first:
 * env `ACP_<ID>_BIN` → absolute `bin` → `searchPaths` → PATH → known dirs.
 */
async function candidatesFor(def: AgentDefinition, bin: string): Promise<string[]> {
  const envKey = `ACP_${def.id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_BIN`;
  const override = process.env[envKey];
  if (override) {
    const hit = (await isExecutable(override))
      ? override
      : await resolveBinaryIn(dirname(override), basename(override));
    // An explicit override that does not resolve is a configuration error, not a
    // reason to fall back silently to whatever PATH offers.
    return hit ? [hit] : [];
  }
  if (isAbsolute(bin) || bin.includes('/') || bin.includes('\\')) {
    return (await isExecutable(bin)) ? [bin] : [];
  }

  const out: string[] = [];
  for (const dir of def.searchPaths ?? []) {
    const hit = await resolveBinaryIn(dir, bin);
    if (hit) out.push(hit);
  }
  out.push(...(await whichAll(bin)));

  const seen = new Set<string>();
  return out.filter((path) => {
    const key = process.platform === 'win32' ? path.toLowerCase() : path;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const versionCache = new Map<string, { at: number; version?: string }>();
const VERSION_TTL_MS = 10 * 60_000;

async function versionOf(path: string, args: string[]): Promise<string | undefined> {
  const key = `${path}\u0000${args.join('\u0000')}`;
  const hit = versionCache.get(key);
  if (hit && Date.now() - hit.at < VERSION_TTL_MS) return hit.version;
  const version = await probeVersion(path, args);
  versionCache.set(key, { at: Date.now(), version });
  return version;
}

/** Tests only: forget probed versions. */
export function resetVersionCache(): void {
  versionCache.clear();
}

/** Parse "v1.2.3-rc.4 (build 5)" into comparable parts. */
export function parseVersion(raw?: string): { nums: number[]; pre: string } | null {
  if (!raw) return null;
  const match = /(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?/.exec(raw);
  if (!match) return null;
  return {
    nums: match[1]!.split('.').map((part) => Number(part) || 0),
    pre: match[2] ?? '',
  };
}

/** Semver ordering with prerelease rules: 1.0.0-rc.1 < 1.0.0. Unknown sorts lowest. */
export function compareVersions(a?: string, b?: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left && !right) return 0;
  if (!left) return -1;
  if (!right) return 1;

  const width = Math.max(left.nums.length, right.nums.length);
  for (let i = 0; i < width; i++) {
    const diff = (left.nums[i] ?? 0) - (right.nums[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (left.pre === right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  return left.pre < right.pre ? -1 : 1;
}

/** `>=1.2.3` / `>1.2.3` / `<=` / `<` / `=` / `*`; a bare version means equality. */
export function satisfies(constraint: string, version?: string): boolean {
  const trimmed = constraint.trim();
  if (trimmed === '' || trimmed === '*') return true;
  if (!version) return false;
  const match = /^(>=|<=|>|<|=)?\s*(.+)$/.exec(trimmed);
  const op = match?.[1] ?? '=';
  const target = match?.[2] ?? trimmed;
  const cmp = compareVersions(version, target);
  switch (op) {
    case '>=':
      return cmp >= 0;
    case '>':
      return cmp > 0;
    case '<=':
      return cmp <= 0;
    case '<':
      return cmp < 0;
    default:
      return cmp === 0;
  }
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, process.platform === 'win32' ? FS.F_OK : FS.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function probeVersion(bin: string, args: string[]): Promise<string | undefined> {
  // npm .cmd shims run through node directly, like the agent itself (see resolveLaunch).
  const entry = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin) ? await shimEntry(bin) : null;
  const isScript = /\.(?:c|m)?js$/i.test(bin);
  const [file, argv, shell] = isScript
    ? [process.execPath, [bin, ...args], false]
    : entry
      ? [process.execPath, [entry, ...args], false]
      : [bin, args, process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin)];
  try {
    const { stdout } = await execFileAsync(file, argv, { timeout: 4_000, windowsHide: true, shell });
    const first = String(stdout).split(/\r?\n/).find((l) => l.trim());
    return first?.trim().slice(0, 80);
  } catch {
    return undefined;
  }
}
