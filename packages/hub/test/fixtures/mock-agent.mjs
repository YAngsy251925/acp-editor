#!/usr/bin/env node
/**
 * A scripted ACP agent used by tests and demos.
 *
 * It implements just enough of ACP to exercise everything the hub cares about:
 * handshake, session config (two fake models), streaming message chunks,
 * a tool call that asks the client for permission, and a stop reason.
 *
 * A prompt containing the word "edit" runs the file-edit scenario instead:
 * read notes.txt through the client, announce the edit as a `diff` tool call,
 * ask permission with that diff, write it through `fs/write_text_file`, then
 * create created.txt without announcing any diff.
 *
 * Run standalone:  node test/fixtures/mock-agent.mjs
 */
import { createInterface } from 'node:readline';
import { join } from 'node:path';

const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

/** `--reject-mcp` makes this fixture behave like an agent that refuses mcpServers. */
const REJECT_MCP = process.argv.includes('--reject-mcp');

let nextAgentRequestId = 1000;
const pending = new Map(); // ours -> resolve

function requestClient(method, params) {
  const id = nextAgentRequestId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    send({ jsonrpc: '2.0', id, method, params });
  });
}

let sessionCounter = 0;
const sessions = new Map();

const MODELS = [
  { value: 'mock/fast', name: 'Mock/Fast' },
  { value: 'mock/thinking', name: 'Mock/Thinking' },
];

function configOptions(currentModel = 'mock/fast') {
  return [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: currentModel,
      options: MODELS,
    },
    {
      id: 'mode',
      name: 'Session Mode',
      category: 'mode',
      type: 'select',
      currentValue: 'build',
      options: [
        { value: 'build', name: 'build' },
        { value: 'plan', name: 'plan' },
      ],
    },
  ];
}

async function handlePrompt(msg) {
  const { sessionId, prompt } = msg.params ?? {};
  const text = (prompt ?? [])
    .filter((b) => b?.type === 'text')
    .map((b) => b.text)
    .join(' ');

  if (/\bedit\b/i.test(text)) return handleEdit(msg, sessionId);

  const update = (u) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: u } });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 1. a thought
  update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking about ' } });
  await sleep(20);
  update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'the request…' } });
  await sleep(20);

  // 2. a tool call that needs permission
  const toolCallId = `call_${Date.now()}`;
  update({
    sessionUpdate: 'tool_call',
    toolCallId,
    title: 'Read project file',
    kind: 'read',
    status: 'pending',
    rawInput: { path: 'README.md' },
  });

  const decision = await requestClient('session/request_permission', {
    sessionId,
    toolCall: { toolCallId, title: 'Read project file', kind: 'read', status: 'pending' },
    options: [
      { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
    ],
  });

  const allowed = decision?.outcome?.outcome === 'selected' && decision.outcome.optionId.startsWith('allow');

  update({
    sessionUpdate: 'tool_call_update',
    toolCallId,
    status: allowed ? 'completed' : 'failed',
    rawOutput: allowed ? 'ok' : 'denied by user',
  });
  await sleep(20);

  // 3. streamed assistant message
  const reply = allowed
    ? `mock-agent: you said "${text}". Permission granted, fake file read.`
    : `mock-agent: you said "${text}". Permission denied.`;

  for (const token of reply.match(/\S+\s*/g) ?? []) {
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: token } });
    await sleep(15);
  }

  // 4. usage + stop
  update({ sessionUpdate: 'usage_update', used: 42, size: 200000 });

  send({
    jsonrpc: '2.0',
    id: msg.id,
    result: { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } },
  });
}

/** The deterministic edit the scenario makes: greet the world, finish the TODOs. */
function editNotes(text) {
  return text.replace('hello', 'hello, world').replace(/TODO/g, 'DONE');
}

