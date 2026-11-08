#!/usr/bin/env node
/**
 * Self-contained demo: boots a hub against the scripted mock agent and prints a
 * complete turn — thought, tool call, permission round-trip, streamed text.
 *
 *   node --import tsx scripts/demo-mock.mjs
 *
 * No API key, no network, no installed agent required. This is what a healthy
 * turn looks like; the editor panel's job is to render exactly these frames.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { AgentRegistry } from '../packages/hub/src/registry.ts';
import { HubServer } from '../packages/hub/src/server.ts';

const fixture = resolve('packages/hub/test/fixtures/mock-agent.mjs');

const dir = await mkdtemp(join(tmpdir(), 'acp-demo-'));
const userConfig = join(dir, 'agents.json');
await writeFile(
  userConfig,
  JSON.stringify({
    agents: [
      { id: 'mock', name: 'Mock Agent', description: 'scripted', command: [process.execPath, fixture] },
    ],
  }),
);

const server = new HubServer({
  port: 0,
  host: '127.0.0.1',
  registry: new AgentRegistry({ userConfigPath: userConfig }),
  permissionMode: 'ask',
});
const base = await server.listen();
console.log(`hub: ${base}\n`);

// 1. session
const createdRes = await fetch(`${base}/sessions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ agentId: 'mock', cwd: dir }),
});
const createdRaw = await createdRes.text();
if (!createdRes.ok) {
  console.error(`POST /sessions -> ${createdRes.status}\n${createdRaw}`);
  await server.close();
  process.exit(1);
}
const session = JSON.parse(createdRaw);

console.log(`session ${session.sessionId}`);
console.log(`models  ${session.models.model.options.map((o) => o.value).join(', ')}`);
console.log(`current ${session.models.model.current}\n`);

// 2. stream
const controller = new AbortController();
const res = await fetch(`${base}/sessions/${session.sessionId}/stream`, { signal: controller.signal });
const reader = res.body.getReader();
const decoder = new TextDecoder();
let buffer = '';
let text = '';

const pump = (async () => {
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let i;
      while ((i = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        let event = 'message';
        let data = '';
        for (const line of frame.split('\n')) {
          if (line.startsWith(':')) continue;
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (!data) continue;
        const payload = JSON.parse(data);
        switch (event) {
          case 'ready':
            console.log('· ready');
            break;
          case 'turn_start':
            console.log('· turn_start');
            break;
          case 'update': {
            const u = payload.update ?? {};
            if (u.sessionUpdate === 'agent_thought_chunk') {
              process.stdout.write(`  [thought] ${u.content?.text ?? ''}`);
            } else if (u.sessionUpdate === 'agent_message_chunk') {
              text += u.content?.text ?? '';
              process.stdout.write(u.content?.text ?? '');
            } else if (u.sessionUpdate === 'tool_call') {
              console.log(`\n  [tool_call] ${u.title} (${u.status})`);
            } else if (u.sessionUpdate === 'tool_call_update') {
              console.log(`  [tool_call] ${u.toolCallId} -> ${u.status}`);
            } else if (u.sessionUpdate === 'usage_update') {
              console.log(`  [usage] ${u.used}/${u.size}`);
            }
            break;
          }
          case 'permission_request':
            console.log(`\n  [permission] ${payload.toolCall?.title} -> auto-allow`);
            void fetch(`${base}/sessions/${payload.sessionId}/permission`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ requestId: payload.requestId, optionId: payload.options[0].optionId }),
            });
            break;
          case 'turn_end':
            console.log(`\n\n· turn_end ${payload.stopReason} in ${payload.durationMs}ms`);
            controller.abort();
            break;
          default:
            break;
        }
      }
    }
  } catch {
    /* aborted */
  }
})();

// 3. prompt
await fetch(`${base}/sessions/${session.sessionId}/prompt`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text: 'hello from the editor' }),
});
console.log('· prompt sent\n');

await Promise.race([pump, new Promise((r) => setTimeout(r, 20_000))]);
controller.abort();

console.log(`\n--- assistant text ---\n${text.trim()}`);
await server.close();
