import type { AppEvent } from '../shared/events.js';
import type { EventStore } from './eventStore.js';

export interface SseEvent {
  id: string;
  event: string;
  data: string;
}

export interface SseClient {
  send(event: SseEvent): void;
  close(): void;
  isClosed(): boolean;
}

export interface SubscribeOptions {
  lastEventId?: number;
  filter?: (event: AppEvent) => boolean;
}

export interface EventBroker {
  subscribe(client: SseClient, options?: SubscribeOptions): void;
  unsubscribe(client: SseClient): void;
  notify(event: AppEvent): void;
  subscriberCount(): number;
}

interface Subscriber {
  client: SseClient;
  filter: (event: AppEvent) => boolean;
}

export class InMemoryEventBroker implements EventBroker {
  private readonly subscribers: Subscriber[] = [];

  constructor(private readonly eventStore: EventStore) {}

  subscribe(client: SseClient, options: SubscribeOptions = {}): void {
    const filter = options.filter ?? (() => true);
    const replayEvents = options.lastEventId !== undefined
      ? this.eventStore.getAfterId(options.lastEventId).filter(filter)
      : [];

    for (const event of replayEvents) {
      client.send(toSseEvent(event));
    }

    if (!client.isClosed()) {
      this.subscribers.push({ client, filter });
    }
  }

  unsubscribe(client: SseClient): void {
    const index = this.subscribers.findIndex((subscriber) => subscriber.client === client);
    if (index !== -1) {
      this.subscribers.splice(index, 1);
    }
  }

  notify(event: AppEvent): void {
    const sseEvent = toSseEvent(event);
    for (const subscriber of [...this.subscribers]) {
      if (subscriber.client.isClosed()) {
        this.unsubscribe(subscriber.client);
        continue;
      }
      if (subscriber.filter(event)) {
        subscriber.client.send(sseEvent);
      }
    }
  }

  subscriberCount(): number {
    return this.subscribers.filter((subscriber) => !subscriber.client.isClosed()).length;
  }
}

export function toSseEvent(event: AppEvent): SseEvent {
  return {
    id: String(event.id),
    event: event.type,
    data: JSON.stringify(event)
  };
}
