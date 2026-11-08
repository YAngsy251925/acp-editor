/**
 * ACP agent process: spawn, handshake, sessions, prompts, streaming updates.
 *
 * The client side of ACP is not just "send prompt, read reply" — the agent
 * calls back into the client for permissions and file access. Both directions
 * are implemented here so an agent never deadlocks waiting on us.
 */
import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { createInterface } from 'node:readline';

import { decodeUtf8 } from './changes.js';
import { JsonRpcConnection, RpcCallError } from './jsonrpc.js';
import { RpcError } from './types.js';
import type {
  ConfigOption,
  ContentBlock,
  InitializeResult,
  McpServer,
  PermissionOption,
  PromptResult,
  ReadTextFileParams,
  RequestPermissionParams,
  RequestPermissionResult,
  SessionNewResult,
  SessionUpdateParams,
  SetConfigOptionResult,
  StopReason,
  WriteTextFileParams,
} from './types.js';

export const ACP_PROTOCOL_VERSION = 1;
const CLIENT_NAME = 'acp-editor-hub';
const CLIENT_VERSION = '0.1.0';

export interface AcpAgentOptions {
  /** Executable + args that starts the agent in ACP mode, e.g. ['opencode','acp']. */
  command: string[];
  /** Working directory used for spawning and as the default fs sandbox root. */
  cwd?: string;
  env?: Record<string, string>;
  /** Default RPC timeout. `session/prompt` uses its own much larger budget. */
  requestTimeoutMs?: number;
  /** Extra roots the agent may read/write through fs/*. Defaults to `cwd`. */
  allowedRoots?: string[];
  /** Cap on retained stderr lines (diagnostics only). */
  stderrLines?: number;
  /** Start through the platform shell (a batch file that could not be resolved to node). */
  shell?: boolean;
}

/** How long a stopping agent gets to exit on stdin EOF before it is killed. */
const GRACEFUL_EXIT_MS = 3_000;

export interface SessionHandle {
  sessionId: string;
  configOptions: ConfigOption[];
}

export interface PromptOptions {
  sessionId: string;
  prompt: ContentBlock[];
  /** Overall turn budget. Default 30 minutes. */
  timeoutMs?: number;
}

/** Emitted as `file-write` after the hub writes a file on the agent's behalf. */
export interface FileWriteEvent {
  sessionId: string;
  /** Absolute, sandbox-checked path. */
  path: string;
  /** Previous content; `null` when the file did not exist. */
  oldText: string | null;
  newText: string;
  /** The previous content was not valid UTF-8; `oldText` is a lossy rendering of it. */
  lossy: boolean;
}

export class AcpAgent extends EventEmitter {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly rpc: JsonRpcConnection;
  private readonly options: AcpAgentOptions;
  private readonly allowedRoots: string[];
  private readonly stderrBuffer: string[] = [];
  private readonly stderrCap: number;
  private initializeResult: InitializeResult | null = null;
  private permissionHandler:
    | ((params: RequestPermissionParams) => Promise<RequestPermissionResult>)
    | null = null;
  private exited = false;
  /** Resolved when the process is really gone (see whenExited). */
  private readonly exitPromise: Promise<void>;
  /** Serialise turns per session so two prompts can't interleave. */
  private readonly turnLocks = new Map<string, Promise<unknown>>();

  private constructor(child: ChildProcessWithoutNullStreams, options: AcpAgentOptions) {
    super();
    this.child = child;
    this.options = options;
    this.stderrCap = options.stderrLines ?? 200;
    const cwd = options.cwd ?? process.cwd();
    this.allowedRoots = (options.allowedRoots ?? [cwd]).map((p) => resolve(p));

    this.rpc = new JsonRpcConnection(
      child.stdout,
      child.stdin,
      (method, params) => this.handleInboundRequest(method, params),
      {
        requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
        onParseError: (line, err) => this.emit('warning', `bad line from agent: ${err.message}`, line),
      },
    );

    this.rpc.on('notification', (method: string, params: unknown) => {
      if (method === 'session/update') {
        this.emit('update', params as SessionUpdateParams);
      } else {
        this.emit('notification', method, params);
      }
    });

    this.rpc.on('close', (reason: string) => {
      this.emit('rpc-close', reason);
    });

    const stderrRl = createInterface({ input: child.stderr, crlfDelay: Infinity });
    stderrRl.on('line', (line) => {
      this.stderrBuffer.push(line);
      if (this.stderrBuffer.length > this.stderrCap) this.stderrBuffer.shift();
      this.emit('stderr', line);
    });

    this.exitPromise = new Promise<void>((resolveExit) => {
      child.on('exit', (code, signal) => {
        this.exited = true;
        resolveExit();
        this.emit('exit', { code, signal });
      });
    });
    child.on('error', (err) => {
      this.exited = true;
      this.emit('error', err);
    });
  }

