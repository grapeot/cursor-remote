import { describe, expect, it } from 'vitest';
import type { AppEvent } from '../src/shared/events.js';
import { InMemoryEventStore } from '../src/server/eventStore.js';
import { InMemoryProjectionStore } from '../src/server/projectionStore.js';

function appendLifecycle(store: InMemoryEventStore): AppEvent[] {
  return [
    store.append({ sessionId: 'session-1', type: 'session.created', payload: { title: 'Build app', runtime: 'local', modelId: 'composer-2' } }),
    store.append({ sessionId: 'session-1', runId: 'run-1', type: 'run.status', payload: { runId: 'run-1', prompt: 'Write hello', runtime: 'local', modelId: 'composer-2', status: 'queued' } }),
    store.append({ sessionId: 'session-1', runId: 'run-1', type: 'run.status', payload: { runId: 'run-1', prompt: 'Write hello', runtime: 'local', modelId: 'composer-2', status: 'running' } }),
    store.append({ sessionId: 'session-1', runId: 'run-1', type: 'assistant.delta', payload: { text: 'Writing' } }),
    store.append({ sessionId: 'session-1', runId: 'run-1', type: 'run.result', payload: { resultText: 'Writing complete' } }),
    store.append({ sessionId: 'session-1', runId: 'run-1', type: 'run.status', payload: { runId: 'run-1', prompt: 'Write hello', runtime: 'local', modelId: 'composer-2', status: 'completed' } })
  ];
}

describe('event projection integration', () => {
  it('projects a complete session lifecycle from EventStore events', () => {
    const eventStore = new InMemoryEventStore(() => '2026-05-01T00:00:00.000Z');
    appendLifecycle(eventStore);

    const projection = new InMemoryProjectionStore();
    projection.rebuild(eventStore.all());

    expect(eventStore.getAfterId(3).map((event) => event.id)).toEqual([4, 5, 6]);
    expect(projection.getSession('session-1')?.status).toBe('idle');
    expect(projection.getRun('run-1')?.status).toBe('completed');
    expect(projection.getRun('run-1')?.resultText).toBe('Writing complete');
    expect(projection.getMessages('session-1').map((message) => message.role)).toEqual(['user', 'assistant']);
  });

  it('projects a failed run without throwing away prior messages', () => {
    const eventStore = new InMemoryEventStore(() => '2026-05-01T00:00:00.000Z');
    eventStore.append({ sessionId: 'session-1', type: 'session.created', payload: { title: 'Build app', runtime: 'local', modelId: 'composer-2' } });
    eventStore.append({ sessionId: 'session-1', runId: 'run-1', type: 'run.status', payload: { runId: 'run-1', prompt: 'Write hello', runtime: 'local', modelId: 'composer-2', status: 'queued' } });
    eventStore.append({ sessionId: 'session-1', runId: 'run-1', type: 'assistant.delta', payload: { text: 'Trying' } });
    eventStore.append({ sessionId: 'session-1', runId: 'run-1', type: 'run.error', payload: { error: 'SDK timeout' } });
    eventStore.append({ sessionId: 'session-1', runId: 'run-1', type: 'run.status', payload: { runId: 'run-1', prompt: 'Write hello', runtime: 'local', modelId: 'composer-2', status: 'failed' } });

    const projection = new InMemoryProjectionStore();
    projection.rebuild(eventStore.all());

    expect(projection.getSession('session-1')?.status).toBe('failed');
    expect(projection.getRun('run-1')?.error).toBe('SDK timeout');
    expect(projection.getMessages('session-1').map((message) => message.status)).toEqual(['completed', 'failed']);
  });
});
