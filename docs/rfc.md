# RFC：Cursor 远程控制 Server + Web Client 架构

## 决策

把当前 prototype 从阻塞式 run launcher 演进成 Cursor-only remote-control server + web client。

技术栈继续使用 Node + Express + TypeScript，因为 `@cursor/sdk` 是 TypeScript-first。前端继续使用 React + Vite。核心架构变化是产品模型：`Session -> Run -> Event`。SSE 负责实时更新，append-only event log 作为 replay 和 UI projection 的事实来源。测试设计和产品模型一起推进：每个核心接口都要有 deterministic mock 测试和可选 live Cursor 验证路径。

系统应该借鉴 OpenCode 的 server/client 分层，但不做 OpenCode API 兼容，也不做 provider connector 平台。OpenCode 暴露的是完整 coding-agent runtime：sessions、message parts、files、diffs、permissions、TUI control、providers 和 global events。Cursor 已经有自己的 runtime primitives：`Agent`、`Run`、`SDKMessage`、local execution、stream events 和 `Agent.resume()`。这个 app 要做的是把 Cursor primitives 翻译成一套面向 web client 的小协议。

## 架构

```text
Browser React app
  ├── REST: sessions, messages, runs, health
  └── SSE: live run events and replay

Node/Express server
  ├── config: .env only for Cursor key, host, port, local cwd, model
  ├── SessionService: user-visible conversation state
  ├── RunService: async Cursor run lifecycle
  ├── CursorAgentGateway: @cursor/sdk adapter
  ├── EventStore: append-only events with monotonic ids
  ├── EventBroker: SSE fan-out and replay
  ├── DiffService: local git baseline and diff summary
  └── TestHarness: mock gateway, SSE client, live sandbox

@cursor/sdk
  ├── Agent.create({ local: { cwd } })
  ├── agent.send(prompt)
  ├── run.stream() / onDelta
  ├── run.wait()
  ├── run.cancel() where available
  └── Agent.resume(agentId) after live validation
```

Frontend 永远不直接调用 Cursor。Backend 持有 API key、SDK lifecycle、本地文件系统访问和 stream conversion。Frontend 只渲染 server state projection。

网络边界交给 Tailscale。Stage 1 默认监听 `HOST=0.0.0.0`、`PORT=8787`，让同一 LAN 或 tailnet 内设备可以访问；纯本机调试时可以改成 `HOST=127.0.0.1`。设备身份、ACL 和访问控制由 tailnet 处理。应用层不实现 shared secret、bearer token、OAuth 或多用户权限。应用代码只负责两件安全事项：Cursor API key 不出 server；UI 明确展示当前 cwd、runtime、run 状态和 prompt，降低远程误操作概率。

## 核心模型

### Session

`Session` 是产品层的长期对话，也是用户在 sidebar 里看到的对象。

```ts
interface Session {
  id: string;
  title: string;
  runtime: 'mock' | 'local';
  status: 'idle' | 'running' | 'failed';
  cwd?: string;
  modelId: string;
  cursorAgentId?: string;
  latestRunId?: string;
  createdAt: string;
  updatedAt: string;
}
```

Stage 1 限制每个 session 同时只有一个 active run。同一个 session 里的 follow-up prompt 应尽量复用同一个 Cursor agent。如果 live validation 证明跨进程恢复需要 `Agent.resume()`，则持久化 `cursorAgentId`，并通过 gateway 重新 hydrate。

### Run

`Run` 是一次提交给 Cursor 的 prompt 执行。

```ts
interface Run {
  id: string;
  sessionId: string;
  cursorRunId?: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  prompt: string;
  runtime: 'mock' | 'local';
  modelId: string;
  startedAt?: string;
  completedAt?: string;
  resultText?: string;
  error?: string;
  diffSummary?: DiffSummary;
}

interface DiffSummary {
  baselineRef?: string;
  changedFiles: string[];
  insertions?: number;
  deletions?: number;
  summaryText?: string;
}
```

### Message

`Message` 是 UI projection，不是底层 storage primitive。User prompt 投影成 user message。Cursor assistant text 和 final result 投影成 assistant message。Tool 和 thinking event 先保留在 activity timeline 里，除非后续证据表明 Cursor 返回了稳定的 message-part 结构，才考虑把它们提升为 message part。

