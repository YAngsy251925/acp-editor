import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AgentRegistry } from '../src/registry.js';
import { HubServer } from '../src/server.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const mockAgent = resolve(here, 'fixtures/mock-agent.mjs');

interface SseEvent {
  event: string;
  data: any;
}

/** Minimal SSE reader: collects frames, resolves waiters. */
function openSse(url: string) {
  const events: SseEvent[] = [];
  const waiters: Array<{ match: (e: SseEvent) => boolean; resolve: (e: SseEvent) => void }> = [];
  const controller = new AbortController();

  const done = (async () => {
    const res = await fetch(url, { signal: controller.signal });
    assert.equal(res.status, 200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done: eof, value } = await reader.read();
        if (eof) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);

          let event = 'message';
          let data = '';
          for (const line of frame.split('\n')) {
            if (line.startsWith(':')) continue;
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data += line.slice(5).trim();
          }
          if (!data) continue;
          const parsed: SseEvent = { event, data: JSON.parse(data) };
          events.push(parsed);
          for (let i = waiters.length - 1; i >= 0; i--) {
            const waiter = waiters[i]!;
            if (waiter.match(parsed)) {
              waiters.splice(i, 1);
              waiter.resolve(parsed);
            }
          }
        }
      }
    } catch {
      /* aborted */
    }
  })();

  return {
    events,
    waitFor(match: (e: SseEvent) => boolean, timeoutMs = 15_000): Promise<SseEvent> {
      const existing = events.find(match);
      if (existing) return Promise.resolve(existing);
      return new Promise((res, rej) => {
        const timer = setTimeout(() => rej(new Error('SSE wait timed out')), timeoutMs);
        waiters.push({
          match,
          resolve: (e) => {
            clearTimeout(timer);
            res(e);
          },
        });
      });
    },
    close() {
      controller.abort();
      return done;
    },
  };
}

