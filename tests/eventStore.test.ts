import { describe, expect, it } from 'vitest';
import { createEventIdSequence } from '../src/shared/dependencies.js';
import type { AppEventType } from '../src/shared/events.js';
import { InMemoryEventStore } from '../src/server/eventStore.js';

const timestamp = '2026-05-01T00:00:00.000Z';

function store() {
  return new InMemoryEventStore(() => timestamp, createEventIdSequence());
}

function append(storeUnderTest: InMemoryEventStore, sessionId: string, runId?: string, type: AppEventType = 'run.status') {
  return storeUnderTest.append({
    sessionId,
    ...(runId ? { runId } : {}),
    type,
    payload: { status: 'running' }
  });
}

describe('InMemoryEventStore', () => {
  it('assigns monotonic ids and timestamps to appended events', () => {
    const eventStore = store();

    const first = append(eventStore, 'session-1', 'run-1');
    const second = append(eventStore, 'session-1', 'run-1');

    expect(first.id).toBe(1);
    expect(second.id).toBe(2);
    expect(first.createdAt).toBe(timestamp);
    expect(eventStore.lastId()).toBe(2);
  });

  it('returns session events in append order', () => {
    const eventStore = store();

    append(eventStore, 'session-1', 'run-1');
    append(eventStore, 'session-2', 'run-2');
    append(eventStore, 'session-1', 'run-3');

    expect(eventStore.getBySession('session-1').map((event) => event.id)).toEqual([1, 3]);
  });

  it('returns run events in append order', () => {
    const eventStore = store();

    append(eventStore, 'session-1', 'run-1');
    append(eventStore, 'session-1', 'run-2');
    append(eventStore, 'session-1', 'run-1');

    expect(eventStore.getByRun('run-1').map((event) => event.id)).toEqual([1, 3]);
  });

  it('replays events after a given id for Last-Event-ID behavior', () => {
    const eventStore = store();

    append(eventStore, 'session-1', 'run-1');
    append(eventStore, 'session-1', 'run-1');
    append(eventStore, 'session-1', 'run-1');

    expect(eventStore.getAfterId(0).map((event) => event.id)).toEqual([1, 2, 3]);
    expect(eventStore.getAfterId(1).map((event) => event.id)).toEqual([2, 3]);
    expect(eventStore.getAfterId(3)).toEqual([]);
  });

  it('returns events by id and empty defaults for missing state', () => {
    const eventStore = store();

    const event = append(eventStore, 'session-1', 'run-1');

    expect(eventStore.getById(event.id)).toEqual(event);
    expect(eventStore.getById(999)).toBeUndefined();
    expect(eventStore.getBySession('missing')).toEqual([]);
    expect(eventStore.getByRun('missing')).toEqual([]);
  });
});
