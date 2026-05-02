# Working Log

## Changelog

### 2026-04-29

- Created `adhoc_jobs/cursor_cloud_remote_poc` as a formal scaffolded project.
- Added TypeScript backend, React frontend, shared contracts, and mock Cursor gateway.
- Added PRD, RFC, test strategy, README, local AGENTS rules, and environment template.
- Added unit tests for config parsing, run storage, and Express API behavior.
- Configured Vitest to run test files serially; API integration tests use an ephemeral loopback listener with `fetch` (Supertest was removed after flaky socket hang ups alongside Cursor SDK imports).
- Added adapter tests for mock Cursor runs, missing API key handling, and gateway selection.
- Verified `npm run typecheck`, `npm test`, `npm run coverage`, and `npm run build` pass without Cursor credentials.
- Incorporated external SDK findings: Cursor supports cloud runs, streaming, `Last-Event-ID` reconnect, `Agent.resume()`, durable follow-up runs, artifacts, and PR creation, but direct mobile calls remain unsafe because `crsr_` API keys are long-lived credentials.
- Corrected the validation direction from cloud-first to local-first. The target product path is a backend running on the user's Mac with `CURSOR_RUNTIME=local` and `CURSOR_LOCAL_CWD` pointing at a local repo.

### 2026-05-01

