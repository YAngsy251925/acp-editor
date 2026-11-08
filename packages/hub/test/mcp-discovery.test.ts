/**
 * Project MCP discovery: what a session hands to its agent, and what it refuses to.
 *
 * The probe is the load-bearing part — agents mount MCP with `failOnStartupError`, so
 * an unprobed dead endpoint would fail `session/new` instead of y
 * degrading to "no tools".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

import { AgentRegistry } from '../src/registry.js';
import { HubServer } from '../src/server.js';
import { discoverProjectMcpServers, probeMcpHttp, resetMcpProbeCache } from '../src/mcp-discovery.js';

/** A minimal live MCP endpoint: answers `initialize` like the real thing. */
async function fakeMcp(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake' } },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('mcp: a dead endpoint is never handed to the agent', async () => {
  resetMcpProbeCache();
  assert.equal(await probeMcpHttp('http://127.0.0.1:1/mcp', 300), false);
});

test('mcp: discovery attaches live http + stdio, skips dead http and sse', async () => {
  resetMcpProbeCache();
  const live = await fakeMcp();
  const dir = await mkdtemp(join(tmpdir(), 'acp-mcp-'));
  await writeFile(
    join(dir, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        'live-one': { type: 'http', url: live.url },
        'dead-one': { type: 'http', url: 'http://127.0.0.1:1/mcp' },
        'local-tool': { command: 'node', args: ['tool.mjs'], env: { TOKEN: 'x' } },
        'legacy-sse': { type: 'sse', url: 'http://127.0.0.1:2/sse' },
      },
    }),
  );

  try {
    const found = await discoverProjectMcpServers(dir, { unrealDefaultUrl: null, probeTimeoutMs: 300 });
    const byName = Object.fromEntries(found.servers.map((s) => [s.name, s]));

    assert.ok(byName['live-one'], 'the live endpoint is attached');
    assert.equal((byName['live-one'] as { url: string }).url, live.url);
    assert.ok(byName['local-tool'], 'a stdio server needs no probe');
    assert.equal(
      'type' in byName['local-tool']!,
      false,
      'stdio entries must not carry a type: agents reject type:"stdio"',
    );
    assert.equal(byName['dead-one'], undefined, 'a dead endpoint is left out');
    assert.equal(byName['legacy-sse'], undefined, 'sse is not a supported transport here');

    const reasons = Object.fromEntries(found.skipped.map((s) => [s.name, s.reason]));
    assert.match(reasons['dead-one']!, /did not answer/);
    assert.match(reasons['legacy-sse']!, /sse/);
  } finally {
    await live.close();
  }
});

test('mcp: a config file in a parent directory is found', async () => {
  resetMcpProbeCache();
  const live = await fakeMcp();
  const root = await mkdtemp(join(tmpdir(), 'acp-mcp-parent-'));
  const nested = join(root, 'Project', 'Source');
  await mkdir(nested, { recursive: true });
  await writeFile(
    join(root, '.mcp.json'),
    JSON.stringify({ mcpServers: { 'root-live': { type: 'http', url: live.url } } }),
  );

  try {
    const found = await discoverProjectMcpServers(nested, { unrealDefaultUrl: null, probeTimeoutMs: 300 });
    assert.deepEqual(found.servers.map((s) => s.name), ['root-live']);
  } finally {
    await live.close();
  }
});

test('mcp: the editor default is attached for a UE project, and only when it answers', async () => {
  resetMcpProbeCache();
  const live = await fakeMcp();
  const ueDir = await mkdtemp(join(tmpdir(), 'acp-ue-'));
  await writeFile(join(ueDir, 'EX.uproject'), '{}');
  const plainDir = await mkdtemp(join(tmpdir(), 'acp-plain-'));

  try {
    const usingDefault = await discoverProjectMcpServers(ueDir, {
      unrealDefaultUrl: live.url,
      probeTimeoutMs: 300,
    });
    assert.deepEqual(usingDefault.servers.map((s) => s.name), ['unreal-mcp']);

    // Not a UE project: the editor endpoint is not even considered.
    const notUnreal = await discoverProjectMcpServers(plainDir, {
      unrealDefaultUrl: live.url,
      probeTimeoutMs: 300,
    });
    assert.deepEqual(notUnreal.servers, []);
  } finally {
    await live.close();
  }
});

