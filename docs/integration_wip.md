# Integration WIP · 端到端验收（先于自动化）

面向 **Meta-Skill**（`rules/skills/skill_creator_skill.md`）与 **T2 结果确定性**（`rules/axioms/t02_results_certainty.md`）：先在真实浏览器里把人机闭环跑通并写下**可验证的成功条件**，再考虑把稳定的检查固化成脚本（Playwright）。过早把未定型的流程程序化，只是把「过程的不确定性」搬进 CI，收益有限。

## 本轮目标（What done looks like）

1. **链路**：前端 `5177`（Vite proxy） ↔ 后端 `8787`，`CURSOR_RUNTIME=local`、`CURSOR_LOCAL_CWD` 与密钥配置正确。
2. **交互**：能选会话 → 能在 composer 填入任务 → Send → 侧栏与时间线呈现 running/completed → 不出现明显 UX 错误（空白死区、错乱折叠、错位 badge）。
3. **结果核验（客观）**：在约定 cwd 下出现预期产物或可重复命令（本轮见下方 Session log）。

### 可选强化（建议在真 token 冒烟时）

- 每次开始前在 shell 中建临时目录，把 **`CURSOR_LOCAL_CWD`** 指到该目录，避免弄脏主分支工作树（本机 `npm run dev` 仍会热加载；改 `.env` 后重启后端）。
- 仍把「看一眼 UI」当人眼验收的一环；无障碍树 / 截图只能覆盖部分观感。

---

## Session log

### 2026-05-01 — 浏览器 MCP 手跑 · local SDK

| 步骤 | 结果 |
|------|------|
| 打开 `http://localhost:5177/` | Runtime / API / CWD 绿标后与「Remote console」会话对齐 |
| 填入创建 `integration_tmp/hello_integration.py` 的简短指令 → Send | 时间线出现 Thinking / shell / read / edit、最终 assistant 正文与 **Run … completed** |
| 磁盘验收 | `integration_tmp/hello_integration.py` 单行 `print("integration_ok")` ✅（目录已 `.gitignore`） |

已知观察（非阻塞）：无障碍快照里扁平 `listitem` 较多（工具卡展开明细），可读性主要靠视觉布局；若要改进可单独开 UI a11y 任务。

### Playwright / 程序化 E2E

**暂缓**。等上表场景在多款任务下都可重复、且无 UX regressions 后再引入；届时把「本节目标」转成可重复的 `expect` / 截图基线。当前仓库保留 **`tests/fixtures/two_sum`** + **`tests/two_sum_harness.node.test.ts`**（stdlib unittest，不经网络），作为小规模 **结果确定性** 样例，与浏览器 UI 无强耦合。

---

## 下一轮待办（自行勾选）

- [ ] 切换 `CURSOR_LOCAL_CWD` 到 **`mktemp -d`** 路径再跑同款任务。
- [ ] 多会话切换 + 未完成 run 时侧栏与时间线对齐抽查。
- [ ] 补齐后再写 Playwright：`webServer` 双进程 + mock **或** staging 密钥（仅存 CI secret）。
