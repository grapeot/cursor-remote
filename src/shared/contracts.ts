import { z } from 'zod';
import type { MessageProjection, RunProjection, SessionProjection } from './projections.js';

export const runtimeSchema = z.enum(['mock', 'cloud', 'local']);
export type CursorRuntime = z.infer<typeof runtimeSchema>;

export const sendPromptRequestSchema = z.object({
  prompt: z.string().min(1, 'Prompt is required'),
  repoUrl: z.string().url().optional().or(z.literal('')),
  startingRef: z.string().min(1).optional().or(z.literal('')),
  modelId: z.string().min(1).optional().or(z.literal('')),
  runtime: runtimeSchema.optional()
});

export type SendPromptRequest = z.infer<typeof sendPromptRequestSchema>;

export interface RunSummary {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'mocked';
  runtime: CursorRuntime;
  prompt: string;
  createdAt: string;
  updatedAt: string;
  repoUrl?: string;
  startingRef?: string;
  modelId?: string;
  resultText?: string;
  prUrl?: string;
}

export interface HealthResponse {
  ok: boolean;
  runtime: CursorRuntime;
  hasCursorApiKey: boolean;
  /** True when `CURSOR_LOCAL_CWD` is set (required for `local` SDK runs). */
  localCwdConfigured: boolean;
  /** Absolute working directory from `CURSOR_LOCAL_CWD` when set (localhost POC only). */
  localCwd?: string;
}

export interface SendPromptResponse {
  run: RunSummary;
}

export interface RunsResponse {
  runs: RunSummary[];
}

export interface ErrorResponse {
  error: {
    code: string;
    message: string;
  };
}

export const createSessionRequestSchema = z.object({
  title: z.string().min(1).max(200).optional()
});

export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;

export const startRunRequestSchema = z.object({
  prompt: z.string().min(1, 'Prompt is required').max(10000),
  modelId: z.string().min(1).optional(),
  runtime: z.enum(['mock', 'local']).optional()
});

export type StartRunRequest = z.infer<typeof startRunRequestSchema>;

export interface CreateSessionResponse {
  session: SessionProjection;
}

export interface ListSessionsResponse {
  sessions: SessionProjection[];
}

export interface StartRunResponse {
  run: RunProjection;
  eventsUrl: string;
}

export interface GetRunResponse {
  run: RunProjection | RunSummary;
}

export interface ListSessionRunsResponse {
  runs: RunProjection[];
}

export interface ListMessagesResponse {
  messages: MessageProjection[];
}
