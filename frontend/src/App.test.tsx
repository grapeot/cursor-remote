// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEvent } from '../../src/shared/events';
import type { StartRunResponse } from '../../src/shared/contracts';
import type { RunProjection, SessionProjection } from '../../src/shared/projections';
import { App } from './main';
import * as api from './api';

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
    expect(screen.getByText('write_file')).toBeTruthy();
    expect(screen.getByText('Wrote hello.txt')).toBeTruthy();
    expect(screen.getByText(/"path": "hello.txt"/)).toBeTruthy();
    expect(screen.getByText(/Cursor · completed ·/)).toBeTruthy();
    expect(screen.getByText('Created hello.txt.')).toBeTruthy();
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
