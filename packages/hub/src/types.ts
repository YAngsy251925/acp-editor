/**
 * Minimal, hand-written ACP (Agent Client Protocol) type surface.
 *
 * Only what the hub actually needs is modelled. Unknown fields from newer
 * agents are preserved via index signatures where it matters, so a protocol
 * bump degrades gracefully instead of throwing.
 */

// ---------------------------------------------------------------------------
// JSON-RPC envelope
// ---------------------------------------------------------------------------

export type JsonRpcId = number | string;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** JSON-RPC error codes used by ACP. */
export const RpcError = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  /** ACP-specific: the requested method exists but is not enabled. */
  AuthRequired: -32000,
  ResourceNotFound: -32002,
} as const;

// ---------------------------------------------------------------------------
// Content blocks
// ---------------------------------------------------------------------------

export interface TextBlock {
  type: 'text';
  text: string;
  annotations?: unknown;
}

export interface ImageBlock {
  type: 'image';
  mimeType: string;
  data: string;
}

export interface ResourceLinkBlock {
  type: 'resource_link';
  uri: string;
  name?: string;
  mimeType?: string;
}

export interface EmbeddedResourceBlock {
  type: 'resource';
  resource: {
    uri: string;
    mimeType?: string;
    text?: string;
    blob?: string;
  };
}

export type ContentBlock =
  | TextBlock
  | ImageBlock
  | ResourceLinkBlock
  | EmbeddedResourceBlock
  | { type: string; [key: string]: unknown };

// ---------------------------------------------------------------------------
// MCP servers handed to the agent
// ---------------------------------------------------------------------------

export interface McpServerStdio {
  /**
   * Optional on purpose. ACP marks *remote* transports with `type`; a stdio server
   * is the one without it. Agents reject `type: "stdio"` as an unknown transport,
   * so leave this undefined when sending.
   */
  type?: 'stdio';
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpServerHttp {
  type: 'http';
  name: string;
  url: string;
  headers?: Record<string, string>;
}

export interface McpServerSse {
  type: 'sse';
  name: string;
  url: string;
  headers?: Record<string, string>;
}

export type McpServer = McpServerStdio | McpServerHttp | McpServerSse;

// ---------------------------------------------------------------------------
// initialize
// ---------------------------------------------------------------------------

export interface ClientCapabilities {
  fs?: {
    readTextFile?: boolean;
    writeTextFile?: boolean;
  };
  terminal?: boolean;
  [key: string]: unknown;
}

export interface InitializeParams {
  protocolVersion: number;
  clientCapabilities?: ClientCapabilities;
  clientInfo?: { name: string; version: string; title?: string };
}

export interface AgentCapabilities {
  loadSession?: boolean;
  mcpCapabilities?: { http?: boolean; sse?: boolean };
  promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean };
  sessionCapabilities?: {
    close?: Record<string, never>;
    fork?: Record<string, never>;
    list?: Record<string, never>;
    resume?: Record<string, never>;
  };
  [key: string]: unknown;
}

export interface AuthMethod {
  id: string;
  name: string;
  description?: string;
}

export interface InitializeResult {
  protocolVersion: number;
  agentCapabilities?: AgentCapabilities;
  authMethods?: AuthMethod[];
  agentInfo?: { name: string; version: string; title?: string };
}

// ---------------------------------------------------------------------------
// session config (models, modes, thought levels ...)
// ---------------------------------------------------------------------------

export interface ConfigOptionValue {
  value: string;
  name: string;
  description?: string;
}

export interface ConfigOption {
  id: string;
  name: string;
  /** 'model' | 'mode' | 'thought_level' | agent-defined */
  category?: string;
  type: 'select' | 'boolean' | string;
  currentValue?: string | boolean;
  options?: ConfigOptionValue[];
  description?: string;
}

export interface SessionNewParams {
  cwd: string;
  mcpServers?: McpServer[];
}

