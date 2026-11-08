# acp-editor

**中文** | [English](README.en.md)

一个直接跑在编辑器里的 [Agent Client Protocol](https://agentclientprotocol.com) 客户端。

`acp-editor` 由两部分组成：本机的 **hub** 用 ACP 跟各类编码 agent 通信，**面板**把聊天、模型选择、
权限确认、改动审阅放到你原本工作的地方。面板既能当普通网页在浏览器里开，也能作为 Unreal Engine 5
编辑器插件内嵌。

## 功能

- **支持任何 ACP agent**：Claude Code、Codex、opencode、Copilot、Gemini、Cursor、Kimi、dsh——hub
  自动发现机器上装了哪些，并报告解析到的路径与版本。
- **会话即资源**：新建、流式输出、恢复、取消、查看历史；同一 agent 可开多个会话，每个会话只有一个归属者。
- **模型与模式**来自 agent 自己通过 ACP 上报的配置项，不是写死的列表。
- **改动可审阅**：每轮 agent 修改的文件按次记录，以 diff 形式展示，可逐条保留或还原。
- **权限确认**：工具调用前弹窗，支持"允许一次 / 总是允许 / 拒绝"。
- **编辑器上下文**：当打开的项目暴露 MCP（例如 Unreal 的 `ModelContextProtocol` 插件）时，hub 会把
  它挂到会话上；对于无法自己挂载 MCP 的 agent，另提供 `ue-mcp` 命令读取编辑器状态。

## 环境要求

- Node.js 20.11 及以上，pnpm 11
- 至少一个 ACP agent 在 `PATH` 上，或在 `~/.acp-editor/agents.json` 里指定

## 快速开始

```bash
pnpm install
pnpm build
pnpm start -- --cwd /path/to/your/project
```

hub 默认监听 `http://127.0.0.1:7878`，面板也由它提供。

```bash
curl http://127.0.0.1:7878/agents     # 已安装的 agent、版本与能力
curl http://127.0.0.1:7878/sessions    # 当前会话
```

| 参数 | 说明 |
|---|---|
| `-p, --port <n>` | 监听端口（默认 7878，`0` 表示随机） |
| `--host <addr>` | 绑定地址（默认 `127.0.0.1`） |
| `--cwd <path>` | 会话默认工作目录 |
| `--permission <mode>` | `ask`（默认）、`deny`、`allow` |
| `--token <secret>` | 除 `/health` 外，所有请求都要求 `Authorization: Bearer <secret>` |
| `--agents <path>` | 额外的 agent 定义文件，覆盖/补充内置列表 |
| `--data-dir <path>` | 会话记录存放目录（默认 `~/.acp-editor/sessions`） |

### Unreal Engine

把 `hosts/unreal/AcpEditor` 复制到 `<项目>/Plugins/`，启用 **AcpEditor** 插件，然后从编辑器工具栏
打开 ACP 面板。插件设置与说明见
[hosts/unreal/AcpEditor/README.md](hosts/unreal/AcpEditor/README.md)。

## Agent 解析

`GET /agents` 会返回每个 agent 的 `available`、`resolvedPath`、`version`、`candidates`、
`capabilities` 和 `warnings`。解析顺序是明确的：

1. `ACP_<ID>_BIN`（例如 `ACP_DSH_BIN`）——显式指定，只认它
2. `~/.acp-editor/agents.json` 里的绝对 `bin`
3. 同一文件里的 `searchPaths`
4. `PATH` 上的每一个目录
5. 常见安装目录（`%APPDATA%\npm`、pnpm、Volta、WinGet、Chocolatey、`C:\Program Files\nodejs`、
   `/usr/local/bin`、`~/.local/bin` 等）

每个候选都会探测版本；胜出者是**满足声明特性最多、其次版本最高**的那个，而不是"PATH 上第一个命中的"。
`agents.json` 里的条目会**合并**同 id 的内置定义，所以指定路径只需要两行：

```json
{ "agents": [ { "id": "dsh", "bin": "D:/path/to/cli.js" } ] }
```

`bin` 可以是绝对 `.js` 入口（用 hub 自己的 node 运行）、`.cmd` 包装脚本，或一个裸命令名。
每个 agent 可以声明两类要求：`minVersion` 是**硬门槛**（不满足就报告为不可用，并列出找到的版本），
`features: { mcp: '>=0.2.2-rc.1' }` 是**软门槛**（agent 照常可用，只是关掉该能力并在 `warnings` 里说明）。

## 编辑器工具（MCP）

hub 会按项目发现 MCP server（`.mcp.json`，以及存在 `.uproject` 时 Unreal 默认的
`http://127.0.0.1:8000/mcp`），并在 `session/new` 时提供给 agent。如果 agent 拒绝，hub 会按无 MCP
重试并回传 `mcpWarning`——可选的增强能力不会导致会话创建失败。

对于无法自己挂载 MCP 的 agent，hub 还会生成一个辅助命令：

```bash
ue-mcp context                     # 打开的资产、选中项、内容浏览器路径、PIE、相机
ue-mcp toolsets                    # 编辑器暴露了哪些 toolset
ue-mcp tools <toolset>             # 工具名与所需参数
ue-mcp call <toolset> <tool> '{…}' # 调用某个工具
```

`ue-mcp` 直接跟编辑器的 MCP 端点通信，因此任何有 shell 的 agent 都能用。对于支持附加 profile
覆盖的 agent（dsh，通过 `--patch`），hub 还会把这条命令写进它的系统提示，让能力开箱可用，
不需要每次会话重新交代。

## HTTP API

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/health` | 存活状态、版本、活跃会话数 |
| GET | `/agents`、`/agents/:id` | agent 列表与其解析结果 |
| POST | `/sessions` | 新建或恢复 `{agentId, cwd, resumeSessionId?, permissionMode?}` |
| GET | `/sessions` | 当前活跃会话 |
| GET | `/sessions/:id/stream` | SSE：`ready`、`update`、`permission`、`turn_start`、`turn_end`、`turn_error`、`agent_exit` |
| POST | `/sessions/:id/prompt` | 发送 `{text}` |
| POST | `/sessions/:id/cancel` | 取消当前轮次 |
| POST | `/sessions/:id/config` | 切换模型或模式（取值来自 agent 的配置项） |
| POST | `/sessions/:id/permission` | 回应一次权限请求 |
| GET | `/sessions/:id/changes` | 本会话记录的文件的改动 |
| POST | `/sessions/:id/changes/:toolCallId/:action` | `keep` 或 `revert` 一条改动 |
| GET | `/sessions/:id/transcript` | 会话已存储的事件（恢复会话时使用） |
| DELETE | `/sessions/:id` | 结束会话并退出其 agent 进程 |
| POST | `/sessions/close-orphans` | 关闭上一次面板实例遗留的会话 |
| GET | `/history` | 历史会话 |

## 安全

hub 默认绑定 `127.0.0.1`，没有账号体系：它是本机工具，不是服务器。除 `/health` 外，加 `--token`
后所有请求都要求 `Authorization: Bearer <secret>`；不加时，本机任何进程都能访问。它启动的 agent
以你的权限运行，可以修改 `--cwd` 下的文件。不要把端口暴露到公网。

## 目录结构

```
packages/hub/     hub：HTTP + SSE、ACP 客户端、agent 注册表、改动追踪、MCP 桥
packages/web/     面板（单文件 HTML，同时复制进 Unreal 插件）
hosts/unreal/     Unreal Engine 5 编辑器插件
scripts/          smoke 测试、mock 演示、面板同步、ue-mcp CLI
```

## 许可

Apache-2.0
