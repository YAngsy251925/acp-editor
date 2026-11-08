import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { JsonRpcConnection, RpcCallError } from '../src/jsonrpc.js';
import { AgentRegistry, which } from '../src/registry.js';
import { HubServer } from '../src/server.js';
import { EventLog } from '../src/sse.js';

/** Wire two JsonRpcConnections back-to-back to act as client and agent. */
function makePair(agentHandler: (method: string, params: unknown) => unknown = () => null) {
  const clientToAgent = new PassThrough();
  const agentToClient = new PassThrough();

  const client = new JsonRpcConnection(clientToAgent, agentToClient, () => null, {
    requestTimeoutMs: 2_000,
  });
  const agent = new JsonRpcConnection(agentToClient, clientToAgent, agentHandler, {
    requestTimeoutMs: 2_000,
  });
  return { client, agent };
}

test('jsonrpc: request/response round trip', async () => {
  const { client } = makePair((method, params) => {
    if (method === 'echo') return params;
    throw new Error(`unexpected ${method}`);
  });

  const result = await client.request('echo', { hello: 'world' });
  assert.deepEqual(result, { hello: 'world' });
  client.close();
});

test('jsonrpc: agent error surfaces as RpcCallError', async () => {
  const { client } = makePair(() => {
    throw new Error('nope');
  });

  await assert.rejects(
    () => client.request('explode'),
    (err: unknown) => err instanceof RpcCallError && /nope/.test((err as Error).message),
  );
  client.close();
});

test('jsonrpc: notifications are dispatched by method name', async () => {
  const { client, agent } = makePair();
  const seen: unknown[] = [];

  client.on('session/update', (params) => seen.push(params));
  agent.notify('session/update', { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk' } });

  await new Promise((r) => setTimeout(r, 50));
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], {
    sessionId: 's1',
    update: { sessionUpdate: 'agent_message_chunk' },
  });
  client.close();
});

test('jsonrpc: request times out instead of hanging', async () => {
  // A silent peer: the handler never resolves, so no response is ever written.
  const clientToAgent = new PassThrough();
  const agentToClient = new PassThrough();
  const client = new JsonRpcConnection(clientToAgent, agentToClient, () => null, {
    requestTimeoutMs: 120,
  });
  new JsonRpcConnection(agentToClient, clientToAgent, () => new Promise(() => {}), {
    requestTimeoutMs: 120,
  });

  await assert.rejects(() => client.request('slow'), /timeout/);
  client.close();
});

test('which: resolves node, rejects nonsense', async () => {
  assert.ok(await which('node'), 'node should resolve on PATH');
  assert.equal(await which('definitely-not-a-real-binary-xyz'), null);
});

test('registry: builtin list includes the ACP natives', async () => {
  const registry = new AgentRegistry({ userConfigPath: '/nonexistent/agents.json' });
  const defs = await registry.listDefinitions();
  const ids = defs.map((d) => d.id);
  for (const expected of ['opencode', 'gemini', 'cursor', 'claude', 'codex']) {
    assert.ok(ids.includes(expected), `missing builtin agent: ${expected}`);
  }
});

test('event log: replay window is bounded and ordered', () => {
  const log = new EventLog(3);
  for (let i = 0; i < 5; i++) log.append('x', { i });

  assert.equal(log.lastSeq, 5);
  assert.equal(log.all().length, 3);
  assert.deepEqual(log.since(4).map((m) => m.data), [{ i: 4 }]);
  assert.deepEqual(log.since(0).map((m) => m.seq), [3, 4, 5]);
});

test('hub: /health and /agents respond', async () => {
  const server = new HubServer({ port: 0, host: '127.0.0.1' });
  const url = await server.listen();
  try {
    const health = await fetch(`${url}/health`).then((r) => r.json());
    assert.equal((health as { ok: boolean }).ok, true);

    const agents = (await fetch(`${url}/agents`).then((r) => r.json())) as {
      agents: Array<{ id: string; available: boolean }>;
    };
    assert.ok(Array.isArray(agents.agents));
    assert.ok(agents.agents.some((a) => a.id === 'opencode'));
  } finally {
    await server.close();
  }
});

test('hub: unknown session is a 404', async () => {
  const server = new HubServer({ port: 0, host: '127.0.0.1' });
  const url = await server.listen();
  try {
    const res = await fetch(`${url}/sessions/nope/stream`);
    assert.equal(res.status, 404);
  } finally {
    await server.close();
  }
});

