# Test Strategy：Cursor Remote Control Evaluation Plan

## 原则

测试分成两条线。默认测试证明我们自己的代码、协议和状态投影正确；live Cursor 测试判断当前 Cursor SDK/API 是否可用。两者共享同一套接口形状、event fixtures、sandbox 和 diff 断言，但不能混在一起。默认 `npm test` 不访问网络、不需要 Cursor API key；`RUN_CURSOR_LIVE_TESTS=1` 才允许调用真实 Cursor。

Stage 1 的测试目标不是追求 UI 覆盖率，而是让 agent 能自我判断这套 remote-control API 是否真的 work：HTTP route 是否返回正确状态，SSE 是否按顺序产生 event，event log 是否可以 replay，Cursor stream 是否能映射成 app event，local sandbox 是否真的被修改，diff 是否能客观检测结果。

## 当前覆盖边界

当前测试覆盖的是 Stage 0 POC：

- `tests/config.test.ts`：覆盖 `loadConfig()` 的默认值、空白 optional env 和 runtime 解析。
- `tests/runStore.test.ts`：覆盖内存 `RunStore` 的 upsert、get 和逆序 list。
- `tests/cursorAgent.test.ts`：覆盖 mock gateway 输出、缺少 API key / cwd / repo 时的 fail-fast，以及 gateway factory routing。
- `tests/app.test.ts`：覆盖 health 不泄露 secret、空 prompt validation、阻塞式 run 创建与列表读取。

这些测试还没有覆盖 Stage 1 所需的 `Session -> Run -> Event`、SSE replay、projection、local diff、frontend event projection 和 live Cursor sandbox。

## 默认 deterministic suite

默认 suite 必须在没有 Cursor token 时通过。它使用 dependency injection 注入 mock gateway、临时时钟、固定 ID generator、内存/临时文件 EventStore、sandbox cwd 和 fake DiffProvider。

| 层级 | Test cases | 判据 |
|---|---|---|
| Config | 默认 `runtime=mock`、默认 `model=composer-2`、自定义 local cwd、invalid port/runtime fallback、secret masking | 不返回 raw key；非法配置有明确错误或 fallback |
| Request validation | 空 prompt、过长 prompt、客户端试图覆盖 cwd/API key、非法 session/run id | 返回 400；错误码稳定 |
| EventStore | append 单调 id、按 session/run 查询、`Last-Event-ID` replay、空 replay、重启后从 JSONL 重建 | event 顺序稳定；projection 一致 |
| ProjectionStore | 从 event log 重建 session、run、message、activity、diff summary | 同一 event log 重放两次得到同一结果 |
| Cursor stream mapper | fixture 中的 assistant/thinking/tool/status/task/request/unknown event 映射到 app event | unknown event 不 crash，保留诊断信息 |
| EventBroker/SSE | live subscribe、unsubscribe cleanup、heartbeat、终止事件、error event、replay 后 tail live | SSE client harness 能断言 id、type、payload 顺序 |
| API integration | create session、start run 立即返回、list messages、get run、SSE events、gateway error -> 502、not found -> 404 | 不等待 `run.wait()`；所有响应不含 secret |
| Mock gateway | synthetic run 产生 queued -> running -> assistant/tool/result -> completed | mock 与真实 app event schema 一致 |
| DiffService | git repo baseline、changed files、stat、无变更、非 git repo graceful degradation | 不因 diff 不可用导致 run 失败 |
| Frontend projection | event fixtures -> session list、timeline、activity panel、status badge、diff card | UI state 纯函数可测，避免只靠浏览器手测 |

## Live Cursor suite

Live tests 显式 opt-in。`.env` 里的产品 cwd 可以指向本 repo，但 live tests 必须覆盖为临时 sandbox cwd：

```bash
RUN_CURSOR_LIVE_TESTS=1 CURSOR_API_KEY=crsr_... npm test -- --run tests/live.cursor.test.ts
```

默认模型固定为 `composer-2`。用户会把 token 写进 `.env`；测试代码只读取环境变量，不依赖 1Password service account。产品默认 `CURSOR_LOCAL_CWD=/Users/grapeot/co/knowledge_working/adhoc_jobs/cursor_cloud_remote_poc`，用于后续自举开发；Live tests 的 cwd 必须是一次性 sandbox，不允许指向这个真实 repo。Sandbox 由测试创建和清理：

```text
tmp/cursor-live-<id>/
  .cursor/sandbox.json
  README.md
  hello.py
```

`sandbox.json` 使用 `workspace_readwrite`，允许 Cursor 修改 sandbox 内文件。测试结束后 dispose agent 并删除 sandbox。Live prompt 只做短任务，默认 thinking 参数用 low；费用不是关键约束，但测试仍要可重复、可诊断、可超时。

