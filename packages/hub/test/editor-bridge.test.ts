/**
 * The generated bridge files: portable (no absolute install paths baked in),
 * self-tested, and honest about their limits.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

import {
  dshPatchText,
  ensureAgentShim,
  ensureEditorBridge,
  resetEditorBridgeCache,
  shimText,
} from '../src/editor-bridge.js';

const repo = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const CLI = resolve(repo, 'scripts/ue-mcp.mjs');

test('editor bridge: the shim locates its script relatively and is self-tested', async () => {
  resetEditorBridgeCache();
  const root = await mkdtemp(join(tmpdir(), 'acp-bridge-'));

  const bridge = await ensureEditorBridge({ root, scriptPath: CLI });
  assert.ok(bridge, 'bridge materialises');

  const shim = await readFile(bridge.shimPath, 'utf8');
  assert.match(shim, /%~dp0ue-mcp\.mjs/, 'the script is located relative to the shim');
  assert.doesNotMatch(shim, /acp-editor[\\/]scripts/, 'no install path is baked in');
  assert.match(shim, /where node/, 'node comes from PATH first');
  assert.equal(bridge.shimWorks, true, 'the shim passed its own --help');

  // The script travels with the shim, so moving the repo cannot break it.
  const localScript = await readFile(join(bridge.binDir, 'ue-mcp.mjs'), 'utf8');
  const original = await readFile(CLI, 'utf8');
  assert.equal(localScript, original, 'the CLI is copied next to the shim');

  const patch = await readFile(bridge.patchPath, 'utf8');
  assert.match(patch, /- id: system-prompt/, 'the overlay targets the system prompt');
  assert.match(patch, /id: unreal-mcp/, 'the editor MCP is registered at profile level');
  assert.match(patch, /failOnStartupError: false/, 'a closed editor must not break the session');
  assert.doesNotMatch(patch, /\{\{\s*\w+\s*\}\}/, 'no template variables: 0.2.2 rejects them');
  assert.match(patch, /ue-mcp context/, 'the agent is told about the command');

  const pathKey = Object.keys(bridge.env).find((key) => key.toUpperCase() === 'PATH');
  assert.ok(pathKey, 'the environment carries a PATH entry');
  assert.equal(bridge.env[pathKey!]!.split(';')[0], bridge.binDir, 'bin dir leads PATH');

  // Idempotent: a second ensure must not rewrite the files.
  const before = (await stat(bridge.patchPath)).mtimeMs;
  await new Promise((r) => setTimeout(r, 30));
  await ensureEditorBridge({ root, scriptPath: CLI });
  assert.equal((await stat(bridge.patchPath)).mtimeMs, before);
});

test('editor bridge: the hint is omitted when the command cannot run', () => {
  const withHint = dshPatchText('http://127.0.0.1:8000/mcp');
  assert.match(withHint, /ue-mcp context/);
  const withoutHint = dshPatchText('http://127.0.0.1:8000/mcp', { includeHint: false });
  assert.doesNotMatch(withoutHint, /ue-mcp context/, 'a broken bridge is not advertised');
  assert.match(withoutHint, /id: unreal-mcp/, 'MCP registration survives regardless');
});

test('editor bridge: the shim prefers PATH and fails loudly without any runtime', () => {
  const withFallback = shimText('ue-mcp.mjs', 'C:\\Program Files\\nodejs\\node.exe');
  assert.match(withFallback, /%~dp0ue-mcp\.mjs/, 'the script is located relative to the shim');
  assert.match(withFallback, /where node >nul 2>nul/, 'PATH is tried first');
  assert.match(withFallback, /^:fallback$/m);
  assert.match(
    withFallback,
    /^if errorlevel 1 goto fallback$/m,
    'the fallback only runs when PATH has no node',
  );
  assert.match(withFallback, /set "NODE_EXE=C:\\Program Files\\nodejs\\node\.exe"/);
  assert.doesNotMatch(withFallback, /NODE_EXE="C:/, 'no nested quoting inside the assignment');

  const without = shimText('ue-mcp.mjs', '');
  assert.match(without, /exit \/b 127/, 'a missing runtime is an explicit failure');
  assert.match(without, /Node\.js was not found/);
  assert.doesNotMatch(without, /NODE_EXE=/, 'no stale path is used when none is meaningful');
});

test('editor bridge: a generated shim actually runs the CLI', async () => {
  resetEditorBridgeCache();
  const root = await mkdtemp(join(tmpdir(), 'acp-shim-run-'));
  const binDir = join(root, 'bin');
  const { mkdir, cp } = await import('node:fs/promises');
  await mkdir(binDir, { recursive: true });
  await cp(CLI, join(binDir, 'ue-mcp.mjs'));
  await writeFile(join(binDir, 'ue-mcp.cmd'), shimText('ue-mcp.mjs'), 'utf8');

  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const { stdout } = await run(join(binDir, 'ue-mcp.cmd'), ['--help'], { shell: true, timeout: 20_000 });
  assert.match(stdout, /ue-mcp — query the running Unreal editor over MCP/);
});

test('agent shim: a pinned entry gets a working shim, a broken one gets none', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acp-shim-'));
  const binDir = join(root, 'bin');

  const entry = join(root, 'fake-cli.js');
  await writeFile(entry, 'console.log("9.9.9");\n', 'utf8');
  const shim = await ensureAgentShim('fake', entry, binDir);
  assert.ok(shim, 'a runnable entry produces a shim');
  assert.match(await readFile(shim!, 'utf8'), new RegExp(entry.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')));

  const broken = await ensureAgentShim('broken', join(root, 'missing.js'), binDir);
  assert.equal(broken, null, 'a shim that cannot run is reported as absent');
});

test('agent shim: the entry is checked on every run and the shim follows a moved entry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acp-shim-move-'));
  const binDir = join(root, 'bin');
  const first = join(root, 'v1.js');
  const second = join(root, 'v2.js');
  await writeFile(first, 'console.log("1.0.0");\n', 'utf8');
  await writeFile(second, 'console.log("2.0.0");\n', 'utf8');

  const shim = await ensureAgentShim('agent', first, binDir);
  assert.ok(shim);
  const text = await readFile(shim!, 'utf8');
  assert.match(
    text,
    /if not exist "/,
    'a runtime that disappeared reports the truth instead of a node stack trace',
  );
  assert.match(text, /Missing:/);

  // Re-resolving to a new build rewrites the same shim (path changes are followed).
  await ensureAgentShim('agent', second, binDir);
  assert.match(await readFile(shim!, 'utf8'), new RegExp(second.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')));
});

/** A gateway-shaped fake: `call_tool` resolves to `{"returnValue": ...}`. */
async function fakeGateway(): Promise<{ url: string; close: () => Promise<void> }> {
  const { createServer } = await import('node:http');
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const message = JSON.parse(body || '{}');
      const reply = (result: unknown) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id ?? 1, result }));
      };
      if (message.method === 'initialize') {
        return reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake' } });
      }
      if (message.method === 'tools/list') return reply({ tools: [] });
      if (message.method === 'tools/call') {
        const tool = message.params?.arguments?.tool_name;
        const values: Record<string, unknown> = {
          GetOpenAssets: ['/Game/BP_Door'],
          GetSelectedActors: [{ name: 'Door_1' }],
          GetSelectedAssets: [],
          GetContentBrowserPath: '/Game/Blueprints',
          IsPIERunning: false,
          GetCameraTransform: { location: { x: 1, y: 2, z: 3 } },
        };
        return reply({ content: [{ type: 'text', text: JSON.stringify({ returnValue: values[tool] ?? null }) }] });
      }
      res.writeHead(202).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

test('ue-mcp context: reports the editor state as JSON the model can read', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const gateway = await fakeGateway();
  try {
    const { stdout } = await run(process.execPath, [CLI, 'context', '--url', gateway.url], { timeout: 20_000 });
    const state = JSON.parse(stdout) as {
      contentBrowserPath: string;
      openAssets: string[];
      selectedActors: Array<{ name: string }>;
      pie: boolean;
    };
    assert.equal(state.contentBrowserPath, '/Game/Blueprints');
    assert.deepEqual(state.openAssets, ['/Game/BP_Door']);
    assert.equal(state.selectedActors[0]!.name, 'Door_1');
    assert.equal(state.pie, false);
  } finally {
    await gateway.close();
  }
});

test('ue-mcp: an unreachable editor fails loudly instead of inventing state', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  await assert.rejects(
    () => run(process.execPath, [CLI, 'context', '--url', 'http://127.0.0.1:1/mcp', '--timeout', '800'], { timeout: 20_000 }),
    (err: { stderr?: string; code?: number }) => {
      assert.match(err.stderr ?? '', /不可达/);
      assert.equal(err.code, 2);
      return true;
    },
  );
});
