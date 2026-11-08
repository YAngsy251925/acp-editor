/**
 * Project MCP discovery.
 *
 * The editor panel is a thin shell: it must not have to know that the Unreal
 * editor happens to run an MCP server. Instead every session gets the MCP servers
 * its project declares (`<cwd>/.mcp.json`, the same file other clients read) plus
 * the Unreal editor's default endpoint when the directory looks like a UE project —
 * *and only when the endpoint actually answers*.
 *
 * The probe is not optional: agents mount MCP with `failOnStartupError`, so handing
 * them a dead URL fails the whole `session/new` instead of degrading to "no tools".
 */
import { readFile, stat } from 'node:fs/promises';
import { dirname, join, parse as parsePath, resolve } from 'node:path';

import type { McpServer } from './types.js';

/** Unreal's ModelContextProtocol plugin: `DefaultServerPort = 8000`, path `/mcp`. */
export const UNREAL_DEFAULT_MCP_URL = 'http://127.0.0.1:8000/mcp';

export interface McpDiscoveryResult {
  /** Servers safe to hand to the agent. */
  servers: McpServer[];
  /** Declared or default candidates that were not attached, and why. */
  skipped: Array<{ name: string; target?: string; reason: string }>;
  /** Files/endpoints the result came from, for logging. */
  sources: string[];
}

export interface McpDiscoveryOptions {
  /** Where to probe for the editor endpoint; null disables the Unreal default. */
  unrealDefaultUrl?: string | null;
  /** How long a TCP+HTTP probe may take. */
  probeTimeoutMs?: number;
  /** Parent directories to search for a config file. */
  maxParents?: number;
  /** Probe cache lifetime. A session per keystroke must not re-probe every time. */
  probeCacheMs?: number;
}

const DEFAULTS = {
  unrealDefaultUrl: UNREAL_DEFAULT_MCP_URL as string | null,
  probeTimeoutMs: 900,
  maxParents: 4,
  probeCacheMs: 5_000,
};

const probeCache = new Map<string, { at: number; alive: boolean }>();

/** Drop cached probe results; tests use it to keep cases independent. */
export function resetMcpProbeCache(): void {
  probeCache.clear();
}

/**
 * Does this URL speak MCP? A single `initialize` request is enough: any live MCP
 * server answers with a JSON-RPC result, a non-MCP listener does not.
 */
export async function probeMcpHttp(
  url: string,
  timeoutMs = DEFAULTS.probeTimeoutMs,
  cacheMs = DEFAULTS.probeCacheMs,
): Promise<boolean> {
  const cached = probeCache.get(url);
  if (cached && Date.now() - cached.at < cacheMs) return cached.alive;

  let alive = false;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'acp-hub-probe', version: '0.0.0' },
        },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) {
      const text = await res.text();
      alive = /"jsonrpc"/.test(text) && /("result"|"capabilities")/.test(text);
    }
    // Drain whatever is left so the socket is not held open.
    await res.arrayBuffer().catch(() => undefined);
  } catch {
    alive = false;
  }

  probeCache.set(url, { at: Date.now(), alive });
  return alive;
}

interface RawEntry {
  type?: unknown;
  url?: unknown;
  command?: unknown;
  args?: unknown;
  env?: unknown;
}

/**
 * Turn a `.mcp.json` entry into the ACP `session/new` shape.
 *
 * Note the asymmetry: ACP stdio servers carry **no** `type` field (a `type` key is
 * how the spec marks a remote transport), so writing `type: "stdio"` makes agents
 * reject the entry outright.
 */