Live test matrix：

| ID | 目标 | Prompt / 操作 | 成功判据 |
|---|---|---|---|
| LIVE-00 | API token 和模型可用 | `Cursor.me()`；`Cursor.models.list()` 查 `composer-2` | 能拿到 user/key metadata；模型存在 |
| LIVE-01 | local run 最短闭环 | `Say hello and nothing else.` | `run.stream()` 收到 system/user/assistant；`run.wait()` finished；assistant text 包含 hello |
| LIVE-02 | 文件写入 | 创建 `hello.txt`，内容为 `Hello World` | tool call completed；文件存在；内容匹配；diff 有 changed file |
| LIVE-03 | 文件读取和精确修改 | 预置 `hello.py`，要求给 `greet()` 加 docstring | 有 read/edit 或 write tool；文件内容变化；diff summary 非空 |
| LIVE-04 | follow-up context | 第一轮记住 `kumquat`，第二轮只回答 secret word | 同一 agent 第二轮回答包含 `kumquat` |
| LIVE-05 | app-level SSE smoke | 通过本 app API 创建 session/run，并订阅 `/events` | HTTP 立即返回；SSE 收到 queued/running/assistant或tool/result/completed；event log 可 replay |
| LIVE-06 | event replay consistency | live run 结束后用 `Last-Event-ID` 重新订阅 | replay events 与存储 event id 顺序一致，不重复、不丢失 |
| LIVE-07 | local diff integration | run 前 baseline，run 后 diff snapshot | changed files 包含目标文件；stat 与磁盘内容一致 |
| LIVE-08 | cancel/resume probe | 只在 SDK 行为明确后启用 | cancel 返回 cancelled；resume 后 agent metadata 可恢复 |

## Evaluation commands

日常开发必须跑：

```bash
npm run typecheck
npm test
npm run build
```

覆盖率检查：

```bash
npm run coverage
```

Live Cursor 验证在 token 写入 `.env` 后手动跑：

```bash
RUN_CURSOR_LIVE_TESTS=1 npm test -- --run tests/live.cursor.test.ts
```

Product server 默认绑定 LAN/Tailscale：

```bash
HOST=0.0.0.0 PORT=8787 npm run dev
```

未来可以增加一个 agent-friendly summary command，例如 `npm run eval:live`，输出稳定 JSON：

```json
{
  "apiAvailable": true,
  "model": "composer-2",
  "failureLayer": null,
  "eventsReceived": 12,
  "diffChangedFiles": ["hello.txt"],
  "nextAction": "none"
}
```

## Coverage gate

Coverage gate 聚焦 remote-control core，而不是测试 helper 或入口脚本。Stage 1 完成时，下面模块的主要分支应被 coverage report 覆盖：

- config / contracts validation
- EventStore / ProjectionStore
- EventBroker / SSE replay
- Cursor stream mapper
- mock gateway event sequence
- API routes and error paths
- DiffService
- frontend projection pure functions

初始阈值可以设在核心模块 80% 左右。Live tests 不计入 coverage gate，因为它们判断外部 API 可用性，不证明本地代码分支覆盖。

## Failure diagnosis

| 现象 | 优先判断层 | 第一检查项 |
|---|---|---|
| deterministic test 失败 | app logic / fixture | fixture 是否过期、event schema 是否变化 |
| replay 和原 run 不一致 | EventStore / ProjectionStore | event 是否缺字段、排序是否稳定、ID/clock 是否注入 |
| SSE 收不到终止事件 | streaming layer | server flush、client timeout、error path 是否 emit final event |
| diff baseline 不匹配 | sandbox / diff logic | cwd 是否正确、路径 normalize 是否一致、是否在 git repo |
| live test 401/403 | Cursor token / account | `.env` token 是否存在、权限是否有效 |
| live test schema mismatch | Cursor SDK boundary | mapper 是否记录 raw event 摘要、SDK 版本是否变化 |
| live test timeout | Cursor availability / prompt size | prompt 是否过大、超时是否太短、API 是否降级 |
| fake smoke 过、live smoke 失败 | Cursor integration | 输出 request id、SDK error、raw event type summary |

## Implementation order

测试和实现按同一节奏推进：

1. `EventStore` + tests。
2. `ProjectionStore` + event projection fixtures。
3. `EventBroker` + SSE client harness。
4. `SessionService` / `RunService` + API integration tests。
5. `CursorStreamMapper` + recorded SDK event fixtures。
6. `DiffService` + git sandbox tests。
7. Live Cursor sandbox tests。
8. Frontend projection tests。

任何模块进入 Stage 1 scope 时，都要同时提交实现和测试。删除失败测试来过验证不接受；如果 Cursor live test 因外部 API 不可用失败，应输出 failure layer，而不是降低 deterministic suite 的要求。
