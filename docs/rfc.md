# RFC：Cursor 远程控制 Server + Web Client 架构

## 决策

把当前 prototype 从阻塞式 run launcher 演进成 Cursor remote-control server + web client。

技术栈继续使用 Node + Express + TypeScript，因为 `@cursor/sdk` 是 TypeScript-first。前端继续使用 React + Vite。核心架构变化是产品模型：`Session -> Run -> Event`。SSE 负责实时更新，append-only event log 作为 replay 和 UI projection 的事实来源。

系统应该借鉴 OpenCode 的 server/client 分层，但不做 OpenCode API 兼容。OpenCode 暴露的是完整 coding-agent runtime：sessions、message parts、files、diffs、permissions、TUI control、providers 和 global events。Cursor 已经有自己的 runtime primitives：`Agent`、`Run`、`SDKMessage`、local/cloud execution、stream events 和 `Agent.resume()`。这个 app 要做的是把 Cursor primitives 翻译成一套面向 web client 的小协议。

## 架构

```text
Browser React app
  ├── REST: sessions, messages, runs, health
  └── SSE: live run events and replay

Node/Express server
  ├── config: .env only for Cursor key, runtime, cwd, model
  ├── SessionService: user-visible conversation state
  ├── RunService: async Cursor run lifecycle
  ├── CursorAgentGateway: @cursor/sdk adapter
  ├── EventStore: append-only events with monotonic ids
  └── EventBroker: SSE fan-out and replay

@cursor/sdk
  ├── Agent.create({ local: { cwd } }) or cloud repos
  ├── agent.send(prompt)
  ├── run.stream() / onDelta
  ├── run.wait()
  ├── run.cancel() where available
  └── Agent.resume(agentId) after live validation
```

Frontend 永远不直接调用 Cursor。Backend 持有 API key、SDK lifecycle、本地文件系统访问和 stream conversion。Frontend 只渲染 server state projection。

## 核心模型

### Session

`Session` 是产品层的长期对话，也是用户在 sidebar 里看到的对象。

```ts
interface Session {
  id: string;
  title: string;
  runtime: 'mock' | 'local' | 'cloud';
  status: 'idle' | 'running' | 'failed';
  cwd?: string;
  repoUrl?: string;
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
  runtime: 'mock' | 'local' | 'cloud';
  modelId: string;
  startedAt?: string;
  completedAt?: string;
  resultText?: string;
  error?: string;
  prUrl?: string;
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

返回 runtime、是否配置 key、local cwd 状态和 store 状态。绝不能返回 secret。

### Sessions

```txt
GET  /api/sessions
POST /api/sessions
GET  /api/sessions/:sessionId
PATCH /api/sessions/:sessionId
DELETE /api/sessions/:sessionId
```

`POST /api/sessions` 可接受可选 title。Runtime、cwd、repo 和 default model 默认来自 `.env`，除非开发调试时显式覆盖。

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

## Local 与 cloud runtime 行为

### Local runtime

Local 是目标产品路径。Backend 跑在用户 Mac 上，并把 Cursor SDK 指向 `CURSOR_LOCAL_CWD`。

Diff/result review 应走本地 git。run 开始前记录 baseline git status 或 diff marker。run 完成后计算 changed files 和 diff summary。这个能力应该和 Cursor SDK streaming 分开，即使 Cursor 不返回 file metadata，也能工作。

### Cloud runtime

Cloud 适合做对照和 PR automation。如果 Cursor 返回 `runResult.git.branches[].prUrl`，run summary 应展示它。Cloud artifacts 和 PR links 是 Stage 1.5 的可选 UI。

## Auth 与暴露边界

Stage 1 可以保持 localhost / LAN-only。在建议公网访问前，增加一个最小 bearer-token middleware：

```env
CURSOR_REMOTE_TOKEN=...
```

当该 env var 存在时，除 health 以外的 routes 都要求 `Authorization: Bearer <token>`。这对个人 tunnel 已经够用。OAuth、多用户 auth 和 team permissions 都不在第一阶段范围内。

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

## 已知风险

- Cursor SDK 仍是 public beta，API 可能变化。
- `tool_call.args` 和 `tool_call.result` 不是稳定 payload。
- `SDKRequestMessage` 表示等待用户输入或审批，但目前证据没有显示稳定的 SDK response method。Permission UX 应留到 Stage 2，等 live validation 证明闭环后再做。
- `Agent.resume()` 恢复的是 agent，不一定是被中断的 run。App-level event replay 仍然必须实现。
- Local runtime 没有 cloud artifacts；local diff review 需要 git integration。

## 从当前 POC 迁移

1. 保留 `CursorAgentGateway`，但把它从 `startRun(): Promise<RunSummary>` 改成会 emit app events 的异步 lifecycle API。
2. 用 event-backed session/run storage 替换 `RunStore`。
3. 用 `POST /api/sessions/:sessionId/runs` 替换 `POST /api/runs`。
4. 增加 SSE event endpoints 和小型 event broker。
5. 把 frontend 从 run launcher 重构成 session sidebar + timeline + activity panel。
6. 保留 mock mode，但让它产出和真实 Cursor mode 相同形状的 event sequence。