```ts
interface Message {
  id: string;
  sessionId: string;
  runId?: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  status: 'streaming' | 'completed' | 'failed';
  createdAt: string;
  updatedAt: string;
}
```

### Event

`Event` 是 live UI 和 replay 的 durable truth。每个 event 都有单调递增 id。SSE endpoint 应支持 `Last-Event-ID`：先 replay 所有更大的已存 events，再 tail live events。

```ts
type AppEventType =
  | 'session.created'
  | 'session.updated'
  | 'run.status'
  | 'assistant.delta'
  | 'thinking.delta'
  | 'thinking.completed'
  | 'tool.started'
  | 'tool.delta'
  | 'tool.completed'
  | 'tool.error'
  | 'task.updated'
  | 'file.changed'
  | 'diff.snapshot'
  | 'run.result'
  | 'run.error'
  | 'heartbeat';

interface AppEvent {
  id: number;
  sessionId: string;
  runId?: string;
  type: AppEventType;
  cursorEventType?: string;
  cursorEventId?: string;
  payload: unknown;
  createdAt: string;
}
```

## API surface

Stage 1 API 应该小而明确，并且是 app-specific。

### Health

```txt
GET /api/health
```

返回 runtime、host、port、是否配置 key、local cwd 状态、store 状态和是否处于 mock mode。绝不能返回 secret。

### Sessions

```txt
GET  /api/sessions
POST /api/sessions
GET  /api/sessions/:sessionId
PATCH /api/sessions/:sessionId
DELETE /api/sessions/:sessionId
```

`POST /api/sessions` 可接受可选 title。Runtime、cwd 和 default model 默认来自 `.env`，除非开发调试时显式覆盖。Stage 1 默认 cwd 是这个 repo 根目录：`/Users/grapeot/co/knowledge_working/adhoc_jobs/cursor_cloud_remote_poc`，用于自举式开发；live tests 的 cwd 永远是测试创建的临时 sandbox。

### Messages

```txt
GET /api/sessions/:sessionId/messages?limit=50&before=<cursor>
```

Messages 来自 user prompt、assistant deltas 和 final run results 的 projection。Stage 1 pagination 可以简单，但 API 不应该强迫 client 永远加载全部历史。

### Runs

```txt
POST /api/sessions/:sessionId/runs
GET  /api/runs/:runId
POST /api/runs/:runId/cancel
```

`cancel` 是 Stage 2 可选 endpoint。只有 Cursor SDK 对 active run cancellation 暴露可靠语义时才启用；Stage 1 可以先不暴露，或返回 `501 not implemented`。

`POST /api/sessions/:sessionId/runs` 必须立即返回：

```json
{
  "run": { "id": "...", "status": "queued" },
  "eventsUrl": "/api/runs/.../events"
}
```

这个 route 不能在返回前调用 `run.wait()`。它只创建 run record，存储 user message，启动后台执行，然后返回。

### Events

```txt
GET /api/runs/:runId/events
GET /api/sessions/:sessionId/events
```

第一版只需要 `/api/runs/:runId/events`。等一个 session 可以有多个 run，或者 client 想对选中 session 只开一个订阅，再加入 `/api/sessions/:sessionId/events`。

SSE response 规则：

- `Content-Type: text/event-stream`
- 每个 event 带 `id: <monotonic id>`
- server 每 10 秒发送 heartbeat event
- 如果请求带 `Last-Event-ID`，先 replay 已存储且 id 更大的 events，再 tail live events

## Cursor stream 映射

`@cursor/sdk` 暴露两层有用的 stream：

1. `run.stream()` 产出 `SDKMessage` events，例如 `assistant`、`thinking`、`tool_call`、`status`、`task`、`request`。
2. `agent.send(..., { onDelta, onStep })` 可以暴露更细粒度的 updates，例如 `text-delta`、`thinking-delta`、`tool-call-started`、`tool-call-completed`、`shell-output-delta` 和 token usage。

