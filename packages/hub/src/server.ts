/**
 * The HTTP surface of the hub.
 *
 * Design notes
 * ------------
 * - Every session owns one agent child process and one SSE stream. Reconnects
 *   replay from `Last-Event-ID`, so an editor tab reload never loses output.
 * - `POST /prompt` returns immediately; the turn's lifecycle is reported on the
 *   stream (`turn_start` / `turn_end`). A multi-minute turn must not hold an
 *   HTTP request open.
 * - Permission requests are parked, surfaced on the stream, and resolved by
 *   `POST /permission`. Auto-denying keeps an agent from hanging forever.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';

import { AcpAgent, type FileWriteEvent } from './acp-client.js';
import { ChangeError, ChangeTracker, type FileChange, type ToolCallLike } from './changes.js';
import { discoverProjectMcpServers, type McpDiscoveryOptions, type McpDiscoveryResult } from './mcp-discovery.js';
import { ensureAgentShim, ensureEditorBridge, ensureUserPathEntry, type EditorBridge, type EditorBridgeOptions } from './editor-bridge.js';
import { AgentRegistry, resolveLaunch, type AgentStatus } from './registry.js';
import { WorkspaceSnapshot } from './snapshot.js';
import { EventLog, SseChannel } from './sse.js';
import { SessionStore, type StoredEvent } from './store.js';
import type {
  ConfigOption,
  ContentBlock,
  McpServer,
  PermissionOption,
  RequestPermissionParams,
  RequestPermissionResult,
  SessionUpdateParams,
} from './types.js';
import { isToolCallDiff } from './types.js';

export type PermissionMode = 'ask' | 'deny' | 'allow';

export interface HubServerOptions {
  host?: string;
  port?: number;
  defaultCwd?: string;
  registry?: AgentRegistry;
  /** Default policy when a session does not specify one. */
  permissionMode?: PermissionMode;
  /** How long a parked permission waits before being denied. */
  permissionTimeoutMs?: number;
  /** Optional bearer token required on every request (except /health). */
  token?: string;
  /** Directory for session transcripts. Defaults to ~/.acp-editor/sessions. */
  dataDir?: string;
  /** Override how project MCP servers are discovered (tests disable the UE default). */
  mcpDiscovery?: McpDiscoveryOptions;
  /**
   * Generate the `ue-mcp` shim and the dsh system-prompt overlay. Defaults to on;
   * `false` disables it (tests, or a host that does not want files written).
   */
  editorBridge?: false | EditorBridgeOptions;
}

interface ManagedSession {
  id: string;
  agentId: string;
  agent: AcpAgent;
  cwd: string;
  /**
   * Opaque id of the client instance that created this session (one editor tab /
   * page load). Orphan cleanup is scoped by it: two tabs of the same panel must
   * never close each other's sessions, so the browser tab's identity — not the
   * user — is what makes "my leftovers" answerable.
   */
  clientId?: string;
  configOptions: ConfigOption[];
  log: EventLog;
  subscribers: Set<SseChannel>;
  pendingPermissions: Map<string, (result: RequestPermissionResult) => void>;
  permissionMode: PermissionMode;
  /** File edits made during this session, open for keep / revert. */
  changes: ChangeTracker;
  /** MCP servers handed to the agent at `session/new` (project discovery or explicit). */
  mcpServers: McpServer[];
  /** Disk baseline for snapshot edit tracking, set only for agents that ask for it. */
  snapshot: WorkspaceSnapshot | null;
  busy: boolean;
  createdAt: number;
  /** Characters of assistant text produced during the current turn. */
  turnChars: number;
  lastTurn?: {
    startedAt: number;
    finishedAt?: number;
    stopReason?: string;
    error?: string;
  };
}

export class HubServer {
  private readonly options: Required<
    Pick<HubServerOptions, 'host' | 'port' | 'permissionMode' | 'permissionTimeoutMs'>
  > &
    HubServerOptions;
  private readonly registry: AgentRegistry;
  private readonly store: SessionStore;
  private readonly sessions = new Map<string, ManagedSession>();
  private server: ReturnType<typeof createServer> | null = null;
  private actualPort = 0;
  /** Lazily materialised `ue-mcp` shim + dsh overlay (see editor-bridge.ts). */
  private bridgePromise: Promise<EditorBridge | null> | null = null;

  constructor(options: HubServerOptions = {}) {
    this.options = {
      host: options.host ?? '127.0.0.1',
      port: options.port ?? 7878,
      permissionMode: options.permissionMode ?? 'ask',
      permissionTimeoutMs: options.permissionTimeoutMs ?? 5 * 60_000,
      ...options,
    };
    this.registry = options.registry ?? new AgentRegistry();
    this.store = new SessionStore(options.dataDir);
  }

  get port(): number {
    return this.actualPort;
  }

  get url(): string {
    return `http://${this.options.host}:${this.actualPort}`;
  }

