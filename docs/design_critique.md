# Design Critique: Cursor Remote-Control Chat Client

## What the UI is trying to be

The product target, defined in `prd.md` and `rfc.md`, is an OpenCode-like local-first web coding client. The user opens a browser, picks a conversation, sends a prompt to a Cursor agent running on a remote machine, and watches that agent work — assistant text, thinking/reasoning, tool calls, status changes — all rendered inline in a chat timeline. The interaction model is conversation, not launch-and-monitor. The visual model is a two-pane layout: a narrow conversation sidebar for navigation, and a wide main pane with a scrollable timeline plus a sticky composer at the bottom.

The current implementation has the right structural bones: 280px sidebar, chat pane with header/timeline/composer grid, timeline projection that emits user/assistant/thinking/tool/status items. The question is whether the current rendering and interaction detail match the target experience closely enough to feel like a coding client rather than a prototype dashboard.

## Evidence from the captured layout

Two Playwright snapshots anchor this critique. The "before" snapshot shows the empty state (welcome card, no messages). The "after-run" snapshot shows a completed conversation with one user message, one assistant message, and one status row.

Key measurements from the after-run snapshot at 1440×1000:

| Element | Position | Dimensions |
|---|---|---|
| Sidebar | x=0 | 280px wide, full height |
| Header bar | y=0..105 | 1160px wide |
| Timeline area | y=105..709 | 1160px wide, 604px tall |
| User message bubble | x=1186 | 228px wide, 77px tall |
| Assistant message bubble | x=306 | 181px wide, 77px tall |
| Status row | x=306 | 814px wide, 49px tall |
| Composer area | y=708..1000 | 292px tall |

From the styles and component code: timeline items max out at 780px wide; user items are right-aligned with `max-width: min(720px, 86%)`; assistant items are left-aligned; thinking/status items use dashed borders; tool items get a left colored stripe. The timeline uses `grid` with `align-content: start` and 12px row gap. The composer is a form with model input (max-width 240px), prompt textarea (min-height 96px, monospace), and two action buttons.

## P0: Issues that block the OpenCode-like coding-client experience

### P0-1. Timeline messages render in wrong chronological order

Evidence: In the after-run snapshot, the user bubble (x=1186, "Say hello and nothing else.") appears visually above the assistant bubble (x=306, "Hello."). But the `createdAt` sort in `buildTimeline` places earlier items first. The underlying problem is that `createOptimisticUserMessage` prepends the optimistic message to the array (`[optimistic, ...currentMessages]`), and the timeline builder reverses messages during iteration. Combined with the chronological sort, this means the first user message and the assistant response may not appear in the expected top-to-bottom reading order that a chat client demands.

An OpenCode-like client expects messages to read top-to-bottom: oldest first at the top, newest at the bottom, with auto-scroll to the latest. The current sort direction and prepending pattern create ambiguity. The fix is straightforward: the timeline should render in ascending chronological order, the container should auto-scroll to the bottom on new items, and the optimistic user message should be appended, not prepended, or the sort should guarantee visual order matches conversational order.

Specifically, `buildTimeline` does `[...items.values()].sort((l, r) => l.createdAt.localeCompare(r.createdAt))`, which is ascending — oldest first. That's correct for a chat timeline. But `createOptimisticUserMessage` prepends (`[message, ...currentMessages]`), and then `buildTimeline` reverses (`[...messages].reverse()`) before processing. This double inversion means the optimistic message's `createdAt` must be earlier than the assistant message's for correct ordering. If SSE events arrive with earlier timestamps due to clock skew or server-side timestamp generation, the order breaks. The rendering logic should not depend on timestamp precision between client and server.

Concrete fix: change `createOptimisticUserMessage` to append, remove the reverse in `buildTimeline`, and render the array as-is in ascending order. Add a `useEffect` that scrolls the timeline container to the bottom whenever `timelineItems` changes.

### P0-2. No auto-scroll to latest activity

Evidence: The timeline container is `overflow: auto` with `align-content: start`. There is no scroll behavior code anywhere in `main.tsx`. When a run is active and events stream in (assistant deltas, thinking blocks, tool cards), the timeline grows upward but the viewport stays pinned to the top. The user must manually scroll to see new content.

In an OpenCode-like client, the primary activity is watching an agent work. If the user has to keep scrolling to follow the agent, the core interaction loop is broken. Every coding chat client (ChatGPT, Claude, Cursor itself) auto-scrolls to the latest content during streaming, then releases scroll lock when the user scrolls up.

Concrete fix: add a `useRef` on the timeline `<div>`. Add a `useEffect` that watches `timelineItems.length` and calls `container.scrollTop = container.scrollHeight` after render. Only auto-scroll if the user is already near the bottom (within ~150px). When the user scrolls up past that threshold, stop auto-scrolling until they scroll back down or a new user message is sent.