export interface SessionNewResult {
  sessionId: string;
  configOptions?: ConfigOption[];
  models?: unknown;
}

export interface SetConfigOptionParams {
  sessionId: string;
  configId: string;
  value: string | boolean;
}

export interface SetConfigOptionResult {
  configOptions?: ConfigOption[];
}

// ---------------------------------------------------------------------------
// prompt
// ---------------------------------------------------------------------------

export interface PromptParams {
  sessionId: string;
  prompt: ContentBlock[];
}

export type StopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled';

export interface PromptResult {
  stopReason: StopReason;
  usage?: unknown;
}

// ---------------------------------------------------------------------------
// session/update notifications
// ---------------------------------------------------------------------------

/** A file modification shown as a diff. `oldText` is omitted or null for a new file. */
export interface ToolCallDiff {
  type: 'diff';
  /** Absolute path of the file being modified. */
  path: string;
  oldText?: string | null;
  newText: string;
}

/** A regular content block produced by a tool (text, image, resource). */
export interface ToolCallContentBlock {
  type: 'content';
  content: ContentBlock;
}

/** A terminal created with `terminal/create`, embedded by id. */
export interface ToolCallTerminal {
  type: 'terminal';
  terminalId: string;
}

export type ToolCallContent =
  | ToolCallDiff
  | ToolCallContentBlock
  | ToolCallTerminal
  | { type: string; [key: string]: unknown };

export function isToolCallDiff(value: unknown): value is ToolCallDiff {
  const v = value as Partial<ToolCallDiff> | null;
  return (
    !!v &&
    v.type === 'diff' &&
    typeof v.path === 'string' &&
    v.path.length > 0 &&
    typeof v.newText === 'string' &&
    (v.oldText === undefined || v.oldText === null || typeof v.oldText === 'string')
  );
}

export interface ToolCallInfo {
  toolCallId: string;
  title?: string;
  kind?: string;
  status?: 'pending' | 'in_progress' | 'completed' | 'failed' | string;
  content?: ToolCallContent[];
  locations?: Array<{ path: string; line?: number }>;
  rawInput?: unknown;
  rawOutput?: unknown;
}

export interface PlanEntry {
  content: string;
  priority?: string;
  status?: 'pending' | 'in_progress' | 'completed' | string;
}

export type SessionUpdate =
  | { sessionUpdate: 'user_message_chunk'; content: ContentBlock }
  | { sessionUpdate: 'agent_message_chunk'; content: ContentBlock }
  | { sessionUpdate: 'agent_thought_chunk'; content: ContentBlock }
  | { sessionUpdate: 'tool_call'; toolCallId: string; [key: string]: unknown }
  | { sessionUpdate: 'tool_call_update'; toolCallId: string; [key: string]: unknown }
  | { sessionUpdate: 'plan'; entries: PlanEntry[] }
  | { sessionUpdate: 'available_commands_update'; availableCommands: unknown[] }
  | { sessionUpdate: string; [key: string]: unknown };

export interface SessionUpdateParams {
  sessionId: string;
  update: SessionUpdate;
}

// ---------------------------------------------------------------------------
// permission
// ---------------------------------------------------------------------------

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' | string;
}

export interface RequestPermissionParams {
  sessionId: string;
  toolCall: ToolCallInfo;
  options: PermissionOption[];
}

export type PermissionOutcome =
  | { outcome: 'selected'; optionId: string }
  | { outcome: 'cancelled' };

export interface RequestPermissionResult {
  outcome: PermissionOutcome;
}

// ---------------------------------------------------------------------------
// filesystem (agent -> client)
// ---------------------------------------------------------------------------

export interface ReadTextFileParams {
  sessionId: string;
  path: string;
  line?: number;
  limit?: number;
}

export interface ReadTextFileResult {
  content: string;
}

export interface WriteTextFileParams {
  sessionId: string;
  path: string;
  content: string;
}
