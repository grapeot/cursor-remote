# 工作备忘

## 变更记录

### 2026-04-29

- 把 `adhoc_jobs/cursor_cloud_remote_poc` 搭成正式脚手架项目。
- 落地 TypeScript 后端、React 前端、共享契约与 mock Cursor gateway。
- 增补 PRD、RFC、测试策略、README、本地 AGENTS、环境模板。
- 为配置解析、run 持久化与 Express API 增加单测。
- Vitest 串行执行用例；API 集成用临时 loopback + `fetch`（因与 Cursor SDK 同进程的 Supertest socket 不稳已弃用）。
- mock run、缺失 API key、网关选择等适配层单测就位。
- 在不配置 Cursor 凭据前提下跑通 `typecheck`、`test`、`coverage`、`build`。
- 外部/SDK 结论：云 run、流式、`Last-Event-ID` 重连、`Agent.resume()`、后续 follow-up run、artifacts、PR 创建等可查；移动端直连 Cursor **不行**，因 `crsr_` 类 key 等价长期凭据。
- 验证主轴从 cloud-first 改为 **local-first**：服务端跑在用户 Mac，`CURSOR_RUNTIME=local`、`CURSOR_LOCAL_CWD` 指向本地 checkout。

### 2026-05-01

- `/api/health` 含 `localCwdConfigured`（后亦在配置 cwd 时返回绝对路径 `localCwd`，响应中不含 API key）。
- Gateway 等待 `run.wait()`，终点态映射 `completed` / `failed`，附带可选 `resultText`，agent 释放走 `Symbol.asyncDispose`。
- 真实跑之前对 `@cursor/sdk` 只做动态 `import()`，避免无谓加载原生依赖。
- PRD/RFC 从一次性 Cursor launcher 收口为：**单用户、local-first 的 Cursor remote-control server + web**，借鉴 OpenCode 形态，不做 OpenCode 协议兼容。
- 产品模型定为 `Session → Run → Event`，Event 作为 SSE/replay 的 append-only 源。
- Stage 1 用 async run + SSE 取代阻塞式 `POST /api/runs → run.wait()`；`run.stream()` / delta 映射为 `assistant.*`、`thinking`、`tool.*`、`run.result` 等应用事件。
- 不做多端 connector；长期 Cursor-only；暴露面交给 Tailscale，应用层不做 bearer/OAuth/shared secret。
- 旧阻塞 POC 归档为废弃参考；新实现围绕 EventStore、ProjectionStore、EventBroker、RunService、DiffService、CursorStreamMapper，不再在单边 launcher 上堆功能。
- 测试：默认确定性套件；`RUN_CURSOR_LIVE_TESTS=1` + 临时目录做单次 live 烟测细节见 `docs/test.md`。
- 运行：`CURSOR_API_KEY` 走 `.env`；本地开发 cwd 可先指向本仓库根；live 必须临时 sandbox，不改真实 workspace。Server 默认 `HOST=0.0.0.0`、`PORT=8787`。约定按小里程碑推进：每阶段更新本文档并跑 typecheck/test/build。
- Milestone 1：应用级事件契约、可注入时钟/ID、内存 EventStore / ProjectionStore、回放与生命周期单测。
- Milestone 1 后试过 Playwright 截屏 + GLM critique，沉淀 `docs/design.md`（偏 premium 远端控制台）。
- UI 雏形：紧凑顶栏、环境 badge、mono 编辑器、quick actions、右对齐主按钮、短 run id 时间线。
- Milestone 2：EventBroker、SSE 辅助函数、Session/Run service、异步 mock gateway、会话/运行 REST、`Last-Event-ID` replay 集成测。
- Milestone 3：前端废弃阻塞 `/api/runs`，改 localStorage session、`/api/sessions/:id/runs`、原生 EventSource、`/api/runs/:id/events`，展示会话内 run/message/近期事件。
- Milestone 4：`CursorStreamMapper` 定型；可选 live：`hello.txt` 写临时 cwd + SSE。
- Stage 1 收口为：远端 prompt → 本地 Cursor run → 映射 → SSE → 会话投影（diff/review 可后置）。
- 产品纠偏：当时 UI 仍偏 launcher/event monitor；目标改为左侧会话列表、右侧 timeline、composer，默认不展示裸 SSE。
- GLM critique 若在「未成形的 chat」阶段产生，不作为后续里程碑主依据。
- OpenCode：侧栏 + transcript + 工具卡 + reasoning 展示；我们以更小的 `TimelineItem` 从 Cursor 事件投影。
- 前端重写 chat shell：侧边栏会话、timeline、粘性 composer，`assistant.delta` / tool / thinking 合成 / run 终结态进时间线。
- 前端抽 `timeline.ts` + 投影单测；happy-dom 集成测覆盖 mock fetch + MockEventSource、`run.result` 后收流。
- `docs/design_critique.md` 归档 GLM critique；对齐 P0/P1：timeline 追加式、靠近底部自动滚动、气泡宽度、紧凑状态行、流式圆点、时间戳、弱化 raw tool id、模型设置折叠；（当时）mock 下 quick fill 仍存在，后同日后续条目已删掉。
- 根目录 `.cursorignore`：`node_modules`、构建产出、`coverage`、`.env`、`.venv` 等不入索引。
- 切换会话时按 `sessionId` 缓存最近一轮前端缓冲事件，避免回到会话时仅存 `tool`/thinking 的 buffer 被 `setEvents([])` 清空；仍在跑的 run 重连 SSE。
- 时间线工具行改为可折叠卡：概要仅工具名与状态；展开为扁平 `key` + JSON。
- 侧栏会话按「有效活动时间」排序：服务端 `updatedAt` 与流式事件时间取较新者，减轻正文已更新列表滞后。
- 侧栏圆点：绿=会话 running；蓝=相对上次打开的未读叠加；打开会话时用 localStorage 记 read ack。（`frontend/src/sessionSidebar.test.ts`、`App.test.tsx` 覆盖。）
- `selectSession` 经 `getSession` 拉满投影、`upsert` 进列表。
- SSE 疑难杂症仍待：`EventSource` 薄封装打点 `lastEventId`/`readyState`/截断 payload、可选 `?sseDebug=1` 等对拍。
- Markdown 气泡：`react-markdown` + `remark-gfm`、禁 raw HTML；`MarkdownContent.test.tsx` + `App.test.tsx` 覆盖标题/GFM。
- CWD badge：两行展示路径，`overflow-wrap`/`word-break`、侧栏 `min-width:0` 防止长路径撑破。
- **Reasoning**：后端 `thinking` 流聚合为单次 synthetic `thinking` tool；前端不订 `thinking.delta`。
- 工具卡：`started`/`completed` 同源 `callId` 合并，保留 args；`<details>` 默认收起。
- Composer：Enter 换行；⌘Enter / Ctrl+Enter 等同 Send；快捷键文案 `aria-describedby`。
- Coverage 包含 `frontend/src/main.tsx`，由挂载测覆盖快捷键与 aria。
- `syncSessionRow`：侧栏与选中会话状态对齐 `ProjectionStore`；optimistic running；`run.result`/`run.error` 收敛终端态。结论写回 `docs/rfc.md`、`docs/test.md`。
- 公开仓库清扫：移除 `npm run dev:op` 叙述；密钥说明以 Cursor 控制台为准；`op://` 仅示意可选 secret manager。
- 文档去掉真实用户名与本机绝对路径；设计稿改用相对占位路径。
- `ThinkingCoalescer`（`thinkingFlush.ts`）：后端拼完后成对发出 `tool.started` / `tool.completed`（`thinking`）；单测与 mapper fixture 对齐「mapper 不接裸 thinking delta」。
- 时间线栅格为三列骨架，tool 卡跨列全宽；`__CCR_ROOT__` + `import.meta.hot.dispose` 缓解 HMR 双 mount。
- 品牌与标题统一为 Cursor Remote（`index.html`、README、服务端启动日志）。
- `frontend/public/favicon.svg`；Express 增加 `/favicon.svg` 与 `/favicon.ico` 302。
- Composer **默认空白**，长文案仅作 **`placeholder`**，避免误发；去掉 mock「Fill hello / smoke」快捷填充。
- 删除仓库内 `mvp_sandbox/`、`scripts/run_mvp_once.ts` 与 **`npm run mvp:run`**；日常全靠用户自拟 prompt；需要真实 SDK 走 `RUN_CURSOR_LIVE_TESTS` 临时 cwd。
- 根目录 bilingual README（英文为主 + 中文锚链）、指向 PRD/RFC 等文档；GitHub Actions CI：`typecheck` / `test` / `build`。
- 集成测试方法论对齐 Meta-Skill / T2：先用 **浏览器 MCP（或人肉）** 在 `5177` 跑通真实 local SDK 闭环并写 **`docs/integration_wip.md`** 的验收表，再给 Playwright；避免未定型 UI 先入 CI。
- 手跑一例：会话 → composer → Send → Thinking / shell / edit 等于时间线，`integration_tmp/hello_integration.py` 落盘可验（目录 **`integration_tmp/`** `.gitignore`）。
- **`tests/fixtures/two_sum`** + **`tests/two_sum_harness.node.test.ts`**：stdlib unittest 作为与 UI 解耦的小型结果确定性示例；暂未引入 Playwright dependency。

