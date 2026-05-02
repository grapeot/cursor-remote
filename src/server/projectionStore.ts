import {
  isRunErrorPayload,
  isRunResultPayload,
  isRunStatusPayload,
  isSessionCreatedPayload,
  isSessionUpdatedPayload,
  readStringField
} from '../shared/events.js';
import type { AppEvent, RunResultPayload, RunStatusPayload } from '../shared/events.js';
import type { MessageProjection, RunProjection, SessionProjection } from '../shared/projections.js';

export interface MessageQueryOptions {
  limit?: number;
  before?: string;
}

export interface ProjectionStore {
  getSession(sessionId: string): SessionProjection | undefined;
  listSessions(): SessionProjection[];
  getRun(runId: string): RunProjection | undefined;
  listRunsBySession(sessionId: string): RunProjection[];
  getMessages(sessionId: string, options?: MessageQueryOptions): MessageProjection[];
  apply(event: AppEvent): void;
  rebuild(events: Iterable<AppEvent>): void;
}

export class InMemoryProjectionStore implements ProjectionStore {
  private readonly sessions = new Map<string, SessionProjection>();
  private readonly runs = new Map<string, RunProjection>();
  private readonly messages = new Map<string, MessageProjection[]>();

  getSession(sessionId: string): SessionProjection | undefined {
    return cloneSession(this.sessions.get(sessionId));
  }

