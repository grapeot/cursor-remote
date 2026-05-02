import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { SyntheticEvent } from 'react';
import type { HealthResponse, RunSummary } from '../../src/shared/contracts';
import { fetchHealth, fetchRuns, sendPrompt } from './api';
import './styles.css';

/** Minimal SDK smoke test: agent writes under `mvp_sandbox/` inside CURSOR_LOCAL_CWD. */
const MVP_PYTHON_HELLO_PROMPT = `In this repo, create or overwrite the file mvp_sandbox/hello_world.py with exactly:

print("Hello, world!")

Use nothing else in that file (no shebang, no imports). If mvp_sandbox/ does not exist, create it.`;

function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [prompt, setPrompt] = useState(MVP_PYTHON_HELLO_PROMPT);
  const [repoUrl, setRepoUrl] = useState('');
  const [startingRef, setStartingRef] = useState('main');
  const [modelId, setModelId] = useState('composer-2');
  const [error, setError] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);

  async function refresh() {
    const [nextHealth, nextRuns] = await Promise.all([fetchHealth(), fetchRuns()]);
    setHealth(nextHealth);
    setRuns(nextRuns);
  }

  useEffect(() => {
    refresh().catch((refreshError: unknown) => {
      setError(refreshError instanceof Error ? refreshError.message : 'Failed to load app state.');
    });
  }, []);

  async function submitRun(overridePrompt?: string): Promise<void> {
    const effectivePrompt = (overridePrompt ?? prompt).trim();
    if (effectivePrompt.length === 0) {
      return;
    }
    setError(null);
    setIsSending(true);
    try {
      const run = await sendPrompt({
        prompt: effectivePrompt,
        repoUrl,
        startingRef,
        modelId
      });
      setRuns((currentRuns) => [run, ...currentRuns]);
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

  return (
    <main className="shell">
      <header className="console-header">
        <div>
          <p className="eyebrow">Cursor Remote Console</p>
          <h1>Agent launcher</h1>
          <p className="lede">
            Server-held Cursor credentials, local repo execution, and a tested path toward streamed agent control.
          </p>
        </div>
        <div className="status-badges" aria-label="Environment status">
          <StatusBadge label="Runtime" value={health?.runtime ?? 'loading'} ready={health !== null && health.runtime !== 'mock'} />
          <StatusBadge label="API" value={health?.hasCursorApiKey ? 'configured' : 'missing'} ready={health?.hasCursorApiKey === true} />
          <StatusBadge label="CWD" value={health?.localCwdConfigured ? 'set' : 'missing'} ready={health?.localCwdConfigured === true} />
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
              disabled={isSending}
              onClick={() => void submitRun(MVP_PYTHON_HELLO_PROMPT)}
            >
              Run Python hello world
            </button>
            <button type="button" className="ghost" disabled={isSending} onClick={() => setPrompt(MVP_PYTHON_HELLO_PROMPT)}>
              Fill prompt
            </button>
          </div>
          <span className="muted inline-hint">
            Writes <code>mvp_sandbox/hello_world.py</code>. Current POC waits until <code>run.wait()</code> completes.
          </span>
        </div>
        <label className="prompt-field">
          Prompt
          <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={8} />
        </label>
        <label>
          Git repository URL
          <input
            value={repoUrl}
            onChange={(event) => setRepoUrl(event.target.value)}
            placeholder="https://github.com/owner/repo"
          />
        </label>
        <div className="grid">
          <label>
            Starting ref
            <input value={startingRef} onChange={(event) => setStartingRef(event.target.value)} />
          </label>
          <label>
            Model
            <input value={modelId} onChange={(event) => setModelId(event.target.value)} />
          </label>
        </div>
        <div className="form-footer">
          <button type="submit" disabled={isSending || prompt.trim().length === 0}>
            {isSending ? 'Waiting for Cursor SDK…' : 'Start Cursor run'}
          </button>
        </div>
        {isSending ? (
          <p className="muted">
            The server blocks until <code>run.wait()</code> completes. This page does not stream progress yet.
          </p>
        ) : null}
        {error ? <p className="error">{error}</p> : null}
      </form>

      <section className="panel">
        <div className="section-heading">
          <h2>Runs</h2>
          <button type="button" className="secondary" onClick={() => refresh()}>
            Refresh
          </button>
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
                {run.prUrl ? <a href={run.prUrl}>Pull request</a> : null}
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