/**
 * Resuming a session this hub still owns must attach, not spawn a second agent
 * process: the agent's store grants one write handle per session, so a rival
 * `session/resume` fails with "already owned by an active write handle" (which
 * dsh reports as -32603 Internal error). This was the "继续这个会话" failure.
 */
test('hub: resuming a live session attaches instead of starting a rival process', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'acp-hub-reuse-'));
  const fixture = resolve(fileURLToPath(new URL('.', import.meta.url)), 'fixtures/mock-agent.mjs');
  const agents = join(dir, 'agents.json');
  await writeFile(
    agents,
    JSON.stringify({
      agents: [
        { id: 'mock', name: 'Mock', command: [process.execPath, fixture] },
        { id: 'other', name: 'Other', command: [process.execPath, fixture] },
      ],
    }),
    'utf8',
  );
  const server = new HubServer({
    port: 0,
    host: '127.0.0.1',
    registry: new AgentRegistry({ userConfigPath: agents }),
    dataDir: join(dir, 'sessions'),
  });
  const url = await server.listen();

  const post = (body: unknown) =>
    fetch(`${url}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  try {
    const created = (await (await post({ agentId: 'mock', cwd: dir })).json()) as {
      sessionId: string;
    };

    const resumed = await post({ agentId: 'mock', cwd: dir, resume: created.sessionId });
    assert.equal(resumed.status, 200, await resumed.clone().text());
    const body = (await resumed.json()) as { sessionId: string; reused?: boolean };
    assert.equal(body.reused, true, 'the live session is reused, not restarted');
    assert.equal(body.sessionId, created.sessionId);

    // A different agent must not take over a session another agent holds.
    const stolen = await post({ agentId: 'other', cwd: dir, resume: created.sessionId });
    assert.equal(stolen.status, 409, 'ownership by another agent is refused');
  } finally {
    await server.close();
  }
});

/**
 * Orphan cleanup is scoped by client id: a panel that reloaded may reclaim what
 * its previous page load left behind, and must not touch another tab's session
 * (or a session created before clients were tagged at all).
 */
test('hub: close-orphans is scoped to one client id', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'acp-hub-orphans-'));
  const fixture = resolve(fileURLToPath(new URL('.', import.meta.url)), 'fixtures/mock-agent.mjs');
  const agents = join(dir, 'agents.json');
  await writeFile(
    agents,
    JSON.stringify({ agents: [{ id: 'mock', name: 'Mock', command: [process.execPath, fixture] }] }),
    'utf8',
  );
  const server = new HubServer({
    port: 0,
    host: '127.0.0.1',
    registry: new AgentRegistry({ userConfigPath: agents }),
    dataDir: join(dir, 'sessions'),
  });
  const url = await server.listen();

  const post = (path: string, body: unknown) =>
    fetch(`${url}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const ids = async () =>
    ((await (await fetch(`${url}/sessions`)).json()) as {
      sessions: Array<{ sessionId: string; clientId?: string }>;
    }).sessions;

  try {
    const tabA1 = ((await (await post('/sessions', { agentId: 'mock', cwd: dir, clientId: 'tab-a' })).json()) as { sessionId: string }).sessionId;
    const tabA2 = ((await (await post('/sessions', { agentId: 'mock', cwd: dir, clientId: 'tab-a' })).json()) as { sessionId: string }).sessionId;
    const tabB = ((await (await post('/sessions', { agentId: 'mock', cwd: dir, clientId: 'tab-b' })).json()) as { sessionId: string }).sessionId;
    const untagged = ((await (await post('/sessions', { agentId: 'mock', cwd: dir })).json()) as { sessionId: string }).sessionId;

    const before = await ids();
    assert.equal(before.length, 4);
    assert.equal(before.find((s) => s.sessionId === tabB)!.clientId, 'tab-b');
    assert.equal(before.find((s) => s.sessionId === untagged)!.clientId, undefined);

    const closed = (await (await post('/sessions/close-orphans', { clientId: 'tab-a' })).json()) as {
      closed: string[];
    };
    assert.deepEqual(closed.closed.sort(), [tabA1, tabA2].sort(), 'only this tab’s leftovers close');

    const after = await ids();
    assert.deepEqual(
      after.map((s) => s.sessionId).sort(),
      [tabB, untagged].sort(),
      'another tab’s session and an untagged session survive',
    );

    // `keep` protects the session the caller is about to use.
    const third = ((await (await post('/sessions', { agentId: 'mock', cwd: dir, clientId: 'tab-a' })).json()) as { sessionId: string }).sessionId;
    await post('/sessions/close-orphans', { clientId: 'tab-a', keep: third });
    assert.ok(
      (await ids()).some((s) => s.sessionId === third),
      'a session named in keep stays open',
    );

    const missing = await post('/sessions/close-orphans', {});
    assert.equal(missing.status, 400, 'clientId is required');
  } finally {
    await server.close();
  }
});

