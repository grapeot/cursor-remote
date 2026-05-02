import { z } from 'zod';

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
