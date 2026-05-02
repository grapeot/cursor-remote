# RFC：Cursor 远程控制 Server + Web Client 架构

## 决策

把当前 prototype 从阻塞式 run launcher / event monitor 演进成 Cursor-only remote-control server + OpenCode-like web coding client。

技术栈继续使用 Node + Express + TypeScript，因为 `@cursor/sdk` 是 TypeScript-first。前端继续使用 React + Vite。核心架构变化是产品模型：`Session -> Run -> Event`。SSE 负责实时更新，append-only event log 作为 replay 和 UI projection 的事实来源。测试设计和产品模型一起推进：每个核心接口都要有 deterministic mock 测试和可选 live Cursor 验证路径。

系统应该借鉴 OpenCode 的 server/client 分层和 client 体验，但不做 OpenCode API 兼容，也不做 provider connector 平台。OpenCode 暴露的是完整 coding-agent runtime：sessions、message parts、tool calls、files、diffs、permissions、TUI control、providers 和 global events。Cursor 已经有自己的 runtime primitives：`Agent`、`Run`、`SDKMessage`、local execution、stream events 和 `Agent.resume()`。这个 app 要做的是把 Cursor primitives 翻译成一套面向 web coding client 的小协议，并把 agent 工作渲染成 chat timeline，而不是把 raw SSE events 展示给用户。

## 架构

```text
Browser React app
  ├── Conversation sidebar: sessions and run state
  ├── Chat timeline: user, assistant, thinking, tool cards, status
  ├── Prompt composer: sends follow-up prompts to active session
  ├── REST: sessions, messages, runs, health
  └── SSE: live run events and replay, rendered as timeline parts

Node/Express server
  ├── config: .env only for Cursor key, host, port, local cwd, model
  ├── SessionService: user-visible conversation state
  ├── RunService: async Cursor run lifecycle
  ├── CursorAgentGateway: @cursor/sdk adapter
  ├── EventStore: append-only events with monotonic ids
  ├── EventBroker: SSE fan-out and replay
  ├── CursorStreamMapper: Cursor SDK messages to app events
  └── TestHarness: mock gateway, SSE client, live sandbox cwd

@cursor/sdk
  ├── Agent.create({ local: { cwd } })
  ├── agent.send(prompt)
  ├── run.stream() / onDelta
  ├── run.wait()
  ├── run.cancel() where available
  └── Agent.resume(agentId) after live validation
```

Frontend 永远不直接调用 Cursor。Backend 持有 API key、SDK lifecycle、本地文件系统访问和 stream conversion。Frontend 只渲染 server state projection。默认用户界面应该是 conversation/chat，不是 SDK benchmark，也不是 SSE debug console。

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
}
```

### Message

`Message` 是 UI projection，不是底层 storage primitive。User prompt 投影成 user message。Cursor assistant text 和 final result 投影成 assistant message。Tool、thinking、task/status event 在前端渲染成 timeline parts：thinking block、tool card、status row。不要把 raw event id / raw event type 作为默认 UI。

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

`POST /api/sessions` 可接受可选 title。Runtime、cwd 和 default model 默认来自 `.env`，除非开发调试时显式覆盖。Stage 1 可将 `CURSOR_LOCAL_CWD=.`（或相对/绝对路径）指向本仓库根目录，用于自举式开发；live tests 的 cwd 永远是测试创建的临时 sandbox。

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

## CursorStreamMapper

`CursorStreamMapper` 是 SDK 边界的唯一翻译层。它接收 `run.stream()` 产出的 `SDKMessage`，加上 app run context，然后输出零个或多个 `RawCursorEvent`。Route、RunService 和前端都不直接理解 Cursor SDK 的 raw event shape。

```ts
interface CursorStreamContext {
  runId: string;
  prompt: string;
  runtime: 'mock' | 'local';
  modelId: string;
}

