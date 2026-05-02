import { randomUUID } from 'node:crypto';
import type { AppConfig } from './config.js';
import type { RunSummary, SendPromptRequest } from '../shared/contracts.js';

export interface CursorAgentGateway {
  startRun(request: SendPromptRequest): Promise<RunSummary>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

interface OptionalRunFields {
  repoUrl?: string | undefined;
  startingRef?: string | undefined;
  modelId?: string | undefined;
  prUrl?: string | undefined;
}

function withOptionalRunFields(
  run: Omit<RunSummary, 'repoUrl' | 'startingRef' | 'modelId' | 'prUrl'>,
  fields: OptionalRunFields
): RunSummary {
  return {
    ...run,
    ...(fields.repoUrl ? { repoUrl: fields.repoUrl } : {}),
    ...(fields.startingRef ? { startingRef: fields.startingRef } : {}),
    ...(fields.modelId ? { modelId: fields.modelId } : {}),
    ...(fields.prUrl ? { prUrl: fields.prUrl } : {})
  };
}

export class MockCursorAgentGateway implements CursorAgentGateway {
  async startRun(request: SendPromptRequest): Promise<RunSummary> {
    const timestamp = nowIso();
    return withOptionalRunFields(
      {
        id: `mock_${randomUUID()}`,
        status: 'mocked',
        runtime: 'mock',
        prompt: request.prompt,
        createdAt: timestamp,
        updatedAt: timestamp,
        resultText:
          'Mock run created. Set CURSOR_API_KEY, CURSOR_RUNTIME=local (or cloud), and use npm run dev:op when the key comes from 1Password.'
      },
      {
        repoUrl: normalizeOptional(request.repoUrl),
        startingRef: normalizeOptional(request.startingRef),
        modelId: normalizeOptional(request.modelId)
      }
    );
  }
}

export class CursorSdkGateway implements CursorAgentGateway {
  constructor(private readonly config: AppConfig) {}

  async startRun(request: SendPromptRequest): Promise<RunSummary> {
    if (!this.config.cursorApiKey) {
      throw new Error('CURSOR_API_KEY is required for real Cursor SDK runs.');
    }

    const runtime = request.runtime ?? this.config.runtime;
    if (runtime === 'mock') {
      return new MockCursorAgentGateway().startRun(request);
    }

    const repoUrl = normalizeOptional(request.repoUrl) ?? this.config.defaultRepoUrl;
    const startingRef = normalizeOptional(request.startingRef) ?? this.config.defaultRef;
    const modelId = normalizeOptional(request.modelId) ?? this.config.defaultModel;

    if (runtime === 'local' && !this.config.localCwd) {
      throw new Error('CURSOR_LOCAL_CWD is required for local Cursor SDK runs.');
    }

    if (runtime === 'cloud' && !repoUrl) {
      throw new Error(
        'Cloud runs require a Git repository URL (set repoUrl in the request or CURSOR_DEFAULT_REPO_URL).'
      );
    }

    const agentOptions = {
      apiKey: this.config.cursorApiKey,
      model: { id: modelId },
      ...(runtime === 'local' && this.config.localCwd
        ? {
            local: {
              cwd: this.config.localCwd
            }
          }
        : {}),
      ...(runtime === 'cloud' && repoUrl
        ? {
            cloud: {
              repos: [{ url: repoUrl, startingRef }],
              autoCreatePR: true
            }
          }
        : {})
    };

    const { Agent } = await import('@cursor/sdk');
    const agent = await Agent.create(agentOptions);
    const createdAt = nowIso();

    try {
      const run = await agent.send(request.prompt);
      const runResult = await run.wait();
      const updatedAt = nowIso();
      const terminalStatus = runResult.status === 'finished' ? 'completed' : 'failed';
      const prUrl = runResult.git?.branches?.find((branch) => branch.prUrl)?.prUrl;

      return withOptionalRunFields(
        {
          id: run.id,
          status: terminalStatus,
          runtime,
          prompt: request.prompt,
          createdAt,
          updatedAt,
          ...(typeof runResult.result === 'string' ? { resultText: runResult.result } : {})
        },
        { repoUrl, startingRef, modelId, ...(prUrl ? { prUrl } : {}) }
      );
    } finally {
      await agent[Symbol.asyncDispose]();
    }
  }
}

export function createCursorGateway(config: AppConfig): CursorAgentGateway {
  if (config.runtime === 'mock') {
    return new MockCursorAgentGateway();
  }
  return new CursorSdkGateway(config);
}
