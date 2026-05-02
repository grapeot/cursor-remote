import type { AppConfig } from './config.js';
import type { AsyncCursorGateway, RawCursorEvent } from './cursorAgent.js';
import type { EventBroker } from './eventBroker.js';
import type { EventStore } from './eventStore.js';
import type { MessageQueryOptions, ProjectionStore } from './projectionStore.js';
import type { Clock, IdGenerator } from '../shared/dependencies.js';
import { realClock, realId } from '../shared/dependencies.js';
import type { StartRunRequest, StartRunResponse } from '../shared/contracts.js';
import type { AppEventType, AppRuntime } from '../shared/events.js';
import type { MessageProjection, RunProjection } from '../shared/projections.js';

export class RunService {
  constructor(
    private readonly config: AppConfig,
    private readonly gateway: AsyncCursorGateway,
    private readonly eventStore: EventStore,
    private readonly projectionStore: ProjectionStore,
    private readonly eventBroker: EventBroker,
    private readonly clock: Clock = realClock,
    private readonly idGenerator: IdGenerator = realId
  ) {}

  async startRun(sessionId: string, request: StartRunRequest): Promise<StartRunResponse> {
    const session = this.projectionStore.getSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} was not found.`);
    }

    const runId = `run-${this.idGenerator()}`;
    const runtime = request.runtime ?? session.runtime;
    const modelId = request.modelId ?? session.modelId ?? this.config.defaultModel;
    this.appendEvent(sessionId, runId, 'run.status', {
      runId,
      prompt: request.prompt,
      runtime,
      modelId,
      status: 'queued'
    });

    const run = this.projectionStore.getRun(runId);
    if (!run) {
      throw new Error(`Run ${runId} was not projected.`);
    }

    void this.executeInBackground(sessionId, runId, request, runtime, modelId);
    return { run, eventsUrl: `/api/runs/${runId}/events` };
  }

  getRun(runId: string): RunProjection | undefined {
    return this.projectionStore.getRun(runId);
  }

  listRuns(sessionId: string): RunProjection[] {
    return this.projectionStore.listRunsBySession(sessionId);
  }

  getMessages(sessionId: string, options?: MessageQueryOptions): MessageProjection[] {
    return this.projectionStore.getMessages(sessionId, options);
  }

  private async executeInBackground(
    sessionId: string,
    runId: string,
    request: StartRunRequest,
    runtime: AppRuntime,
    modelId: string
  ): Promise<void> {
    try {
      this.appendEvent(sessionId, runId, 'run.status', {
        runId,
        prompt: request.prompt,
        runtime,
        modelId,
        status: 'running'
      });
      await this.gateway.executeRun(sessionId, runId, request, (event) => this.applyRawCursorEvent(sessionId, runId, event));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown Cursor SDK error.';
      this.appendEvent(sessionId, runId, 'run.error', { error: message });
      this.appendEvent(sessionId, runId, 'run.status', {
        runId,
        prompt: request.prompt,
        runtime,
        modelId,
        status: 'failed'
      });
    }
  }

  private applyRawCursorEvent(sessionId: string, runId: string, event: RawCursorEvent): void {
    this.appendEvent(sessionId, runId, event.type, event.payload, event.cursorEventType, event.cursorEventId);
  }

  private appendEvent(
    sessionId: string,
    runId: string,
    type: AppEventType,
    payload: unknown,
    cursorEventType?: string,
    cursorEventId?: string
  ): void {
    const event = this.eventStore.append({
      sessionId,
      runId,
      type,
      payload,
      ...(cursorEventType ? { cursorEventType } : {}),
      ...(cursorEventId ? { cursorEventId } : {}),
      createdAt: this.clock()
    });
    this.projectionStore.apply(event);
    this.eventBroker.notify(event);
  }
}