test('e2e (mock agent): streaming, tool call, permission round-trip', async () => {
  // Register the fixture as a user-defined agent.
  const dir = await mkdtemp(join(tmpdir(), 'acp-hub-test-'));
  const userConfig = join(dir, 'agents.json');
  await writeFile(
    userConfig,
    JSON.stringify({
      agents: [
        {
          id: 'mock',
          name: 'Mock Agent',
          description: 'scripted ACP agent',
          command: [process.execPath, mockAgent],
        },
      ],
    }),
    'utf8',
  );

  const registry = new AgentRegistry({ userConfigPath: userConfig });
  const server = new HubServer({
    port: 0,
    host: '127.0.0.1',
    registry,
    permissionMode: 'ask',
    // Keep test transcripts out of the user's real history.
    dataDir: join(dir, 'sessions'),
  });
  const url = await server.listen();

  try {
    // The mock must be visible and available.
    const { agents } = (await fetch(`${url}/agents`).then((r) => r.json())) as {
      agents: Array<{ id: string; available: boolean }>;
    };
    const mock = agents.find((a) => a.id === 'mock');
    assert.ok(mock, 'mock agent should be registered');
    assert.equal(mock!.available, true);

    // Create the session.
    const created = await fetch(`${url}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'mock', cwd: dir, permissionMode: 'ask' }),
    });
    const createdRaw = await created.text();
    assert.equal(created.status, 201, createdRaw);
    const session = JSON.parse(createdRaw) as {
      sessionId: string;
      models: { model: { current: string; options: Array<{ value: string }> } };
    };
    assert.equal(session.models.model.options.length, 2);

    // Switch model before prompting.
    const switched = await fetch(`${url}/sessions/${session.sessionId}/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ configId: 'model', value: 'mock/thinking' }),
    });
    assert.equal(switched.status, 200);
    const switchedBody = (await switched.json()) as {
      models: { model: { current: string } };
    };
    assert.equal(switchedBody.models.model.current, 'mock/thinking');

    // Subscribe, then prompt.
    const sse = openSse(`${url}/sessions/${session.sessionId}/stream`);
    await sse.waitFor((e) => e.event === 'ready');

    const promptRes = await fetch(`${url}/sessions/${session.sessionId}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello hub' }),
    });
    assert.equal(promptRes.status, 202);

    // Tool call must be announced.
    const toolCall = await sse.waitFor(
      (e) => e.event === 'update' && e.data.update?.sessionUpdate === 'tool_call',
    );
    assert.match(toolCall.data.update.title, /Read project file/);

    // Permission must be parked and surfaced.
    const perm = await sse.waitFor((e) => e.event === 'permission_request');
    assert.ok(perm.data.requestId);
    assert.equal(perm.data.options.length, 2);
    assert.equal(perm.data.sessionId, session.sessionId);

    // Allow it.
    const approved = await fetch(`${url}/sessions/${session.sessionId}/permission`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: perm.data.requestId, optionId: 'allow_once' }),
    });
    assert.equal(approved.status, 200);

    // Tool call resolves to completed.
    const toolUpdate = await sse.waitFor(
      (e) =>
        e.event === 'update' &&
        e.data.update?.sessionUpdate === 'tool_call_update' &&
        e.data.update.toolCallId === toolCall.data.update.toolCallId,
    );
    assert.equal(toolUpdate.data.update.status, 'completed');

    // Assistant text streams in.
    const messageChunks = [];
    await sse.waitFor((e) => {
      if (e.event === 'update' && e.data.update?.sessionUpdate === 'agent_message_chunk') {
        messageChunks.push(e.data.update.content.text);
        return false;
      }
      return false;
    }, 300).catch(() => {});

    const turnEnd = await sse.waitFor((e) => e.event === 'turn_end');
    assert.equal(turnEnd.data.stopReason, 'end_turn');

    const text = messageChunks.join('');
    assert.match(text, /mock-agent: you said "hello hub"/);
    assert.match(text, /Permission granted/);

    // Thought chunks came through too.
    assert.ok(
      sse.events.some(
        (e) => e.event === 'update' && e.data.update?.sessionUpdate === 'agent_thought_chunk',
      ),
      'expected at least one thought chunk',
    );

    await sse.close();
    await fetch(`${url}/sessions/${session.sessionId}`, { method: 'DELETE' });
  } finally {
    await server.close();
  }
});

test('e2e (mock agent): permission deny path marks the tool failed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'acp-hub-deny-'));
  const userConfig = join(dir, 'agents.json');
  await writeFile(
    userConfig,
    JSON.stringify({
      agents: [{ id: 'mock', name: 'Mock', command: [process.execPath, mockAgent] }],
    }),
    'utf8',
  );

  const server = new HubServer({
    port: 0,
    host: '127.0.0.1',
    registry: new AgentRegistry({ userConfigPath: userConfig }),
    permissionMode: 'deny',
    dataDir: join(dir, 'sessions'),
  });
  const url = await server.listen();

  try {
    const created = await fetch(`${url}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'mock', cwd: dir, permissionMode: 'deny' }),
    });
    const { sessionId } = (await created.json()) as { sessionId: string };

    const sse = openSse(`${url}/sessions/${sessionId}/stream`);
    await sse.waitFor((e) => e.event === 'ready');

    await fetch(`${url}/sessions/${sessionId}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'deny me' }),
    });

    const toolUpdate = await sse.waitFor(
      (e) => e.event === 'update' && e.data.update?.sessionUpdate === 'tool_call_update',
    );
    assert.equal(toolUpdate.data.update.status, 'failed');

    const turnEnd = await sse.waitFor((e) => e.event === 'turn_end');
    assert.equal(turnEnd.data.stopReason, 'end_turn');

    const text = sse.events
      .filter((e) => e.event === 'update' && e.data.update?.sessionUpdate === 'agent_message_chunk')
      .map((e) => e.data.update.content.text)
      .join('');
    assert.match(text, /Permission denied/);

    await sse.close();
    await fetch(`${url}/sessions/${sessionId}`, { method: 'DELETE' });
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// file-edit review
// ---------------------------------------------------------------------------

const ORIGINAL_NOTES = 'hello\nTODO: ship it\n';
const EDITED_NOTES = 'hello, world\nDONE: ship it\n';

async function editFixture() {
  const dir = await mkdtemp(join(tmpdir(), 'acp-hub-edit-'));
  const project = join(dir, 'project');
  await mkdir(project);
  const userConfig = join(dir, 'agents.json');
  await writeFile(
    userConfig,
    JSON.stringify({ agents: [{ id: 'mock', name: 'Mock', command: [process.execPath, mockAgent] }] }),
    'utf8',
  );
  await writeFile(join(project, 'notes.txt'), ORIGINAL_NOTES, 'utf8');

  const server = new HubServer({
    port: 0,
    host: '127.0.0.1',
    registry: new AgentRegistry({ userConfigPath: userConfig }),
    permissionMode: 'ask',
    dataDir: join(dir, 'sessions'),
  });
  const url = await server.listen();

  const created = await fetch(`${url}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId: 'mock', cwd: project }),
  });
  const { sessionId } = (await created.json()) as { sessionId: string };
  const sse = openSse(`${url}/sessions/${sessionId}/stream`);
  await sse.waitFor((e) => e.event === 'ready');

  const post = (path: string, body?: unknown) =>
    fetch(`${url}/sessions/${sessionId}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  return { project, server, url, sessionId, sse, post };
}

test('e2e (mock agent): diff approval, write tracking, keep and revert', async () => {
  const { project, server, url, sessionId, sse, post } = await editFixture();
  const notes = join(project, 'notes.txt');
  const createdFile = join(project, 'created.txt');

  try {
    assert.equal((await post('/prompt', { text: 'please edit the notes' })).status, 202);

    // The edit is announced as a diff tool call ...
    const toolCall = await sse.waitFor(
      (e) => e.event === 'update' && e.data.update?.sessionUpdate === 'tool_call',
    );
    const diff = toolCall.data.update.content[0];
    assert.equal(diff.type, 'diff');
    assert.equal(diff.oldText, ORIGINAL_NOTES);
    assert.equal(diff.newText, EDITED_NOTES);

    // ... which becomes a change that is not applied yet.
    const proposed = await sse.waitFor(
      (e) => e.event === 'file_change' && e.data.change.displayPath === 'notes.txt',
    );
    assert.equal(proposed.data.change.applied, false);
    assert.equal(proposed.data.change.toolCallId, toolCall.data.update.toolCallId);

    // The permission request carries the same diff, and nothing is written yet.
    const perm = await sse.waitFor((e) => e.event === 'permission_request');
    assert.equal(perm.data.toolCall.content[0].type, 'diff');
    assert.equal(await readFile(notes, 'utf8'), ORIGINAL_NOTES);

    assert.equal((await post('/permission', { requestId: perm.data.requestId, optionId: 'allow_once' })).status, 200);
    await sse.waitFor((e) => e.event === 'turn_end');

    assert.equal(await readFile(notes, 'utf8'), EDITED_NOTES);
    assert.equal(await readFile(createdFile, 'utf8'), 'brand new\n');

    // One change per file: the hub's write folded into the announced diff.
    const { changes } = (await fetch(`${url}/sessions/${sessionId}/changes`).then((r) => r.json())) as {
      changes: Array<Record<string, any>>;
    };
    assert.equal(changes.length, 2);
    const noteChange = changes.find((c) => c.displayPath === 'notes.txt')!;
    const newFile = changes.find((c) => c.displayPath === 'created.txt')!;
    assert.equal(noteChange.changeId, proposed.data.change.changeId);
    assert.equal(noteChange.exact, true);
    assert.equal(noteChange.applied, true);
    assert.equal(newFile.origin, 'fs_write');
    assert.equal(newFile.oldText, null);

    const summary = (await fetch(`${url}/sessions/${sessionId}`).then((r) => r.json())) as {
      changes: { total: number; undecided: number };
    };
    assert.deepEqual(summary.changes, { total: 2, undecided: 2 });

    // Revert the edit: the file goes back and the decision is broadcast.
    const reverted = await post(`/changes/${noteChange.changeId}/revert`);
    assert.equal(reverted.status, 200);
    assert.equal(((await reverted.json()) as { result: string }).result, 'reverted');
    assert.equal(await readFile(notes, 'utf8'), ORIGINAL_NOTES);
    await sse.waitFor(
      (e) =>
        e.event === 'file_change' &&
        e.data.change.changeId === noteChange.changeId &&
        e.data.change.decision === 'reverted',
    );

    // Keep the new file; it stays on disk.
    assert.equal((await post(`/changes/${newFile.changeId}/keep`)).status, 200);
    assert.equal(await readFile(createdFile, 'utf8'), 'brand new\n');

    // Once the user rewrites it, a revert is a conflict and changes nothing.
    await writeFile(createdFile, 'user rewrote it\n', 'utf8');
    const conflict = await post(`/changes/${newFile.changeId}/revert`);
    assert.equal(conflict.status, 409);
    assert.equal(((await conflict.json()) as { error: { code: string } }).error.code, 'conflict');
    assert.equal(await readFile(createdFile, 'utf8'), 'user rewrote it\n');

    assert.equal((await post('/changes/nope/revert')).status, 404);

    // The transcript keeps the texts once, then the decision.
    const { events } = (await fetch(`${url}/sessions/${sessionId}/transcript`).then((r) => r.json())) as {
      events: Array<Record<string, any>>;
    };
    const records = events.filter((e) => e.type === 'file_change' && e.changeId === noteChange.changeId);
    assert.ok(records.some((r) => r.newText === EDITED_NOTES), 'texts are persisted');
    assert.equal(records.at(-1)!.decision, 'reverted');
    assert.equal(records.at(-1)!.newText, undefined, 'a decision record carries no texts');

    await sse.close();
    await fetch(`${url}/sessions/${sessionId}`, { method: 'DELETE' });
  } finally {
    await server.close();
  }
});

test('e2e (mock agent): a rejected edit writes nothing', async () => {
  const { project, server, url, sessionId, sse, post } = await editFixture();

  try {
    await post('/prompt', { text: 'edit please' });
    const perm = await sse.waitFor((e) => e.event === 'permission_request');
    await post('/permission', { requestId: perm.data.requestId, optionId: 'reject_once' });

    const failed = await sse.waitFor(
      (e) => e.event === 'update' && e.data.update?.sessionUpdate === 'tool_call_update',
    );
    assert.equal(failed.data.update.status, 'failed');
    await sse.waitFor((e) => e.event === 'turn_end');

    assert.equal(await readFile(join(project, 'notes.txt'), 'utf8'), ORIGINAL_NOTES);
    await assert.rejects(access(join(project, 'created.txt')), 'nothing was created');

    const { changes } = (await fetch(`${url}/sessions/${sessionId}/changes`).then((r) => r.json())) as {
      changes: Array<{ applied: boolean; decision: string | null }>;
    };
    assert.equal(changes.length, 1, 'only the proposal is known');
    assert.equal(changes[0]!.applied, false);

    await sse.close();
    await fetch(`${url}/sessions/${sessionId}`, { method: 'DELETE' });
  } finally {
    await server.close();
  }
});
