#!/usr/bin/env node
/**
 * ue-mcp — read the running Unreal editor through its MCP server.
 *
 * Why this exists: some ACP agents (dsh 0.1.5-rc.2 among them) accept MCP servers
 * in `session/new` and then mount nothing, so the model never gets `mcp__*` tools.
 * The agent does always have a shell, so this gives it one command that answers
 * "what is the user looking at?" without any MCP support on its side.
 *
 *   ue-mcp context            open assets, selection, content-browser path, PIE, camera
 *   ue-mcp toolsets           what the editor exposes
 *   ue-mcp tools <toolset>    one toolset's tools and their required arguments
 *   ue-mcp call <toolset> <tool> ['{"json":"args"}']
 *   ue-mcp ping               is the endpoint alive, and what does it report
 *
 * Endpoint: --url, else $UE_MCP_URL, else http://127.0.0.1:8000/mcp
 * Output is JSON (agent-friendly); errors go to stderr with a non-zero exit.
 */
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
let url = process.env.UE_MCP_URL || 'http://127.0.0.1:8000/mcp';
let timeoutMs = Number(process.env.UE_MCP_TIMEOUT_MS || 15_000);

/** Pull `--url` / `--timeout` out of the argv before the command word. */
const rest = [];
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--url') url = args[++i] ?? url;
  else if (arg === '--timeout') timeoutMs = Number(args[++i] ?? timeoutMs);
  else if (arg === '--help' || arg === '-h') {
    console.log(help());
    process.exit(0);
  } else rest.push(arg);
}

function help() {
  return `ue-mcp — query the running Unreal editor over MCP

Usage
  ue-mcp [--url URL] [--timeout MS] <command> [args]

Commands
  context                          open assets, selection, content-browser path, PIE, camera
  toolsets                         list the editor's toolsets
  tools <toolset>                  tools in one toolset
  call <toolset> <tool> [json]     call a tool; json defaults to {}
  ping                             connectivity and server info

Defaults: --url $UE_MCP_URL or ${'http://127.0.0.1:8000/mcp'}`;
}

let sessionId = null;

function parseBody(text, contentType) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (contentType?.includes('text/event-stream') || trimmed.startsWith('data:')) {
    const out = [];
    for (const line of trimmed.split(/\r?\n/)) if (line.startsWith('data:')) out.push(JSON.parse(line.slice(5).trim()));
    return out.length === 1 ? out[0] : out;
  }
  return JSON.parse(trimmed);
}

async function rpc(method, params, { notify = false } = {}) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (sessionId) headers['MCP-Session-Id'] = sessionId;
  const body = notify
    ? { jsonrpc: '2.0', method, params }
    : { jsonrpc: '2.0', id: randomUUID(), method, params };

  let res;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const reason = err?.name === 'TimeoutError' ? `timed out after ${timeoutMs}ms` : err?.message ?? String(err);
    fail(`编辑器 MCP 不可达（${url}）：${reason}\n` +
      '编辑器没开、或没启用 ModelContextProtocol 插件时会出现这个错误。');
  }
  const sid = res.headers.get('mcp-session-id');
  if (sid) sessionId = sid;
  const text = await res.text();
  const parsed = parseBody(text, res.headers.get('content-type'));
  if (!res.ok && parsed?.error) return parsed;
  return parsed;
}

function fail(message, code = 2) {
  console.error(message);
  process.exit(code);
}

async function connect() {
  const init = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'ue-mcp', version: '1.0.0' },
  });
  if (init?.error) fail(`initialize 失败：${JSON.stringify(init.error)}`, 1);
  await rpc('notifications/initialized', {}, { notify: true });
  return init?.result ?? {};
}

/** tools/call on the gateway; returns the unwrapped `returnValue` when present. */
async function callTool(name, toolArguments) {
  const r = await rpc('tools/call', { name, arguments: toolArguments });
  if (r?.error) return { error: r.error };
  const text = (r?.result?.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  if (!text) return r?.result ?? null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && 'returnValue' in parsed ? parsed.returnValue : parsed;
  } catch {
    return text;
  }
}

async function editorCall(toolset, tool, toolArguments = {}) {
  const out = await callTool('call_tool', { toolset_name: toolset, tool_name: tool, arguments: toolArguments });
  if (out?.error) fail(`${toolset}.${tool} 失败：${JSON.stringify(out.error)}`, 1);
  return out;
}

const EDITOR = 'EditorToolset.EditorAppToolset';

async function commandContext() {
  await connect();
  const [openAssets, selectedActors, selectedAssets, contentBrowserPath, pie, camera] = await Promise.all([
    editorCall(EDITOR, 'GetOpenAssets'),
    editorCall(EDITOR, 'GetSelectedActors'),
    editorCall(EDITOR, 'GetSelectedAssets'),
    editorCall(EDITOR, 'GetContentBrowserPath'),
    editorCall(EDITOR, 'IsPIERunning'),
    editorCall(EDITOR, 'GetCameraTransform'),
  ]);
  const summary = {
    endpoint: url,
    contentBrowserPath,
    openAssets,
    selectedActors,
    selectedAssets,
    pie,
    camera,
  };
  console.log(JSON.stringify(summary, null, 2));
}

async function commandToolsets() {
  await connect();
  const text = await callTool('list_toolsets', {});
  console.log(typeof text === 'string' ? text : JSON.stringify(text, null, 2));
}

async function commandTools(toolset) {
  if (!toolset) fail('用法：ue-mcp tools <toolset>', 2);
  await connect();
  const detail = await callTool('describe_toolset', { toolset_name: toolset });
  let parsed = detail;
  if (typeof detail === 'string') {
    try {
      parsed = JSON.parse(detail);
    } catch {
      parsed = null;
    }
  }
  if (!parsed?.tools) {
    console.log(typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2));
    return;
  }
  const tools = parsed.tools.map((t) => ({
    name: (t.name ?? '').split('.').pop(),
    description: t.description,
    required: t.inputSchema?.required ?? [],
  }));
  console.log(JSON.stringify({ toolset: parsed.name ?? toolset, count: tools.length, tools }, null, 2));
}

async function commandCall(toolset, tool, json) {
  if (!toolset || !tool) fail("用法：ue-mcp call <toolset> <tool> ['{\"k\":1}']", 2);
  let toolArguments = {};
  if (json) {
    try {
      toolArguments = JSON.parse(json);
    } catch (err) {
      fail(`参数不是合法 JSON：${err.message}`, 2);
    }
  }
  await connect();
  const out = await editorCall(toolset, tool, toolArguments);
  console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2));
}

async function commandPing() {
  const info = await connect();
  const tools = await rpc('tools/list', {});
  console.log(
    JSON.stringify(
      {
        endpoint: url,
        protocolVersion: info.protocolVersion,
        serverInfo: info.serverInfo ?? null,
        capabilities: info.capabilities ?? null,
        tools: (tools?.result?.tools ?? []).map((t) => t.name),
      },
      null,
      2,
    ),
  );
}

const [command, ...commandArgs] = rest;
try {
  switch (command) {
    case 'context':
      await commandContext();
      break;
    case 'toolsets':
      await commandToolsets();
      break;
    case 'tools':
      await commandTools(commandArgs[0]);
      break;
    case 'call':
      await commandCall(commandArgs[0], commandArgs[1], commandArgs[2]);
      break;
    case 'ping':
      await commandPing();
      break;
    case undefined:
      fail(help(), 2);
      break;
    default:
      fail(`未知命令：${command}\n${help()}`, 2);
  }
} catch (err) {
  fail(`ue-mcp 失败：${err?.message ?? err}`, 1);
}
