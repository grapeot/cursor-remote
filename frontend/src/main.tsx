import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactElement, SyntheticEvent } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { HealthResponse } from '../../src/shared/contracts';
import {
  appEventSchema,
  isRunErrorPayload,
  isRunResultPayload,
  isRunStatusPayload,
  readStringField
} from '../../src/shared/events';
import type { AppEvent, AppRunStatus, SessionStatus } from '../../src/shared/events';
import type { MessageProjection, RunProjection, SessionProjection } from '../../src/shared/projections';
import {
  createSession,
  fetchHealth,
  getSession,
  listSessionMessages,
  listSessionRuns,
  listSessions,
  startSessionRun
} from './api';
import { MarkdownContent } from './MarkdownContent';
import {
  effectiveSidebarActivityAt,
  isSidebarSessionUnread,
  loadSessionReadAckFromStorage,
  maxIso,
  persistSessionReadAckToStorage,
  sidebarSessionsSorter
} from './sessionSidebar';
import { buildTimeline, flattenJsonForDisplay, shortRunId } from './timeline';
import type { TimelineItem } from './timeline';
import './styles.css';

declare global {
  interface Window {
    /** HMR-stable React root handle (avoids duplicate createRoot warnings under Vite HMR). */
    __CCR_ROOT__?: Root;
  }
}

const MVP_PYTHON_HELLO_PROMPT = `In this repo, create or overwrite the file mvp_sandbox/hello_world.py with exactly:

print("Hello, world!")

Use nothing else in that file (no shebang, no imports). If mvp_sandbox/ does not exist, create it.`;

const SESSION_STORAGE_KEY = 'cursor-remote.sessionId';

function sessionStatusFromRunStatus(status: AppRunStatus): SessionStatus {
  if (status === 'queued' || status === 'running') {
    return 'running';
  }
  if (status === 'failed') {
    return 'failed';
  }
  return 'idle';
}

