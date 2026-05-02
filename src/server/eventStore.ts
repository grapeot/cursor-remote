import type { Clock, EventIdSequence } from '../shared/dependencies.js';
import { createEventIdSequence, realClock } from '../shared/dependencies.js';
import type { AppEvent } from '../shared/events.js';

export type AppendEvent = Omit<AppEvent, 'id' | 'createdAt'> & { createdAt?: string };

export interface EventStore {
  append(event: AppendEvent): AppEvent;
  getBySession(sessionId: string): AppEvent[];
  getByRun(runId: string): AppEvent[];
  getAfterId(afterId: number): AppEvent[];
  getById(id: number): AppEvent | undefined;
  all(): AppEvent[];
  lastId(): number;
}

export class InMemoryEventStore implements EventStore {
  private readonly events: AppEvent[] = [];

  constructor(
    private readonly clock: Clock = realClock,
    private readonly nextEventId: EventIdSequence = createEventIdSequence()
  ) {}

  append(event: AppendEvent): AppEvent {
    const stored = withOptionalEventFields({
      ...event,
      id: this.nextEventId(),
      createdAt: event.createdAt ?? this.clock()
    });
    this.events.push(stored);
    return stored;
  }

  getBySession(sessionId: string): AppEvent[] {
    return this.events.filter((event) => event.sessionId === sessionId);
  }

  getByRun(runId: string): AppEvent[] {
    return this.events.filter((event) => event.runId === runId);
  }

  getAfterId(afterId: number): AppEvent[] {
    return this.events.filter((event) => event.id > afterId);
  }

  getById(id: number): AppEvent | undefined {
    return this.events.find((event) => event.id === id);
  }

  all(): AppEvent[] {
    return [...this.events];
  }

  lastId(): number {
    return this.events.at(-1)?.id ?? 0;
  }
}

function withOptionalEventFields(event: AppendEvent & { id: number; createdAt: string }): AppEvent {
  return {
    id: event.id,
    sessionId: event.sessionId,
    ...(event.runId ? { runId: event.runId } : {}),
    type: event.type,
    ...(event.cursorEventType ? { cursorEventType: event.cursorEventType } : {}),
    ...(event.cursorEventId ? { cursorEventId: event.cursorEventId } : {}),
    payload: event.payload,
    createdAt: event.createdAt
  };
}