- MVP default prompt targets `mvp_sandbox/hello_world.py`; `/api/health` includes `localCwdConfigured`.
- SDK gateway awaits `run.wait()`, maps terminal status to `completed`/`failed`, attaches optional `resultText`, and disposes agents via `Symbol.asyncDispose`.
- Deferred `@cursor/sdk` static import until a real run (dynamic `import()` inside `CursorSdkGateway.startRun`).
- 将 PRD/RFC 从一次性 Cursor SDK launcher 重新定位为 Cursor remote-control server + web client。目标架构是单用户、local-first，借鉴 OpenCode 的 client/server 体验，但不做 OpenCode API 兼容。
- 设计决策：引入 `Session -> Run -> Event` 作为产品模型。`Session` 是长期用户对话，`Run` 是一次 Cursor prompt 执行，`Event` 是用于 live SSE 和 replay 的 append-only stream。
- 设计决策：Stage 1 应用 async run lifecycle + SSE 替换阻塞式 `POST /api/runs -> run.wait()`。Cursor `run.stream()` / `onDelta` events 应映射成 `assistant.delta`、`thinking.delta`、`tool.started`、`tool.completed`、`run.result` 等 app events。
- 设计决策：不实现 OpenCode protocol compatibility。复用 OpenCode 的体验形态——session history、live activity、tool cards、diff/result review——但 server protocol 保持 Cursor-native。
- 设计决策：不论 Stage 几都不做 connector 平台。产品长期 Cursor-only，网络暴露边界交给 Tailscale，应用层不做 bearer token / OAuth / shared secret auth。
- 设计决策：当前阻塞式 POC 标记为 deprecated reference。后续实现围绕 `EventStore`、`ProjectionStore`、`EventBroker`、`RunService`、`DiffService` 和 `CursorStreamMapper` 重建，不继续在单一 `POST /api/runs` launcher 上堆功能。
- 设计决策：测试覆盖是一等需求。默认 deterministic suite 证明 app logic 正确；`RUN_CURSOR_LIVE_TESTS=1` 的 live Cursor suite 用真实 token、`composer-2` 和一次性 sandbox 判断 Cursor API 当前是否可用。
- Evaluation plan 已细化到 `docs/test.md`：覆盖 unit、API integration、SSE replay、frontend projection、local diff、mock gateway event sequence、live Cursor sandbox、coverage gate 和 failure diagnosis matrix。
- 运行约定：`.env` 已直接提供 `CURSOR_API_KEY`，不依赖 1Password。默认 `CURSOR_LOCAL_CWD` 指向本 repo 根目录，用于自举式开发；live tests 必须覆盖为临时 sandbox，不能改真实 repo。
- 运行约定：Stage 1 server 默认 `HOST=0.0.0.0`、`PORT=8787`，方便 LAN/Tailscale 设备访问；Tailscale 只作为网络认证层，应用本身不做 token auth。
- 工作节奏：Stage 1 按小 milestone 实现。每个 milestone 完成后更新 `working.md`，跑 typecheck/test/build，单独 commit，再进入下一个 milestone。
- Milestone 1 completed: added typed app event contracts, injectable clock/id helpers, in-memory `EventStore`, in-memory `ProjectionStore`, and deterministic tests for event replay, session/run/message projection, and lifecycle integration.
- Design review started after Milestone 1: captured the current UI with Playwright, asked GLM 5.1 for critique, and added `docs/design.md` as the visual direction for a premium Cursor remote-control console.
- UI design pass applied to the current POC: compact console header, environment badges, mono prompt editor, Quick actions container, right-aligned primary action, and compact run timeline rows with shortened run ids.
- Playwright verification passed for the design pass: final screenshot shows the design direction in-page and console warnings/errors are clear after adding a small SVG favicon.
- Milestone 2 completed: added EventBroker, SSE response helpers, SessionService, RunService, async mock gateway execution, session/run REST routes, SSE replay endpoint, and integration tests for immediate queued responses and Last-Event-ID replay.
- Milestone 3 started by migrating the browser from deprecated blocking `/api/runs` to the session API. The frontend now creates/resumes a localStorage-backed session, starts runs through `/api/sessions/:sessionId/runs`, opens `/api/runs/:id/events` with native EventSource, and renders session-scoped runs, messages, and recent app events.
- Milestone 4 completed: documented and implemented `CursorStreamMapper`, replacing the temporary raw SDK passthrough with a pure mapper for `assistant`, `thinking`, `tool_call`, `status`, `task`, `request`, and unknown Cursor stream messages. Added deterministic mapper fixtures and an opt-in live Cursor integration test that uses real token + local SDK + temporary cwd + app SSE to create `hello.txt`.
- Scope correction: diff, file change, and result review are no longer Stage 1 blockers. Stage 1 is now remote prompt -> real Cursor local run -> stream mapping -> SSE -> session projection. Diff/review can be designed later if the product needs a code review panel.
- Product reset after reviewing the post-SSE UI: the current browser is still a launcher/event monitor, not the desired coding client. Next frontend milestone should rebuild around OpenCode-like conversations: left session list, right chat timeline, session-scoped composer, rendered assistant/thinking/tool/status blocks, and no raw SSE event table in the default UI.
- Process correction: design critique should run after the functional chat client exists. The intermediate GLM critique based on the event-monitor UI was discarded and should not guide the next implementation milestone.
- OpenCode reference pass completed. iOS client points to session sidebar + transcript + inline tool cards + streaming reasoning (`SessionListView`, `ChatTabView`, `MessageRowView`, `ToolPartView`, `StreamingReasoningView`). Official OpenCode points to message parts as the rendering unit (`message-v2.ts`, `Share.tsx`, `share/part.tsx`) and the bootstrap snapshot + incremental event pattern. Cursor UI will implement a smaller app-level `TimelineItem` projection from Cursor events.
- Frontend chat-client rewrite applied: replaced the single-column launcher/event monitor with a persistent conversation sidebar, selected-session chat header, timeline projection, and sticky composer. The raw SSE event panel is removed from default UI; `assistant.delta`, `thinking.delta`, tool events, task updates, run errors and run statuses now render as chat timeline items.
- UI test milestone completed: extracted the frontend `TimelineItem` projection into `frontend/src/timeline.ts`, added deterministic projection tests, and added a happy-dom React flow test that mounts the chat client with mock API + mock EventSource. The test covers conversation shell load, composer submit, streamed thinking/tool/assistant/result rendering, and closing the stream only after `run.result`.
- GLM design critique completed and saved to `docs/design_critique.md`. P0/P1 fixes applied: stable append-oriented timeline projection, auto-scroll when the user stays near the bottom, wider user/assistant bubbles, compact run-status rows, streaming activity dots, timestamp labels, hidden raw tool call ids, collapsed model settings, and smoke actions limited to mock mode.

### 2026-05-02