export function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [sessions, setSessions] = useState<SessionProjection[]>([]);
  const [session, setSession] = useState<SessionProjection | null>(null);
  const [runs, setRuns] = useState<RunProjection[]>([]);
  const [messages, setMessages] = useState<MessageProjection[]>([]);
  const [events, setEvents] = useState<AppEvent[]>([]);
  const [prompt, setPrompt] = useState(MVP_PYTHON_HELLO_PROMPT);
  const [modelId, setModelId] = useState('composer-2');
  const [error, setError] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const eventSourcesRef = useRef<Map<string, EventSource>>(new Map());
  const sessionEventsCacheRef = useRef<Map<string, AppEvent[]>>(new Map());
  const sessionActivityOverlayRef = useRef<Record<string, string>>({});
  const eventsRef = useRef<AppEvent[]>([]);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const shouldStickToBottomRef = useRef(true);
  const runsRef = useRef<RunProjection[]>(runs);
  runsRef.current = runs;

  const [sessionActivityOverlay, setSessionActivityOverlay] = useState<Record<string, string>>({});
  const [sessionReadAckById, setSessionReadAckById] = useState<Record<string, string>>(loadSessionReadAckFromStorage);

  const activeRun = runs.find((run) => run.status === 'queued' || run.status === 'running');
  const sidebarSessionsOrdered = useMemo(
    () => sidebarSessionsSorter(sessions, sessionActivityOverlay),
    [sessions, sessionActivityOverlay]
  );
  const timelineItems = useMemo(() => buildTimeline(messages, runs, events), [messages, runs, events]);

  useEffect(() => {
    sessionActivityOverlayRef.current = sessionActivityOverlay;
  }, [sessionActivityOverlay]);

  useEffect(() => {
    setSessionReadAckById((prev) => {
      let changed = false;
      const nextMap = { ...prev };
      for (const projection of sessions) {
        if (nextMap[projection.id] === undefined) {
          nextMap[projection.id] = projection.updatedAt;
          changed = true;
        }
      }
      if (!changed) {
        return prev;
      }
      persistSessionReadAckToStorage(nextMap);
      return nextMap;
    });
  }, [sessions]);

  async function loadSessionState(nextSession: SessionProjection): Promise<RunProjection[]> {
    const [nextRuns, nextMessages] = await Promise.all([
      listSessionRuns(nextSession.id),
      listSessionMessages(nextSession.id)
    ]);
    setSession(nextSession);
    setRuns(nextRuns);
    setMessages(nextMessages);
    return nextRuns;
  }

  async function resolveSession(nextSessions: SessionProjection[]): Promise<SessionProjection> {
    const storedSessionId = window.localStorage.getItem(SESSION_STORAGE_KEY);
    const storedSession = nextSessions.find((candidate) => candidate.id === storedSessionId);
    const latestSession = nextSessions[0];
    const nextSession = storedSession ?? latestSession ?? (await createSession('Remote console'));
    window.localStorage.setItem(SESSION_STORAGE_KEY, nextSession.id);
    return nextSession;
  }

  async function refresh(targetSession = session): Promise<void> {
    setIsRefreshing(true);
    try {
      const [nextHealth, nextSessions] = await Promise.all([fetchHealth(), listSessions()]);
      setHealth(nextHealth);
      setSessions(nextSessions);
      if (targetSession === null) {
        const resolvedSession = await resolveSession(nextSessions);
        const sessionExists = nextSessions.some((candidate) => candidate.id === resolvedSession.id);
        if (!sessionExists) {
          setSessions([resolvedSession, ...nextSessions]);
        }
        const initialRuns = await loadSessionState(resolvedSession);
        reconnectStreamingRuns(initialRuns);
        return;
      }
      const refreshedSession = await getSession(targetSession.id);
      const refreshedRuns = await loadSessionState(refreshedSession);
      setSessions((currentSessions) => upsertSession(currentSessions, refreshedSession));
      reconnectStreamingRuns(refreshedRuns);
    } finally {
      setIsRefreshing(false);
    }
  }

  useEffect(() => {
    refresh().catch((refreshError: unknown) => {
      setError(refreshError instanceof Error ? refreshError.message : 'Failed to load app state.');
    });
    return () => {
      eventSourcesRef.current.forEach((source) => source.close());
      eventSourcesRef.current.clear();
    };
  }, []);

  useEffect(() => {
    eventsRef.current = events;
  }, [events]);

  useEffect(() => {
    const timeline = timelineRef.current;
    if (timeline === null || !shouldStickToBottomRef.current) {
      return;
    }
    timeline.scrollTop = timeline.scrollHeight;
  }, [timelineItems.length]);

  async function selectSession(nextSession: SessionProjection): Promise<void> {
    if (session !== null && nextSession.id === session.id) {
      return;
    }
    setError(null);
    const previousSessionId = session?.id;
    if (previousSessionId !== undefined) {
      sessionEventsCacheRef.current.set(previousSessionId, [...eventsRef.current]);
    }
    eventSourcesRef.current.forEach((source) => source.close());
    eventSourcesRef.current.clear();
    const refreshedProjection = await getSession(nextSession.id);
    window.localStorage.setItem(SESSION_STORAGE_KEY, refreshedProjection.id);
    const overlay = sessionActivityOverlayRef.current;
    const readAck = maxIso(new Date().toISOString(), effectiveSidebarActivityAt(refreshedProjection, overlay));
    setSessionReadAckById((prev) => {
      const nextMap = { ...prev, [refreshedProjection.id]: readAck };
      persistSessionReadAckToStorage(nextMap);
      return nextMap;
    });
    const nextRuns = await loadSessionState(refreshedProjection);
    setSessions((currentSessions) => upsertSession(currentSessions, refreshedProjection));
    setEvents(sessionEventsCacheRef.current.get(refreshedProjection.id) ?? []);
    reconnectStreamingRuns(nextRuns);
  }

  async function createConversation(): Promise<void> {
    setError(null);
    const nextSession = await createSession('New conversation');
    setSessions((currentSessions) => [nextSession, ...currentSessions]);
    await selectSession(nextSession);
  }

  async function submitRun(overridePrompt?: string): Promise<void> {
    const effectivePrompt = (overridePrompt ?? prompt).trim();
    if (effectivePrompt.length === 0 || session === null || activeRun !== undefined) {
      return;
    }
    setError(null);
    setIsSending(true);
    try {
      const response = await startSessionRun(session.id, {
        prompt: effectivePrompt,
        modelId: modelId.trim() || undefined,
        runtime: health?.runtime === 'local' ? 'local' : 'mock'
      });
      setRuns((currentRuns) => upsertRun(currentRuns, response.run));
      syncSessionRow(session.id, {
        status: 'running',
        latestRunId: response.run.id,
        updatedAt: response.run.updatedAt
      });
      setMessages((currentMessages) => [
        ...currentMessages,
        createOptimisticUserMessage(session.id, response.run.id, effectivePrompt, response.run.createdAt)
      ]);
      setEvents([]);
      shouldStickToBottomRef.current = true;
      openRunEvents(response.run.id, response.eventsUrl);
      setPrompt('');
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Failed to start run.');
    } finally {
      setIsSending(false);
    }
  }

  async function handleSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    await submitRun();
  }

  function syncSessionRow(
    sessionId: string,
    patch: Partial<Pick<SessionProjection, 'status' | 'latestRunId' | 'updatedAt'>>
  ): void {
    const nextUpdatedAt = patch.updatedAt;
    if (typeof nextUpdatedAt === 'string' && nextUpdatedAt.length > 0) {
      bumpSessionActivityAt(sessionId, nextUpdatedAt);
    }
    setSession((currentSession) =>
      currentSession !== null && currentSession.id === sessionId ? { ...currentSession, ...patch } : currentSession
    );
    setSessions((currentSessions) => {
      const existing = currentSessions.find((candidate) => candidate.id === sessionId);
      if (existing === undefined) {
        return currentSessions;
      }
      return upsertSession(currentSessions, { ...existing, ...patch });
    });
  }

  function bumpSessionActivityAt(sessionId: string, iso: string): void {
    setSessionActivityOverlay((previousOverlay) => {
      const merged = maxIso(previousOverlay[sessionId] ?? '', iso);
      if ((previousOverlay[sessionId] ?? '') === merged) {
        return previousOverlay;
      }
      return { ...previousOverlay, [sessionId]: merged };
    });
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key !== 'Enter') {
      return;
    }
    if (!(event.metaKey || event.ctrlKey)) {
      return;
    }
    event.preventDefault();
    void submitRun();
  }

  function openRunEvents(runId: string, eventsUrl: string): void {
    eventSourcesRef.current.get(runId)?.close();
    const source = new EventSource(eventsUrl);
    eventSourcesRef.current.set(runId, source);
    getSubscribedEventTypes().forEach((type) => {
      source.addEventListener(type, (message) => {
        const parsed = parseAppEvent(message);
        if (parsed === null) {
          return;
        }
        applyRunEvent(parsed);
        if (shouldCloseEventStream(parsed)) {
          source.close();
          eventSourcesRef.current.delete(runId);
        }
      });
    });
    source.onerror = () => {
      setError('Run event stream disconnected. Use Refresh to load the latest projection.');
      source.close();
      eventSourcesRef.current.delete(runId);
    };
  }

  function reconnectStreamingRuns(runsList: RunProjection[]): void {
    for (const run of runsList) {
      if (run.status === 'queued' || run.status === 'running') {
        openRunEvents(run.id, `/api/runs/${run.id}/events`);
      }
    }
  }

  function applyRunEvent(event: AppEvent): void {
    if (event.type !== 'heartbeat' && event.type !== 'tool.delta') {
      bumpSessionActivityAt(event.sessionId, event.createdAt);
    }
    setEvents((currentEvents) => appendTimelineEvents(currentEvents, event));
    const payload = event.payload;
    if (event.type === 'run.status' && isRunStatusPayload(payload)) {
      setRuns((currentRuns) =>
        currentRuns.map((run) =>
          run.id === payload.runId ? { ...run, status: payload.status, updatedAt: event.createdAt } : run
        )
      );
      syncSessionRow(event.sessionId, {
        latestRunId: payload.runId,
        status: sessionStatusFromRunStatus(payload.status),
        updatedAt: event.createdAt
      });
    }
    if (event.type === 'assistant.delta') {
      const text = readStringField(event.payload, 'text');
      if (text !== undefined) {
        setMessages((currentMessages) => appendAssistantDelta(currentMessages, event, text));
      }
    }
    if (event.type === 'run.result' && isRunResultPayload(payload)) {
      const prior = runsRef.current.find((run) => run.id === event.runId);
      const staysTerminal = prior?.status === 'failed' || prior?.status === 'cancelled';
      setRuns((currentRuns) =>
        currentRuns.map((run) =>
          run.id === event.runId
            ? {
                ...run,
                status: staysTerminal ? run.status : 'completed',
                resultText: payload.resultText,
                diffSummary: payload.diffSummary,
                completedAt: event.createdAt,
                updatedAt: event.createdAt
              }
            : run
        )
      );
      if (!staysTerminal) {
        syncSessionRow(event.sessionId, {
          status: 'idle',
          updatedAt: event.createdAt
        });
      }
      setMessages((currentMessages) => completeAssistantMessage(currentMessages, event));
    }
    if (event.type === 'run.error' && isRunErrorPayload(payload)) {
      setRuns((currentRuns) =>
        currentRuns.map((run) =>
          run.id === event.runId ? { ...run, status: 'failed', error: payload.error, updatedAt: event.createdAt } : run
        )
      );
      syncSessionRow(event.sessionId, {
        status: 'failed',
        updatedAt: event.createdAt
      });
    }
  }

  function handleTimelineScroll(): void {
    const timeline = timelineRef.current;
    if (timeline === null) {
      return;
    }
    const distanceFromBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight;
    shouldStickToBottomRef.current = distanceFromBottom < 150;
  }

  const showSmokeActions = health?.runtime === 'mock';

  return (
    <main className="app-shell">
      <aside className="conversation-sidebar">
        <div className="sidebar-header">
          <div>
            <p className="eyebrow">Cursor Remote</p>
            <h1>Conversations</h1>
          </div>
          <button type="button" className="icon-button" onClick={() => void createConversation()} aria-label="New conversation">
            +
          </button>
        </div>
        <div className="status-stack" aria-label="Environment status">
          <StatusBadge label="Runtime" value={health?.runtime ?? 'loading'} ready={health !== null && health.runtime !== 'mock'} />
          <StatusBadge label="API" value={health?.hasCursorApiKey ? 'configured' : 'missing'} ready={health?.hasCursorApiKey === true} />
          <StatusBadge
            label="CWD"
            value={health?.localCwdConfigured ? 'set' : 'missing'}
            ready={health?.localCwdConfigured === true}
            detail={health?.localCwd}
          />
        </div>
        <nav className="session-list" aria-label="Conversations">
          {sessions.length === 0 ? (
            <p className="empty sidebar-empty">No conversations yet.</p>
          ) : (
            sidebarSessionsOrdered.map((candidate) => {
              const showRunning = candidate.status === 'running';
              const unread = isSidebarSessionUnread({
                session: candidate,
                activityOverlayBySessionId: sessionActivityOverlay,
                selectedSessionId: session?.id,
                readAckBySessionId: sessionReadAckById
              });
              const showUnreadDot = !showRunning && unread;
              return (
              <button
                type="button"
                key={candidate.id}
                className={`session-row ${candidate.id === session?.id ? 'session-row-active' : ''}`}
                aria-busy={showRunning ? true : undefined}
                aria-label={
                  `${candidate.title}, ${candidate.status === 'idle' ? 'ready' : candidate.status}` +
                  (showRunning ? ', run in progress' : '') +
                  (showUnreadDot ? ', unread' : '')
                }
                onClick={() => void selectSession(candidate)}
              >
                <div className="session-row-title-row">
                  <span className="session-row-dot-slot">
                    {showRunning ? (
                      <span className="session-row-dot session-row-dot-running" title="Run in progress" />
                    ) : showUnreadDot ? (
                      <span className="session-row-dot session-row-dot-unread" title="Unread activity" />
                    ) : (
                      <span className="session-row-dot-spacer" aria-hidden="true" />
                    )}
                  </span>
                  <span className="session-row-title">{candidate.title}</span>
                </div>
                <span className="session-row-meta">
                  {candidate.status === 'idle' ? 'ready' : candidate.status}
                  {candidate.latestRunId ? ` · ${shortRunId(candidate.latestRunId)}` : ''}
                </span>
              </button>
            );
            })
          )}
        </nav>
      </aside>

      <section className="chat-pane">
        <header className="chat-header">
          <div>
            <p className="eyebrow">Coding session</p>
            <h2>{session?.title ?? 'Loading conversation'}</h2>
            <p className="muted header-subtitle">
              {session ? `${shortRunId(session.id)} · ${session.runtime} · ${session.modelId}` : 'Preparing session state…'}
            </p>
          </div>
          <div className="chat-actions">
            {activeRun ? <span className="active-run-pill">● Streaming {shortRunId(activeRun.id)}</span> : null}
            <button type="button" className="secondary" disabled={isRefreshing} onClick={() => void refresh()}>
              {isRefreshing ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
        </header>

        {health?.runtime === 'local' && !health.localCwdConfigured ? (
          <p className="warn">
            Local SDK runs need <code>CURSOR_LOCAL_CWD</code> in <code>.env</code>, then restart the server.
          </p>
        ) : null}
        {error ? <p className="error error-banner">{error}</p> : null}

        <div className="timeline" aria-label="Conversation timeline" ref={timelineRef} onScroll={handleTimelineScroll}>
          {timelineItems.length === 0 ? (
            <div className="chat-empty">
              <h3>Start a Cursor conversation</h3>
              <p>Send a task below. Cursor will work in the configured local cwd and stream assistant text, tool activity (including batched Thinking), and status here.</p>
              {showSmokeActions ? (
                <button type="button" className="outline" disabled={activeRun !== undefined} onClick={() => setPrompt(MVP_PYTHON_HELLO_PROMPT)}>
                  Fill Python hello world prompt
                </button>
              ) : null}
            </div>
          ) : (
            timelineItems.map((item) => <TimelineItemView key={`${item.kind}-${item.id}`} item={item} />)
          )}
        </div>

        <form className="composer" onSubmit={(event) => void handleSubmit(event)}>
          <details className="composer-model">
            <summary>Model: {modelId || 'default'}</summary>
            <label>
              <span>Model ID</span>
              <input value={modelId} onChange={(event) => setModelId(event.target.value)} />
            </label>
          </details>
          <div className="composer-prompt">
            <div className="composer-prompt-heading">
              <label htmlFor="composer-prompt-input">Prompt</label>
              <span className="muted composer-shortcut-hint" id="composer-shortcut-hint">
                Enter newline · ⌘↵ or Ctrl+Enter to send
              </span>
            </div>
            <textarea
              id="composer-prompt-input"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={handleComposerKeyDown}
              rows={4}
              placeholder="Ask Cursor to edit, explain, or create code in the configured cwd…"
              aria-describedby="composer-shortcut-hint"
            />
          </div>
          <div className="composer-actions">
            {showSmokeActions ? (
              <button type="button" className="ghost" disabled={activeRun !== undefined} onClick={() => setPrompt(MVP_PYTHON_HELLO_PROMPT)}>
                Use smoke prompt
              </button>
            ) : null}
            <button type="submit" disabled={isSending || activeRun !== undefined || session === null || prompt.trim().length === 0}>
              {activeRun ? 'Cursor is running…' : isSending ? 'Sending…' : 'Send'}
            </button>
          </div>
        </form>
      </section>
    </main>
  );
}

