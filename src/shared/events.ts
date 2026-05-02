import { z } from 'zod';

export const appRuntimeSchema = z.enum(['mock', 'local']);
export type AppRuntime = z.infer<typeof appRuntimeSchema>;

export const sessionStatusSchema = z.enum(['idle', 'running', 'failed']);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

export const appRunStatusSchema = z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']);
export type AppRunStatus = z.infer<typeof appRunStatusSchema>;

export const appEventTypeSchema = z.enum([
  'session.created',
  'session.updated',
  'run.status',
  'assistant.delta',
  'thinking.delta',
  'thinking.completed',
  'tool.started',
  'tool.delta',
  'tool.completed',
  'tool.error',
  'task.updated',
  'file.changed',
  'diff.snapshot',
  'run.result',
  'run.error',
  'heartbeat'
]);
export type AppEventType = z.infer<typeof appEventTypeSchema>;

export interface DiffSummary {
  baselineRef?: string;
  changedFiles: string[];
  insertions?: number;
  deletions?: number;
  summaryText?: string;
}

export interface SessionCreatedPayload {
  title: string;
  runtime: AppRuntime;
  cwd?: string;
  modelId: string;
}

export interface SessionUpdatedPayload {
  title?: string;
  status?: SessionStatus;
  cursorAgentId?: string;
  latestRunId?: string;
}

export interface RunStatusPayload {
  runId: string;
  prompt: string;
  runtime: AppRuntime;
  modelId: string;
  status: AppRunStatus;
}

export interface RunResultPayload {
  resultText?: string;
  diffSummary?: DiffSummary;
}

export interface RunErrorPayload {
  error: string;
}

export interface AppEvent {
  id: number;
  sessionId: string;
  runId?: string;
  type: AppEventType;
  cursorEventType?: string;
  cursorEventId?: string;
  payload: unknown;
  createdAt: string;
}

export const appEventSchema = z.object({
  id: z.number().int().nonnegative(),
  sessionId: z.string().min(1),
  runId: z.string().min(1).optional(),
  type: appEventTypeSchema,
  cursorEventType: z.string().min(1).optional(),
  cursorEventId: z.string().min(1).optional(),
  payload: z.unknown(),
  createdAt: z.string().min(1)
});

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readStringField(value: unknown, field: string): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const fieldValue = value[field];
  return typeof fieldValue === 'string' ? fieldValue : undefined;
}

export function isSessionCreatedPayload(value: unknown): value is SessionCreatedPayload {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.title === 'string' &&
    appRuntimeSchema.safeParse(value.runtime).success &&
    (value.cwd === undefined || typeof value.cwd === 'string') &&
    typeof value.modelId === 'string'
  );
}

export function isSessionUpdatedPayload(value: unknown): value is SessionUpdatedPayload {
  if (!isRecord(value)) {
    return false;
  }
  return (
    (value.title === undefined || typeof value.title === 'string') &&
    (value.status === undefined || sessionStatusSchema.safeParse(value.status).success) &&
    (value.cursorAgentId === undefined || typeof value.cursorAgentId === 'string') &&
    (value.latestRunId === undefined || typeof value.latestRunId === 'string')
  );
}

export function isRunStatusPayload(value: unknown): value is RunStatusPayload {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.runId === 'string' &&
    typeof value.prompt === 'string' &&
    appRuntimeSchema.safeParse(value.runtime).success &&
    typeof value.modelId === 'string' &&
    appRunStatusSchema.safeParse(value.status).success
  );
}

export function isRunResultPayload(value: unknown): value is RunResultPayload {
  if (!isRecord(value)) {
    return false;
  }
  return (
    (value.resultText === undefined || typeof value.resultText === 'string') &&
    (value.diffSummary === undefined || isDiffSummary(value.diffSummary))
  );
}

export function isRunErrorPayload(value: unknown): value is RunErrorPayload {
  return isRecord(value) && typeof value.error === 'string';
}

function isDiffSummary(value: unknown): value is DiffSummary {
  if (!isRecord(value) || !Array.isArray(value.changedFiles)) {
    return false;
  }
  return (
    value.changedFiles.every((file) => typeof file === 'string') &&
    (value.baselineRef === undefined || typeof value.baselineRef === 'string') &&
    (value.insertions === undefined || typeof value.insertions === 'number') &&
    (value.deletions === undefined || typeof value.deletions === 'number') &&
    (value.summaryText === undefined || typeof value.summaryText === 'string')
  );
}
