import type { AppConfig } from './config.js';
import type { EventBroker } from './eventBroker.js';
import type { EventStore } from './eventStore.js';
import type { ProjectionStore } from './projectionStore.js';
import type { Clock, IdGenerator } from '../shared/dependencies.js';
import { realClock, realId } from '../shared/dependencies.js';
import type { CreateSessionRequest } from '../shared/contracts.js';
import type { SessionProjection } from '../shared/projections.js';

export class SessionService {
  constructor(
    private readonly config: AppConfig,
    private readonly eventStore: EventStore,
    private readonly projectionStore: ProjectionStore,
    private readonly eventBroker: EventBroker,
    private readonly clock: Clock = realClock,
    private readonly idGenerator: IdGenerator = realId
  ) {}

  createSession(request: CreateSessionRequest): SessionProjection {
    const sessionId = `session-${this.idGenerator()}`;
    const event = this.eventStore.append({
      sessionId,
      type: 'session.created',
      payload: {
        title: request.title ?? 'New Cursor session',
        runtime: this.config.runtime === 'local' ? 'local' : 'mock',
        ...(this.config.localCwd ? { cwd: this.config.localCwd } : {}),
        modelId: this.config.defaultModel
      },
      createdAt: this.clock()
    });
    this.projectionStore.apply(event);
    this.eventBroker.notify(event);
    const session = this.projectionStore.getSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} was not projected.`);
    }
    return session;
  }

  getSession(sessionId: string): SessionProjection | undefined {
    return this.projectionStore.getSession(sessionId);
  }

  listSessions(): SessionProjection[] {
    return this.projectionStore.listSessions();
  }
}