async function handleEdit(msg, sessionId) {
  const update = (u) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: u } });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const cwd = sessions.get(sessionId)?.cwd ?? process.cwd();
  const target = join(cwd, 'notes.txt');
  const created = join(cwd, 'created.txt');

  // Read through the client so the hub's sandbox is exercised too.
  const read = await requestClient('fs/read_text_file', { sessionId, path: target });
  const oldText = typeof read?.content === 'string' ? read.content : '';
  const newText = editNotes(oldText);
  const diff = { type: 'diff', path: target, oldText, newText };

  const toolCallId = `edit_${Date.now()}`;
  update({
    sessionUpdate: 'tool_call',
    toolCallId,
    title: 'Edit notes.txt',
    kind: 'edit',
    status: 'pending',
    locations: [{ path: target, line: 1 }],
    content: [diff],
  });

  const decision = await requestClient('session/request_permission', {
    sessionId,
    toolCall: { toolCallId, title: 'Edit notes.txt', kind: 'edit', status: 'pending', content: [diff] },
    options: [
      { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
    ],
  });
  const allowed = decision?.outcome?.outcome === 'selected' && decision.outcome.optionId.startsWith('allow');

  if (allowed) {
    await requestClient('fs/write_text_file', { sessionId, path: target, content: newText });
    update({ sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', content: [diff] });
    // A second file, written without announcing any diff.
    await requestClient('fs/write_text_file', { sessionId, path: created, content: 'brand new\n' });
  } else {
    update({ sessionUpdate: 'tool_call_update', toolCallId, status: 'failed', rawOutput: 'denied by user' });
  }
  await sleep(10);

  const reply = allowed
    ? 'mock-agent: edited notes.txt and created created.txt.'
    : 'mock-agent: edit rejected, nothing written.';
  for (const token of reply.match(/\S+\s*/g) ?? []) {
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: token } });
    await sleep(10);
  }

  send({
    jsonrpc: '2.0',
    id: msg.id,
    result: { stopReason: 'end_turn', usage: { inputTokens: 12, outputTokens: 24, totalTokens: 36 } },
  });
}

async function handle(msg) {
  // response to one of our requests
  if (msg.id !== undefined && msg.method === undefined) {
    const resolve = pending.get(msg.id);
    if (resolve) {
      pending.delete(msg.id);
      resolve(msg.result ?? msg.error);
    }
    return;
  }

  switch (msg.method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { loadSession: false, promptCapabilities: { embeddedContext: true } },
          agentInfo: { name: 'mock-agent', version: '0.1.0' },
        },
      });
      return;

    case 'authenticate':
      send({ jsonrpc: '2.0', id: msg.id, result: null });
      return;

    case 'session/new': {
      if (REJECT_MCP && Array.isArray(msg.params?.mcpServers) && msg.params.mcpServers.length > 0) {
        send({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32602, message: 'Invalid params', data: { mcpServers: 'refused by fixture' } },
        });
        return;
      }
      // Unique across processes: the hub spawns one mock agent per session, so a
      // plain counter would hand every session the same id ("mock-session-1").
      const sessionId = `mock-session-${process.pid}-${++sessionCounter}`;
      sessions.set(sessionId, { model: 'mock/fast', cwd: msg.params?.cwd });
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: { sessionId, configOptions: configOptions() },
      });
      return;
    }

    case 'session/load': {
      const sessionId = msg.params?.sessionId ?? `mock-session-${process.pid}-${++sessionCounter}`;
      sessions.set(sessionId, { model: 'mock/fast' });
      send({ jsonrpc: '2.0', id: msg.id, result: { sessionId, configOptions: configOptions() } });
      return;
    }

    case 'session/set_config_option': {
      const { sessionId, configId, value } = msg.params ?? {};
      const session = sessions.get(sessionId) ?? { model: 'mock/fast' };
      sessions.set(sessionId, session);
      if (configId === 'model' && MODELS.some((m) => m.value === value)) {
        session.model = value;
      }
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: { configOptions: configOptions(session.model) },
      });
      return;
    }

    case 'session/prompt':
      void handlePrompt(msg);
      return;

    case 'session/cancel':
      // notification, no reply
      return;

    case 'session/close':
      send({ jsonrpc: '2.0', id: msg.id, result: null });
      return;

    default:
      send({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: `mock-agent has no method ${msg.method}` },
      });
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }
  void handle(msg);
});
