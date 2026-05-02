# PRD：Cursor 远程控制 Server + Web Client

## 目标

把这个项目从一次性 Cursor SDK 验证，推进成一个 Cursor 版的 OpenCode server/client 体验：一台有本地 repo 的机器上运行小型 server，浏览器 UI 远程控制 Cursor agent session。Server 负责 Cursor API key、SDK 生命周期、本地 repo 路径、事件流和 session 历史；Web client 只负责创建 session、发送 prompt、订阅实时活动、审阅结果。

这个项目已经证明 `@cursor/sdk` 可以被 Node 后端调用。下一步要验证的是更接近产品的闭环：Cursor 的 `Agent`、`Run`、`stream()` 能否支撑类似 OpenCode 的远程控制体验，包括 session、多轮对话、实时 activity、tool call 可视化和结果审阅。

## 用户

初始用户是已经有 OpenCode iOS client 经验的 agent 工具构建者。他理解 OpenCode 的 server/client 模式，希望用 Cursor 做一个相似但更窄的产品形态：从笔记本、手机或平板打开网页，选择一个 session，输入任务，看 Cursor agent 在配置好的 repo 里工作，然后审阅输出和文件变更。

## 产品边界

这是一个**单用户、local-first 的 Cursor 远程控制应用**。

Stage 1 不做 connector 平台。系统只支持 Cursor，所有运行配置都放在 `.env` 里。repo 路径也可以先放在 `.env`，第一版不需要 repo picker。Cursor API key 只存在 server 端。server 未来可以通过安全 tunnel 暴露出去，但本阶段 localhost / LAN 已经足够验证核心形态。

## 问题

OpenCode 的价值在于 runtime 和 client 分得很清楚：`opencode serve` / `opencode web` 运行 agent runtime，iOS client 通过 REST + SSE 控制它。这样一来，远程控制自然成立。

当前 Cursor POC 只有一个阻塞式 `POST /api/runs` launcher。它能证明 SDK 可以启动一次 run，但还不能证明真正的产品循环：长期 session、实时进度、可见的 tool activity、刷新/断线恢复、以及可审阅的结果。

## 需求

### Stage 1 必须有

- React web client，包含 session list、message/activity timeline 和 prompt composer。
- Node/Express backend，持有 `CURSOR_API_KEY`、`CURSOR_RUNTIME`、`CURSOR_LOCAL_CWD`、默认 model，以及可选 cloud repo 配置。
- `Session` 抽象：用户看到的是一个长期对话，一个 session 可以包含多个 Cursor run。
- `Run` 抽象：一次提交给 Cursor agent 的 prompt，必须归属于某个 session。
- 异步 run lifecycle：提交 prompt 后立即返回，server 在后台运行 Cursor。
- Server-Sent Events：用于实时更新，并带单调递增 event id，方便客户端断线后 replay。
- Cursor SDK streaming 集成，优先使用 `run.stream()`，必要时使用 `onDelta`。
- Best-effort 可视化：assistant text、thinking/activity、tool call、run status、final result 和 error。
- 简单持久化 event log 或 store，刷新页面后不丢当前 session timeline。
- Mock mode 必须走同一套 session/run/event API，不依赖 Cursor 凭证。
- 单元测试覆盖 config parsing、request validation、session/run storage 和 event projection。

### Stage 1.5 应该有

- Local runtime 完成后生成 diff summary，可通过本地 git snapshot 或 `git diff` 实现。
- Cloud runtime 如果 Cursor 返回 branch / PR metadata，就展示 PR 或结果链接。
- 如果 SDK 对 active run 暴露可靠 cancel 能力，就支持 run cancellation。
- 如果 server 要暴露到 localhost / LAN 之外，增加 basic shared secret 或 bearer token auth。
- 客户端 reconnect 时通过 `Last-Event-ID` replay；SDK 级 `Agent.resume()` 等 live validation 确认语义后再加入。

### Stage 2

- Parallel sub-agent / multi-run session，用 `RunGroup` 或同一 session 下多个 concurrent runs 表达。
- 更完整的 diff review UI。
- server 重启后的 resume，基于持久化的 `cursorAgentId` 和可用的 SDK `Agent.resume()`。
- 如果 Cursor 暴露可响应的 request event，再做 permission/request UX。
- 同一 run event stream 的多 client fan-out。

### 第一阶段不做

- iOS client。
- 多用户 SaaS、team account、billing、OAuth 或 workspace tenancy。
- 多 provider connector 设计。
- OpenCode protocol compatibility。
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
7. README 清楚解释 `.env` 配置和 local-first 架构。

## 风险与约束

- Cursor stream 的可视化程度取决于 `@cursor/sdk` 暴露的信息。Tool-call envelope 足够用于 UI，但 tool `args` / `result` payload 属于内部形态，可能变化。UI 应该称为 activity / tool output，而不是承诺稳定 tool schema。
- Thinking visibility 应该作为 product activity 或 reasoning summary 处理，不承诺保存 raw chain-of-thought。
- Local runtime 要求 backend 跑在拥有 working directory 的机器上。
- Local runtime 没有 cloud artifacts 或 PR metadata；diff/result review 需要单独走本地 git 路径。
- `Agent.resume()` 是 agent-level resume，不保证任意中断的 run 都能继续。App-level event replay 和 SDK-level resume 必须分层设计。