const TIMELINE_EVENT_BUFFER_MAX = 500;

/** Heartbeat / deltas already reflected elsewhere would only bloat this buffer and evict tool/task rows via .slice — drop them client-side (still receive SSE keepalive). */
function shouldRetainClientRunEvent(event: AppEvent): boolean {
  return event.type !== 'heartbeat' && event.type !== 'tool.delta' && event.type !== 'assistant.delta';
}

function appendTimelineEvents(currentEvents: AppEvent[], event: AppEvent): AppEvent[] {
  if (!shouldRetainClientRunEvent(event)) {
    return currentEvents;
  }
  return [...currentEvents, event].slice(-TIMELINE_EVENT_BUFFER_MAX);
}

function TimelineItemView({ item }: { item: TimelineItem }): ReactElement | null {
  if (item.kind === 'user') {
    return (
      <article className="timeline-item user-item">
        <div className="timeline-label">You · {item.status} · {formatTimelineTime(item.createdAt)}</div>
        <p>{item.text}</p>
      </article>
    );
  }
  if (item.kind === 'assistant') {
    const trimmed = item.text.trim();
    if (trimmed.length === 0 && item.status !== 'streaming') {
      return null;
    }
    return (
      <article className={`timeline-item assistant-item assistant-${item.status}`}>
        <div className="timeline-label">
          {item.status === 'streaming' ? <span className="streaming-dot" aria-hidden="true" /> : null}
          Cursor · {item.status} · {formatTimelineTime(item.createdAt)}
        </div>
        {trimmed.length > 0 ? <MarkdownContent markdown={item.text} /> : <p className="muted markdown-body markdown-body--streaming">Receiving…</p>}
      </article>
    );
  }
  if (item.kind === 'tool') {
    return <ToolTimelineCard item={item} />;
  }
  if (item.text.trim().length === 0) {
    return null;
  }
  return (
    <article className={`timeline-item status-item status-${item.tone}`}>
      <span>{item.text} · {formatTimelineTime(item.createdAt)}</span>
    </article>
  );
}

