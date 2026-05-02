# PRD：Cursor 远程控制 Server + Web Client

## 目标

把这个项目从一次性 Cursor SDK 验证，推进成一个长期只服务 Cursor 的 remote-control server/client 体验：一台有本地 repo 的机器上运行小型 server，浏览器 UI 远程控制 Cursor agent session。Server 负责 Cursor API key、SDK 生命周期、本地 repo 路径、事件流和 session 历史；Web client 只负责创建 session、发送 prompt、订阅实时活动、审阅结果。

这个项目已经证明 `@cursor/sdk` 可以被 Node 后端调用。下一步要验证的是更接近产品的闭环：Cursor 的 `Agent`、`Run`、`stream()` 能否支撑类似 OpenCode 的远程控制体验，包括 session、多轮对话、实时 activity、tool call 可视化和结果审阅。

## 用户

初始用户是已经有 OpenCode iOS client 经验的 agent 工具构建者。他理解 OpenCode 的 server/client 模式，希望用 Cursor 做一个相似但更窄的产品形态：从笔记本、手机或平板打开网页，选择一个 session，输入任务，看 Cursor agent 在配置好的 repo 里工作，然后审阅输出和文件变更。

## 产品边界

这是一个**单用户、local-first、Cursor-only 的远程控制应用**。

不论 Stage 几，都不做 connector 平台。这个项目在相当长一段时间内只针对 Cursor，不抽象 provider，不设计 OpenCode/Cursor/Claude Code 之间的通用 runtime，也不为了未来 connector 牺牲当前实现的直接性。

部署边界按个人 Tailscale 网络设计。Server 暴露到 LA 机器或 Tailscale tailnet 内即可，认证由 Tailscale 完成。应用层不做 shared secret、bearer token、OAuth 或多用户 auth。Cursor API key 只存在 server 端，由 `.env` 提供；用户会手动把 token 写进 `.env`，项目不需要依赖 1Password service account 才能工作。

当前阻塞式 POC 已经完成它的验证任务，后续作为 deprecated reference 保留。新实现应该围绕 session、run、event、SSE、持久化和测试重新组织，而不是在当前 `POST /api/runs -> run.wait()` 形态上继续增量补丁。

## 问题

OpenCode 的价值在于 runtime 和 client 分得很清楚：`opencode serve` / `opencode web` 运行 agent runtime，iOS client 通过 REST + SSE 控制它。这样一来，远程控制自然成立。

当前 Cursor POC 只有一个阻塞式 `POST /api/runs` launcher。它能证明 SDK 可以启动一次 run，但还不能证明真正的产品循环：长期 session、实时进度、可见的 tool activity、刷新/断线恢复、以及可审阅的结果。

## 需求

### Stage 1 必须有

- React web client，包含 session list、message/activity timeline 和 prompt composer。
- Node/Express backend，持有 `CURSOR_API_KEY`、`CURSOR_RUNTIME=local`、`CURSOR_LOCAL_CWD` 和默认 model。Cloud runtime 可以保留为 SDK 对照实验，但产品路径按 local Cursor remote-control 设计。
- `Session` 抽象：用户看到的是一个长期对话，一个 session 可以包含多个 Cursor run。
- `Run` 抽象：一次提交给 Cursor agent 的 prompt，必须归属于某个 session。
- 异步 run lifecycle：提交 prompt 后立即返回，server 在后台运行 Cursor。
- Server-Sent Events：用于实时更新，并带单调递增 event id，方便客户端断线后 replay。
- Cursor SDK streaming 集成，优先使用 `run.stream()`，必要时使用 `onDelta`。
- Best-effort 可视化：assistant text、thinking/activity、tool call、run status、final result 和 error。
- 简单持久化 event log 或 store，刷新页面后不丢当前 session timeline。
- Mock mode 必须走同一套 session/run/event API，不依赖 Cursor 凭证。
- 测试覆盖作为一等需求：单元测试覆盖 config parsing、request validation、session/run/event storage、event projection、SSE replay、mock gateway event sequence 和 frontend state projection。任何架构改动都要同时更新测试。
- Live Cursor evaluation 是一等需求：当 `RUN_CURSOR_LIVE_TESTS=1` 且 `.env` 里有 `CURSOR_API_KEY` 时，测试应能用 `composer-2` 在一次性 sandbox cwd 中验证真实 SDK 的 stream、文件写入、follow-up context、SSE 转发和 diff detection。
- 基础 diff summary：local runtime 完成后用本地 git baseline / `git diff` 展示 changed files 和摘要。这个能力属于 Cursor-only local 产品闭环，不依赖 cloud PR metadata。
- 客户端 reconnect 通过 `Last-Event-ID` replay 已持久化 events。

