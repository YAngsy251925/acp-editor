#!/usr/bin/env node
/**
 * End-to-end smoke test against a running hub.
 *
 *   node scripts/smoke.mjs [hubUrl] [agentId] [prompt]
 *
 * Exercises the full loop: list agents -> create session -> open SSE ->
 * prompt -> switch model -> print the streamed turn.
 */
const base = process.argv[2] ?? 'http://127.0.0.1:7878';
const agentId = process.argv[3] ?? 'opencode';
const prompt = process.argv[4] ?? 'Reply with exactly: hub-ok';

const t0 = Date.now();
const log = (...args) => console.log(`[+${String(Date.now() - t0).padStart(5)}ms]`, ...args);

async function json(path, init) {
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

// 1. agents
const { agents } = await json('/agents');
log('agents:', agents.map((a) => `${a.id}${a.available ? '' : '(missing)'}`).join(', '));

const target = agents.find((a) => a.id === agentId);
if (!target) throw new Error(`agent ${agentId} is not in the registry`);
if (!target.available) throw new Error(`agent ${agentId} is not installed: ${target.reason}`);
log(`using ${target.name} ${target.version ?? ''} -> ${target.resolvedPath}`);

// 2. session
const session = await json('/sessions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ agentId, cwd: process.cwd() }),
});
log('session:', session.sessionId);
log('models:', session.models?.model?.options?.length ?? 0, 'available');
for (const option of session.models?.model?.options ?? []) {
  const marker = option.value === session.models.model.current ? '*' : ' ';
  console.log(`   ${marker} ${option.value}  (${option.name})`);
}

// 3. SSE
const controller = new AbortController();
const streamReady = (async () => {
  const res = await fetch(`${base}/sessions/${session.sessionId}/stream`, {
    signal: controller.signal,
  });
  if (!res.ok) throw new Error(`stream -> ${res.status}`);
  return res.body;
})();

const body = await streamReady;
log('SSE connected');

let assistantText = '';
const reading = (async () => {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      handleFrame(frame);
    }
  }
})();

function handleFrame(frame) {
  const lines = frame.split('\n');
  let event = 'message';
  let data = '';
  for (const line of lines) {
    if (line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data += line.slice(5).trim();
  }
  if (!data) return;

  let payload;
  try {
    payload = JSON.parse(data);
  } catch {
    return;
  }

  switch (event) {
    case 'ready':
      log('ready:', JSON.stringify({ sessionId: payload.sessionId, agentId: payload.agentId }));
      break;
    case 'turn_start':
      log('turn_start');
      break;
    case 'update': {
      const u = payload.update ?? {};
      if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') {
        assistantText += u.content.text;
        process.stdout.write(u.content.text);
      } else if (u.sessionUpdate === 'agent_thought_chunk' && u.content?.type === 'text') {
        // keep thoughts out of the main line
      } else if (u.sessionUpdate === 'tool_call') {
        log(`tool_call: ${u.title ?? u.toolCallId} [${u.status ?? '?'}]`);
      } else if (u.sessionUpdate === 'tool_call_update') {
        log(`tool_call_update: ${u.toolCallId} -> ${u.status ?? '?'}`);
      } else {
        log('update:', JSON.stringify(u).slice(0, 400));
      }
      break;
    }
    case 'permission_request':
      log('permission_request:', JSON.stringify(payload.toolCall?.title ?? payload.requestId));
      // auto-allow for the smoke test
      void fetch(`${base}/sessions/${payload.sessionId}/permission`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: payload.requestId, optionId: payload.options?.[0]?.optionId }),
      });
      break;
    case 'turn_end':
      log(`turn_end stopReason=${payload.stopReason} duration=${payload.durationMs}ms`);
      controller.abort();
      break;
    case 'turn_error':
      log('turn_error:', payload.message);
      controller.abort();
      break;
    case 'agent_exit':
      log('agent_exit:', payload.code, payload.signal);
      controller.abort();
      break;
    case 'agent_stderr': {
      const line = String(payload.line ?? '');
      if (/error|fail|invalid|denied/i.test(line)) {
        log('agent_stderr:', line.slice(0, 240));
      }
      break;
    }
    default:
      break;
  }
}

// 4. prompt
await json(`/sessions/${session.sessionId}/prompt`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text: prompt }),
});
log('prompt sent');

// wait for the turn to finish
await Promise.race([reading, new Promise((r) => setTimeout(r, 120_000))]).catch(() => {});
controller.abort();

console.log('\n--- assistant text ---');
console.log(assistantText.trim() || '(empty)');

await fetch(`${base}/sessions/${session.sessionId}`, { method: 'DELETE' }).catch(() => {});
log('done');
process.exit(0);