function toolTimelineLabel(toolName: string): string {
  return toolName === 'thinking' ? 'Thinking' : toolName;
}

/** Tool invocation: collapsible card; summary is a compact 3-column row; expanded body shows flattened args + result text. */
function ToolTimelineCard({ item }: { item: Extract<TimelineItem, { kind: 'tool' }> }) {
  const kvLines = item.detail !== undefined ? flattenJsonForDisplay(item.detail) : [];
  const label = toolTimelineLabel(item.name);
  return (
    <article className={`timeline-item tool-item tool-card tool-span-full tool-${item.status}`}>
      <details className="tool-card-details">
        <summary className="tool-card-summary" aria-label={`${label} (${item.status})`}>
          <span className="tool-card-icon" aria-hidden="true">
            {item.status === 'running' ? '●' : item.status === 'error' ? '!' : '✓'}
          </span>
          <span className="tool-card-type">{label}</span>
          <span className="tool-status">{item.status}</span>
        </summary>
        <div className="tool-card-body">
          {kvLines.length > 0 ? (
            <ul className="tool-kv-list">
              {kvLines.map((line, index) => (
                <li key={`${index}-${line}`}>
                  <code className="tool-kv-code">{line}</code>
                </li>
              ))}
            </ul>
          ) : null}
          {item.summary !== undefined ? <p className="tool-result">{item.summary}</p> : null}
        </div>
      </details>
    </article>
  );
}