## 经验教训

- Cursor API key 只能留在服务端；浏览器/移动端应打自有后端而非直连 Cursor。
- 首期价值在 SDK 是否能提供足够 **run/session/stream/diff 元数据** 支撑远端控制形态，不只是 UI。
- OpenCode iOS 强耦合其 REST/SSE；接 Cursor 时应先在后端抽象出稳定协议再给客户端改。
- Cursor SDK 可能拉原生组件，默认单测别太激进并行初始化，除非你已摸清 live 行为。
- 证据链条里 Cursor 难有稳定一等 diff API；展示变更更稳妥的路线常是 PR URL + GitHub API。
- Cloud run 只能说明远端派发；**本地文件远端控制** 要看 local runtime。
- 借鉴 OpenCode 的是 **分层**：REST 承载状态，SSE 承载增量，timeline 聚合 text/tool/status。
- SDK 侧的 `assistant` / `thinking` / `tool_call` / `status` / `task`（及 delta）够 Stage 1 使用；payload 只做 best-effort 解析。
- `Agent.resume()` 恢复 agent 与被中断 run 不完全等价；应用级单调 event replay 应与 SDK resume 拆开设计。
- 默认测与 live 测分层：CI 不测网；live 用来暴露帐号、模型、超时、SSE、schema 漂移。
- Live 测试 cwd 必须用临时目录，成功标准落在文件、序列、replay 一致性等客观产物上。
- `ProjectionStore` 应对同一日志 `rebuild/apply` 得到相同物化视图；Cursor payload 仍可 `unknown`，仅生命周期载荷强类型。
- Stage 2 仍可暂时保留老旧阻塞路由作迁移过渡，新会话路径走异步 + ProjectionStore。
- 浏览器原生 `EventSource` + GET SSE + `Last-Event-ID` 对 Stage 1 够用，不必引额外流式库。
- `run.stream()` 可能早于 `wait()` 先给终点 `FINISHED`，集成测要等到 `run.result` 再过关以免假阴性。
- 测过流不等于产品过关；交付标准是「会话 + 可控 timeline」体验对齐 OpenCode 类产物。
- 同一 session 维度同时维护列表与选中项两套投影时，SSE/乐观路径必须 **`upsert` 同源规则**，否则列表与正文状态会假性脱节。