function normalizeEntry(name: string, raw: RawEntry): McpServer | { reason: string } {
  const url = typeof raw.url === 'string' ? raw.url : undefined;
  const type = typeof raw.type === 'string' ? raw.type : undefined;

  if (type === 'sse') {
    return { reason: 'sse transport is not supported by current agents; declare it as http' };
  }
  if (type && type !== 'http' && type !== 'stdio' && type !== 'streamable-http') {
    return { reason: `unknown transport: ${type}` };
  }
  if (url) {
    if (!/^https?:\/\//i.test(url)) return { reason: `not an http(s) url: ${url}` };
    return { type: 'http', name, url };
  }
  const command = typeof raw.command === 'string' ? raw.command : undefined;
  if (command) {
    const args = Array.isArray(raw.args) ? raw.args.filter((a): a is string => typeof a === 'string') : undefined;
    const env =
      raw.env && typeof raw.env === 'object'
        ? Object.fromEntries(
            Object.entries(raw.env as Record<string, unknown>).filter(
              (entry): entry is [string, string] => typeof entry[1] === 'string',
            ),
          )
        : undefined;
    return { name, command, ...(args ? { args } : {}), ...(env ? { env } : {}) };
  }
  return { reason: 'entry has neither url nor command' };
}

async function findConfig(startDir: string, maxParents: number): Promise<string | null> {
  let dir = resolve(startDir);
  for (let i = 0; i <= maxParents; i++) {
    const candidate = join(dir, '.mcp.json');
    try {
      const info = await stat(candidate);
      if (info.isFile()) return candidate;
    } catch {
      /* keep walking */
    }
    const parent = dirname(dir);
    if (parent === dir || parent === parsePath(dir).root) break;
    dir = parent;
  }
  return null;
}

async function readConfig(path: string): Promise<Record<string, RawEntry>> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as { mcpServers?: unknown };
    const servers = parsed?.mcpServers;
    if (!servers || typeof servers !== 'object') return {};
    return servers as Record<string, RawEntry>;
  } catch {
    return {};
  }
}

async function looksLikeUnrealProject(cwd: string): Promise<boolean> {
  try {
    const entries = await stat(cwd);
    if (!entries.isDirectory()) return false;
  } catch {
    return false;
  }
  try {
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(cwd);
    return files.some((f) => f.toLowerCase().endsWith('.uproject'));
  } catch {
    return false;
  }
}

/**
 * Resolve every MCP server this project should hand to an agent.
 *
 * Order: the project's `.mcp.json` declarations, then — for a UE project — the
 * editor's default endpoint, unless the config already names that URL. http
 * candidates are probed; stdio ones are passed through (the agent starts them).
 */
export async function discoverProjectMcpServers(
  cwd: string,
  options: McpDiscoveryOptions = {},
): Promise<McpDiscoveryResult> {
  const opts = { ...DEFAULTS, ...options };
  const result: McpDiscoveryResult = { servers: [], skipped: [], sources: [] };
  const seenUrls = new Set<string>();
  const seenNames = new Set<string>();

  const addHttp = async (name: string, url: string, source: string): Promise<void> => {
    if (seenUrls.has(url)) return;
    seenUrls.add(url);
    if (await probeMcpHttp(url, opts.probeTimeoutMs, opts.probeCacheMs)) {
      if (seenNames.has(name)) {
        result.skipped.push({ name, target: url, reason: 'duplicate server name' });
        return;
      }
      seenNames.add(name);
      result.servers.push({ type: 'http', name, url });
      result.sources.push(`${source} (${url})`);
    } else {
      result.skipped.push({ name, target: url, reason: 'endpoint did not answer MCP initialize' });
    }
  };

  const configPath = await findConfig(cwd, opts.maxParents);
  if (configPath) {
    const declared = await readConfig(configPath);
    for (const [name, raw] of Object.entries(declared)) {
      if (!raw || typeof raw !== 'object') continue;
      // Transport check first: an `sse` entry also has a url, and probing it would
      // report a misleading "endpoint did not answer".
      if (typeof raw.type === 'string' && raw.type === 'sse') {
        result.skipped.push({ name, reason: 'sse transport is not supported by current agents' });
        continue;
      }
      if (typeof raw.url === 'string' && /^https?:\/\//i.test(raw.url)) {
        await addHttp(name, raw.url, configPath);
        continue;
      }
      const normalized = normalizeEntry(name, raw);
      if ('reason' in normalized) {
        result.skipped.push({ name, reason: normalized.reason });
        continue;
      }
      if (seenNames.has(name)) {
        result.skipped.push({ name, reason: 'duplicate server name' });
        continue;
      }
      seenNames.add(name);
      result.servers.push(normalized);
      result.sources.push(configPath);
    }
  }

  if (opts.unrealDefaultUrl && (await looksLikeUnrealProject(cwd))) {
    await addHttp('unreal-mcp', opts.unrealDefaultUrl, 'unreal editor default');
  }

  return result;
}