  /** Spawn the agent process. Does not perform the ACP handshake. */
  static spawn(options: AcpAgentOptions): AcpAgent {
    const [bin, ...args] = options.command;
    if (!bin) throw new Error('AcpAgent.spawn: empty command');

    const child = spawn(bin, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: 'pipe',
      // Windows .cmd shims are resolved to `node <entry>` by the registry
      // (resolveLaunch); `shell` is only the fallback for other batch files.
      shell: options.shell ?? false,
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;

    return new AcpAgent(child, options);
  }

  static async start(options: AcpAgentOptions): Promise<AcpAgent> {
    const agent = AcpAgent.spawn(options);
    await agent.initialize();
    return agent;
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get info(): InitializeResult | null {
    return this.initializeResult;
  }

  get stderr(): string[] {
    return [...this.stderrBuffer];
  }

  // -------------------------------------------------------------------------
  // handshake
  // -------------------------------------------------------------------------

  async initialize(): Promise<InitializeResult> {
    const result = await this.rpc.request<InitializeResult>('initialize', {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: false,
      },
      clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
    });

    if (typeof result?.protocolVersion !== 'number') {
      throw new Error('agent returned an initialize result without protocolVersion');
    }
    if (result.protocolVersion !== ACP_PROTOCOL_VERSION) {
      this.emit(
        'warning',
        `protocol mismatch: agent=${result.protocolVersion} client=${ACP_PROTOCOL_VERSION}`,
      );
    }
    this.initializeResult = result;
    return result;
  }

  async authenticate(methodId: string): Promise<void> {
    await this.rpc.request('authenticate', { methodId });
  }

  // -------------------------------------------------------------------------
  // sessions
  // -------------------------------------------------------------------------

  async newSession(params: { cwd?: string; mcpServers?: McpServer[] }): Promise<SessionHandle> {
    const result = await this.rpc.request<SessionNewResult>('session/new', {
      cwd: params.cwd ?? this.options.cwd ?? process.cwd(),
      mcpServers: params.mcpServers ?? [],
    });
    if (!result?.sessionId) throw new Error('session/new returned no sessionId');
    return {
      sessionId: result.sessionId,
      configOptions: result.configOptions ?? [],
    };
  }

  async loadSession(params: {
    sessionId: string;
    cwd?: string;
    mcpServers?: McpServer[];
  }): Promise<SessionHandle> {
    const result = await this.rpc.request<SessionNewResult>('session/load', {
      sessionId: params.sessionId,
      cwd: params.cwd ?? this.options.cwd ?? process.cwd(),
      mcpServers: params.mcpServers ?? [],
    });
    return {
      sessionId: params.sessionId,
      configOptions: result?.configOptions ?? [],
    };
  }

  /**
   * Reattach to a session the agent persisted (`sessionCapabilities.resume`).
   * Unlike session/load, nothing is replayed: the client shows the history it kept.
   */
  async resumeSession(params: {
    sessionId: string;
    cwd?: string;
    mcpServers?: McpServer[];
  }): Promise<SessionHandle> {
    const result = await this.rpc.request<{ configOptions?: ConfigOption[] | null }>('session/resume', {
      sessionId: params.sessionId,
      cwd: params.cwd ?? this.options.cwd ?? process.cwd(),
      mcpServers: params.mcpServers ?? [],
    });
    return { sessionId: params.sessionId, configOptions: result?.configOptions ?? [] };
  }

  async setConfigOption(params: {
    sessionId: string;
    configId: string;
    value: string | boolean;
  }): Promise<ConfigOption[]> {
    const result = await this.rpc.request<SetConfigOptionResult>('session/set_config_option', {
      sessionId: params.sessionId,
      configId: params.configId,
      value: params.value,
    });
    return result?.configOptions ?? [];
  }

  async cancel(sessionId: string): Promise<void> {
    await this.rpc.notify('session/cancel', { sessionId });
  }

  async closeSession(sessionId: string): Promise<void> {
    try {
      await this.rpc.request('session/close', { sessionId }, 10_000);
    } catch (err) {
      // Agents without sessionCapabilities.close: ignore.
      if (!(err instanceof RpcCallError)) throw err;
    }
  }

  /**
   * Run one turn. Resolves when the agent reports a stop reason.
   * Streamed content arrives via the `update` event.
   */
  async prompt(options: PromptOptions): Promise<PromptResult> {
    const { sessionId } = options;

    // Serialise turns for this session.
    const previous = this.turnLocks.get(sessionId) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(() =>
        this.rpc.request<PromptResult>(
          'session/prompt',
          { sessionId, prompt: options.prompt },
          options.timeoutMs ?? 30 * 60_000,
        ),
      );

    this.turnLocks.set(
      sessionId,
      run.catch(() => undefined),
    );

    try {
      const result = await run;
      return {
        stopReason: (result?.stopReason ?? 'end_turn') as StopReason,
        usage: result?.usage,
      };
    } finally {
      if (this.turnLocks.get(sessionId) === run) this.turnLocks.delete(sessionId);
    }
  }

  // -------------------------------------------------------------------------
  // permissions
  // -------------------------------------------------------------------------

  setPermissionHandler(
    handler: (params: RequestPermissionParams) => Promise<RequestPermissionResult>,
  ): void {
    this.permissionHandler = handler;
  }

  // -------------------------------------------------------------------------
  // lifecycle
  // -------------------------------------------------------------------------

  /** Resolves once the process has exited; false if `timeoutMs` passed first. */
  async whenExited(timeoutMs = GRACEFUL_EXIT_MS + 2_000): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    timer?.unref?.();
    const outcome = await Promise.race([this.exitPromise.then(() => 'exit' as const), timeout]);
    clearTimeout(timer);
    return outcome === 'exit';
  }

