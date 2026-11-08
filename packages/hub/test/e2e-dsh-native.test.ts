/**
 * End-to-end against the native `dsh --profile acp` (installed DeepSeek Harness).
 *
 *   ACP_E2E_DSH=1 pnpm --filter @acp-editor/hub test
 *
 * Requires the dsh CLI on PATH and DeepSeek credentials. Covers what the other
 * e2e tests cannot with a scripted agent: real config options (model,
 * reasoning_effort), an agent that writes files itself (snapshot edit tracking
 * folded under its tool calls), and resuming a persisted session in a new agent
 * process.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentRegistry } from '../src/registry.js';
import { HubServer } from '../src/server.js';
import { openSse, waitFor } from './helpers.js';

test('e2e (native dsh): config options, tracked edits, revert, resume', { skip: !process.env.ACP_E2E_DSH }, async () => {
  const NL = String.fromCharCode(10);
const dir = await mkdtemp(join(tmpdir(), 'acp-dsh-native-'));
  const project = join(dir, 'project');
  await mkdir(project);
  await writeFile(join(project, 'notes.txt'), 'hello\nTODO: ship it\n', 'utf8');

  // A real registry, so the dsh builtin (dsh --profile acp) is used as shipped.
  const server = new HubServer({
    port: 0,
    host: '127.0.0.1',
    registry: new AgentRegistry({ userConfigPath: join(dir, 'does-not-exist.json') }),
    permissionMode: 'ask',
    dataDir: join(dir, 'sessions'),
  });
  const url = await server.listen();
  try {
    const created = await fetch(`${url}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'dsh', cwd: project }),
    });
    const createdRaw = await created.text();
    assert.equal(created.status, 201, createdRaw);
    const session = JSON.parse(createdRaw) as {
      sessionId: string;
      models: { model: { current: string; options: unknown[] } | null };
    };

    // The agent's own model catalogue and reasoning levels, generically.
    assert.ok(session.models.model, 'the agent reports a model select');
    assert.ok(session.models.model.options.length >= 1);

    const sse = openSse(`${url}/sessions/${session.sessionId}/stream`);
    await waitFor(sse, (e) => e.event === 'ready');

    await fetch(`${url}/sessions/${session.sessionId}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text:
          'Replace the word TODO with DONE in notes.txt, then create hello.txt containing one line: hi. ' +
          'Also remember the word BANANA for later. Reply with just: done.',
      }),
    });
    const end = await waitFor(sse, (e) => e.event === 'turn_end', 180_000);
    assert.equal(end.data.stopReason, 'end_turn');

    // The agent edits files itself; the hub's snapshot turned that into changes.
    assert.equal(await readFile(join(project, 'notes.txt'), 'utf8'), 'hello\nDONE: ship it\n');
    assert.equal(await readFile(join(project, 'hello.txt'), 'utf8'), 'hi\n');
    const { changes } = (await fetch(`${url}/sessions/${session.sessionId}/changes`).then((r) => r.json())) as {
      changes: Array<{ changeId: string; displayPath: string; exact: boolean; applied: boolean; origin: string }>;
    };
    assert.deepEqual(
      changes.map((c) => [c.displayPath, c.origin, c.exact, c.applied]).sort(),
      [
        ['hello.txt', 'snapshot', true, true],
        ['notes.txt', 'snapshot', true, true],
      ],
    );

    // Revert restores the original texts.
    for (const change of changes) {
      const res = await fetch(`${url}/sessions/${session.sessionId}/changes/${change.changeId}/revert`, {
        method: 'POST',
      });
      assert.equal(res.status, 200);
    }
    assert.equal(await readFile(join(project, 'notes.txt'), 'utf8'), 'hello' + NL + 'TODO: ship it' + NL);
    await assert.rejects(readFile(join(project, 'hello.txt'), 'utf8'), () => true);

    // Resume: end the first session (its agent drains and persists on stdin EOF),
    // then a brand-new agent process reattaches to the same persisted session.
    await fetch(`${url}/sessions/${session.sessionId}`, { method: 'DELETE' });
    await new Promise((r) => setTimeout(r, 1_000));
    const resumed = await fetch(`${url}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'dsh', cwd: project, resume: session.sessionId }),
    });
    const resumedRaw = await resumed.text();
    assert.equal(resumed.status, 201, resumedRaw);
    const second = JSON.parse(resumedRaw) as { sessionId: string; resumed: boolean };
    assert.equal(second.resumed, true);
    assert.equal(second.sessionId, session.sessionId);

    const sse2 = openSse(`${url}/sessions/${second.sessionId}/stream`);
    await waitFor(sse2, (e) => e.event === 'ready');
    await fetch(`${url}/sessions/${second.sessionId}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // The model answers from the restored conversation context, not the disk:
      // this is exactly what resume is supposed to carry over.
      body: JSON.stringify({ text: 'What was the word I asked you to remember? Reply with that word only.' }),
    });
    const end2 = await waitFor(sse2, (e) => e.event === 'turn_end', 120_000);
    assert.equal(end2.data.stopReason, 'end_turn');
    const text = sse2.events
      .filter((e) => e.event === 'update' && e.data.update?.sessionUpdate === 'agent_message_chunk')
      .map((e) => e.data.update.content.text)
      .join('');
    assert.match(text, /BANANA/);

    await sse.close();
    await sse2.close();
    await fetch(`${url}/sessions/${second.sessionId}`, { method: 'DELETE' });
  } finally {
    await server.close();
  }
});