  async listen(): Promise<string> {
    const server = createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        if (!res.headersSent) this.sendJson(res, 500, { error: { message: String(err?.message ?? err) } });
        else res.end();
      });
    });
    this.server = server;

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.options.port, this.options.host, () => resolve());
    });

    const address = server.address();
    this.actualPort = typeof address === 'object' && address ? address.port : this.options.port;
    return this.url;
  }

  async close(): Promise<void> {
    for (const session of this.sessions.values()) {
      for (const sub of session.subscribers) sub.close();
      session.agent.kill();
    }
    this.sessions.clear();
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
    this.server = null;
  }

  // -------------------------------------------------------------------------
  // routing
  // -------------------------------------------------------------------------

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method ?? 'GET';

    if (method === 'OPTIONS') {
      this.sendCors(res);
      res.writeHead(204).end();
      return;
    }

    // Auth (optional).
    const token = this.options.token;
    if (token && path !== '/health') {
      const auth = req.headers.authorization ?? '';
      if (auth !== `Bearer ${token}`) {
        this.sendJson(res, 401, { error: { message: 'unauthorized' } });
        return;
      }
    }

    if (method === 'GET' && path === '/health') {
      this.sendJson(res, 200, {
        ok: true,
        name: 'acp-editor-hub',
        version: '0.1.0',
        sessions: this.sessions.size,
      });
      return;
    }

    if (method === 'GET' && path === '/agents') {
      const statuses = await this.registry.listStatuses();
      this.sendJson(res, 200, { agents: statuses.map(toPublicAgent) });
      return;
    }

    const agentMatch = /^\/agents\/([^/]+)$/.exec(path);
    if (method === 'GET' && agentMatch) {
      const status = await this.registry.getStatus(decodeURIComponent(agentMatch[1]!));
      if (!status) this.sendJson(res, 404, { error: { message: 'unknown agent' } });
      else this.sendJson(res, 200, toPublicAgent(status));
      return;
    }

    if (method === 'POST' && path === '/sessions') {
      await this.createSession(req, res);
      return;
    }

    // Close this client's own leftovers — the sessions a previous page load of the
    // same tab left behind. Scoped by clientId on purpose: a global "close
    // everything" would kill another tab's agent (and the edits it is reviewing),
    // which is exactly what multi-session tabs must never allow.
    if (method === 'POST' && path === '/sessions/close-orphans') {
      const body = await readJsonBody(req);
      const clientId = readClientId(body);
      if (!clientId) {
        this.sendJson(res, 400, { error: { message: 'clientId is required' } });
        return;
      }
      const keep = typeof body.keep === 'string' ? body.keep : null;
      const victims = [...this.sessions.values()].filter(
        (session) => session.clientId === clientId && session.id !== keep,
      );
      await Promise.all(victims.map((session) => this.shutdownSession(session)));
      this.sendJson(res, 200, { closed: victims.map((session) => session.id), clientId });
      return;
    }

    if (method === 'GET' && path === '/sessions') {
      this.sendJson(res, 200, {
        sessions: [...this.sessions.values()].map((s) => this.sessionSummary(s)),
      });
      return;
    }

    // Persisted history (includes sessions whose agent already exited).
    if (method === 'GET' && path === '/history') {
      this.sendJson(res, 200, { sessions: await this.store.list() });
      return;
    }

    const transcriptMatch = /^\/sessions\/([^/]+)\/transcript$/.exec(path);
    if (method === 'GET' && transcriptMatch) {
      const id = decodeURIComponent(transcriptMatch[1]!);
      this.sendJson(res, 200, { sessionId: id, events: await this.store.read(id) });
      return;
    }

    const historyDeleteMatch = /^\/history\/([^/]+)$/.exec(path);
    if (method === 'DELETE' && historyDeleteMatch) {
      const id = decodeURIComponent(historyDeleteMatch[1]!);
      await this.store.delete(id);
      this.sendJson(res, 200, { deleted: id });
      return;
    }

    const changesMatch = /^\/sessions\/([^/]+)\/changes(?:\/([^/]+)\/(keep|revert))?$/.exec(path);
    if (changesMatch) {
      const session = this.sessions.get(decodeURIComponent(changesMatch[1]!));
      if (!session) {
        this.sendJson(res, 404, { error: { message: 'unknown session' } });
        return;
      }
      if (!changesMatch[2]) {
        if (method === 'GET') this.sendJson(res, 200, { changes: session.changes.list() });
        else this.sendJson(res, 405, { error: { message: 'method not allowed' } });
        return;
      }
      if (method !== 'POST') {
        this.sendJson(res, 405, { error: { message: 'method not allowed' } });
        return;
      }
      await this.decideChange(session, decodeURIComponent(changesMatch[2]), changesMatch[3]!, res);
      return;
    }

    const sessionMatch = /^\/sessions\/([^/]+)(?:\/(stream|prompt|cancel|config|permission))?$/.exec(
      path,
    );
    if (sessionMatch) {
      const sessionId = decodeURIComponent(sessionMatch[1]!);
      const action = sessionMatch[2];
      const session = this.sessions.get(sessionId);
      if (!session) {
        this.sendJson(res, 404, { error: { message: 'unknown session' } });
        return;
      }
      if (!action) {
        if (method === 'GET') this.sendJson(res, 200, this.sessionSummary(session));
        else if (method === 'DELETE') await this.deleteSession(session, res);
        else this.sendJson(res, 405, { error: { message: 'method not allowed' } });
        return;
      }
      switch (action) {
        case 'stream':
          this.openStream(session, req, res);
          return;
        case 'prompt':
          await this.startPrompt(session, req, res);
          return;
        case 'cancel':
          await session.agent.cancel(session.id);
          this.sendJson(res, 202, { accepted: true });
          return;
        case 'config':
          await this.setConfig(session, req, res);
          return;
        case 'permission':
          await this.resolvePermission(session, req, res);
          return;
      }
    }

    this.sendJson(res, 404, { error: { message: `no route for ${method} ${path}` } });
  }

  // -------------------------------------------------------------------------
  // sessions
  // -------------------------------------------------------------------------

  private async createSession(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJsonBody(req);
    const agentId = typeof body.agentId === 'string' ? body.agentId : '';
    if (!agentId) {
      this.sendJson(res, 400, { error: { message: 'agentId is required' } });
      return;
    }

    const status = await this.registry.getStatus(agentId);
    if (!status) {
      this.sendJson(res, 404, { error: { message: `unknown agent: ${agentId}` } });
      return;
    }
    if (!status.available) {
      this.sendJson(res, 409, {
        error: { message: `agent not available: ${agentId}`, reason: status.reason },
      });
      return;
    }

    const cwd = typeof body.cwd === 'string' ? body.cwd : (this.options.defaultCwd ?? process.cwd());
    // MCP: an explicit list from the client wins. Otherwise the session inherits what
    // the project itself declares (`.mcp.json`, the same file other clients read) plus
    // the Unreal editor's default endpoint when this looks like a UE project. That is
    // what makes "the agent already knows about the editor's tools" true for every
    // client and every agent — the panel configures nothing.
    const explicitMcp = Array.isArray(body.mcpServers) ? (body.mcpServers as McpServer[]) : null;
    let mcpServers: McpServer[] = explicitMcp ?? [];
    let mcpWarning: string | undefined;
    // A version gate we can answer before spawning: no point handing a list to an
    // agent whose build is known not to surface it.
    const mcpUnsupported = status.capabilities?.mcp === false;
    if (!explicitMcp && !mcpUnsupported) {
      const discovered: McpDiscoveryResult = await discoverProjectMcpServers(
        cwd,
        this.options.mcpDiscovery ?? {},
      );
      mcpServers = discovered.servers;
      if (mcpServers.length > 0) {
        console.log(`[mcp] ${cwd}: ${mcpServers.map((s) => s.name).join(', ')}`);
      }
      for (const skip of discovered.skipped) {
        console.log(
          `[mcp] skipped ${skip.name}${skip.target ? ` (${skip.target})` : ''}: ${skip.reason}`,
        );
      }
    }
    const permissionMode = isPermissionMode(body.permissionMode)
      ? body.permissionMode
      : this.options.permissionMode;
    const clientId = readClientId(body);

    // `resume` reattaches to a session a previous agent process persisted, so an
    // old conversation can be continued. Requires the agent's sessionCapabilities.
    const resumeId = typeof body.resume === 'string' && body.resume ? body.resume : null;

    // A session this hub already owns cannot be resumed by a second process: the
    // agent's persistence layer allows exactly one write handle per session, so
    // the second `session/resume` dies with "already owned by an active write
    // handle". Attaching to the live session is what the caller actually wants
    // (and it is also the race when the client resumes the session it just had
    // open). Reuse it instead of spawning a rival process.
    if (resumeId) {
      const live = this.sessions.get(resumeId);
      if (live && live.agentId !== agentId) {
        this.sendJson(res, 409, {
          error: {
            message: `会话 ${resumeId} 正由另一个 agent（${live.agentId}）持有，不能换成 ${agentId} 接管`,
            reason: 'session-owned-by-other-agent',
          },
        });
        return;
      }
      if (live) {
        this.sendJson(res, 200, {
          sessionId: live.id,
          agentId: live.agentId,
          clientId: live.clientId,
          cwd: live.cwd,
          permissionMode: live.permissionMode,
          resumed: true,
          reused: true,
          configOptions: live.configOptions,
          models: pickModels(live.configOptions),
          mcpServers: publicMcpServers(live.mcpServers),
          stream: `/sessions/${live.id}/stream`,
        });
        return;
      }
    }

    let agent: AcpAgent | undefined;
    let handle: { sessionId: string; configOptions: ConfigOption[] };
    if (!explicitMcp && mcpUnsupported) {
      mcpWarning =
        `${agentId} ${status.version ?? ''} 不支持编辑器 MCP（需要 ${status.features?.mcp ?? '更新版本'}），未注入；` +
        '可用 ue-mcp 兜底读取编辑器状态。';
      console.log(`[mcp] ${agentId}: skipped (${mcpWarning})`);
    }
    try {
      ({ agent, handle } = await this.spawnAgentSession(status, agentId, cwd, resumeId, mcpServers));
    } catch (err) {
      const why = (err as Error).message;
      const detail = (err as { data?: { details?: unknown } }).data?.details;
      const details = typeof detail === 'string' ? detail : '';
      const data = JSON.stringify((err as { data?: unknown }).data ?? '');

      // A session with no editor tools beats no session at all: if MCP is what the
      // agent refused, start again without it and say so. Agents disagree about the
      // accepted transports (dsh takes http and ignores it, opencode only takes sse
      // and hangs on streamable http), and ACP gives us no capability flag to ask.
      if (mcpServers.length > 0 && /(-32602|-32603|invalid params|mcp ?servers)/i.test(`${why} ${data}`)) {
        mcpWarning = `agent 拒绝了 MCP 服务器，已按无 MCP 重试：${details || why}`;
        console.log(`[mcp] ${agentId}: ${mcpWarning}`);
        mcpServers = [];
        try {
          ({ agent, handle } = await this.spawnAgentSession(status, agentId, cwd, resumeId, []));
        } catch (retryErr) {
          this.sendStartError(res, retryErr, resumeId);
          return;
        }
      } else {
        this.sendStartError(res, err, resumeId);
        return;
      }
    }

    // An agent that hands back an id this hub already holds would silently replace
    // a live session in the map — leaking its agent process and its open file-edit
    // review. Refuse instead of pretending the new one took its place.
    if (handle.sessionId && this.sessions.has(handle.sessionId)) {
      agent?.kill();
      this.sendJson(res, 409, {
        error: {
          message: `agent 返回了已被占用的 sessionId：${handle.sessionId}`,
          reason: 'duplicate-session-id',
        },
      });
      return;
    }

    const shortId = randomUUID().slice(0, 8);
    const session: ManagedSession = {
      id: handle.sessionId || shortId,
      agentId,
      agent,
      cwd,
      ...(clientId ? { clientId } : {}),
      configOptions: handle.configOptions ?? [],
      log: new EventLog(),
      subscribers: new Set(),
      pendingPermissions: new Map(),
      permissionMode,
      changes: new ChangeTracker({ cwd }),
      mcpServers,
      snapshot: status.trackEdits === 'snapshot' ? new WorkspaceSnapshot(cwd) : null,
      busy: false,
      createdAt: Date.now(),
      turnChars: 0,
    };

    this.wireSessionEvents(session);
    this.sessions.set(session.id, session);

    void this.store.append(session.id, {
      t: Date.now(),
      type: 'meta',
      sessionId: session.id,
      agentId,
      cwd,
      createdAt: session.createdAt,
    });

    this.sendJson(res, 201, {
      sessionId: session.id,
      agentId,
      cwd,
      permissionMode,
      resumed: Boolean(resumeId),
      configOptions: session.configOptions,
      models: pickModels(session.configOptions),
      mcpServers: publicMcpServers(session.mcpServers),
      ...(mcpWarning ? { mcpWarning } : {}),
      stream: `/sessions/${session.id}/stream`,
    });
  }

  /**
   * Spawn the agent and open (or resume) the session. The process is killed on any
   * failure so a retry never races a half-started agent.
   */
  private async spawnAgentSession(
    status: AgentStatus,
    agentId: string,
    cwd: string,
    resumeId: string | null,
    mcpServers: McpServer[],
  ): Promise<{ agent: AcpAgent; handle: { sessionId: string; configOptions: ConfigOption[] } }> {
    const launch = await resolveLaunch(status);
    const bridge = await this.editorBridge();
    const command = [...launch.command];
    // Agents that take extra profile overlays get told about the editor's `ue-mcp`
    // command in their system prompt — the one thing that makes the capability
    // innate rather than something the user has to explain per conversation.
    const patchSupported = status.capabilities?.patch ?? true;
    if (bridge && status.patchFlag && patchSupported) command.push(status.patchFlag, bridge.patchPath);
    const agent = AcpAgent.spawn({
      command,
      cwd,
      shell: launch.shell,
      ...(bridge ? { env: bridge.env } : {}),
    });
    hookAgentLogging(agent, agentId);
    if (bridge && status.patchFlag && patchSupported) {
      console.log(`[bridge] ${agentId}: ue-mcp on PATH via ${bridge.binDir}`);
    }
    // A runtime that is not a CLI (an entry point pinned from inside another product)
    // gets a shim of its own, so `dsh` keeps working in a shell without a second install.
    if (bridge && status.resolvedPath && /\.(?:c|m)?js$/i.test(status.resolvedPath)) {
      // The shim is named after the *command* the user types (`dsh`), not after the
      // pinned file (`bin.js`) — otherwise you get a `bin.cmd` nobody asked for.
      const commandName = status.command[0] ?? '';
      const shimName = /^[A-Za-z0-9._-]+$/.test(commandName) ? commandName : status.id;
      const shim = await ensureAgentShim(shimName, status.resolvedPath, bridge.binDir);
      if (shim) console.log(`[bridge] ${shimName} shim -> ${shim}`);
    }
    try {
      await agent.initialize();
      const handle = resumeId
        ? await agent.resumeSession({ sessionId: resumeId, cwd, mcpServers })
        : await agent.newSession({ cwd, mcpServers });
      return { agent, handle };
    } catch (err) {
      agent.kill();
      throw err;
    }
  }

  /** Generated once per hub process; `null` when disabled or unwritable. */
  private editorBridge(): Promise<EditorBridge | null> {
    const configured = this.options.editorBridge;
    if (configured === false) return Promise.resolve(null);
    this.bridgePromise ??= (async () => {
      const bridge = await ensureEditorBridge(configured ?? {});
      // One-time convenience for the human: the agent gets the directory through env,
      // a shell the user opens later does not.
      if (bridge) {
        void ensureUserPathEntry(bridge.binDir).then((added) => {
          if (added) {
            console.log(`[bridge] added ${bridge.binDir} to the user PATH (new shells only)`);
          }
        });
      }
      return bridge;
    })();
    return this.bridgePromise;
  }

  /** Turn a failed agent start into an actionable response. */
  private sendStartError(res: ServerResponse, err: unknown, resumeId: string | null): void {
    const why = (err as Error).message;
    const detail = (err as { data?: { details?: unknown } }).data?.details;
    const details = typeof detail === 'string' ? detail : '';

    // The agent's own words are worth far more than "-32603 Internal error".
    if (/already owned by an active write handle|already exists/i.test(`${why} ${details}`)) {
      this.sendJson(res, 409, {
        error: {
          message: `会话 ${resumeId ?? ''} 正被另一个进程占用（同一个会话只能有一个活动的写句柄）`,
          reason: 'session-busy',
          details,
          hint: '上一轮的 agent 进程还没退出，或这个会话正开在另一个编辑器 / DSH 窗口里。等几秒重试，或先关掉那个窗口。',
        },
      });
      return;
    }

    const resumed =
      resumeId && /method not found|-32601/i.test(why)
        ? '，该 agent 不支持恢复会话（session/resume）'
        : '';
    this.sendJson(res, 502, {
      error: { message: `failed to start agent: ${why}${resumed}`, details },
    });
  }

  private wireSessionEvents(session: ManagedSession): void {
    session.agent.on('update', (params: SessionUpdateParams) => {
      if (params?.sessionId && params.sessionId !== session.id) return;
      const update = params?.update as Record<string, unknown> | undefined;
      if (update?.sessionUpdate === 'agent_message_chunk') {
        const text = (update.content as { text?: string } | undefined)?.text ?? '';
        session.turnChars += text.length;
      }
      this.broadcast(session, 'update', { sessionId: session.id, update: params?.update });

      // After the update itself, so the client already has the tool call to attach to.
      if (update?.sessionUpdate === 'tool_call' || update?.sessionUpdate === 'tool_call_update') {
        for (const change of session.changes.observeToolCall(update as ToolCallLike)) {
          this.announceChange(session, change, true);
        }
      }
    });

    session.agent.on('file-write', (write: FileWriteEvent) => {
      const change = session.changes.recordWrite(write.path, write.oldText, write.newText, {
        lossy: write.lossy,
      });
      if (change) this.announceChange(session, change, true);
    });

    session.agent.on('stderr', (line: string) => {
      // stderr is noisy; surface it only for diagnostics.
      this.broadcast(session, 'agent_stderr', { sessionId: session.id, line });
    });

    session.agent.on('exit', ({ code, signal }: { code: number | null; signal: string | null }) => {
      // Fail any parked permissions so callers don't hang.
      for (const [, resolve] of session.pendingPermissions) {
        resolve({ outcome: { outcome: 'cancelled' } });
      }
      session.pendingPermissions.clear();
      this.broadcast(session, 'agent_exit', { sessionId: session.id, code, signal });
      this.sessions.delete(session.id);
      void this.dropEmptyTranscript(session.id);
    });

    session.agent.setPermissionHandler(async (params: RequestPermissionParams) => {
      return this.requestPermission(session, params);
    });
  }

  private async deleteSession(session: ManagedSession, res: ServerResponse): Promise<void> {
    await this.shutdownSession(session);
    this.sendJson(res, 200, { closed: session.id });
  }

  /**
   * Tear a session down completely: close it politely, kill the agent, wait for the
   * real exit (a resumed session must not race the old process's write handle),
   * drop its subscribers and its empty transcript.
   */
  private async shutdownSession(session: ManagedSession): Promise<void> {
    // Two cleanup paths can name the same session (a page handing its session back
    // on unload while boot reclaims the same client's leftovers). Claim it in the
    // map first so the teardown runs exactly once.
    if (!this.sessions.has(session.id)) return;
    this.sessions.delete(session.id);
    try {
      await session.agent.closeSession(session.id);
    } catch {
      /* best effort */
    }
    session.agent.kill();
    await session.agent.whenExited();
    for (const sub of session.subscribers) sub.close();
    await this.dropEmptyTranscript(session.id);
  }

  // -------------------------------------------------------------------------
  // streaming
  // -------------------------------------------------------------------------

  private openStream(session: ManagedSession, req: IncomingMessage, res: ServerResponse): void {
    const channel = new SseChannel(res);
    session.subscribers.add(channel);

    const lastEventIdHeader = req.headers['last-event-id'];
    const lastEventId = Number(
      (typeof lastEventIdHeader === 'string' ? lastEventIdHeader : undefined) ??
        new URL(req.url ?? '/', 'http://local').searchParams.get('lastEventId') ??
        0,
    );

    // Handshake frame: lets the client render without waiting for an event.
    channel.send({
      seq: 0,
      event: 'ready',
      at: Date.now(),
      data: {
        sessionId: session.id,
        agentId: session.agentId,
        configOptions: session.configOptions,
        models: pickModels(session.configOptions),
        lastSeq: session.log.lastSeq,
      },
    });

    if (Number.isFinite(lastEventId) && lastEventId > 0) {
      for (const message of session.log.since(lastEventId)) channel.send(message);
    }

    const keepAlive = setInterval(() => channel.comment('keep-alive'), 15_000);
    keepAlive.unref?.();

    const cleanup = () => {
      clearInterval(keepAlive);
      session.subscribers.delete(channel);
      channel.close();
    };
    req.on('close', cleanup);
    req.on('error', cleanup);
    res.on('error', cleanup);
  }

  private broadcast(session: ManagedSession, event: string, data: unknown): void {
    const message = session.log.append(event, data);
    for (const sub of session.subscribers) sub.send(message);
    this.persist(session, event, data);
  }

  /** Mirror stream events into the session transcript. */
  private persist(session: ManagedSession, event: string, data: unknown): void {
    const now = Date.now();
    let record: StoredEvent | null = null;

    if (event === 'turn_start') {
      record = { t: now, type: 'turn_start' };
    } else if (event === 'turn_end') {
      record = { t: now, type: 'turn_end', ...(data as Record<string, unknown>) };
    } else if (event === 'turn_error') {
      record = { t: now, type: 'error', ...(data as Record<string, unknown>) };
    } else if (event === 'update') {
      const u = ((data as { update?: Record<string, unknown> }).update ?? {}) as Record<string, unknown>;
      const kind = String(u.sessionUpdate ?? '');
      const content = u.content as { text?: string } | undefined;
      const text = content?.text ?? '';

      if (kind === 'agent_message_chunk' && text) {
        record = { t: now, type: 'assistant', text };
      } else if (kind === 'agent_thought_chunk' && text) {
        record = { t: now, type: 'thought', text };
      } else if (kind === 'tool_call' || kind === 'tool_call_update') {
        record = {
          t: now,
          type: 'tool',
          toolCallId: u.toolCallId,
          title: u.title,
          status: u.status,
          kind: u.kind,
          rawInput: u.rawInput,
          rawOutput: u.rawOutput,
          locations: u.locations,
          // Diffs are kept as file_change records; only the text output goes here.
          contentText: toolContentText(u.content),
        };
      }
    }

    if (record) void this.store.append(session.id, record);
  }

  // -------------------------------------------------------------------------
  // prompt
  // -------------------------------------------------------------------------

  private async startPrompt(
    session: ManagedSession,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (session.busy) {
      this.sendJson(res, 409, { error: { message: 'a turn is already running in this session' } });
      return;
    }

    const body = await readJsonBody(req);
    const prompt = toPromptBlocks(body);
    if (prompt.length === 0) {
      this.sendJson(res, 400, { error: { message: 'prompt text is empty' } });
      return;
    }

    const turn: NonNullable<ManagedSession['lastTurn']> = { startedAt: Date.now() };
    session.lastTurn = turn;
    session.busy = true;

    const userText = prompt
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('\n');
    void this.store.append(session.id, { t: Date.now(), type: 'user', text: userText });

    this.broadcast(session, 'turn_start', { sessionId: session.id, at: turn.startedAt });

    // Respond before the turn finishes — the result arrives on the stream.
    this.sendJson(res, 202, { accepted: true, sessionId: session.id });

    void (async () => {
      try {
        session.turnChars = 0;
        const snapshot = session.snapshot;
        const tracked: Array<{ path: string; toolCallId: string | null }> = [];
        if (snapshot) {
          try {
            await snapshot.prime();
          } catch (err) {
            console.warn(`[snapshot] tracking off this turn: ${(err as Error).message}`);
            session.snapshot = null;
          }
          // A completed tool that names a file is checked immediately, so its change
          // lands under that tool call in the panel.
          session.agent.on('update', (params: SessionUpdateParams) => {
            if (params?.sessionId !== session.id) return;
            const update = params.update as Record<string, unknown> | undefined;
            if (String(update?.sessionUpdate ?? '') !== 'tool_call_update' || update?.status !== 'completed') return;
            const toolCallId = typeof update.toolCallId === 'string' ? update.toolCallId : null;
            for (const path of fileMentions(update)) tracked.push({ path, toolCallId });
          });
        }

        const result = await session.agent.prompt({ sessionId: session.id, prompt });
        turn.finishedAt = Date.now();
        turn.stopReason = result.stopReason;

        if (snapshot) {
          // Later tool calls name earlier files, so check the newest mention first;
          // a change already recorded (as a diff or a hub write) folds into it.
          for (const { path, toolCallId } of tracked.reverse()) {
            try {
              const edit = await snapshot.checkFile(path);
              if (!edit) continue;
              const change = session.changes.recordObserved(edit.path, edit.oldText, edit.newText, toolCallId);
              if (change) this.announceChange(session, change, true);
            } catch {
              /* the disk is compared again at the end of the turn */
            }
          }
          try {
            for (const edit of await snapshot.collect()) {
              const change = session.changes.recordObserved(edit.path, edit.oldText, edit.newText, null);
              if (change) this.announceChange(session, change, true);
            }
          } catch (err) {
            console.warn(`[snapshot] collect failed: ${(err as Error).message}`);
          }
        }

        // A turn that reports success but produced no text and burned no tokens
        // is almost always a silent agent failure (bad credentials, unreachable
        // provider). Surfacing it beats an empty pane the user can't explain.
        const tokens = (result.usage as { totalTokens?: number } | undefined)?.totalTokens ?? 0;
        if (session.turnChars === 0 && tokens === 0) {
          this.broadcast(session, 'turn_warning', {
            sessionId: session.id,
            code: 'empty_turn',
            message: 'agent 返回了 end_turn，但没有产生任何内容，也没有消耗 token。多半是凭据失效或模型不可达 —— 检查 agent 的登录状态。',
            stopReason: result.stopReason,
            durationMs: turn.finishedAt - turn.startedAt,
          });
        }

        this.broadcast(session, 'turn_end', {
          sessionId: session.id,
          stopReason: result.stopReason,
          usage: result.usage,
          durationMs: turn.finishedAt - turn.startedAt,
        });
      } catch (err) {
        turn.finishedAt = Date.now();
        turn.error = (err as Error).message;
        this.broadcast(session, 'turn_error', {
          sessionId: session.id,
          message: turn.error,
          durationMs: turn.finishedAt - turn.startedAt,
        });
      } finally {
        session.busy = false;
      }
    })();
  }

  private async setConfig(
    session: ManagedSession,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const body = await readJsonBody(req);
    const configId = typeof body.configId === 'string' ? body.configId : '';
    const value = body.value;
    if (!configId || (typeof value !== 'string' && typeof value !== 'boolean')) {
      this.sendJson(res, 400, { error: { message: 'configId and string|boolean value required' } });
      return;
    }

    try {
      const configOptions = await session.agent.setConfigOption({
        sessionId: session.id,
        configId,
        value,
      });
      session.configOptions = configOptions;
      this.broadcast(session, 'config_changed', {
        sessionId: session.id,
        configOptions,
        models: pickModels(configOptions),
      });
      this.sendJson(res, 200, { configOptions, models: pickModels(configOptions) });
    } catch (err) {
      this.sendJson(res, 502, { error: { message: (err as Error).message } });
    }
  }

  // -------------------------------------------------------------------------
  // permissions
  // -------------------------------------------------------------------------

  private requestPermission(
    session: ManagedSession,
    params: RequestPermissionParams,
  ): Promise<RequestPermissionResult> {
    const options = (params.options ?? []) as PermissionOption[];

    // A diff in the request is a proposal; record it so the eventual write folds into it.
    for (const change of session.changes.observeToolCall((params.toolCall ?? {}) as ToolCallLike)) {
      this.announceChange(session, change, true);
    }

    if (session.permissionMode === 'allow') {
      const allow = options.find((o) => o.kind === 'allow_once' || o.kind === 'allow_always');
      if (allow) return Promise.resolve({ outcome: { outcome: 'selected', optionId: allow.optionId } });
    }
    if (session.permissionMode === 'deny') {
      const deny = options.find((o) => o.kind === 'reject_once' || o.kind === 'reject_always');
      if (deny) return Promise.resolve({ outcome: { outcome: 'selected', optionId: deny.optionId } });
      return Promise.resolve({ outcome: { outcome: 'cancelled' } });
    }

    // ask: park the request and surface it on the stream.
    const requestId = randomUUID();
    return new Promise<RequestPermissionResult>((resolve) => {
      const timer = setTimeout(() => {
        if (session.pendingPermissions.delete(requestId)) {
          this.broadcast(session, 'permission_timeout', { sessionId: session.id, requestId });
          resolve({ outcome: { outcome: 'cancelled' } });
        }
      }, this.options.permissionTimeoutMs);
      timer.unref?.();

      session.pendingPermissions.set(requestId, (result) => {
        clearTimeout(timer);
        resolve(result);
      });

      this.broadcast(session, 'permission_request', {
        sessionId: session.id,
        requestId,
        toolCall: params.toolCall,
        options,
        expiresInMs: this.options.permissionTimeoutMs,
      });
    });
  }

  private async resolvePermission(
    session: ManagedSession,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const body = await readJsonBody(req);
    const requestId = typeof body.requestId === 'string' ? body.requestId : '';
    const resolve = session.pendingPermissions.get(requestId);
    if (!resolve) {
      this.sendJson(res, 404, { error: { message: 'unknown or expired permission request' } });
      return;
    }
    session.pendingPermissions.delete(requestId);

    if (body.cancelled === true || typeof body.optionId !== 'string') {
      resolve({ outcome: { outcome: 'cancelled' } });
      this.sendJson(res, 200, { resolved: true, outcome: 'cancelled' });
      return;
    }

    const optionId = body.optionId;
    resolve({ outcome: { outcome: 'selected', optionId } });
    this.sendJson(res, 200, { resolved: true, optionId });
  }

  /**
   * Delete the transcript when nobody ever messaged in that session: panel
   * boots and pickers create throwaway sessions, which are noise, not history.
   */
  private async dropEmptyTranscript(sessionId: string): Promise<void> {
    try {
      const events = await this.store.read(sessionId);
      if (!events.some((event) => event.type === 'user')) {
        await this.store.delete(sessionId);
      }
    } catch {
      /* closing must never fail on bookkeeping */
    }
  }

  // -------------------------------------------------------------------------
  // file changes
  // -------------------------------------------------------------------------

  private async decideChange(
    session: ManagedSession,
    changeId: string,
    action: string,
    res: ServerResponse,
  ): Promise<void> {
    try {
      if (action === 'keep') {
        const change = session.changes.keep(changeId);
        this.announceChange(session, change, false);
        this.sendJson(res, 200, { change });
        return;
      }
      const { change, result } = await session.changes.revert(changeId);
      this.announceChange(session, change, false);
      this.sendJson(res, 200, { change, result });
    } catch (err) {
      if (err instanceof ChangeError) {
        const status = { not_found: 404, conflict: 409, not_revertable: 403, not_utf8: 422 }[err.code];
        this.sendJson(res, status, { error: { message: err.message, code: err.code } });
        return;
      }
      this.sendJson(res, 500, { error: { message: (err as Error).message } });
    }
  }

  /**
   * Publish a change on the stream and the transcript. The transcript keeps
   * the texts only when they changed; a later decision is recorded without them.
   */
  private announceChange(session: ManagedSession, change: FileChange, withTexts: boolean): void {
    this.broadcast(session, 'file_change', { sessionId: session.id, change });

    const record: StoredEvent = {
      t: Date.now(),
      type: 'file_change',
      changeId: change.changeId,
      toolCallId: change.toolCallId,
      path: change.path,
      displayPath: change.displayPath,
      origin: change.origin,
      exact: change.exact,
      applied: change.applied,
      revertable: change.revertable,
      revertBlock: change.revertBlock,
      decision: change.decision,
    };
    if (withTexts) {
      const size = (change.oldText?.length ?? 0) + change.newText.length;
      if (size <= MAX_PERSISTED_DIFF_CHARS) {
        record.oldText = change.oldText;
        record.newText = change.newText;
      } else {
        record.textsOmitted = true;
      }
    }
    void this.store.append(session.id, record);
  }

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  private sessionSummary(session: ManagedSession) {
    return {
      sessionId: session.id,
      agentId: session.agentId,
      clientId: session.clientId,
      cwd: session.cwd,
      busy: session.busy,
      permissionMode: session.permissionMode,
      createdAt: session.createdAt,
      lastTurn: session.lastTurn,
      lastSeq: session.log.lastSeq,
      configOptions: session.configOptions,
      models: pickModels(session.configOptions),
      agentInfo: session.agent.info?.agentInfo,
      changes: { total: session.changes.list().length, undecided: session.changes.undecided },
    };
  }

  private sendCors(res: ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,Last-Event-ID');
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    this.sendCors(res);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
    });
    res.end(payload);
  }
}

