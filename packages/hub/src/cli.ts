#!/usr/bin/env node
/**
 * acp-hub — run the hub standalone.
 *
 *   acp-hub --port 7878 --cwd D:\MyProject
 */
import { HubServer, type PermissionMode } from './server.js';
import { AgentRegistry } from './registry.js';

interface CliOptions {
  port: number;
  host: string;
  cwd: string;
  permission: PermissionMode;
  token?: string;
  /** Path to an agents.json overlay (builtin list stays available). */
  agents?: string;
  /** Directory for session transcripts (default ~/.acp-editor/sessions). */
  dataDir?: string;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    port: 7878,
    host: '127.0.0.1',
    cwd: process.cwd(),
    permission: 'ask',
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case '--port':
      case '-p': {
        const value = Number(next());
        if (Number.isFinite(value)) options.port = value;
        break;
      }
      case '--host':
        options.host = next() ?? options.host;
        break;
      case '--cwd':
        options.cwd = next() ?? options.cwd;
        break;
      case '--token':
        options.token = next();
        break;
      case '--agents':
        options.agents = next();
        break;
      case '--data-dir':
        options.dataDir = next();
        break;
      case '--permission': {
        const value = next();
        if (value === 'ask' || value === 'deny' || value === 'allow') options.permission = value;
        break;
      }
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
      default:
        if (arg?.startsWith('-')) {
          console.error(`unknown option: ${arg}`);
          printHelp();
          process.exit(2);
        }
    }
  }
  return options;
}

function printHelp(): void {
  console.log(`acp-hub — ACP client + HTTP/SSE bridge

Usage
  acp-hub [options]

Options
  -p, --port <n>          listen port (default 7878, 0 = random)
      --host <addr>       bind address (default 127.0.0.1)
      --cwd <path>        default working directory for sessions
      --permission <mode> ask | deny | allow   (default ask)
      --token <secret>    require Authorization: Bearer <secret>
      --agents <path>     agents.json overlay (adds to the builtin list)
      --data-dir <path>   session transcripts (default ~/.acp-editor/sessions)
  -h, --help              this help

Endpoints
  GET  /health
  GET  /agents
  POST /sessions                 { agentId, cwd?, mcpServers?, permissionMode? }
  GET  /sessions/:id/stream      SSE (supports Last-Event-ID replay)
  POST /sessions/:id/prompt      { text } or { content: [...] }  -> 202
  POST /sessions/:id/config      { configId: "model", value: "..." }
  POST /sessions/:id/permission  { requestId, optionId } | { requestId, cancelled: true }
  POST /sessions/:id/cancel
  GET  /sessions/:id/changes     file edits made in this session
  POST /sessions/:id/changes/:changeId/keep | /revert
  DELETE /sessions/:id
`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const server = new HubServer({
    host: options.host,
    port: options.port,
    defaultCwd: options.cwd,
    permissionMode: options.permission,
    ...(options.token ? { token: options.token } : {}),
    ...(options.dataDir ? { dataDir: options.dataDir } : {}),
    ...(options.agents
      ? { registry: new AgentRegistry({ userConfigPath: options.agents }) }
      : {}),
  });

  const url = await server.listen();
  console.log(`acp-hub listening on ${url}`);
  console.log(`  cwd:        ${options.cwd}`);
  console.log(`  permission: ${options.permission}`);

  const shutdown = async (signal: string) => {
    console.log(`\n[${signal}] shutting down…`);
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('acp-hub failed to start:', err);
  process.exit(1);
});