function formatTimelineTime(value: string): string {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    return value;
  }
  return timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

interface StatusBadgeProps {
  label: string;
  value: string;
  ready: boolean;
  /** Second line (e.g. full path); word-wrapped. */
  detail?: string;
}

function StatusBadge({ label, value, ready, detail }: StatusBadgeProps) {
  const cls = `status-badge ${ready ? 'status-badge-ready' : 'status-badge-warn'}${detail ? ' status-badge-stacked' : ''}`;
  if (detail) {
    return (
      <span className={cls}>
        <span className="status-badge-top">
          <span className="status-dot" aria-hidden="true" />
          <span>{label}</span>
          <strong>{value}</strong>
        </span>
        <span className="status-badge-detail">{detail}</span>
      </span>
    );
  }
  return (
    <span className={cls}>
      <span className="status-dot" aria-hidden="true" />
      <span>{label}</span>
      <strong>{value}</strong>
    </span>
  );
}

function parseAppEvent(message: Event): AppEvent | null {
  if (!(message instanceof MessageEvent) || typeof message.data !== 'string') {
    return null;
  }
  try {
    const parsedJson: unknown = JSON.parse(message.data);
    const parsedEvent = appEventSchema.safeParse(parsedJson);
    if (!parsedEvent.success || !Object.prototype.hasOwnProperty.call(parsedEvent.data, 'payload')) {
      return null;
    }
    const data = parsedEvent.data;
    return {
      id: data.id,
      sessionId: data.sessionId,
      ...(data.runId !== undefined ? { runId: data.runId } : {}),
      type: data.type,
      ...(data.cursorEventType !== undefined ? { cursorEventType: data.cursorEventType } : {}),
      ...(data.cursorEventId !== undefined ? { cursorEventId: data.cursorEventId } : {}),
      payload: data.payload,
      createdAt: data.createdAt
    };
  } catch {
    return null;
  }
}