// ---------------------------------------------------------------------------
// module-level helpers
// ---------------------------------------------------------------------------

/** Absolute file paths a completed tool call mentions in its diff blocks, locations or raw input. */
function fileMentions(update: Record<string, unknown> | undefined): string[] {
  const paths: string[] = [];
  const add = (value: unknown): void => {
    // Windows absolute paths start with a drive letter and a backslash separator.
    if (typeof value !== 'string' || value.length <= 2) return;
    if (/^[A-Za-z]:[/\x5c]/.test(value) || value.startsWith('/')) paths.push(value);
  };
  return [...new Set(paths)];
}

/** Diff texts larger than this stay out of the transcript (live review still works). */
const MAX_PERSISTED_DIFF_CHARS = 512 * 1024;
const MAX_TOOL_TEXT_CHARS = 8 * 1024;

/** Text produced by a tool as `content` blocks, or undefined when there is none. */
function toolContentText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const item of content) {
    const block = (item as { type?: string; content?: { type?: string; text?: unknown } }) ?? {};
    if (block.type === 'content' && block.content?.type === 'text' && typeof block.content.text === 'string') {
      parts.push(block.content.text);
    }
  }
  if (parts.length === 0) return undefined;
  const text = parts.join('\n');
  return text.length > MAX_TOOL_TEXT_CHARS ? text.slice(0, MAX_TOOL_TEXT_CHARS) + '\n…' : text;
}

