import { describe, expect, it } from 'vitest';
import type { AppEvent, AppEventType } from '../src/shared/events.js';
import { InMemoryProjectionStore } from '../src/server/projectionStore.js';

function event(
  id: number,
  type: AppEventType,
  payload: unknown,
  options: { sessionId?: string; runId?: string; createdAt?: string } = {}
): AppEvent {
  return {
    id,
    sessionId: options.sessionId ?? 'session-1',
    ...(options.runId ? { runId: options.runId } : {}),
    type,
    payload,
    createdAt: options.createdAt ?? `2026-05-01T00:00:0${id}.000Z`
  };
}

function sessionCreated(id = 1): AppEvent {
  return event(id, 'session.created', {
    title: 'Self bootstrapping session',
    runtime: 'local',
    cwd: '/tmp/repo',
    modelId: 'composer-2'
  });
}

function runStatus(id: number, status: string): AppEvent {
  return event(
    id,
    'run.status',
    {
      runId: 'run-1',
      prompt: 'Create hello.txt',
      runtime: 'local',
      modelId: 'composer-2',
      status
    },
    { runId: 'run-1' }
  );
}

function project(events: AppEvent[]) {
  const projection = new InMemoryProjectionStore();
  projection.rebuild(events);
  return projection;
}

describe('InMemoryProjectionStore', () => {
  it('projects session creation and updates', () => {
    const projection = project([
      sessionCreated(),
      event(2, 'session.updated', { title: 'Renamed session', cursorAgentId: 'agent-1' })
    ]);

    expect(projection.getSession('session-1')).toEqual({
      id: 'session-1',
      title: 'Renamed session',
      runtime: 'local',
      status: 'idle',
      cwd: '/tmp/repo',
      modelId: 'composer-2',
      cursorAgentId: 'agent-1',
      createdAt: '2026-05-01T00:00:01.000Z',
      updatedAt: '2026-05-01T00:00:02.000Z'
    });
    expect(projection.listSessions()).toHaveLength(1);
  });

  it('projects run lifecycle and user messages', () => {
    const projection = project([
      sessionCreated(),
      runStatus(2, 'queued'),
      runStatus(3, 'running'),
      runStatus(4, 'completed')
    ]);

    expect(projection.getRun('run-1')).toEqual({
      id: 'run-1',
      sessionId: 'session-1',
      status: 'completed',
      prompt: 'Create hello.txt',
      runtime: 'local',
      modelId: 'composer-2',
      createdAt: '2026-05-01T00:00:02.000Z',
      updatedAt: '2026-05-01T00:00:04.000Z',
      startedAt: '2026-05-01T00:00:03.000Z',
      completedAt: '2026-05-01T00:00:04.000Z'
    });
    expect(projection.getSession('session-1')?.status).toBe('idle');
    expect(projection.getSession('session-1')?.latestRunId).toBe('run-1');
    expect(projection.getMessages('session-1')).toEqual([
      {
        id: 'run-1-user',
        sessionId: 'session-1',
        runId: 'run-1',
        role: 'user',
        content: 'Create hello.txt',
        status: 'completed',
        createdAt: '2026-05-01T00:00:02.000Z',
        updatedAt: '2026-05-01T00:00:02.000Z'
      }
    ]);
  });

  it('appends assistant deltas and completes the assistant message on run result', () => {
    const projection = project([
      sessionCreated(),
      runStatus(2, 'queued'),
      event(3, 'assistant.delta', { text: 'Hello' }, { runId: 'run-1' }),
      event(4, 'assistant.delta', { text: ', world' }, { runId: 'run-1' }),
      event(5, 'run.result', { resultText: 'Hello, world' }, { runId: 'run-1' })
    ]);

    expect(projection.getMessages('session-1')).toEqual([
      expect.objectContaining({ id: 'run-1-user', role: 'user' }),
      {
        id: 'run-1-assistant',
        sessionId: 'session-1',
        runId: 'run-1',
        role: 'assistant',
        content: 'Hello, world',
        status: 'completed',
        createdAt: '2026-05-01T00:00:03.000Z',
        updatedAt: '2026-05-01T00:00:05.000Z'
      }
    ]);
    expect(projection.getRun('run-1')?.resultText).toBe('Hello, world');
  });

  it('projects run errors onto run, session, and assistant message state', () => {
    const projection = project([
      sessionCreated(),
      runStatus(2, 'queued'),
      runStatus(3, 'running'),
      event(4, 'assistant.delta', { text: 'Working' }, { runId: 'run-1' }),
      event(5, 'run.error', { error: 'Cursor failed' }, { runId: 'run-1' }),
      runStatus(6, 'failed')
    ]);

    expect(projection.getRun('run-1')?.error).toBe('Cursor failed');
    expect(projection.getRun('run-1')?.status).toBe('failed');
    expect(projection.getSession('session-1')?.status).toBe('failed');
    expect(projection.getMessages('session-1').at(-1)?.status).toBe('failed');
  });

  it('keeps sessions isolated and lists session runs in creation order', () => {
    const projection = project([
      sessionCreated(),
      event(2, 'session.created', { title: 'Other', runtime: 'mock', modelId: 'composer-2' }, { sessionId: 'session-2' }),
      runStatus(3, 'queued'),
      event(4, 'run.status', { runId: 'run-2', prompt: 'Mock prompt', runtime: 'mock', modelId: 'composer-2', status: 'queued' }, { sessionId: 'session-2', runId: 'run-2' })
    ]);

    expect(projection.listRunsBySession('session-1').map((run) => run.id)).toEqual(['run-1']);
    expect(projection.listRunsBySession('session-2').map((run) => run.id)).toEqual(['run-2']);
    expect(projection.getMessages('session-1')).toHaveLength(1);
    expect(projection.getMessages('session-2')).toHaveLength(1);
  });

  it('rebuild and incremental apply produce the same projections', () => {
    const events = [
      sessionCreated(),
      runStatus(2, 'queued'),
      runStatus(3, 'running'),
      event(4, 'assistant.delta', { text: 'Done' }, { runId: 'run-1' }),
      event(5, 'run.result', { resultText: 'Done' }, { runId: 'run-1' }),
      runStatus(6, 'completed')
    ];
    const rebuilt = project(events);
    const incremental = new InMemoryProjectionStore();
    for (const candidate of events) {
      incremental.apply(candidate);
    }

    expect(incremental.listSessions()).toEqual(rebuilt.listSessions());
    expect(incremental.listRunsBySession('session-1')).toEqual(rebuilt.listRunsBySession('session-1'));
    expect(incremental.getMessages('session-1')).toEqual(rebuilt.getMessages('session-1'));
  });

  it('ignores heartbeat and future event types in Milestone 1 projections', () => {
    const projection = project([
      sessionCreated(),
      event(2, 'heartbeat', {}),
      event(3, 'tool.started', { name: 'write_file' }, { runId: 'run-1' })
    ]);

    expect(projection.getSession('session-1')?.updatedAt).toBe('2026-05-01T00:00:01.000Z');
    expect(projection.getMessages('session-1')).toEqual([]);
  });
});