function getSubscribedEventTypes(): string[] {
  return [
    'run.status',
    'assistant.delta',
    'tool.started',
    'tool.delta',
    'tool.completed',
    'tool.error',
    'task.updated',
    'run.result',
    'run.error',
    'heartbeat'
  ];
}

function shouldCloseEventStream(event: AppEvent): boolean {
  if (event.type === 'run.result' || event.type === 'run.error') {
    return true;
  }
  return (
    event.type === 'run.status' &&
    isRunStatusPayload(event.payload) &&
    event.payload.status === 'cancelled'
  );
}

function upsertRun(currentRuns: RunProjection[], nextRun: RunProjection): RunProjection[] {
  const existingIndex = currentRuns.findIndex((run) => run.id === nextRun.id);
  if (existingIndex === -1) {
    return [nextRun, ...currentRuns];
  }
  return currentRuns.map((run) => (run.id === nextRun.id ? nextRun : run));
}

function upsertSession(currentSessions: SessionProjection[], nextSession: SessionProjection): SessionProjection[] {
  const existingIndex = currentSessions.findIndex((candidate) => candidate.id === nextSession.id);
  if (existingIndex === -1) {
    return [nextSession, ...currentSessions];
  }
  return currentSessions.map((candidate) => (candidate.id === nextSession.id ? nextSession : candidate));
}

