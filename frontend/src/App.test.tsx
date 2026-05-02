// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEvent } from '../../src/shared/events';
import type { StartRunResponse } from '../../src/shared/contracts';
import type { RunProjection, SessionProjection } from '../../src/shared/projections';
import { App } from './main';
import * as api from './api';
import { SESSION_READ_ACK_STORAGE_KEY } from './sessionSidebar';

vi.mock('./api', () => ({
  fetchHealth: vi.fn(),
  createSession: vi.fn(),
  getSession: vi.fn(),
  listSessionMessages: vi.fn(),
  listSessionRuns: vi.fn(),
  listSessions: vi.fn(),
  startSessionRun: vi.fn()
}));

describe('App chat client', () => {
  beforeEach(() => {
    cleanup();
    window.localStorage.clear();
    MockEventSource.reset();
    Object.defineProperty(globalThis, 'EventSource', {
      configurable: true,
      writable: true,
      value: MockEventSource
    });

    vi.mocked(api.fetchHealth).mockResolvedValue({
      ok: true,
      runtime: 'local',
      hasCursorApiKey: true,
      localCwdConfigured: true,
      localCwd: '/tmp/cursor-poc-cwd'
    });
    vi.mocked(api.listSessions).mockResolvedValue([sessionFixture]);
    vi.mocked(api.getSession).mockResolvedValue(sessionFixture);
    vi.mocked(api.listSessionRuns).mockResolvedValue([]);
    vi.mocked(api.listSessionMessages).mockResolvedValue([]);
    vi.mocked(api.startSessionRun).mockResolvedValue(startRunFixture);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('loads the conversation shell and renders streamed chat events after submit', async () => {
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Conversations' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Remote console' })).toBeTruthy();

    const textarea = screen.getByLabelText('Prompt');
    await userEvent.clear(textarea);
    await userEvent.type(textarea, 'Create hello.txt');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(api.startSessionRun).toHaveBeenCalledWith('session-1', {
      prompt: 'Create hello.txt',
      modelId: 'composer-2',
      runtime: 'local'
    }));
    const sessionRow = screen.getByRole('button', { name: /Remote console/ });
    await waitFor(() => expect(sessionRow.textContent).toMatch(/running/i));
    expect(MockEventSource.latest().url).toBe('/api/runs/run-1/events');
    expect(screen.getByText(/You · sent ·/)).toBeTruthy();
    expect(screen.getByText('Create hello.txt')).toBeTruthy();

    act(() => {
      MockEventSource.latest().emit(event({ id: 2, type: 'run.status', payload: runStatusPayload('running'), createdAt: '2026-05-01T12:00:01.000Z' }));
      MockEventSource.latest().emit(event({ id: 3, type: 'thinking.delta', payload: { text: 'Inspecting workspace.' }, createdAt: '2026-05-01T12:00:02.000Z' }));
      MockEventSource.latest().emit(event({ id: 4, type: 'tool.started', payload: { callId: 'tool-1', name: 'write_file', args: { path: 'hello.txt' } }, createdAt: '2026-05-01T12:00:03.000Z' }));
      MockEventSource.latest().emit(event({ id: 5, type: 'tool.completed', payload: { callId: 'tool-1', name: 'write_file', result: 'Wrote hello.txt' }, createdAt: '2026-05-01T12:00:04.000Z' }));
      MockEventSource.latest().emit(event({ id: 6, type: 'assistant.delta', payload: { text: 'Created hello.txt.' }, createdAt: '2026-05-01T12:00:05.000Z' }));
      MockEventSource.latest().emit(event({ id: 7, type: 'run.result', payload: { resultText: 'Created hello.txt.' }, createdAt: '2026-05-01T12:00:06.000Z' }));
    });

    expect(await screen.findByText(/Thinking · streaming ·/)).toBeTruthy();
    expect(screen.getByText('Inspecting workspace.')).toBeTruthy();
    const toolDetails = screen.getByText('write_file').closest('details') as HTMLDetailsElement | null;
    expect(toolDetails).toBeTruthy();
    expect(toolDetails!.open).toBe(false);
    await userEvent.click(toolDetails!.querySelector('summary') as HTMLElement);
    expect(toolDetails!.open).toBe(true);
    expect(within(toolDetails as HTMLElement).getByText(/path:\s*"hello\.txt"/)).toBeTruthy();
    expect(screen.getByText('Wrote hello.txt')).toBeTruthy();
    expect(screen.getByText(/Cursor · completed ·/)).toBeTruthy();
    expect(screen.getByText('Created hello.txt.')).toBeTruthy();
    await waitFor(() => expect(sessionRow.textContent).toMatch(/ready/i));
    expect(MockEventSource.latest().closed).toBe(true);
  });

  it('renders assistant markdown as structured HTML (heading + bold)', async () => {
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Conversations' })).toBeTruthy();
    const textarea = screen.getByLabelText('Prompt');
    await userEvent.clear(textarea);
    await userEvent.type(textarea, 'Md');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(api.startSessionRun).toHaveBeenCalled());

    act(() => {
      MockEventSource.latest().emit(
        event({
          id: 2,
          type: 'assistant.delta',
          payload: { text: '# Title\n\nParagraph with **emphasis**.' },
          createdAt: '2026-05-01T12:00:05.000Z'
        })
      );
      MockEventSource.latest().emit(
        event({
          id: 3,
          type: 'run.result',
          payload: { resultText: 'ok' },
          createdAt: '2026-05-01T12:00:06.000Z'
        })
      );
    });

    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Title' })).toBeTruthy());
    const assistant = document.querySelector('article.assistant-item');
    expect(assistant?.querySelector('.markdown-body strong')?.textContent).toBe('emphasis');
    expect(MockEventSource.latest().closed).toBe(true);
  });

  it('submits the prompt when pressing Meta+Enter in the textarea', async () => {
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Conversations' })).toBeTruthy();
    const textarea = screen.getByLabelText('Prompt');
    await userEvent.clear(textarea);
    await userEvent.type(textarea, 'Meta enter');
    await userEvent.keyboard('{Meta>}{Enter}{/Meta}');
    await waitFor(() =>
      expect(api.startSessionRun).toHaveBeenCalledWith('session-1', {
        prompt: 'Meta enter',
        modelId: 'composer-2',
        runtime: 'local'
      })
    );
  });

  it('submits the prompt when pressing Ctrl+Enter in the textarea', async () => {
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Conversations' })).toBeTruthy();
    const textarea = screen.getByLabelText('Prompt');
    await userEvent.clear(textarea);
    await userEvent.type(textarea, 'Ctrl enter');
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() =>
      expect(api.startSessionRun).toHaveBeenCalledWith('session-1', {
        prompt: 'Ctrl enter',
        modelId: 'composer-2',
        runtime: 'local'
      })
    );
  });

  it('keeps streamed tool cards when switching conversations and switching back', async () => {
    const sessionBeta: SessionProjection = {
      ...sessionFixture,
      id: 'session-2',
      title: 'Beta'
    };
    vi.mocked(api.listSessions).mockResolvedValue([sessionFixture, sessionBeta]);
    vi.mocked(api.getSession).mockImplementation((id: string) =>
      Promise.resolve(id === sessionBeta.id ? sessionBeta : sessionFixture)
    );

    render(<App />);
    await waitFor(() => expect(api.listSessions).toHaveBeenCalled());

    const textarea = screen.getByLabelText('Prompt');
    await userEvent.clear(textarea);
    await userEvent.type(textarea, 'Run tool');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(api.startSessionRun).toHaveBeenCalled());

    vi.mocked(api.listSessionRuns).mockImplementation((sessionId: string) => {
      if (sessionId === 'session-1') {
        return Promise.resolve([
          {
            ...runFixture,
            status: 'running' as const,
            prompt: 'Run tool'
          }
        ]);
      }
      return Promise.resolve([]);
    });

    act(() => {
      MockEventSource.latest().emit(
        event({ id: 2, type: 'run.status', payload: runStatusPayload('running'), createdAt: '2026-05-01T12:00:01.000Z' })
      );
      MockEventSource.latest().emit(
        event({
          id: 3,
          type: 'tool.started',
          payload: { callId: 'tool-persist', name: 'write_file', args: { path: 'keep.txt' } },
          createdAt: '2026-05-01T12:00:02.000Z'
        })
      );
    });

    await screen.findByText('write_file');

    await userEvent.click(screen.getByRole('button', { name: /\bBeta\b/ }));
    await waitFor(() =>
      expect(
        screen.getByRole('heading', {
          level: 2,
          name: 'Beta'
        })
      ).toBeTruthy()
    );

    await userEvent.click(screen.getByRole('button', { name: /Remote console/ }));

    await waitFor(() => expect(screen.getByRole('heading', { level: 2, name: 'Remote console' })).toBeTruthy());

    expect(await screen.findByText('write_file')).toBeTruthy();
  });

  it('does not submit on plain Enter and inserts a newline in the prompt', async () => {
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Conversations' })).toBeTruthy();
    const textarea = screen.getByLabelText('Prompt');
    await userEvent.clear(textarea);
    await userEvent.type(textarea, 'line-a');
    await userEvent.keyboard('{Enter}');
    await userEvent.type(textarea, 'line-b');
    expect((textarea as HTMLTextAreaElement).value.replace(/\r\n/g, '\n')).toBe('line-a\nline-b');
    expect(api.startSessionRun).not.toHaveBeenCalled();
  });

  it('exposes composer shortcut hint via aria-describedby on the prompt textarea', async () => {
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Conversations' })).toBeTruthy();
    const textarea = screen.getByLabelText('Prompt');
    expect(textarea.getAttribute('aria-describedby')).toBe('composer-shortcut-hint');
    expect(screen.getByText(/Ctrl\+Enter to send/)).toBeTruthy();
  });

  it('keeps conversation sidebar status in sync with the active run (running and failed)', async () => {
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Conversations' })).toBeTruthy();
    const sessionRow = screen.getByRole('button', { name: /Remote console/ });
    expect(sessionRow.textContent).toMatch(/ready/i);

    const textarea = screen.getByLabelText('Prompt');
    await userEvent.clear(textarea);
    await userEvent.type(textarea, 'Fail plz');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(api.startSessionRun).toHaveBeenCalled());
    await waitFor(() => expect(sessionRow.textContent).toMatch(/running/i));

    act(() => {
      MockEventSource.latest().emit(
        event({
          id: 2,
          type: 'run.error',
          payload: { error: 'gateway boom' },
          createdAt: '2026-05-01T12:00:02.000Z'
        })
      );
    });
    await waitFor(() => expect(sessionRow.textContent).toMatch(/failed/i));
    expect(MockEventSource.latest().closed).toBe(true);
  });

  it('lists conversations by declining activity time and shows unread until the conversation is opened', async () => {
    const alpha: SessionProjection = {
      ...sessionFixture,
      id: 'session-alpha',
      title: 'Alpha',
      updatedAt: '2026-05-01T10:00:00.000Z'
    };
    const beta: SessionProjection = {
      ...sessionFixture,
      id: 'session-beta',
      title: 'Beta',
      updatedAt: '2026-05-01T14:00:00.000Z'
    };

    vi.mocked(api.listSessions).mockResolvedValue([alpha, beta]);
    vi.mocked(api.getSession).mockImplementation((id: string) =>
      Promise.resolve(id === beta.id ? beta : alpha)
    );

    window.localStorage.setItem(
      SESSION_READ_ACK_STORAGE_KEY,
      JSON.stringify({ 'session-beta': '2026-05-01T11:30:00.000Z' })
    );

    render(<App />);
    await waitFor(() => expect(api.listSessions).toHaveBeenCalled());

    const nav = screen.getByRole('navigation', { name: 'Conversations' });
    const rows = within(nav).getAllByRole('button');
    expect(rows[0].textContent).toMatch(/Beta/);
    expect(rows[1].textContent).toMatch(/Alpha/);

    const betaRow = within(nav).getByRole('button', { name: /Beta/ });
    expect(betaRow.querySelector('.session-row-dot-unread')).toBeTruthy();

    await userEvent.click(betaRow);
    await waitFor(() => expect(screen.getByRole('heading', { level: 2, name: 'Beta' })).toBeTruthy());
    await waitFor(() => expect(within(nav).getByRole('button', { name: /Beta/ }).querySelector('.session-row-dot-unread')).toBeNull());
  });

  it('shows only the running indicator when unread would also apply', async () => {
    const alpha: SessionProjection = {
      ...sessionFixture,
      id: 'session-alpha',
      title: 'Alpha',
      updatedAt: '2026-05-01T10:00:00.000Z'
    };
    const betaBusy: SessionProjection = {
      ...sessionFixture,
      id: 'session-beta',
      title: 'Beta',
      status: 'running',
      updatedAt: '2026-05-01T14:00:00.000Z'
    };

    vi.mocked(api.listSessions).mockResolvedValue([alpha, betaBusy]);
    vi.mocked(api.getSession).mockImplementation((id: string) =>
      Promise.resolve(id === betaBusy.id ? betaBusy : alpha)
    );
    window.localStorage.setItem(
      SESSION_READ_ACK_STORAGE_KEY,
      JSON.stringify({ 'session-beta': '2026-05-01T11:30:00.000Z' })
    );

    render(<App />);
    await waitFor(() => expect(api.listSessions).toHaveBeenCalled());
    const nav = screen.getByRole('navigation', { name: 'Conversations' });
    const betaRow = within(nav).getByRole('button', { name: /Beta/ });
    await waitFor(() => expect(betaRow.querySelector('.session-row-dot-running')).toBeTruthy());
    expect(betaRow.querySelector('.session-row-dot-unread')).toBeNull();
  });
});