test('mcp: an unreachable editor endpoint leaves the session with no MCP, not an error', async () => {
  resetMcpProbeCache();
  const ueDir = await mkdtemp(join(tmpdir(), 'acp-ue-dead-'));
  await writeFile(join(ueDir, 'EX.uproject'), '{}');
  const found = await discoverProjectMcpServers(ueDir, {
    unrealDefaultUrl: 'http://127.0.0.1:1/mcp',
    probeTimeoutMs: 300,
  });
  assert.deepEqual(found.servers, []);
  assert.match(found.skipped[0]!.reason, /did not answer/);
});

/**
 * Auto-injection must never cost the user their session. Agents disagree about the
 * accepted MCP transports — dsh takes `http` and ignores it, opencode only accepts
 * `sse` — and ACP has no capability flag to ask, so a refusal is retried without MCP.
 */
test('mcp: an agent that refuses mcpServers still gets a working session', async () => {
  resetMcpProbeCache();
  const live = await fakeMcp();
  const dir = await mkdtemp(join(tmpdir(), 'acp-mcp-refuse-'));
  await writeFile(
    join(dir, '.mcp.json'),
    JSON.stringify({ mcpServers: { 'editor-tools': { type: 'http', url: live.url } } }),
  );

  const fixture = resolve(fileURLToPath(new URL('.', import.meta.url)), 'fixtures/mock-agent.mjs');
  const agents = join(dir, 'agents.json');
  await writeFile(
    agents,
    JSON.stringify({
      agents: [
        { id: 'picky', name: 'Picky', command: [process.execPath, fixture, '--reject-mcp'] },
      ],
    }),
  );
  const server = new HubServer({
    port: 0,
    host: '127.0.0.1',
    registry: new AgentRegistry({ userConfigPath: agents }),
    dataDir: join(dir, 'sessions'),
    mcpDiscovery: { unrealDefaultUrl: null, probeTimeoutMs: 300 },
  });
  const url = await server.listen();

  try {
    const res = await fetch(`${url}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'picky', cwd: dir }),
    });
    const body = (await res.json()) as {
      sessionId?: string;
      mcpServers?: unknown[];
      mcpWarning?: string;
      error?: { message: string };
    };

    assert.equal(res.status, 201, JSON.stringify(body));
    assert.ok(body.sessionId, 'the session exists despite the MCP refusal');
    assert.deepEqual(body.mcpServers, [], 'the retry carries no MCP servers');
    assert.match(body.mcpWarning ?? '', /MCP/, 'the degradation is reported, not hidden');
  } finally {
    await server.close();
    await live.close();
  }
});

/**
 * End of the chain: a session created by any client inherits the project's MCP
 * servers, so the agent has the editor's tools without the panel configuring a
 * thing. An explicit list still wins.
 */
test('mcp: session creation injects project servers unless the client is explicit', async () => {
  resetMcpProbeCache();
  const live = await fakeMcp();
  const dir = await mkdtemp(join(tmpdir(), 'acp-mcp-hub-'));
  await writeFile(
    join(dir, '.mcp.json'),
    JSON.stringify({ mcpServers: { 'editor-tools': { type: 'http', url: live.url } } }),
  );

  const fixture = resolve(fileURLToPath(new URL('.', import.meta.url)), 'fixtures/mock-agent.mjs');
  const agents = join(dir, 'agents.json');
  await writeFile(
    agents,
    JSON.stringify({ agents: [{ id: 'mock', name: 'Mock', command: [process.execPath, fixture] }] }),
  );
  const server = new HubServer({
    port: 0,
    host: '127.0.0.1',
    registry: new AgentRegistry({ userConfigPath: agents }),
    dataDir: join(dir, 'sessions'),
    mcpDiscovery: { unrealDefaultUrl: null, probeTimeoutMs: 300 },
  });
  const url = await server.listen();

  const create = async (body: object) =>
    (await (
      await fetch(`${url}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: 'mock', cwd: dir, ...body }),
      })
    ).json()) as { sessionId: string; mcpServers?: Array<{ name: string; type: string }> };

  try {
    const inherited = await create({});
    assert.deepEqual(inherited.mcpServers, [{ name: 'editor-tools', type: 'http', url: live.url }]);

    const explicit = await create({ mcpServers: [] });
    assert.deepEqual(explicit.mcpServers, [], 'an explicit list is not overridden by discovery');
  } finally {
    await server.close();
    await live.close();
  }
});