function createOptimisticUserMessage(sessionId: string, runId: string, content: string, createdAt: string): MessageProjection {
  return {
    id: `${runId}-user`,
    sessionId,
    runId,
    role: 'user',
    content,
    status: 'completed',
    createdAt,
    updatedAt: createdAt
  };
}

function appendAssistantDelta(currentMessages: MessageProjection[], event: AppEvent, text: string): MessageProjection[] {
  const runId = event.runId;
  if (runId === undefined) {
    return currentMessages;
  }
  if (text.length === 0) {
    return currentMessages;
  }
  const assistantId = `${runId}-assistant`;
  const existingMessage = currentMessages.find((message) => message.role === 'assistant' && message.runId === runId);
  if (existingMessage === undefined) {
    const message: MessageProjection = {
      id: assistantId,
      sessionId: event.sessionId,
      runId,
      role: 'assistant',
      content: text,
      status: 'streaming',
      createdAt: event.createdAt,
      updatedAt: event.createdAt
    };
    return [...currentMessages, message];
  }
  return currentMessages.map((message) =>
    message.id === existingMessage.id ? { ...message, content: `${message.content}${text}`, updatedAt: event.createdAt } : message
  );
}

function completeAssistantMessage(currentMessages: MessageProjection[], event: AppEvent): MessageProjection[] {
  if (event.runId === undefined) {
    return currentMessages;
  }
  const assistantId = `${event.runId}-assistant`;
  return currentMessages.map((message) => {
    if (message.role !== 'assistant' || message.runId !== event.runId) {
      return message;
    }
    return { ...message, id: assistantId, status: 'completed', updatedAt: event.createdAt };
  });
}

const rootElement = document.getElementById('root');
if (rootElement !== null) {
  let root = window.__CCR_ROOT__;
  if (!root) {
    root = createRoot(rootElement);
    window.__CCR_ROOT__ = root;
  }
  root.render(<App />);
}

import.meta.hot?.dispose(() => {
  window.__CCR_ROOT__?.unmount();
  window.__CCR_ROOT__ = undefined;
});