- `/api/health` 在已配置 `CURSOR_LOCAL_CWD` 时额外返回 **`localCwd`**（绝对路径）；不含 API key。
- 侧栏 **CWD** 状态：第一行 `set` / `missing`，第二行展示路径并启用 **`overflow-wrap: anywhere`**、**`word-break: break-word`**；侧栏 **`min-width: 0`**、badge **`max-width: 100%`** 防止长路径溢出。
- 集成测试与 `App.test.tsx` health mock 覆盖带 `localCwd` 的响应。
- **Thinking 流式**：`buildTimeline` 按时间排序后对同一 `runId` 的 `thinking.delta` **追加拼接**（不再被 Map 覆盖只留最后一条）；支持 `thinking.completed` 将状态标为 completed。
- **Tool 卡片**：`tool.started` 与 `tool.completed` **合并**同一 `callId`，完成后仍保留 **args（detail）**；UI 上 **completed/error** 也继续展示 `<pre class="tool-args">`，不再仅在 running 时显示。
- **Composer 快捷键**：**Enter** 换行；**⌘↵（Meta+Enter）或 Ctrl+Enter** 发送（与 Send 按钮同一套 `submitRun` 校验）；快捷键说明在 Prompt 标题旁，并用 **`aria-describedby`** 关联到 textarea。
- **Coverage / `App.test.tsx`**：`vitest` 覆盖率 **`include`** 不再排除 `frontend/src/main.tsx`（入口组件仍主要由挂载集成测试覆盖）。`App.test.tsx` 覆盖：Send、Meta+Enter / Ctrl+Enter 发送、**纯 Enter 不调用 `startSessionRun` 且保留换行**、textarea **`aria-describedby`** 与快捷键文案。

## Lessons Learned

- Cursor API keys must stay server-side; a browser or mobile client should call a project-owned backend instead of Cursor directly.
- The first useful validation is not UI polish. It is whether Cursor SDK returns enough run/session/diff/stream metadata to support a remote-control product.
- OpenCode iOS Client is strongly coupled to OpenCode's REST + SSE protocol, so Cursor integration should first prove a compatible backend abstraction before modifying that app.
- Cursor SDK imports may involve native/platform packages, so default unit tests should avoid unnecessary parallel worker initialization until live SDK behavior is understood.
- Cursor has no stable first-class diff API in the current evidence. For product UX, PR URL + GitHub API is the safer route for showing final code changes.
- Cloud runtime validates remote dispatch, but it does not validate local-file remote control. Local runtime is the relevant test for an OpenCode-like experience.
- OpenCode 最值得借鉴的是架构，而不是协议：REST 承载 durable state，SSE 承载 live events，client 把 agent 工作渲染成 text、activity、tools、results 组成的 timeline。
- Cursor SDK 已经暴露了 Stage 1 UI 所需的 stream surface：`assistant`、`thinking`、`tool_call`、`status`、`task`，以及更底层的 delta callbacks。Tool event envelope 足够用于展示，但 `args` 和 `result` payloads 应按 best-effort details 处理。
- `Agent.resume()` 恢复的是 agent，不一定是被中断的 run。带单调 event id 的 app-level event replay 应独立于 SDK-level resume 实现。
- 默认测试和 live 测试要分层。默认测试不能依赖网络或 token；live 测试的价值是暴露 token/account、model availability、SDK schema、stream timeout、SSE broker、diff baseline 等 failure layer。
- Live Cursor 测试必须使用临时 sandbox cwd，不能指向真实 workspace。成功判据应落在客观状态上：event sequence、文件内容、diff changed files、follow-up context 和 replay consistency，而不是自然语言主观判断。
- `ProjectionStore` 应保持 deterministic materialized view 角色：同一 event log 通过 `rebuild()` 或逐条 `apply()` 得到相同状态；Cursor-derived payload 继续作为 `unknown`/record 处理，只有 app lifecycle payload 做 type guard。
- 当前 UI 的主要设计债不是信息架构，而是视觉密度和默认控件气味。下一轮 RFC/UI work 应围绕 compact console header、environment badges、mono prompt editor、compact runs timeline 和 activity panel 展开。
- Milestone 2 keeps the deprecated blocking `/api/runs` route alive for the current frontend while the new `/api/sessions/:sessionId/runs` path uses EventStore/ProjectionStore and returns queued immediately. This lets Stage 1 migrate UI and Cursor SDK streaming without a big-bang route switch.
- Native browser `EventSource` is enough for the Stage 1 client because the backend uses GET SSE and supports `Last-Event-ID`; no frontend streaming dependency is needed. The remaining product gap is SDK event fidelity, not transport plumbing.
- Real Cursor `run.stream()` can emit terminal `status: FINISHED` before `run.wait()` emits final `run.result`. SSE/live tests should wait for both terminal status and result before closing the stream; otherwise the harness can falsely report a missing result event even when the app is correct.
- A passing stream integration test is necessary but not sufficient. The product acceptance criterion is the client experience: selecting a conversation, chatting with Cursor, and seeing tool/thinking/status rendered in a usable timeline similar to OpenCode clients.
- Frontend UI tests should assert product-level behavior rather than CSS details: the contract is conversation shell -> prompt submit -> timeline receives user, thinking, tool, assistant, and terminal result. Visual critique remains a separate design pass after this deterministic behavior is locked.