Stage 1 先使用 `run.stream()`，因为 event envelope 有文档且足够简单。如果文本更新粒度太粗，再用 `onDelta` 生成 `assistant.delta` 和 `thinking.delta`。

推荐映射：

| Cursor event | App event | UI 用途 |
|---|---|---|
| `status` | `run.status` | status pill / activity row |
| `assistant` text block | `assistant.delta` 或 assistant message update | chat text |
| `thinking` | `thinking.delta` / `thinking.completed` | 可折叠 activity/reasoning 区域 |
| `tool_call` running | `tool.started` | tool card 展开 |
| `tool_call` completed | `tool.completed` | tool card 收起或完成态 |
| `tool_call` error | `tool.error` | tool card error state |
| `task` | `task.updated` | 高层 activity row |
| run final result | `run.result` | final assistant message + run summary |

不要把 Cursor tool `args` / `result` payload 当作稳定 schema。稳定的是 `type`、`call_id`、`name` 和 `status` 这层 envelope；细节 payload 只做 best-effort 展示。

## 持久化

Stage 1 如果优先实现速度，可以先用 JSONL，而不是立刻引入 SQLite：

```txt
data/
  sessions.jsonl
  runs.jsonl
  events/<sessionId>.jsonl
```

每次 mutation append 一个 event。启动时 replay JSONL 重建内存 index。这样可以在最终查询需求明确前避免数据库复杂度。等 session search、pagination 或 restart resume 变复杂，再迁移到 SQLite：`sessions`、`runs`、`messages`、`events` 四张表。

当前 `RunStore` map 应拆成两层：

- `EventStore`：append、replay、按 session/run list。
- `ProjectionStore`：从 events 重建当前 session/run/message summaries。

## Local runtime 行为

Local 是目标产品路径。Backend 跑在用户 Mac 或 LA 机器上，并把 Cursor SDK 指向 `CURSOR_LOCAL_CWD`。默认 `CURSOR_LOCAL_CWD` 指向本项目 repo 根目录，这样产品成熟后可以用 Cursor remote-control 来修改自己；测试路径必须和产品 cwd 分离。

Diff/result review 应走本地 git。run 开始前记录 baseline git status 或 diff marker。run 完成后计算 changed files 和 diff summary。这个能力应该和 Cursor SDK streaming 分开，即使 Cursor 不返回 file metadata，也能工作。

Stage 1 的 diff 能力可以保持小而确定：run 开始前记录当前 `HEAD` 和 `git status --porcelain`；run 结束后用 `git diff --stat`、`git diff --name-only` 和必要的短 diff 生成 `diff.snapshot`。如果 cwd 不是 git repo，系统发出 `diff.unavailable` 类型的 activity，而不是让 Cursor run 失败。

## Auth 与暴露边界

Stage 1/2 都不做应用层 token auth。目标部署方式是 Tailscale：server 监听在 localhost、LAN IP 或 Tailscale IP，只有 tailnet 内设备可以访问。这样做的好处是边界清楚：网络身份、设备授权和 ACL 由 Tailscale 管；应用代码专注 Cursor session lifecycle。

这条决策也影响测试：默认测试不需要 auth fixture，不需要 bearer token middleware，不需要权限矩阵。安全测试集中在两件事：第一，`CURSOR_API_KEY` 不进入 HTTP response、SSE payload、frontend bundle 或 logs；第二，API request validation 能阻止客户端覆盖 server 端 cwd 和 secret 配置。

## 前端架构

随着 API 演进，把当前单文件 `main.tsx` 拆成产品组件：

```text
SessionSidebar
SessionView
MessageTimeline
PromptComposer
ActivityPanel
ToolCallCard
ThinkingBlock
RunStatusBadge
DiffSummary
```

第一版 UI 应该是三栏：

1. Session list。
2. Chat/message timeline。
3. Activity/result panel，展示 thinking、tool calls、status、diff/PR links。

OpenCode iOS client 是有价值的交互参考：running tool card 默认展开，完成后收起；thinking 和普通 assistant output 视觉上分开；status text 来自最新 activity，而不只是最终 run state。

## Evaluation architecture