/**
 * End-to-end against a real agent. Only runs when ACP_E2E_AGENT is set to an
 * agent id that is actually installed, e.g.
 *   ACP_E2E_AGENT=opencode pnpm test
 */
test('e2e: real agent session exposes models', { skip: !process.env.ACP_E2E_AGENT }, async () => {
  const agentId = process.env.ACP_E2E_AGENT!;
  const server = new HubServer({ port: 0, host: '127.0.0.1' });
  const url = await server.listen();
  try {
    const created = await fetch(`${url}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId, cwd: process.cwd() }),
    });
    const createdRaw = await created.text();
    assert.equal(created.status, 201, createdRaw);

    const session = JSON.parse(createdRaw) as {
      sessionId: string;
      models: { model: { current: unknown; options: unknown[] } | null };
    };
    assert.ok(session.sessionId);
    assert.ok(session.models.model, 'agent should advertise a model config option');
    assert.ok(session.models.model!.options.length > 0);

    // Switching to the current value must be a no-op that still succeeds.
    const switched = await fetch(`${url}/sessions/${session.sessionId}/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ configId: 'model', value: session.models.model!.current }),
    });
    const switchedRaw = await switched.text();
    assert.equal(switched.status, 200, switchedRaw);

    await fetch(`${url}/sessions/${session.sessionId}`, { method: 'DELETE' });
  } finally {
    await server.close();
  }
});

test('hub: sessions never messaged in leave no history', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'acp-hub-empty-'));
  await mkdir(join(dir, 'sessions'), { recursive: true });
  const fixture = resolve(fileURLToPath(new URL('.', import.meta.url)), 'fixtures/mock-agent.mjs');
  const agents = join(dir, 'agents.json');
  await writeFile(
    agents,
    JSON.stringify({ agents: [{ id: 'mock', name: 'Mock', command: [process.execPath, fixture] }] }),
    'utf8',
  );
  const server = new HubServer({
    port: 0,
    host: '127.0.0.1',
    registry: new AgentRegistry({ userConfigPath: agents }),
    dataDir: join(dir, 'sessions'),
  });
  const url = await server.listen();

  try {
    // Boot creates a throwaway session; closing it must not leave history...
    const created = await fetch(`${url}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'mock', cwd: dir }),
    });
    const session = (await created.json()) as { sessionId: string };

    const { sessions: beforeClose } = (await fetch(`${url}/history`).then((r) => r.json())) as {
      sessions: unknown[];
    };
    assert.deepEqual(beforeClose, [], 'an open session with no turns is not history yet');

    await fetch(`${url}/sessions/${session.sessionId}`, { method: 'DELETE' });
    const { sessions: afterClose } = (await fetch(`${url}/history`).then((r) => r.json())) as {
      sessions: unknown[];
    };
    assert.deepEqual(afterClose, [], 'closing a never-messaged session drops its transcript');

    // ...but a session that was actually used is kept.
    const used = await fetch(`${url}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'mock', cwd: dir }),
    });
    const usedSession = (await used.json()) as { sessionId: string };
    await fetch(`${url}/sessions/${usedSession.sessionId}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });
    // The turn streams asynchronously; wait for it to settle before closing.
    await new Promise((r) => setTimeout(r, 1_500));
    await fetch(`${url}/sessions/${usedSession.sessionId}`, { method: 'DELETE' });

    const { sessions } = (await fetch(`${url}/history`).then((r) => r.json())) as {
      sessions: Array<{ sessionId: string; turns: number }>;
    };
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]!.sessionId, usedSession.sessionId);
    assert.equal(sessions[0]!.turns, 1);
  } finally {
    await server.close();
  }
});
