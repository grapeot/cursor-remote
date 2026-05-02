import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { SyntheticEvent } from 'react';
import type { HealthResponse } from '../../src/shared/contracts';
import { appEventSchema, isRunErrorPayload, isRunResultPayload, isRunStatusPayload, readStringField } from '../../src/shared/events';
import type { AppEvent } from '../../src/shared/events';
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
import './styles.css';

/** Minimal SDK smoke test: agent writes under `mvp_sandbox/` inside CURSOR_LOCAL_CWD. */
const MVP_PYTHON_HELLO_PROMPT = `In this repo, create or overwrite the file mvp_sandbox/hello_world.py with exactly:

print("Hello, world!")

Use nothing else in that file (no shebang, no imports). If mvp_sandbox/ does not exist, create it.`;

const SESSION_STORAGE_KEY = 'cursor-cloud-remote-poc.sessionId';

function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [session, setSession] = useState<SessionProjection | null>(null);
  const [runs, setRuns] = useState<RunProjection[]>([]);
  const [messages, setMessages] = useState<MessageProjection[]>([]);
  const [events, setEvents] = useState<AppEvent[]>([]);
  const [prompt, setPrompt] = useState(MVP_PYTHON_HELLO_PROMPT);
  const [modelId, setModelId] = useState('composer-2');
  const [error, setError] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const eventSourcesRef = useRef<Map<string, EventSource>>(new Map());

  async function loadSessionState(nextSession: SessionProjection): Promise<void> {
    const [nextRuns, nextMessages] = await Promise.all([
      listSessionRuns(nextSession.id),
      listSessionMessages(nextSession.id)
    ]);
    setSession(nextSession);
    setRuns(nextRuns);
    setMessages(nextMessages);
  }

  async function resolveSession(): Promise<SessionProjection> {
    const sessions = await listSessions();
    const storedSessionId = window.localStorage.getItem(SESSION_STORAGE_KEY);
    const storedSession = sessions.find((candidate) => candidate.id === storedSessionId);
    const latestSession = sessions[0];
    const nextSession = storedSession ?? latestSession ?? (await createSession('Remote console'));
    window.localStorage.setItem(SESSION_STORAGE_KEY, nextSession.id);
    return nextSession;
  }

  async function refresh(nextSession = session): Promise<void> {
    const nextHealth = await fetchHealth();
    setHealth(nextHealth);
    if (nextSession === null) {
      const resolvedSession = await resolveSession();
      await loadSessionState(resolvedSession);
      return;
    }
    const refreshedSession = await getSession(nextSession.id);
    await loadSessionState(refreshedSession);
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

  async function submitRun(overridePrompt?: string): Promise<void> {
    const effectivePrompt = (overridePrompt ?? prompt).trim();
    if (effectivePrompt.length === 0 || session === null) {
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
      setMessages((currentMessages) => [
        createOptimisticUserMessage(session.id, response.run.id, effectivePrompt),
        ...currentMessages
      ]);
      setEvents([]);
      openRunEvents(response.run.id, response.eventsUrl);
      if (overridePrompt !== undefined) {
        setPrompt(overridePrompt);
      }
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

  function openRunEvents(runId: string, eventsUrl: string): void {
    eventSourcesRef.current.get(runId)?.close();
    const source = new EventSource(eventsUrl);
    eventSourcesRef.current.set(runId, source);

    const eventTypes = [
      'run.status',
      'assistant.delta',
      'thinking.delta',
      'thinking.completed',
      'tool.started',
      'tool.delta',
      'tool.completed',
      'tool.error',
      'task.updated',
      'file.changed',
      'diff.snapshot',
      'run.result',
      'run.error',
      'heartbeat'
    ];

    eventTypes.forEach((type) => {
      source.addEventListener(type, (message) => {
        const parsed = parseAppEvent(message);
        if (parsed === null) {
          return;
        }
        applyRunEvent(parsed);
        const payload = parsed.payload;
        if (parsed.type === 'run.status' && isRunStatusPayload(payload)) {
          if (payload.status === 'completed' || payload.status === 'failed' || payload.status === 'cancelled') {
            source.close();
            eventSourcesRef.current.delete(runId);
          }
        }
      });
    });

    source.onerror = () => {
      setError('Run event stream disconnected. Use Refresh to load the latest projection.');
      source.close();
      eventSourcesRef.current.delete(runId);
    };
  }

  function applyRunEvent(event: AppEvent): void {
    setEvents((currentEvents) => [event, ...currentEvents].slice(0, 20));
    const payload = event.payload;
    if (event.type === 'run.status' && isRunStatusPayload(payload)) {
      setRuns((currentRuns) =>
        currentRuns.map((run) =>
          run.id === payload.runId
            ? { ...run, status: payload.status, updatedAt: event.createdAt }
            : run
        )
      );
      setSession((currentSession) =>
        currentSession === null
          ? currentSession
          : {
              ...currentSession,
              latestRunId: payload.runId,
              status: payload.status === 'running' || payload.status === 'queued' ? 'running' : 'idle',
              updatedAt: event.createdAt
            }
      );
    }
    if (event.type === 'assistant.delta') {
      const text = readStringField(event.payload, 'text');
      if (text !== undefined) {
        setMessages((currentMessages) => appendAssistantDelta(currentMessages, event, text));
      }
    }
    if (event.type === 'run.result' && isRunResultPayload(payload)) {
      setRuns((currentRuns) =>
        currentRuns.map((run) =>
          run.id === event.runId
            ? {
                ...run,
                resultText: payload.resultText,
                diffSummary: payload.diffSummary,
                completedAt: event.createdAt,
                updatedAt: event.createdAt
              }
            : run
        )
      );
      setMessages((currentMessages) => completeAssistantMessage(currentMessages, event));
    }
    if (event.type === 'run.error' && isRunErrorPayload(payload)) {
      setRuns((currentRuns) =>
        currentRuns.map((run) =>
          run.id === event.runId
            ? { ...run, status: 'failed', error: payload.error, updatedAt: event.createdAt }
            : run
        )
      );
    }
  }

  const latestRun = runs[0];
  const activeRun = runs.find((run) => run.status === 'queued' || run.status === 'running');

  return (
    <main className="shell">
      <header className="console-header">
        <div>
          <p className="eyebrow">Cursor Remote Console</p>
          <h1>Agent launcher</h1>
          <p className="lede">
            Server-held Cursor credentials, local repo execution, and streamed agent progress over the new session API.
          </p>
        </div>
        <div className="status-badges" aria-label="Environment status">
          <StatusBadge label="Runtime" value={health?.runtime ?? 'loading'} ready={health !== null && health.runtime !== 'mock'} />
          <StatusBadge label="API" value={health?.hasCursorApiKey ? 'configured' : 'missing'} ready={health?.hasCursorApiKey === true} />
          <StatusBadge label="CWD" value={health?.localCwdConfigured ? 'set' : 'missing'} ready={health?.localCwdConfigured === true} />
          <StatusBadge label="Session" value={session?.status ?? 'loading'} ready={session !== null && session.status !== 'failed'} />
        </div>
      </header>

      {health?.runtime === 'local' && !health.localCwdConfigured ? (
        <p className="panel warn">
          Local SDK runs need <code>CURSOR_LOCAL_CWD</code> in <code>.env</code> (absolute path to this project root),
          then restart the server.
        </p>
      ) : null}

      <form className="panel form" onSubmit={(event) => void handleSubmit(event)}>
        <div className="quick-actions">
          <div>
            <span className="label">Quick action</span>
            <p>Minimal smoke test for the self-bootstrapping repo.</p>
          </div>
          <div className="mvp-row">
            <button
              type="button"
              className="outline"
              disabled={isSending || session === null}
              onClick={() => void submitRun(MVP_PYTHON_HELLO_PROMPT)}
            >
              Run Python hello world
            </button>
            <button type="button" className="ghost" disabled={isSending} onClick={() => setPrompt(MVP_PYTHON_HELLO_PROMPT)}>
              Fill prompt
            </button>
          </div>
          <span className="muted inline-hint">
            Writes <code>mvp_sandbox/hello_world.py</code>. Runs now queue immediately and stream app events over SSE.
          </span>
        </div>
        <label className="prompt-field">
          Prompt
          <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={8} />
        </label>
        <label>
          Model
          <input value={modelId} onChange={(event) => setModelId(event.target.value)} />
        </label>
        <div className="form-footer">
          <button type="submit" disabled={isSending || session === null || prompt.trim().length === 0}>
            {isSending ? 'Queueing run…' : 'Start Cursor run'}
          </button>
        </div>
        {activeRun ? (
          <p className="muted">
            Streaming <code>{shortRunId(activeRun.id)}</code> through <code>/api/runs/:id/events</code>.
          </p>
        ) : null}
        {error ? <p className="error">{error}</p> : null}
      </form>

      <section className="panel session-panel">
        <div className="section-heading">
          <div>
            <h2>Session</h2>
            <p className="muted section-subtitle">
              {session ? `${session.title} · ${shortRunId(session.id)} · ${session.modelId}` : 'Loading session projection…'}
            </p>
          </div>
          <button type="button" className="secondary" onClick={() => void refresh()}>
            Refresh
          </button>
        </div>
        <div className="session-grid">
          <ProjectionCard label="Latest run" value={latestRun ? shortRunId(latestRun.id) : 'none'} />
          <ProjectionCard label="Runtime" value={session?.runtime ?? 'loading'} />
          <ProjectionCard label="Messages" value={String(messages.length)} />
        </div>
      </section>

      <section className="panel stream-panel">
        <div className="section-heading">
          <h2>Live event stream</h2>
          <span className="muted inline-hint">Last 20 app events</span>
        </div>
        {events.length === 0 ? (
          <p className="empty">No live events yet. Start a run to open the SSE stream.</p>
        ) : (
          <ul className="events">
            {events.map((event) => (
              <li key={event.id}>
                <code>{event.id}</code>
                <span>{event.type}</span>
                <span className="muted">{formatEventPayload(event)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel">
        <div className="section-heading">
          <h2>Messages</h2>
          <span className="muted inline-hint">Projection from session events</span>
        </div>
        {messages.length === 0 ? (
          <p className="empty">No messages yet.</p>
        ) : (
          <ul className="messages">
            {messages.map((message) => (
              <li key={message.id} className={`message message-${message.role}`}>
                <div>
                  <span className="label">{message.role}</span>
                  <span className="muted">{message.status}</span>
                </div>
                <p>{message.content}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel">
        <div className="section-heading">
          <h2>Runs</h2>
          <span className="muted inline-hint">Session-scoped history</span>
        </div>
        {runs.length === 0 ? (
          <p className="empty">No runs yet.</p>
        ) : (
          <ul className="runs">
            {runs.map((run) => (
              <li key={run.id}>
                <div className="run-header">
                  <span className={`run-status run-status-${run.status}`}>{run.status}</span>
                  <span className="run-title">{summarizePrompt(run.prompt)}</span>
                  <code title={run.id}>{shortRunId(run.id)}</code>
                </div>
                <p>{run.prompt}</p>
                {run.resultText ? <p className="muted">{run.resultText}</p> : null}
                {run.error ? <p className="error">{run.error}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

interface StatusBadgeProps {
  label: string;
  value: string;
  ready: boolean;
}

function StatusBadge({ label, value, ready }: StatusBadgeProps) {
  return (
    <span className={`status-badge ${ready ? 'status-badge-ready' : 'status-badge-warn'}`}>
      <span className="status-dot" aria-hidden="true" />
      <span>{label}</span>
      <strong>{value}</strong>
    </span>
  );
}

interface ProjectionCardProps {
  label: string;
  value: string;
}

function ProjectionCard({ label, value }: ProjectionCardProps) {
  return (
    <div className="projection-card">
      <span className="label">{label}</span>
      <strong>{value}</strong>
    </div>
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

function upsertRun(currentRuns: RunProjection[], nextRun: RunProjection): RunProjection[] {
  const existingIndex = currentRuns.findIndex((run) => run.id === nextRun.id);
  if (existingIndex === -1) {
    return [nextRun, ...currentRuns];
  }
  return currentRuns.map((run) => (run.id === nextRun.id ? nextRun : run));
}

function createOptimisticUserMessage(sessionId: string, runId: string, content: string): MessageProjection {
  const createdAt = new Date().toISOString();
  return {
    id: `optimistic-user-${runId}`,
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
  const existingMessage = currentMessages.find((message) => message.role === 'assistant' && message.runId === runId);
  if (existingMessage === undefined) {
    const message: MessageProjection = {
      id: `streaming-assistant-${runId ?? event.id}`,
      sessionId: event.sessionId,
      ...(runId !== undefined ? { runId } : {}),
      role: 'assistant',
      content: text,
      status: 'streaming',
      createdAt: event.createdAt,
      updatedAt: event.createdAt
    };
    return [message, ...currentMessages];
  }
  return currentMessages.map((message) =>
    message.id === existingMessage.id
      ? { ...message, content: `${message.content}${text}`, updatedAt: event.createdAt }
      : message
  );
}

function completeAssistantMessage(currentMessages: MessageProjection[], event: AppEvent): MessageProjection[] {
  return currentMessages.map((message) =>
    message.role === 'assistant' && message.runId === event.runId
      ? { ...message, status: 'completed', updatedAt: event.createdAt }
      : message
  );
}

function formatEventPayload(event: AppEvent): string {
  if (event.type === 'assistant.delta') {
    return readStringField(event.payload, 'text') ?? '';
  }
  if (event.type === 'run.status' && isRunStatusPayload(event.payload)) {
    return event.payload.status;
  }
  if (event.type === 'run.result' && isRunResultPayload(event.payload)) {
    return event.payload.resultText ?? 'result received';
  }
  if (event.type === 'run.error' && isRunErrorPayload(event.payload)) {
    return event.payload.error;
  }
  return event.cursorEventType ?? event.createdAt;
}

function shortRunId(id: string): string {
  if (id.length <= 18) {
    return id;
  }
  return `${id.slice(0, 8)}…${id.slice(-6)}`;
}

function summarizePrompt(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.includes('hello_world.py')) {
    return 'create hello_world.py';
  }
  return normalized.length > 48 ? `${normalized.slice(0, 45)}…` : normalized;
}

const root = createRoot(document.getElementById('root') as HTMLElement);
root.render(<App />);
