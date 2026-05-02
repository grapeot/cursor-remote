import { describe, expect, it } from 'vitest';
import { InMemoryEventBroker, type SseClient, type SseEvent } from '../src/server/eventBroker.js';
import { InMemoryEventStore } from '../src/server/eventStore.js';

class TestSseClient implements SseClient {
  readonly received: SseEvent[] = [];
  private closed = false;

  send(event: SseEvent): void {
    this.received.push(event);
  }

  close(): void {
    this.closed = true;
  }

  isClosed(): boolean {
    return this.closed;
  }
}

describe('InMemoryEventBroker', () => {
  it('broadcasts live events to subscribers', () => {
    const eventStore = new InMemoryEventStore();
    const broker = new InMemoryEventBroker(eventStore);
    const client = new TestSseClient();
    broker.subscribe(client);

    const event = eventStore.append({ sessionId: 'session-1', runId: 'run-1', type: 'assistant.delta', payload: { text: 'hi' } });
    broker.notify(event);

    expect(client.received).toEqual([
      { id: '1', event: 'assistant.delta', data: JSON.stringify(event) }
    ]);
  });

  it('replays events after Last-Event-ID and then receives live events', () => {
    const eventStore = new InMemoryEventStore();
    const first = eventStore.append({ sessionId: 'session-1', runId: 'run-1', type: 'assistant.delta', payload: { text: 'first' } });
    const second = eventStore.append({ sessionId: 'session-1', runId: 'run-1', type: 'assistant.delta', payload: { text: 'second' } });
    const broker = new InMemoryEventBroker(eventStore);
    const client = new TestSseClient();

    broker.subscribe(client, { lastEventId: first.id, filter: (event) => event.runId === 'run-1' });
    const third = eventStore.append({ sessionId: 'session-1', runId: 'run-1', type: 'run.result', payload: { resultText: 'done' } });
    broker.notify(third);

    expect(client.received.map((event) => event.id)).toEqual([String(second.id), String(third.id)]);
  });

  it('stops sending after unsubscribe and removes closed clients', () => {
    const eventStore = new InMemoryEventStore();
    const broker = new InMemoryEventBroker(eventStore);
    const openClient = new TestSseClient();
    const closedClient = new TestSseClient();
    broker.subscribe(openClient);
    broker.subscribe(closedClient);
    broker.unsubscribe(openClient);
    closedClient.close();

    const event = eventStore.append({ sessionId: 'session-1', type: 'heartbeat', payload: {} });
    broker.notify(event);

    expect(openClient.received).toEqual([]);
    expect(closedClient.received).toEqual([]);
    expect(broker.subscriberCount()).toBe(0);
  });
});