可测试性要进入接口设计，而不是事后补测试。核心服务必须通过 dependency injection 接收 Cursor gateway、EventStore、Clock、IdGenerator、SandboxCwd 和 DiffProvider。这样同一套 RunService 可以跑三种模式：deterministic mock、recorded event replay、真实 Cursor local sandbox。

默认 `npm test` 跑 deterministic suite，不访问 Cursor API。它验证 app logic：config、request validation、EventStore、ProjectionStore、Cursor stream mapper、EventBroker/SSE、API routes、DiffService、frontend projection 和 mock gateway event sequence。这里的成功判据是纯客观的：event id 单调、projection 一致、SSE replay 不丢事件、HTTP error code 稳定、secret 不出现在 response 或 event payload。

Live Cursor suite 通过 `RUN_CURSOR_LIVE_TESTS=1` 显式开启，模型固定 `composer-2`。测试创建一次性 local sandbox cwd，并写入 `.cursor/sandbox.json`。Live smoke 不做长任务，只验证 API 是否真的可用：`Cursor.me()` 成功，`composer-2` 可用，`run.stream()` 产生 assistant/tool/status event，Cursor 能在 sandbox 写入 `hello.txt` 或修改 `hello.py`，app SSE 能转发这些 event，run 结束后 DiffService 能看到 changed files。

Live suite 的失败输出要服务 agent 自我诊断。测试摘要应能区分 failure layer：token/account、model availability、SDK schema mismatch、stream timeout、SSE broker、diff baseline、projection。这样 agent 可以判断下一步是修本地代码、更新 fixture，还是标记 Cursor API 当前不可用。

Stage 1 测试矩阵：

| 层级 | 默认运行 | 覆盖内容 |
|---|---|---|
| Unit | 是 | config、contracts、event store、projection、stream mapper、diff service |
| API integration | 是 | session CRUD、start run、messages、events、error paths、secret masking |
| SSE harness | 是 | live subscribe、heartbeat、disconnect cleanup、`Last-Event-ID` replay |
| Frontend projection | 是 | event fixtures 到 timeline/activity/status/diff state |
| Coverage | 手动/CI | remote-control core 主要分支，live tests 不计入 gate |
| Live Cursor | 否 | `RUN_CURSOR_LIVE_TESTS=1` 时用真实 token、composer-2 和 sandbox cwd 验证 SDK |

## 已知风险

- Cursor SDK 仍是 public beta，API 可能变化。
- `tool_call.args` 和 `tool_call.result` 不是稳定 payload。
- `SDKRequestMessage` 表示等待用户输入或审批，但目前证据没有显示稳定的 SDK response method。Permission UX 应留到 Stage 2，等 live validation 证明闭环后再做。
- `Agent.resume()` 恢复的是 agent，不一定是被中断的 run。App-level event replay 仍然必须实现。
- Local runtime 没有 cloud artifacts；local diff review 必须依赖本地 git integration。
- Tailscale 认证简化了应用代码，但 tailnet 内设备默认可信。UI 需要降低误操作概率，特别是清楚展示 cwd 和 active run。

## 从当前 POC 迁移

当前 POC 标记为 deprecated reference。它证明了 SDK 能被后端调用，但它的同步 route、单 run store 和单页面 launcher 都不是后续产品架构。

迁移顺序：

1. 新增 `EventStore`、`ProjectionStore`、`SessionService` 和 `RunService`，先用 mock gateway 跑通全链路测试。
2. 保留 `CursorAgentGateway` 的 SDK 适配代码，但把它从 `startRun(): Promise<RunSummary>` 改成会 emit app events 的异步 lifecycle API。
3. 用 `POST /api/sessions/:sessionId/runs` 替换 `POST /api/runs`，旧 route 可以短期保留但标记 deprecated。
4. 增加 SSE event endpoints 和 event broker，并为 replay / reconnect 写测试。
5. 增加 `DiffService`，让 local Cursor run 完成后独立生成 changed files 和 diff summary。
6. 把 frontend 从 run launcher 重构成 session sidebar + timeline + activity panel，同时把 event projection 抽出单测。
7. 保留 mock mode，但让它产出和真实 Cursor mode 相同形状的 event sequence。