const sessionFixture: SessionProjection = {
  id: 'session-1',
  title: 'Remote console',
  runtime: 'mock',
  status: 'idle',
  modelId: 'composer-2',
  createdAt: '2026-05-01T12:00:00.000Z',
  updatedAt: '2026-05-01T12:00:00.000Z'
};

const runFixture: RunProjection = {
  id: 'run-1',
  sessionId: 'session-1',
  status: 'queued',
  prompt: 'Create hello.txt',
  runtime: 'mock',
  modelId: 'composer-2',
  createdAt: '2026-05-01T12:00:00.000Z',
  updatedAt: '2026-05-01T12:00:00.000Z'
};

const startRunFixture: StartRunResponse = {
  run: runFixture,
  eventsUrl: '/api/runs/run-1/events'
};

class MockEventSource {
  static instances: MockEventSource[] = [];
  readonly url: string;
  closed = false;
  onerror: (() => void) | null = null;
  private readonly listeners = new Map<string, Array<(message: MessageEvent<string>) => void>>();

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  static reset(): void {
    MockEventSource.instances = [];
  }

  static latest(): MockEventSource {
    const latestInstance = MockEventSource.instances.at(-1);
    if (latestInstance === undefined) {
      throw new Error('No EventSource instance was created.');
    }
    return latestInstance;
  }

  addEventListener(type: string, listener: (message: MessageEvent<string>) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  close(): void {
    this.closed = true;
  }

  emit(eventValue: AppEvent): void {
    const message = new MessageEvent(eventValue.type, { data: JSON.stringify(eventValue) });
    this.listeners.get(eventValue.type)?.forEach((listener) => listener(message));
  }
}

function event(overrides: Partial<AppEvent>): AppEvent {
  return {
    id: 1,
    sessionId: 'session-1',
    runId: 'run-1',
    type: 'run.status',
    payload: runStatusPayload('queued'),
    createdAt: '2026-05-01T12:00:00.000Z',
    ...overrides
  };
}

function runStatusPayload(status: RunProjection['status']) {
  return {
    runId: 'run-1',
    prompt: 'Create hello.txt',
    runtime: 'mock',
    modelId: 'composer-2',
    status
  };
}