interface RawCursorEvent {
  type: AppEventType;
  payload: unknown;
  cursorEventType?: string;
  cursorEventId?: string;
}
```

`@cursor/sdk` 暴露两层有用的 stream：

1. `run.stream()` 产出 `SDKMessage` events，例如 `assistant`、`thinking`、`tool_call`、`status`、`task`、`request`。
2. `agent.send(..., { onDelta, onStep })` 可以暴露更细粒度的 updates，例如 `text-delta`、`thinking-delta`、`tool-call-started`、`tool-call-completed`、`shell-output-delta` 和 token usage。

Stage 1 使用 `run.stream()`，因为 event envelope 在 `@cursor/sdk@1.0.9` 类型里清楚：`system`、`user`、`assistant`、`tool_call`、`thinking`、`status`、`request`、`task`。如果后续文本更新粒度不够，再把 `agent.send(..., { onDelta })` 作为补充来源，但仍然通过同一个 mapper 输出 app events。

| Cursor `SDKMessage` | App event | Payload contract |
|---|---|---|
| `status: CREATING/RUNNING` | `run.status` | `{ runId, prompt, runtime, modelId, status: 'running' }` |
| `status: FINISHED` | `run.status` | same envelope with `status: 'completed'` |
| `status: ERROR/EXPIRED` | `run.status` | same envelope with `status: 'failed'` |
| `status: CANCELLED` | `run.status` | same envelope with `status: 'cancelled'` |
| `assistant.message.content[].type === 'text'` | `assistant.delta` | `{ text }` for each non-empty text block |
| `assistant.message.content[].type === 'tool_use'` | `tool.started` | `{ callId, name, status: 'running', args }` |
| `thinking` | `tool.started` + `tool.completed` (`name: 'thinking'`) | Gateway **`ThinkingCoalescer`** merges stream chunks, then emits one synthetic tool pair (可选 `args.thinkingDurationMs`)；不向 SSE 逐个 chunk 推送 `thinking.delta`。 |
| `tool_call: running` | `tool.started` | `{ callId, name, status, args?, truncated? }` |
| `tool_call: completed` | `tool.completed` | `{ callId, name, status, result?, truncated? }` |
| `tool_call: error` | `tool.error` | `{ callId, name, status, result?, truncated? }` |
| `task` | `task.updated` | `{ status?, text? }` |
| `request` | `task.updated` | `{ requestId, status: 'request' }` until approval UX exists |
| `system` / `user` | no event by default | Already represented by session/run state or user message projection |
| unknown shape | `task.updated` | `{ status: 'unknown_cursor_event', rawType? }` for diagnostics |

Mapper rules:

- It must be a pure function. No I/O, no clock, no EventStore access.
- It may return multiple app events for one Cursor message, especially assistant messages with multiple text/tool blocks.
- It must never throw on unknown SDK shapes. Unknown or malformed input becomes a diagnostic `task.updated` event.
- **`thinking`** 不在 mapper 内展开：`CursorSdkGateway` 使用 `ThinkingCoalescer` 聚合成单次 `tool.started` + `tool.completed`（`name: 'thinking'`）；`mapCursorStreamMessage` 对原始 `thinking` envelope 返回空数组，以免落入 unknown-handler。
- It must not expose credentials. Raw Cursor payloads can be retained only where they are SDK message content; environment, headers and API keys are never part of mapper input.
- Terminal `run.result` still comes from `run.wait()`, not from stream messages. `run.stream()` provides progress; `run.wait()` provides final result text and terminal status.

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

Diff、file change 和 result review 不进入当前 Stage 1。当前阶段只要求远程 prompt、真实 Cursor local execution、app-level stream mapping、SSE delivery 和 session projection 跑通。后续如果 UI 需要 code review 面板，再独立设计本地 git baseline 和 diff summary；它不阻塞 Cursor remote-control MVP。

## Stage 2：Prompt 队列（对标 Cursor IDE）

原生 Cursor 在 agent 执行任务时会占用输入能力（界面常表现为类似 *running*、不可并行提交），桌面端另有 **prompt queue**：用户可把后续指令排入队列（而非丢失草稿），并可 **排序、编辑、删除** 某项；**立即发送（Send now）** 的预期语义是先 **中止当前编排 / stop 活跃 run（以 Cursor SDK 可用 cancel/stop 为准）**，再以队列中选中的文案发起一轮新的提交；若在某一阶段无法实现可靠 cancel，则产品需退化为「仅排队直至当前 run 自然结束」，并在 UI 上分清楚两种模式。

产品与协议占位要点：

- **客户端**：会话级有序队列（可为 FIFO 或可拖拽）；项含草稿正文、可选 `modelId` 覆盖、插入时间戳；是否与 server 对齐 id 以利于多客户端由 Stage 2 实施方案决定。
- **与 Stage 1 的关系**：Stage 1 仍推荐「同一时间单 session 单一 active run + active 期间禁用直接 Send」，Stage 2 用「enqueue / 队列 UI」接住用户意图，而不是在长 run 期间完全锁死表达式。
- **API 占位**：可演进为例如 `POST/GET/PATCH/DELETE /api/sessions/:sessionId/queue`、或扩展 `POST …/runs` 接受 dequeue / send-now flag；细则与 Stage 2 的 cancel 能力同步锁定。

本节与 PRD Stage 2 中的「prompt 队列」条目一致。

## Auth 与暴露边界

Stage 1/2 都不做应用层 token auth。目标部署方式是 Tailscale：server 监听在 localhost、LAN IP 或 Tailscale IP，只有 tailnet 内设备可以访问。这样做的好处是边界清楚：网络身份、设备授权和 ACL 由 Tailscale 管；应用代码专注 Cursor session lifecycle。

这条决策也影响测试：默认测试不需要 auth fixture，不需要 bearer token middleware，不需要权限矩阵。安全测试集中在两件事：第一，`CURSOR_API_KEY` 不进入 HTTP response、SSE payload、frontend bundle 或 logs；第二，API request validation 能阻止客户端覆盖 server 端 cwd 和 secret 配置。

## 前端架构

当前前端已经证明 session/run/SSE 能工作，但产品形态仍然不对：它更像一个 launcher + raw event monitor。下一步要把它重写成 OpenCode-like web coding client。先允许仍然放在单个 React 入口里实现，但结构上按以下组件边界组织，后续再拆文件：

```text
SessionSidebar
SessionView
MessageTimeline
PromptComposer
ActivityPanel
ToolCallCard
ThinkingBlock
RunStatusBadge
```

### OpenCode reference findings

OpenCode iOS client 的核心参考文件：`Views/SessionListView.swift`、`Views/Chat/ChatTabView.swift`、`Views/Chat/MessageRowView.swift`、`Views/Chat/ToolPartView.swift`、`Views/Chat/StreamingReasoningView.swift`、`Stores/MessageStore.swift`、`Controllers/ActivityTracker.swift`。它的关键规则是：session list 是长期导航；chat transcript 是主要工作区；running tool card 默认展开，完成后自动收起；streaming reasoning 和 assistant text 分开渲染；status 文案来自最近 activity，而不是只显示最终 run state。

OpenCode official 的核心参考文件：`packages/opencode/src/session/message-v2.ts`、`packages/opencode/src/server/routes/instance/httpapi/session.ts`、`packages/opencode/src/server/routes/instance/event.ts`、`packages/opencode/src/sync/index.ts`、`packages/web/src/components/Share.tsx`、`packages/web/src/components/share/part.tsx`。它的关键规则是：`Session` 是壳，`Message` 分 user/assistant，`Part` 才是渲染单位；首屏通过 message history/bootstrap 拿快照，后续通过 sync/SSE 事件做增量更新。

第一版 UI 应该是两栏或三栏，优先两栏以降低实现成本：

1. Session list。
2. Chat/message timeline + composer。
3. 可选 Activity panel，展示最近 thinking、tool calls、status。若先不做第三栏，tool/thinking/status 必须内嵌在 chat timeline 里。

OpenCode iOS client 和 OpenCode official web client 是交互参考：running tool card 默认展开，完成后收起；thinking 和普通 assistant output 视觉上分开；status text 来自最新 activity，而不只是最终 run state。Cursor 版本只复制体验骨架，不复制 provider/auth/permission/diff 的完整产品面。

### Required Stage 1 screen shape

```text
┌──────────────────────────────────────────────────────────────┐
│ Header: Cursor Remote Console + runtime/API/CWD/session state │
├───────────────┬──────────────────────────────────────────────┤
│ Conversations │ Chat timeline                                 │
│ - session A   │  user prompt                                  │
│ - session B   │  assistant text                               │
│ - running...  │  thinking/activity block                      │
│               │  tool card: write_file running/completed       │
│               │  run status row / error row                    │
│               │                                                │
│               │ Prompt composer                                │
└───────────────┴──────────────────────────────────────────────┘
```

The timeline rendering rules:

- User messages render as right-aligned or visually distinct prompt bubbles/cards.
- Assistant text renders as primary response content, not as raw `assistant.delta` rows.
- Thinking/activity renders in a subdued block with label such as `Thinking` or `Activity`; do not claim raw chain-of-thought fidelity.
- Tool calls render as cards. Running cards stay expanded and prominent; completed cards collapse to a one-line summary with name/status; error cards use error color.
- Run status renders as human-readable text: `Queued`, `Running`, `Completed`, `Failed`, `Cancelled`.
- Raw event stream can exist behind a debug disclosure later, but it is not part of default Stage 1 UI.
- The composer is session-scoped. Starting a run appends a user message and disables overlapping sends until the active run reaches a terminal status (**Stage 2**：改为可同时 **enqueue** prompts，参见上文「Prompt 队列」）。

### Cursor UI projection model

Cursor SDK 没有 OpenCode 那套完整 `message.part` schema，所以前端应在 app 层建立轻量 projection：

```ts
type TimelineItem =
  | { kind: 'user'; id: string; runId?: string; text: string; status: 'sent' | 'failed' }
  | { kind: 'assistant'; id: string; runId?: string; text: string; status: 'streaming' | 'completed' | 'failed' }
  | { kind: 'tool'; id: string; runId?: string; callId: string; name: string; status: 'running' | 'completed' | 'error'; summary?: string; detail?: unknown }
  | { kind: 'status'; id: string; runId?: string; text: string; tone: 'muted' | 'running' | 'success' | 'error' };
