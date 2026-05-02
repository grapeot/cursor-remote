# Cursor Remote

Browser UI + Node backend experiment: prompts go to a small server on your machine, which drives [`@cursor/sdk`](https://www.npmjs.com/package/@cursor/sdk) agent runs **without putting Cursor credentials in the client**. Mock mode stays on by default so the stack runs before you wire a real key.

**中文版** · [简体说明（跳转到下方](#readme-zh)

## Documentation (source of truth)

Read these **before changing behavior or shipping UI**:

| Doc | Purpose |
| --- | --- |
| [`docs/prd.md`](docs/prd.md) | Product goals, staged scope, UX direction (coding chat client, not raw event spam). |
| [`docs/rfc.md`](docs/rfc.md) | Architecture: `Session → Run → Event`, SSE projections, adapters, rationale vs OpenCode cloning. |
| [`docs/design.md`](docs/design.md) | Visual / interaction constraints (premium dev console vibe, timeline rendering). |
| [`docs/test.md`](docs/test.md) | Testing strategy (mock-heavy, optional live Cursor). |
| [`docs/working.md`](docs/working.md) | Working log / checkpoints. |

| [`docs/integration_wip.md`](docs/integration_wip.md) | 浏览器端到端手跑日志与验收清单（先于 Playwright）。 |

## Design goals (short version)

The long-form goals live in **`docs/prd.md`** + **`docs/rfc.md`**. In one glance:

1. **OpenCode-shaped client, Cursor-only spine** — Conversations sidebar, timeline, composer; SSE + REST projections; **not** multi-provider adapters.
2. **Local-first, key on server only** — `CURSOR_API_KEY` stays in `.env` on the host; LAN/Tailscale exposure is intentional; browser never holds the Cursor secret.
3. **Async runs with replayable projections** — Create runs without blocking HTTP; timeline materializes from modeled events/thinking/tool activity, not a raw SSE dump for end users.

## Prerequisites

- **Node.js** 22+ recommended (matches toolchain in this repo).
- **npm** (workspaces: root server + `frontend/`).

## Quick start

```bash
npm install
cp .env.example .env
# Set CURSOR_API_KEY when leaving mock mode (see below).
npm run dev
```

- Web client: **`http://localhost:5177`**
- API / SSE backend: **`http://localhost:8787`**

Frontend dev-server proxy: set **`CURSOR_REMOTE_VITE_API_ORIGIN=http://localhost:<backend-port>`** if the backend is not on 8787.

## Configuration

Copy **`.env.example`** → **`.env`**. Sensitive values must not be committed.

| Variable | Role |
| --- | --- |
| `CURSOR_API_KEY` | Required for live Cursor SDK; omit or use mocks for playground. |
| `CURSOR_RUNTIME` | `mock` \| `local` \| `cloud` — **`mock`** keeps everything runnable offline. |
| `CURSOR_LOCAL_CWD` | Directory the agent sees when `CURSOR_RUNTIME=local` (`.` = checkout root unless you override). |
| `CURSOR_DEFAULT_REPO_URL` | Cloud runs: `https://github.com/<owner>/<repo>`. |

Optional secret managers (illustrative only):

```bash
CURSOR_API_KEY="$(op read 'op://YourVault/ExampleItem/credential')" npm run dev
```

Mock mode skips that entirely.

### Local SDK from the UI

With `CURSOR_RUNTIME=local`, `CURSOR_LOCAL_CWD`, and `CURSOR_API_KEY` set, restart `npm run dev` and type your task in the composer (empty by default—the grey text is placeholder only).

## Runtime modes at a glance

| Mode | When to use |
| --- | --- |
| **`mock`** | Default demos, deterministic UI/tests, CI. |
| **`local`** | Real SDK against local checkout — primary product path per PRD/RFC. |
| **`cloud`** | Cursor cloud agent + GitHub repo; comparison path only. |

## Commands

```bash
npm run typecheck
npm test
npm run coverage
npm run build
npm run lint
```

Production-style entry after `npm run build`:

```bash
npm start   # serves dist/server
```

GitHub Actions **CI** (`typecheck`, `test`, `build`) runs on pushes and PRs to `master`.

## Security posture

Assume **Tailscale/VPN/LAN**, not anonymous internet. Authenticate networks yourself; application-layer multi-user OAuth is explicitly out of scope for now (see `docs/prd.md`).

<div id="readme-zh"></div>

## 中文版

（默认以英文为主体；本节为中文速览；细节仍以 `docs/` 为准。）

**英文版**：[回到文档索引与英文说明](#cursor-remote)

### 项目做什么

用小型的 **Node + Express** 服务端持有 **Cursor API key**，浏览器只跟自己的后端通讯，通过 SSE 等手段把会话、运行状态和聊天时间轴推到前端。**默认 mock**，无 key 也可跑。

### 设计目标（简述）

完整叙述见 **`docs/prd.md`**、**`docs/rfc.md`**：**单用户、local-first、只服务 Cursor**，产品形态对齐 OpenCode 式 coding client（侧边会话 + 时间轴 + 输入框），用 Session / Run / Event 模型异步驱动；不把原始 SSE 当主界面；短期不做多 provider connector。

### 文档导航

| 文件 | 内容 |
| --- | --- |
| [`docs/prd.md`](docs/prd.md) | 产品与阶段需求 |
| [`docs/rfc.md`](docs/rfc.md) | 架构与协议取舍 |
| [`docs/design.md`](docs/design.md) | UI/视觉方向 |
| [`docs/test.md`](docs/test.md) | 测试策略 |
| [`docs/working.md`](docs/working.md) | 工作备忘 |

### 快速使用

```bash
npm install
cp .env.example .env
npm run dev
```

浏览器：`http://localhost:5177`；后端：`http://localhost:8787`。要离开 mock：`CURSOR_API_KEY`、`CURSOR_RUNTIME=local`、`CURSOR_LOCAL_CWD`。云端对比路径：`CURSOR_RUNTIME=cloud` + `CURSOR_DEFAULT_REPO_URL`。composer 默认为空；灰色提示仅为 **placeholder**，不会随 Send 送出。

常用命令：`npm run typecheck`、`npm test`、`npm run build`。合并到 **`master`** 后 GitHub Actions 会跑同样检查。