function toPublicAgent(status: AgentStatus) {
  return {
    id: status.id,
    name: status.name,
    description: status.description,
    available: status.available,
    resolvedPath: status.resolvedPath,
    version: status.version,
    requiresInstall: status.requiresInstall ?? false,
    homepage: status.homepage,
    reason: status.reason,
    // Resolution must be explainable to the user: which builds were found, which one
    // won, and which features that build cannot provide.
    candidates: status.candidates ?? [],
    capabilities: status.capabilities ?? {},
    warnings: status.warnings ?? [],
  };
}

/** Shape the panel can display without knowing ACP's transport quirks. */
function publicMcpServers(servers: McpServer[]) {
  return servers.map((server) => ({
    name: server.name,
    type: server.type ?? 'stdio',
    ...('url' in server && server.url ? { url: server.url } : {}),
  }));
}

function pickModels(configOptions: ConfigOption[]) {  const pick = (category: string) => {
    const option = configOptions.find((o) => o.category === category);
    return option ? { current: option.currentValue, options: option.options ?? [] } : null;
  };
  return { model: pick('model'), mode: pick('mode') };
}

function isPermissionMode(value: unknown): value is PermissionMode {
  return value === 'ask' || value === 'deny' || value === 'allow';
}

/** A client instance id: opaque, short, and never echoed into a path. */
function readClientId(body: Record<string, unknown>): string | undefined {
  const raw = body.clientId;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed && trimmed.length <= 128 ? trimmed : undefined;
}

function agentEnv(status: AgentStatus): { env?: Record<string, string> } | null {
  // Placeholder for future per-agent env overrides (registry can grow an `env` field).
  return status ? null : null;
}

function hookAgentLogging(agent: AcpAgent, agentId: string): void {
  agent.on('warning', (message: string) => console.warn(`[agent:${agentId}] ${message}`));
  agent.on('error', (err: Error) => console.error(`[agent:${agentId}] ${err.message}`));
  agent.on('exit', ({ code, signal }: { code: number | null; signal: string | null }) => {
    console.log(`[agent:${agentId}] exited code=${code} signal=${signal}`);
  });
}

function toPromptBlocks(body: Record<string, unknown>): ContentBlock[] {
  if (Array.isArray(body.content)) return body.content as ContentBlock[];
  const text = typeof body.text === 'string' ? body.text : typeof body.prompt === 'string' ? body.prompt : '';
  return text.trim() ? [{ type: 'text', text }] : [];
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  const limit = 16 * 1024 * 1024; // 16 MiB, generous for pasted images

  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(buf);
  }
  if (size === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch (err) {
    throw new Error(`invalid JSON body: ${(err as Error).message}`);
  }
}