```

Projection rules:

- Initial state comes from `GET /api/sessions`, `GET /api/sessions/:id/messages`, and `GET /api/sessions/:id/runs`.
- Submitting a prompt creates an optimistic `user` item and opens `/api/runs/:id/events`.
- **`Session` list consistency (client):** the conversation sidebar renders each row from the list returned by `GET /api/sessions`, not only the selected session. Any live SSE handler or optimistic `POST …/runs` path that updates `SessionProjection.status`, `latestRunId`, or `updatedAt` must apply the same patch to **both** the matching entry in the sidebar list and the selected session state. Otherwise the timeline can show streaming or completed runs while the sidebar still shows `ready`, or a failed run while the sidebar still shows `running`. Client-side session status should mirror `ProjectionStore`: queued/running runs → session `running`; run `failed` → session `failed`; completed/cancelled → `idle`. `run.error` must mark the session `failed`; `run.result` should mark the run `completed` and session `idle` when the failure/cancel path was not taken (covers missing terminal `run.status` on flaky SSE).
- `assistant.delta` appends to the current assistant item for that run, creating it if needed.
- **Reasoning** uses the synthetic tool name **`thinking`**: timeline renders it与其它 tool 共用折叠卡片，`summary`/`result` 在展开区查看（不在单独的「Thinking · streaming」行里流式展示）。
- `tool.started` creates or updates a running tool item; **`thinking`** behaves like any other tool card (默认折叠)。
- `tool.completed` merges args + result for tool rows (including **`thinking`**).
- `tool.error` marks the matching tool item red.
- `task.updated` creates a status/activity row unless it duplicates the current tool row.
- Legacy event types **`thinking.delta` / `thinking.completed`** 仍可能在 schema/replay 中出现；新版本 gateway 已不再产生它们。
- `run.status` updates run badges and creates human-readable status rows for queued/running/completed/failed/cancelled.
- `run.result` completes assistant item if present; if result text is distinct from accumulated assistant text, append a final assistant item.

The raw SSE event list should be removed from the default UI. If needed for debugging, put it behind a `Debug events` disclosure later.

### Implementation slice for the next frontend commit

The next frontend commit should prioritize functional shape over polish:

1. Replace the single-column launcher with an app shell: fixed sidebar + main chat area.
2. Sidebar lists sessions with title, status, latest run id/status, and a `New conversation` button.
3. Main chat area shows selected session header, timeline, and sticky composer.
4. Timeline renders user/assistant/tool/status items from a frontend projection derived from current messages, runs, and live events.
5. Existing `Start Cursor run` becomes `Send` in the composer. It remains session-scoped and disallows overlapping active runs.
6. The previous session cards/runs/event stream panels can be removed or demoted into debug information.

Visual design still follows `docs/design.md`, but design polish happens after the functional chat shape exists. A GLM critique should run after this UI is implemented, then P0/P1 critique items can be applied in a separate commit.

## Evaluation architecture

可测试性要进入接口设计，而不是事后补测试。核心服务必须通过 dependency injection 接收 Cursor gateway、EventStore、Clock、IdGenerator 和 sandbox cwd。这样同一套 RunService 可以跑三种模式：deterministic mock、recorded event replay、真实 Cursor local sandbox。

默认 `npm test` 跑 deterministic suite，不访问 Cursor API。它验证 app logic：config、request validation、EventStore、ProjectionStore、Cursor stream mapper、EventBroker/SSE、API routes、frontend projection 和 mock gateway event sequence。这里的成功判据是纯客观的：event id 单调、projection 一致、SSE replay 不丢事件、HTTP error code 稳定、secret 不出现在 response 或 event payload。

Live Cursor suite 通过 `RUN_CURSOR_LIVE_TESTS=1` 显式开启，模型固定 `composer-2`。测试创建一次性 local sandbox cwd。Live smoke 不做长任务，只验证 API 是否真的可用：`run.stream()` 产生 status/assistant 或 tool/task event，Cursor 能在 sandbox 写入 `hello.txt`，app SSE 能转发这些 event，并且 run 进入 completed/failed terminal state。产品默认 cwd 可以指向真实 repo；live tests 必须覆盖 cwd，避免测试误改真实 workspace。

Live suite 的失败输出要服务 agent 自我诊断。测试摘要应能区分 failure layer：token/account、model availability、SDK schema mismatch、stream timeout、SSE broker、projection。这样 agent 可以判断下一步是修本地代码、更新 fixture，还是标记 Cursor API 当前不可用。

Stage 1 测试矩阵：

| 层级 | 默认运行 | 覆盖内容 |
|---|---|---|
| Unit | 是 | config、contracts、event store、projection、stream mapper |
| API integration | 是 | session CRUD、start run、messages、events、error paths、secret masking |
| SSE harness | 是 | live subscribe、heartbeat、disconnect cleanup、`Last-Event-ID` replay |
| Frontend projection | 是 | event fixtures 到 timeline/activity/status state |
| Coverage | 手动/CI | remote-control core 主要分支，live tests 不计入 gate |
| Live Cursor | 否 | `RUN_CURSOR_LIVE_TESTS=1` 时用真实 token、composer-2 和 sandbox cwd 验证 SDK |

## 已知风险

- Cursor SDK 仍是 public beta，API 可能变化。
- `tool_call.args` 和 `tool_call.result` 不是稳定 payload。
- `SDKRequestMessage` 表示等待用户输入或审批，但目前证据没有显示稳定的 SDK response method。Permission UX 应留到 Stage 2，等 live validation 证明闭环后再做。
- `Agent.resume()` 恢复的是 agent，不一定是被中断的 run。App-level event replay 仍然必须实现。
- Local runtime 没有 cloud artifacts；如果后续要做 diff review，应独立依赖本地 git integration，而不是假设 Cursor stream 提供稳定文件变更元数据。
- Tailscale 认证简化了应用代码，但 tailnet 内设备默认可信。UI 需要降低误操作概率，特别是清楚展示 cwd 和 active run。

## 从当前 POC 迁移

当前 POC 标记为 deprecated reference。它证明了 SDK 能被后端调用，但它的同步 route、单 run store 和单页面 launcher 都不是后续产品架构。

迁移顺序：

1. 新增 `EventStore`、`ProjectionStore`、`SessionService` 和 `RunService`，先用 mock gateway 跑通全链路测试。
2. 保留 `CursorAgentGateway` 的 SDK 适配代码，但把它从 `startRun(): Promise<RunSummary>` 改成会 emit app events 的异步 lifecycle API。
3. 用 `POST /api/sessions/:sessionId/runs` 替换 `POST /api/runs`，旧 route 可以短期保留但标记 deprecated。
4. 增加 SSE event endpoints 和 event broker，并为 replay / reconnect 写测试。
5. 增加 `CursorStreamMapper`，让真实 Cursor SDK stream 稳定转成 app events，并用 recorded fixtures 覆盖 unknown shape。
6. 把 frontend 从 run launcher / raw event monitor 重构成 conversations + chat timeline + composer，同时把 event projection 抽出单测。
7. 保留 mock mode，但让它产出和真实 Cursor mode 相同形状的 event sequence。