  /**
   * Stop the agent. Closing stdin comes first: ACP agents treat EOF as the end of
   * the connection and flush what they persist (dsh --profile acp drains its
   * sessions), which a Windows kill — TerminateProcess — would skip. Only an
   * agent still running after GRACEFUL_EXIT_MS is killed.
   */
  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    this.rpc.close('client killing agent');
    if (this.exited) return;
    try {
      this.child.stdin.end();
    } catch {
      /* already closed */
    }
    const force = (sig: NodeJS.Signals) => {
      if (this.exited) return;
      try {
        this.child.kill(sig);
      } catch {
        /* already gone */
      }
    };
    const timer = setTimeout(() => {
      force(signal);
      setTimeout(() => force('SIGKILL'), 2_000).unref?.();
    }, GRACEFUL_EXIT_MS);
    timer.unref?.();
  }

  // -------------------------------------------------------------------------
  // inbound requests (agent -> client)
  // -------------------------------------------------------------------------

  private async handleInboundRequest(method: string, rawParams: unknown): Promise<unknown> {
    switch (method) {
      case 'session/request_permission': {
        const params = rawParams as RequestPermissionParams;
        if (!this.permissionHandler) {
          // Safe default: deny by picking a reject option when available.
          return denyPermission(params);
        }
        return this.permissionHandler(params);
      }

      case 'fs/read_text_file': {
        const params = rawParams as ReadTextFileParams;
        const path = this.resolveAllowed(params.path);
        const content = await readFile(path, 'utf8');
        if (params.line === undefined && params.limit === undefined) return { content };
        const lines = content.split('\n');
        const start = Math.max(0, (params.line ?? 1) - 1);
        const end = params.limit ? start + params.limit : lines.length;
        return { content: lines.slice(start, end).join('\n') };
      }

      case 'fs/write_text_file': {
        const params = rawParams as WriteTextFileParams;
        const path = this.resolveAllowed(params.path);
        // Keep what was there, so the write can be reviewed and reverted.
        let oldText: string | null | undefined;
        let lossy = false;
        try {
          const bytes = await readFile(path);
          const decoded = decodeUtf8(bytes);
          lossy = decoded === null;
          oldText = decoded ?? bytes.toString('utf8');
        } catch (err) {
          oldText = (err as NodeJS.ErrnoException).code === 'ENOENT' ? null : undefined;
        }
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, params.content, 'utf8');
        if (oldText !== undefined) {
          const write: FileWriteEvent = {
            sessionId: params.sessionId,
            path,
            oldText,
            newText: params.content,
            lossy,
          };
          this.emit('file-write', write);
        }
        // WriteTextFileResponse is an object (only `_meta`), not null.
        return {};
      }

      case 'terminal/create':
      case 'terminal/output':
      case 'terminal/wait_for_exit':
      case 'terminal/kill':
      case 'terminal/release':
        // We advertise terminal:false, so a compliant agent never sends these.
        throw Object.assign(new Error(`unsupported client method: ${method}`), {
          code: RpcError.MethodNotFound,
        });

      default:
        throw Object.assign(new Error(`unknown client method: ${method}`), {
          code: RpcError.MethodNotFound,
        });
    }
  }

  private resolveAllowed(requestedPath: string): string {
    const absolute = isAbsolute(requestedPath)
      ? resolve(requestedPath)
      : resolve(this.options.cwd ?? process.cwd(), requestedPath);

    const inside = this.allowedRoots.some((root) => {
      const rel = relative(root, absolute);
      return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
    });
    if (!inside) {
      throw Object.assign(new Error(`path outside allowed roots: ${absolute}`), {
        code: RpcError.InvalidParams,
      });
    }
    return absolute;
  }
}

function denyPermission(params: RequestPermissionParams): RequestPermissionResult {
  const reject = (params.options ?? []).find(
    (o: PermissionOption) => o.kind === 'reject_once' || o.kind === 'reject_always',
  );
  if (reject) return { outcome: { outcome: 'selected', optionId: reject.optionId } };
  return { outcome: { outcome: 'cancelled' } };
}