### Stage 2

- Parallel sub-agent / multi-run session，用 `RunGroup` 或同一 session 下多个 concurrent runs 表达。
- 更完整的 local diff review UI，包括文件级 diff、按 run 分组的 changed files、结果摘要和可复制 patch。
- server 重启后的 resume，基于持久化的 `cursorAgentId`、event log 和可用的 SDK `Agent.resume()`。App-level replay 是必需能力，SDK-level resume 是增强能力。
- 如果 Cursor 暴露可响应的 request event，再做 Cursor-specific permission/request UX。
- 同一 run event stream 的多 client fan-out。
- 可选 run cancellation。只有 SDK 对 active run 暴露可靠 cancel 语义时才实现。

### 第一阶段不做

- iOS client。
- 多用户 SaaS、team account、billing、OAuth 或 workspace tenancy。
- 多 provider connector 设计。
- OpenCode protocol compatibility。
- 应用层 token auth。Tailscale 是认证边界。
- 1Password service account 自动取密钥。`.env` 是第一版配置入口。
- 完整 file explorer 或 terminal/PTY clone。
- 等价于 OpenCode 的完整 tool approval / permission engine。

## OpenCode 参考模型

OpenCode iOS client 值得复用的是三件事：

第一，REST 负责 durable state，例如 sessions、messages、status、diff、file/result metadata。第二，SSE 负责实时更新，例如 connected、heartbeat、session status、message/part updates、tool progress。第三，client 把 agent 工作渲染成 timeline：text、reasoning/activity、tool cards、todos/diffs 和 final result。

Cursor app 应该复用这套体验骨架，而不是复刻完整 OpenCode 实现。Cursor 原生抽象是 `Agent`、`Run`、`SDKMessage`、`run.stream()`、`Agent.resume()`、local/cloud runtime，以及可选 cloud PR metadata。server 要做的是把这些 Cursor primitive 翻译成一套更小的 app-specific session/event protocol。

## 成功标准

Stage 1 验证通过的标准：

1. `npm test`、`npm run typecheck`、`npm run build` 通过。
2. Mock mode 可以创建 session、发送 prompt、stream synthetic events，并在刷新后恢复 timeline。
3. Local Cursor mode 可以在 `CURSOR_LOCAL_CWD` 上启动 run，同时不把 API key 暴露给浏览器。
4. 浏览器可以看到 live run activity，而不是等 `run.wait()` 完成。
5. Timeline 能区分 user prompt、assistant text、thinking/activity、tool call、status change、final result 和 error。
6. 一个 session 至少支持第一次 run 完成后的 follow-up prompt。
7. Stage 1 的核心模块有可维护的测试覆盖，coverage report 能显示 storage、projection、API、SSE 和 mock gateway 的主要路径被覆盖。
8. Live Cursor suite 在有 token 时可以客观判断 API 是否可用：`Cursor.me()` / `composer-2` 可用、sandbox 文件被写入、SSE 收到完整 run event、event replay 不丢事件、diff summary 能定位 changed files。
9. README 清楚解释 `.env` 配置、Tailscale 暴露方式、默认 deterministic tests 和 opt-in live Cursor tests。

## 风险与约束

- Cursor stream 的可视化程度取决于 `@cursor/sdk` 暴露的信息。Tool-call envelope 足够用于 UI，但 tool `args` / `result` payload 属于内部形态，可能变化。UI 应该称为 activity / tool output，而不是承诺稳定 tool schema。
- Thinking visibility 应该作为 product activity 或 reasoning summary 处理，不承诺保存 raw chain-of-thought。
- Local runtime 要求 backend 跑在拥有 working directory 的机器上。
- Local runtime 没有 cloud artifacts 或 PR metadata；diff/result review 需要单独走本地 git 路径。
- `Agent.resume()` 是 agent-level resume，不保证任意中断的 run 都能继续。App-level event replay 和 SDK-level resume 必须分层设计。
- Tailscale 解决网络认证，不解决应用误操作。UI 仍需要清楚展示当前 cwd、运行状态和即将发送给 Cursor 的 prompt，避免远程误触。
