# acp-editor

An [Agent Client Protocol](https://agentclientprotocol.com) client that lives inside your
editor.

`acp-editor` is a local **hub** that speaks ACP to coding agents, plus a **panel** that gives
you chat, model selection, permission prompts and diff review without leaving the tool you
work in. The panel runs as a web page in any browser and as an Unreal Engine 5 editor plugin.

## Features

- **Any ACP agent.** Claude Code, Codex, opencode, Copilot, Gemini, Cursor, Kimi, dsh — the hub
  discovers what the machine has and reports the resolved path and version.
- **Sessions as resources.** Create, stream, resume, cancel and list history; many sessions per
  agent, exactly one owner per session.
- **Models and modes** come from the agent's own ACP config options, never from a hard-coded
  list.
- **Reviewable edits.** File writes are tracked per turn and shown as diffs you can keep or
  revert.
- **Permission prompts** for tool calls: allow once, always, or reject.
- **Editor context.** When the open project exposes an MCP server (for example Unreal's
  `ModelContextProtocol` plugin), the hub attaches it to the session; a small `ue-mcp` command
  covers agents that cannot mount MCP themselves.

## Requirements

- Node.js 20.11 or newer, pnpm 11
- At least one ACP-capable agent on `PATH`, or pinned in `~/.acp-editor/agents.json`

## Quick start

```bash
pnpm install
pnpm build
pnpm start -- --cwd /path/to/your/project
```

The hub listens on `http://127.0.0.1:7878` and serves the panel there.

```bash
curl http://127.0.0.1:7878/agents     # installed agents, versions and capabilities
curl http://127.0.0.1:7878/sessions    # live sessions
```

| option | meaning |
|---|---|
| `-p, --port <n>` | listen port (default 7878, `0` = random) |
| `--host <addr>` | bind address (default `127.0.0.1`) |
| `--cwd <path>` | default working directory for sessions |
| `--permission <mode>` | `ask` (default), `deny`, `allow` |
| `--token <secret>` | require `Authorization: Bearer <secret>` on every request |
| `--agents <path>` | extra agents file, merged over the built-in list |
| `--data-dir <path>` | where transcripts are stored (default `~/.acp-editor/sessions`) |

### Unreal Engine

Copy `hosts/unreal/AcpEditor` into `<Project>/Plugins/`, enable the **AcpEditor** plugin, then
open the ACP panel from the editor toolbar. Details and plugin settings:
[hosts/unreal/AcpEditor/README.md](hosts/unreal/AcpEditor/README.md).

## Agents

`GET /agents` lists every definition with `available`, `resolvedPath`, `version`,
`candidates`, `capabilities` and `warnings`. Resolution is deliberate:

1. `ACP_<ID>_BIN` (for example `ACP_DSH_BIN`) — an explicit pin, used alone
2. an absolute `bin` in `~/.acp-editor/agents.json`
3. `searchPaths` from the same file
4. every directory on `PATH`
5. known install directories (`%APPDATA%\npm`, pnpm, Volta, WinGet, Chocolatey,
   `C:\Program Files\nodejs`, `/usr/local/bin`, `~/.local/bin`, …)

Every candidate is version-probed; the winner satisfies the most declared features, then has
the highest version — never simply the first match on `PATH`. A user entry *patches* the
built-in of the same id, so pinning is two lines:

```json
{ "agents": [ { "id": "dsh", "bin": "D:/path/to/cli.js" } ] }
```

`bin` may be an absolute `.js` entry (run with the hub's node), a `.cmd` shim, or a bare name.
Two kinds of requirement can be declared per agent: `minVersion` is a hard floor (below it the
agent is reported unavailable, with the versions that were found), while
`features: { mcp: '>=0.2.2-rc.1' }` is soft — the agent keeps working, the capability is
switched off and `warnings` says why.

## Editor tools (MCP)

MCP servers are discovered per project (`.mcp.json`, plus Unreal's default
`http://127.0.0.1:8000/mcp` when a `.uproject` is present) and offered to the agent in
`session/new`. If an agent rejects them the hub retries without MCP and reports `mcpWarning`,
so a session never fails because of an optional capability.

For agents that cannot mount MCP, the hub also generates a helper command:

```bash
ue-mcp context                     # open assets, selection, content-browser path, PIE, camera
ue-mcp toolsets                    # what the editor exposes
ue-mcp tools <toolset>             # tool names and required arguments
ue-mcp call <toolset> <tool> '{…}' # call one tool
```

`ue-mcp` speaks the editor's MCP endpoint directly, so it works with any agent that has a
shell. Agents that accept a profile overlay (dsh, via `--patch`) are also told about it in
their system prompt, which is what makes the capability available without per-conversation
setup.

## HTTP API

| method | path | purpose |
|---|---|---|
| GET | `/health` | liveness, version, live session count |
| GET | `/agents`, `/agents/:id` | installed agents and their resolution |
| POST | `/sessions` | create or resume `{agentId, cwd, resumeSessionId?, permissionMode?}` |
| GET | `/sessions` | live sessions |
| GET | `/sessions/:id/stream` | SSE: `ready`, `update`, `permission`, `turn_start`, `turn_end`, `turn_error`, `agent_exit` |
| POST | `/sessions/:id/prompt` | send `{text}` |
| POST | `/sessions/:id/cancel` | cancel the current turn |
| POST | `/sessions/:id/config` | set a model or mode, from the agent's config options |
| POST | `/sessions/:id/permission` | answer a permission request |
| GET | `/sessions/:id/changes` | file edits tracked for this session |
| POST | `/sessions/:id/changes/:toolCallId/:action` | `keep` or `revert` an edit |
| GET | `/sessions/:id/transcript` | stored events for a session (used when resuming) |
| DELETE | `/sessions/:id` | end the session and its agent process |
| POST | `/sessions/close-orphans` | close sessions left by a previous panel instance |
| GET | `/history` | past sessions |

## Security

The hub binds to `127.0.0.1` and has no user accounts: it is a local tool, not a server. Any
process on the machine can talk to it unless you pass `--token`, which adds
`Authorization: Bearer <secret>` to every route except `/health`. Agents it starts run with
your privileges and can edit the files under `--cwd`. Do not bind it to a public interface.

## Layout

```
packages/hub/     hub: HTTP + SSE, ACP client, agent registry, edit tracking, MCP bridge
packages/web/     the panel (single HTML file; also copied into the Unreal plugin)
hosts/unreal/     Unreal Engine 5 editor plugin
scripts/          smoke test, mock demo, panel sync, ue-mcp CLI
```

## License

Apache-2.0
