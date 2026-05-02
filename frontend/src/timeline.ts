import { isRunErrorPayload, readStringField } from '../../src/shared/events';
import type { AppEvent } from '../../src/shared/events';
import type { MessageProjection, RunProjection } from '../../src/shared/projections';

export type TimelineTone = 'muted' | 'running' | 'success' | 'error';

export type TimelineItem =
  | { kind: 'user'; id: string; runId?: string; text: string; status: 'sent' | 'failed'; createdAt: string }
  | { kind: 'assistant'; id: string; runId?: string; text: string; status: 'streaming' | 'completed' | 'failed'; createdAt: string }
  | { kind: 'thinking'; id: string; runId?: string; text: string; status: 'streaming' | 'completed'; createdAt: string }
  | {
      kind: 'tool';
      id: string;
      runId?: string;
      callId: string;
      name: string;
      status: 'running' | 'completed' | 'error';
      summary?: string;
      detail?: unknown;
      createdAt: string;
    }
  | { kind: 'status'; id: string; runId?: string; text: string; tone: TimelineTone; createdAt: string };

export function buildTimeline(messages: MessageProjection[], runs: RunProjection[], events: AppEvent[]): TimelineItem[] {
  const items = new Map<string, TimelineItem>();
  messages.forEach((message) => {
    if (message.role === 'user') {
      items.set(message.id, {
        kind: 'user',
        id: message.id,
        ...(message.runId !== undefined ? { runId: message.runId } : {}),
        text: message.content,
        status: message.status === 'failed' ? 'failed' : 'sent',
        createdAt: message.createdAt
      });
      return;
    }
    items.set(message.id, {
      kind: 'assistant',
      id: message.id,
      ...(message.runId !== undefined ? { runId: message.runId } : {}),
      text: message.content,
      status: message.status,
      createdAt: message.createdAt
    });
  });

  runs.forEach((run) => {
    items.set(`run-status-${run.id}`, {
      kind: 'status',
      id: `run-status-${run.id}`,
      runId: run.id,
      text: `Run ${shortRunId(run.id)} is ${run.status}`,
      tone: statusTone(run.status),
      createdAt: run.updatedAt
    });
  });

  events.forEach((event) => {
    const eventItem = eventToTimelineItem(event);
    if (eventItem !== undefined) {
      items.set(eventItem.id, eventItem);
    }
  });

  return [...items.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export function eventToTimelineItem(event: AppEvent): TimelineItem | undefined {
  if (event.type === 'thinking.delta') {
    const text = readStringField(event.payload, 'text');
    if (text === undefined || text.trim().length === 0) {
      return undefined;
    }
    return {
      kind: 'thinking',
      id: `thinking-${event.runId ?? event.id}`,
      ...(event.runId !== undefined ? { runId: event.runId } : {}),
      text,
      status: 'streaming',
      createdAt: event.createdAt
    };
  }
  if (event.type === 'tool.started' || event.type === 'tool.completed' || event.type === 'tool.error') {
    const tool = readToolPayload(event.payload);
    if (tool === undefined) {
      return undefined;
    }
    return {
      kind: 'tool',
      id: `tool-${tool.callId}`,
      ...(event.runId !== undefined ? { runId: event.runId } : {}),
      callId: tool.callId,
      name: tool.name,
      status: event.type === 'tool.completed' ? 'completed' : event.type === 'tool.error' ? 'error' : 'running',
      summary: tool.summary,
      detail: tool.detail,
      createdAt: event.createdAt
    };
  }
  if (event.type === 'task.updated') {
    const text = readStringField(event.payload, 'text') ?? readStringField(event.payload, 'status');
    return text
      ? {
          kind: 'status',
          id: `task-${event.id}`,
          ...(event.runId !== undefined ? { runId: event.runId } : {}),
          text,
          tone: 'muted',
          createdAt: event.createdAt
        }
      : undefined;
  }
  if (event.type === 'run.error' && isRunErrorPayload(event.payload)) {
    return {
      kind: 'status',
      id: `error-${event.id}`,
      ...(event.runId !== undefined ? { runId: event.runId } : {}),
      text: event.payload.error,
      tone: 'error',
      createdAt: event.createdAt
    };
  }
  return undefined;
}

export function formatDetail(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function shortRunId(id: string): string {
  if (id.length <= 18) {
    return id;
  }
  return `${id.slice(0, 8)}…${id.slice(-6)}`;
}

function readToolPayload(payload: unknown): { callId: string; name: string; summary?: string; detail?: unknown } | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  const callId = typeof record.callId === 'string' ? record.callId : undefined;
  const name = typeof record.name === 'string' ? record.name : undefined;
  if (callId === undefined || name === undefined) {
    return undefined;
  }
  const result = record.result;
  const args = record.args;
  return {
    callId,
    name,
    ...(result !== undefined ? { summary: formatToolSummary(result) } : {}),
    ...(args !== undefined ? { detail: args } : {})
  };
}

function formatToolSummary(value: unknown): string {
  if (typeof value === 'string') {
    return value.length > 160 ? `${value.slice(0, 157)}…` : value;
  }
  return 'Tool completed.';
}

function statusTone(status: RunProjection['status']): TimelineTone {
  if (status === 'completed') {
    return 'success';
  }
  if (status === 'failed' || status === 'cancelled') {
    return 'error';
  }
  if (status === 'queued' || status === 'running') {
    return 'running';
  }
  return 'muted';
}