### P0-3. Status row renders as a separate article spanning full width, breaking visual grouping

Evidence: The status row ("Run run-3761…ca6bc4 is completed") renders at x=306 with width=814px — it stretches nearly the full timeline width. The assistant bubble above it is only 181px wide. Visually, the status row looks like a top-level timeline entry rather than metadata attached to the assistant's response. There is no visual nesting, no indent, no shared container.

In the PRD, the timeline is supposed to show "user prompt, assistant text, thinking/activity, tool call cards, run status, final result and error" as a coherent narrative. A run status that describes the same run as the assistant bubble should be visually associated with it — either inside the assistant card, immediately below it with a subtle indent, or connected by a timeline thread line.

Concrete fix: status items that share a `runId` with an adjacent assistant item should render inside or immediately below the assistant bubble, with reduced padding and a muted style. Alternatively, group all items for a single run into a collapsible section with the run status as the section footer. The minimum viable fix: render run-status items with the same `max-width` and alignment as the parent assistant item, not as a full-width standalone article.

### P0-4. User message bubble is too narrow for meaningful prompts

Evidence: The user bubble at x=1186 is only 228px wide. The actual user message in the snapshot is "Say hello and nothing else." — 30 characters, fits easily. But real prompts (like the smoke test: a multi-line Python file creation instruction) will be much longer. The bubble's max-width is `min(720px, 86%)`, which should be adequate. The narrow 228px measurement suggests the bubble is sizing to its short content and right-aligning near the edge, leaving ~700px of empty space in the timeline.

The real issue is not the CSS max-width but the visual weight. At 228px, the user bubble occupies ~19% of the 1160px main pane. The assistant bubble at 181px is ~16%. Together they use ~35% of the horizontal space. The remaining 65% is empty. This creates a sparse, disconnected feel — messages look like isolated cards floating in a void rather than a connected conversation thread.

Concrete fix: increase the minimum width of user and assistant bubbles so short messages don't collapse to tiny cards. A reasonable minimum is 40-50% of the timeline width. Alternatively, reduce the horizontal padding on the timeline (currently 26px per side = 52px, leaving 1108px for content) and let bubbles stretch wider. The timeline should feel like a dense conversation stream, not a sparse card layout.

## P1: Issues that materially improve usability

### P1-1. No streaming indicator or progress affordance during active runs

Evidence: The header shows a small pill "● Streaming run-3761…" when a run is active, but the timeline itself has no visual indicator that the agent is currently working. When the assistant is streaming deltas, the assistant item label says "Cursor · streaming" in plain text, which is easy to miss. There is no pulsing dot, no spinner, no animated border, no "agent is typing" indicator.

A coding client's core anxiety is "is it doing something?" The user sends a prompt and needs immediate, persistent confirmation that the agent received it and is working. OpenCode uses a running tool card that stays expanded, with a visible activity pulse. The current UI has a static text label.

Concrete fix: add a subtle CSS animation (pulsing border, animated dot, or shimmer) to assistant items with `status: 'streaming'`. Add a small indicator at the bottom of the timeline when a run is active — a "Cursor is working…" bar with an animated element. The header streaming pill is a good start but is too far from the content area to serve as the primary progress signal.

### P1-2. Tool call card shows raw callId in a `<code>` block

Evidence: The `TimelineItemView` for tool items renders `{item.status === 'running' ? '●' : '✓'} {item.name} {item.callId}` with `callId` wrapped in a `<code>` tag. In practice, `callId` is a Cursor SDK internal identifier. Showing it as a prominent code element adds noise — the user doesn't need to see the internal call ID. The tool name (e.g., "write_file", "read_file") is the useful identifier.

Concrete fix: remove the `callId` display from the default view. If needed for debugging, put it behind a disclosure triangle or in a tooltip on hover. The tool header should show: status icon, tool name, and optionally a one-line summary of what the tool is doing (file path, command, etc.).

### P1-3. Composer model input is always visible and editable

Evidence: The composer shows a "Model" input field (max-width 240px) with the value "composer-2" at all times. This is a power-user setting that most users will set once and never touch again. Having it as a permanent, prominent element in the composer wastes vertical space and adds cognitive load.

Concrete fix: collapse the model input into a small label or dropdown that shows the current model but only expands to edit on click. Alternatively, move it to the header bar next to the session metadata, or hide it behind a settings gear icon. The composer should be dominated by the prompt textarea, not split between model input and prompt.

### P1-4. Empty state "Fill Python hello world prompt" button is orphaned after first use