  listSessions(): SessionProjection[] {
    return Array.from(this.sessions.values())
      .map((session) => cloneExistingSession(session))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getRun(runId: string): RunProjection | undefined {
    return cloneRun(this.runs.get(runId));
  }

  listRunsBySession(sessionId: string): RunProjection[] {
    return Array.from(this.runs.values())
      .filter((run) => run.sessionId === sessionId)
      .map((run) => cloneExistingRun(run))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  getMessages(sessionId: string, options: MessageQueryOptions = {}): MessageProjection[] {
    const messages = this.messages.get(sessionId) ?? [];
    const before = options.before;
    const beforeFiltered = before !== undefined
      ? messages.filter((message) => message.createdAt < before)
      : messages;
    const limited = options.limit ? beforeFiltered.slice(-options.limit) : beforeFiltered;
    return limited.map((message) => cloneMessage(message));
  }

  apply(event: AppEvent): void {
    switch (event.type) {
      case 'session.created':
        this.applySessionCreated(event);
        break;
      case 'session.updated':
        this.applySessionUpdated(event);
        break;
      case 'run.status':
        this.applyRunStatus(event);
        break;
      case 'assistant.delta':
        this.applyAssistantDelta(event);
        break;
      case 'run.result':
        this.applyRunResult(event);
        break;
      case 'run.error':
        this.applyRunError(event);
        break;
      default:
        break;
    }
  }

  rebuild(events: Iterable<AppEvent>): void {
    this.sessions.clear();
    this.runs.clear();
    this.messages.clear();
    for (const event of events) {
      this.apply(event);
    }
  }

  private applySessionCreated(event: AppEvent): void {
    if (!isSessionCreatedPayload(event.payload)) {
      return;
    }
    this.sessions.set(event.sessionId, {
      id: event.sessionId,
      title: event.payload.title,
      runtime: event.payload.runtime,
      status: 'idle',
      ...(event.payload.cwd ? { cwd: event.payload.cwd } : {}),
      modelId: event.payload.modelId,
      createdAt: event.createdAt,
      updatedAt: event.createdAt
    });
  }

  private applySessionUpdated(event: AppEvent): void {
    if (!isSessionUpdatedPayload(event.payload)) {
      return;
    }
    const existing = this.sessions.get(event.sessionId);
    if (!existing) {
      return;
    }
    this.sessions.set(event.sessionId, {
      ...existing,
      ...(event.payload.title !== undefined ? { title: event.payload.title } : {}),
      ...(event.payload.status !== undefined ? { status: event.payload.status } : {}),
      ...(event.payload.cursorAgentId !== undefined ? { cursorAgentId: event.payload.cursorAgentId } : {}),
      ...(event.payload.latestRunId !== undefined ? { latestRunId: event.payload.latestRunId } : {}),
      updatedAt: event.createdAt
    });
  }

  private applyRunStatus(event: AppEvent): void {
    if (!isRunStatusPayload(event.payload)) {
      return;
    }
    if (event.payload.status === 'queued') {
      this.createQueuedRun(event, event.payload);
      return;
    }
    this.updateExistingRunStatus(event, event.payload);
  }

  private createQueuedRun(event: AppEvent, payload: RunStatusPayload): void {
    this.runs.set(payload.runId, {
      id: payload.runId,
      sessionId: event.sessionId,
      status: 'queued',
      prompt: payload.prompt,
      runtime: payload.runtime,
      modelId: payload.modelId,
      createdAt: event.createdAt,
      updatedAt: event.createdAt
    });
    this.upsertMessage(event.sessionId, {
      id: `${payload.runId}-user`,
      sessionId: event.sessionId,
      runId: payload.runId,
      role: 'user',
      content: payload.prompt,
      status: 'completed',
      createdAt: event.createdAt,
      updatedAt: event.createdAt
    });
    const session = this.sessions.get(event.sessionId);
    if (session) {
      this.sessions.set(event.sessionId, {
        ...session,
        status: 'running',
        latestRunId: payload.runId,
        updatedAt: event.createdAt
      });
    }
  }

  private updateExistingRunStatus(event: AppEvent, payload: RunStatusPayload): void {
    const run = this.runs.get(payload.runId);
    if (!run) {
      return;
    }
    const terminal = payload.status === 'completed' || payload.status === 'failed' || payload.status === 'cancelled';
    this.runs.set(payload.runId, {
      ...run,
      status: payload.status,
      updatedAt: event.createdAt,
      ...(payload.status === 'running' ? { startedAt: event.createdAt } : {}),
      ...(terminal ? { completedAt: event.createdAt } : {})
    });
    if (terminal) {
      const session = this.sessions.get(event.sessionId);
      if (session) {
        this.sessions.set(event.sessionId, {
          ...session,
          status: payload.status === 'failed' ? 'failed' : 'idle',
          updatedAt: event.createdAt
        });
      }
    }
  }

  private applyAssistantDelta(event: AppEvent): void {
    if (!event.runId) {
      return;
    }
    const text = readStringField(event.payload, 'text') ?? '';
    const messageId = `${event.runId}-assistant`;
    const existing = this.findMessage(event.sessionId, messageId);
    if (!existing) {
      this.upsertMessage(event.sessionId, {
        id: messageId,
        sessionId: event.sessionId,
        runId: event.runId,
        role: 'assistant',
        content: text,
        status: 'streaming',
        createdAt: event.createdAt,
        updatedAt: event.createdAt
      });
      return;
    }
    this.upsertMessage(event.sessionId, {
      ...existing,
      content: `${existing.content}${text}`,
      updatedAt: event.createdAt
    });
  }

  private applyRunResult(event: AppEvent): void {
    if (!event.runId || !isRunResultPayload(event.payload)) {
      return;
    }
    const run = this.runs.get(event.runId);
    if (run) {
      this.runs.set(event.runId, {
        ...run,
        ...(event.payload.resultText !== undefined ? { resultText: event.payload.resultText } : {}),
        ...(event.payload.diffSummary !== undefined ? { diffSummary: event.payload.diffSummary } : {}),
        updatedAt: event.createdAt
      });
    }
    this.completeAssistantMessage(event, event.payload);
  }

  private applyRunError(event: AppEvent): void {
    if (!event.runId || !isRunErrorPayload(event.payload)) {
      return;
    }
    const run = this.runs.get(event.runId);
    if (run) {
      this.runs.set(event.runId, {
        ...run,
        error: event.payload.error,
        updatedAt: event.createdAt
      });
    }
    const session = this.sessions.get(event.sessionId);
    if (session) {
      this.sessions.set(event.sessionId, {
        ...session,
        status: 'failed',
        updatedAt: event.createdAt
      });
    }
    const message = this.findMessage(event.sessionId, `${event.runId}-assistant`);
    if (message) {
      this.upsertMessage(event.sessionId, {
        ...message,
        status: 'failed',
        updatedAt: event.createdAt
      });
    }
  }

  private completeAssistantMessage(event: AppEvent, payload: RunResultPayload): void {
    if (!event.runId) {
      return;
    }
    const messageId = `${event.runId}-assistant`;
    const existing = this.findMessage(event.sessionId, messageId);
    if (existing) {
      this.upsertMessage(event.sessionId, {
        ...existing,
        status: 'completed',
        updatedAt: event.createdAt
      });
      return;
    }
    if (payload.resultText) {
      this.upsertMessage(event.sessionId, {
        id: messageId,
        sessionId: event.sessionId,
        runId: event.runId,
        role: 'assistant',
        content: payload.resultText,
        status: 'completed',
        createdAt: event.createdAt,
        updatedAt: event.createdAt
      });
    }
  }

  private findMessage(sessionId: string, messageId: string): MessageProjection | undefined {
    return this.messages.get(sessionId)?.find((message) => message.id === messageId);
  }

  private upsertMessage(sessionId: string, message: MessageProjection): void {
    const existing = this.messages.get(sessionId) ?? [];
    const index = existing.findIndex((candidate) => candidate.id === message.id);
    if (index === -1) {
      this.messages.set(sessionId, [...existing, message]);
      return;
    }
    this.messages.set(sessionId, [
      ...existing.slice(0, index),
      message,
      ...existing.slice(index + 1)
    ]);
  }
}

function cloneSession(session: SessionProjection | undefined): SessionProjection | undefined {
  return session ? cloneExistingSession(session) : undefined;
}

function cloneRun(run: RunProjection | undefined): RunProjection | undefined {
  return run ? cloneExistingRun(run) : undefined;
}

function cloneExistingSession(session: SessionProjection): SessionProjection {
  return { ...session };
}

function cloneExistingRun(run: RunProjection): RunProjection {
  return {
    ...run,
    ...(run.diffSummary
      ? { diffSummary: { ...run.diffSummary, changedFiles: [...run.diffSummary.changedFiles] } }
      : {})
  };
}

function cloneMessage(message: MessageProjection): MessageProjection {
  return { ...message };
}
