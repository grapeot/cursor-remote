import type { AppRuntime, AppRunStatus, DiffSummary, SessionStatus } from './events.js';

export interface SessionProjection {
  id: string;
  title: string;
  runtime: AppRuntime;
  status: SessionStatus;
  cwd?: string;
  modelId: string;
  cursorAgentId?: string;
  latestRunId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RunProjection {
  id: string;
  sessionId: string;
  cursorRunId?: string;
  status: AppRunStatus;
  prompt: string;
  runtime: AppRuntime;
  modelId: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  resultText?: string;
  error?: string;
  diffSummary?: DiffSummary;
}

export interface MessageProjection {
  id: string;
  sessionId: string;
  runId?: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  status: 'streaming' | 'completed' | 'failed';
  createdAt: string;
  updatedAt: string;
}