Evidence: The empty-state card shows a "Fill Python hello world prompt" button that populates the textarea with the smoke test prompt. This is useful for first-time validation. But after the first run, when the user clears all messages and returns to an empty timeline, this MVP-specific button reappears. It's a testing artifact, not a product feature.

Concrete fix: only show the smoke test button in development mode (e.g., when `health.runtime === 'mock'` or a query parameter is set). In the normal empty state, show a simpler prompt: "Send a task to start working."

### P1-5. Timeline has no timestamp display

Evidence: The timeline items show no timestamps at all. The `TimelineItem` type carries `createdAt`, but `TimelineItemView` never renders it. For a coding client where the user might walk away and come back, timestamps are essential for understanding what happened and when. They also help distinguish between items from different runs in the same session.

Concrete fix: render a relative timestamp (e.g., "2m ago", "just now") in the timeline label area, next to the role indicator. On hover, show the full ISO timestamp. Keep it small and muted — it's reference information, not primary content.

### P1-6. No visual run grouping in the timeline

Evidence: The timeline is a flat list of items. When a session has multiple runs, user messages, assistant responses, thinking blocks, tool cards, and status rows from different runs all interleave without visual separation. There is no divider, no run label, no collapsible section to distinguish "Run 1" from "Run 2."

For sessions with follow-up prompts (a stated PRD requirement: "一个 session 至少支持第一次 run 完成后的 follow-up prompt"), the flat timeline becomes confusing. The user can't tell where one task ends and another begins.

Concrete fix: add a thin horizontal divider or run header between runs in the same session. The header can be minimal: "Run · completed · 2m ago" in muted text. Alternatively, visually group consecutive items with the same `runId` by giving them a shared left border or background tint.

## P2: Polish items

### P2-1. Sidebar "Cursor Remote" eyebrow + "Conversations" heading takes too much vertical space

The sidebar header uses two lines of text plus 22px top padding and an 18px gap below. At 41px total height it's acceptable, but the "Cursor Remote" eyebrow at 0.7rem/800-weight with 0.12em letter-spacing feels over-designed for what is effectively a product name. A single line "Conversations" or a logo mark would be tighter.

### P2-2. "New conversation" button is just a "+" character

The circular icon button at x=229 contains only "+" in plain text. No tooltip, no aria-label beyond `aria-label="New conversation"`. For a button that triggers a significant action (creating a new session), a slightly larger hit target and a visible label or hover tooltip would reduce ambiguity.

### P2-3. Status badges in sidebar are always visible but rarely change

The three status badges (Runtime, API, CWD) occupy 90px of vertical space and display values that change only on server restart. Once the user has confirmed the environment is configured, these badges become visual noise. They could collapse to a single "Environment: ready" indicator, with the detailed badges revealed on hover or click.

### P2-4. Session row shows "ready" instead of run status for idle sessions

The session row renders `candidate.status === 'idle' ? 'ready' : candidate.status`. The word "ready" is ambiguous — ready for what? It would be clearer to show the last action: "Last run completed · 5m ago" or simply the last run status with a timestamp.

### P2-5. Composer textarea uses monospace font for all prompts

The textarea has `font-family: "JetBrains Mono", "SF Mono", "Fira Code", monospace` and a light gray background. This is appropriate for code-heavy prompts but heavy-handed for general tasks like "Explain what this function does." Consider switching to the body font by default and only using monospace when the prompt contains code-like patterns (e.g., lines starting with indentation or containing code fences).

### P2-6. No keyboard shortcut hints

The composer has no mention of keyboard shortcuts. Common expectations: Enter to send (with Shift+Enter for newline), Escape to clear. Adding a small "Shift+Enter for newline" hint below the textarea would reduce friction.

### P2-7. Refresh button is a plain text button with no loading state feedback beyond text

The Refresh button changes its text to "Refreshing…" during refresh, but has no spinner or visual indicator. For an action that might take a moment (especially over Tailscale), a small spinner or opacity change would give better feedback.

## Recommendation: what to implement first

Fix P0-1 through P0-4 before any other work. These four issues directly prevent the UI from reading as a chat client. P0-1 (chronological order) and P0-2 (auto-scroll) are the highest priority because they break the fundamental interaction: send a prompt, see the response appear. P0-3 (status row grouping) and P0-4 (bubble width) are close behind because they determine whether the timeline feels like a conversation or a scattered card list.

After the P0 items, P1-1 (streaming indicator) and P1-5 (timestamps) give the most usability improvement per unit of implementation effort. P1-2 (remove raw callId) and P1-3 (collapse model input) are quick wins that reduce noise. P1-6 (run grouping) becomes important as soon as follow-up prompts are common.

P2 items can wait until the interaction model is solid. None of them block the coding-client experience; they improve comfort and professionalism.
