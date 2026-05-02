# Design Review：Cursor Remote-Control Console

## Context

本轮 review 基于当前 POC UI 的 Playwright 截图和 accessibility snapshot。截图文件在本机工作区：`/Users/grapeot/co/knowledge_working/cursor-remote-current-ui.png`。当前界面是单列 980px 居中 layout：hero、status panel、prompt form、runs list。它已经能表达产品逻辑，但视觉气质仍然像内部 POC。

目标不是做一个花哨的消费级界面，而是做一个精密、安静、可信的 developer console。这个产品会远程控制 Cursor agent 修改代码，UI 的职责是让用户感到系统可控、状态清楚、每个动作都有反馈。

## Current Diagnosis

当前 UI 做对了三件事。第一，信息分区合理：顶部解释产品，状态区确认环境，表单发起 run，底部展示历史。第二，Inter/system font、浅灰背景和白色圆角卡片是安全的 developer SaaS 基底。第三，Start Cursor run 作为主动作有足够视觉权重。

主要问题也很集中。第一，hero 占用过多视觉空间，像 landing page，不像控制台。第二，status panel 和 form panel 彼此割裂，缺少 ready -> launch 的流程感。第三，input/textarea 还保留了默认表单的气味，边框、focus、mono treatment 都不够精细。第四，runs list 的信噪比低，完整 UUID 和 prompt 原文抢走了用户真正关心的状态和摘要。

## Product Feel

设计关键词是：精密、安静、可信。

高级感在 developer tool 里不来自大渐变、插画或复杂动效，而来自信息密度、克制色彩和细节一致性。参考方向更接近 Raycast、Warp、iTerm 精调主题，而不是通用 SaaS landing page。界面要保留工具感：状态明确、层级紧凑、技术内容有清楚的 monospace treatment。

## Design Tokens

### Color

```css
:root {
  --color-primary: #2b3a67;
  --color-primary-action: #3561d4;
  --color-primary-hover: #2a4fc0;
  --color-primary-subtle: #e8edf8;

  --color-success: #1a7f37;
  --color-success-bg: #e6f4ea;
  --color-warning: #9a6700;
  --color-warning-bg: #fff8e1;
  --color-error: #cf222e;
  --color-error-bg: #ffebe9;

  --color-bg: #f4f6fa;
  --color-surface: #ffffff;
  --color-border: #d8dee9;
  --color-border-subtle: #e8ecf1;
  --color-text-primary: #1a1f36;
  --color-text-secondary: #5c6370;
  --color-text-tertiary: #8b929e;
  --color-mono-bg: #f0f2f5;
  --color-mono-text: #3561d4;
}
```

色相控制在靛蓝、绿色和灰阶内。靛蓝承担产品主色，绿色只表达 ready/completed，灰阶负责所有结构和文本层级。

### Typography

```css
:root {
  --font-sans: Inter, -apple-system, BlinkMacSystemFont, sans-serif;
  --font-mono: "JetBrains Mono", "SF Mono", "Fira Code", monospace;

  --text-xs: 11px;
  --text-sm: 13px;
  --text-base: 14px;
  --text-lg: 16px;
  --text-xl: 20px;
  --text-2xl: 24px;
}
```

Hero 标题应从 landing-page 级别收回到 console header 级别。Prompt textarea 和 run ids 使用 mono font；普通说明和 label 使用 sans。

### Shape and Shadow

```css
:root {
  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 14px;
  --radius-xl: 18px;

  --shadow-sm: 0 1px 2px rgba(16, 24, 40, 0.05);
  --shadow-md: 0 2px 8px rgba(16, 24, 40, 0.08);
  --shadow-lg: 0 4px 16px rgba(16, 24, 40, 0.12);
}
```

当前 22px panel radius 偏软。主面板建议 14-18px，input 10px，badge 6px。阴影应使用冷调 rgba，不要用重黑影。

## Information Architecture

当前结构是 Hero -> Status -> Form -> Runs。短期可以保持单页，但要把它从 landing page 改成 console：

```text
Header: product name + environment badges
Launcher: prompt + quick actions + model/cwd metadata
Runs: compact run history
```

Stage 1 完整 UI 应进入三栏结构：

```text
SessionSidebar (240px)
MessageTimeline (flex)
ActivityPanel (320px)
```

SessionSidebar 显示 sessions 和 recent runs；MessageTimeline 渲染 user/assistant/tool/thinking；ActivityPanel 显示 runtime、cwd、model、active run status、diff summary 和 tool cards。这样能从根上解决当前单列界面的信息拥挤和流程割裂。

## Component Direction

### Header and Status

删除大 hero。顶部改成紧凑 header：左侧是产品名和一句短说明，右侧是环境 badge。

状态 badge 使用圆点 + label + value：

```text
● Runtime local
● API configured
● CWD set
```

成功态用绿色圆点和浅绿背景；warning/missing 用 warning 色；failed/error 用 error 色。用户应在 0.5 秒内判断环境是否 ready。

### Launcher Form

Prompt textarea 使用 mono font、浅灰代码背景、清楚 focus ring。它是发给 agent 的指令，不应和普通 text input 长得一样。

MVP buttons 收进 Quick actions 容器。Quick actions 用浅靛蓝背景和小标题，按钮降级为 outline / secondary，避免和 Start action 抢层级。

Start button 不必全宽。建议 `fit-content` 并右对齐：这更像控制台里的明确动作，而不是 marketing form 的大 CTA。

### Runs List

Runs list 是当前最需要改的区域。列表项应从大卡片改成紧凑 timeline row：

```text
● completed   create hello_world.py · 2 min ago
  run-2a0e…ed14
```

完整 UUID 不在默认列表显示，只显示短 id。Prompt 原文改成摘要，最多一行；完整内容可以 hover/title 或详情里看。列表项高度控制在 56-64px，使用 subtle border 分隔而不是每项一个厚卡片。

### Activity / Tool Cards

Stage 1 进入 SSE 后，activity panel 应显示 running tool card、thinking block、status row 和 diff summary。Tool card 默认运行时展开、完成后收起。Thinking 与 assistant output 视觉上分开，不承诺展示 raw chain-of-thought，只展示 product activity / reasoning summary。

## Interaction Details

- 所有 input/button 增加 150ms hover/focus transition。
- Focus ring 使用 `0 0 0 3px rgba(53, 97, 212, 0.12)`。
- Button hover 可以 `translateY(-1px)`，但不要做弹跳或夸张动效。
- Loading 状态用 status text + disabled button，不需要 skeleton。
- Runs row hover 使用 `--color-primary-subtle` 的轻背景，为后续点击详情预留。

## Acceptance Criteria

1. 顶部 hero 高度降到当前的一半以下，页面第一屏更像 console 而不是 landing page。
2. Runtime/API/CWD 都用 badge 表达，ready/missing 状态一眼可读。
3. Prompt textarea 有 mono treatment 和 focus ring，不再像默认 textarea。
4. Runs list 不显示完整 UUID，单项高度不超过 64px。
5. 页面色相不超过三类：靛蓝、绿色/语义色、灰阶。
6. 主按钮和 secondary/quick action 的层级清楚，MVP quick action 不抢 Start action。
7. Playwright 截图验证新 UI 已进入页面；console 无新增错误。

## Things to Keep

- Inter/system font 作为 sans baseline。
- 浅色主题方向。
- Prompt -> repo/ref/model -> submit 的表单逻辑顺序。
- Runtime / API key / Local cwd 作为最小环境状态集。
- Cursor-only、Tailscale-only 的产品边界，不为 UI 引入 provider 或 auth 概念。
