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

  const sortedEvents = [...events].sort((left, right) => {
    const time = left.createdAt.localeCompare(right.createdAt);
    if (time !== 0) {
      return time;
    }
    return left.id - right.id;
  });

  for (const event of sortedEvents) {
    mergeEventIntoTimeline(items, event);
  }

  return [...items.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function thinkingKey(event: AppEvent): string {
  return `thinking-${event.runId ?? `n-${event.sessionId}`}`;
}

function mergeThinkingDelta(items: Map<string, TimelineItem>, event: AppEvent): void {
  const text = readStringField(event.payload, 'text');
  if (text === undefined || text.trim().length === 0) {
    return;
  }
  const id = thinkingKey(event);
  const existing = items.get(id);
  if (existing !== undefined && existing.kind === 'thinking') {
    items.set(id, {
      ...existing,
      text: existing.text + text,
      status: 'streaming'
    });
    return;
  }
  items.set(id, {
    kind: 'thinking',
    id,
    ...(event.runId !== undefined ? { runId: event.runId } : {}),
    text,
    status: 'streaming',
    createdAt: event.createdAt
  });
}

function mergeThinkingCompleted(items: Map<string, TimelineItem>, event: AppEvent): void {
  const id = thinkingKey(event);
  const existing = items.get(id);
  if (existing !== undefined && existing.kind === 'thinking') {
    items.set(id, { ...existing, status: 'completed' });
  }
}

function mergeToolTimelineEvent(items: Map<string, TimelineItem>, event: AppEvent): void {
  const tool = readToolPayload(event.payload);
  if (tool === undefined) {
    return;
  }
  const key = `tool-${tool.callId}`;
  const prev = items.get(key);
  const prevTool = prev?.kind === 'tool' ? prev : undefined;

  const detail = tool.detail ?? prevTool?.detail;
  const summary = tool.summary ?? prevTool?.summary;
  const status =
    event.type === 'tool.completed' ? 'completed' : event.type === 'tool.error' ? 'error' : 'running';

  items.set(key, {
    kind: 'tool',
    id: key,
    ...(event.runId !== undefined ? { runId: event.runId } : {}),
    callId: tool.callId,
    name: tool.name,
    status,
    ...(summary !== undefined ? { summary } : {}),
    ...(detail !== undefined ? { detail } : {}),
    createdAt: prevTool?.createdAt ?? event.createdAt
  });
}

function mergeEventIntoTimeline(items: Map<string, TimelineItem>, event: AppEvent): void {
  if (event.type === 'thinking.delta') {
    mergeThinkingDelta(items, event);
    return;
  }
  if (event.type === 'thinking.completed') {
    mergeThinkingCompleted(items, event);
    return;
  }
  if (event.type === 'tool.started' || event.type === 'tool.completed' || event.type === 'tool.error') {
    mergeToolTimelineEvent(items, event);
    return;
  }

  const eventItem = eventToTimelineItem(event);
  if (eventItem !== undefined) {
    items.set(eventItem.id, eventItem);
  }
}

export function eventToTimelineItem(event: AppEvent): TimelineItem | undefined {
  if (event.type === 'task.updated') {
    const raw = readStringField(event.payload, 'text') ?? readStringField(event.payload, 'status');
    const text = raw?.trim();
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

/** Pretty key paths with JSON-stringified scalar/array leaves (nested objects flattened with dotted keys). */
export function flattenJsonForDisplay(value: unknown): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return [`value: ${stringifyLeaf(value)}`];
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length === 0) {
    return [];
  }
  const lines: string[] = [];
  for (const key of keys) {
    const nested = record[key];
    if (nested !== null && typeof nested === 'object' && !Array.isArray(nested)) {
      lines.push(...flattenNestedObject(`${key}`, nested as Record<string, unknown>));
    } else {
      lines.push(`${key}: ${stringifyLeaf(nested)}`);
    }
  }
  return lines;
}

function flattenNestedObject(prefix: string, obj: Record<string, unknown>): string[] {
  const keys = Object.keys(obj).sort();
  if (keys.length === 0) {
    return [`${prefix}: {}`];
  }
  const lines: string[] = [];
  for (const key of keys) {
    const path = `${prefix}.${key}`;
    const nested = obj[key];
    if (nested !== null && typeof nested === 'object' && !Array.isArray(nested)) {
      lines.push(...flattenNestedObject(path, nested as Record<string, unknown>));
    } else {
      lines.push(`${path}: ${stringifyLeaf(nested)}`);
    }
  }
  return lines;
}

function stringifyLeaf(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return `"${String(value).replace(/"/g, '\\"')}"`;
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
