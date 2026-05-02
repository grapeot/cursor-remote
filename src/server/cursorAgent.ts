import { randomUUID } from 'node:crypto';
import type { AppConfig } from './config.js';
import type { RunSummary, SendPromptRequest, StartRunRequest } from '../shared/contracts.js';
import type { AppEventType } from '../shared/events.js';
import { makeCursorStreamContext, mapCursorStreamMessage } from './cursorStreamMapper.js';
import { isCursorThinkingStreamMessage, ThinkingCoalescer } from './thinkingFlush.js';

export interface CursorAgentGateway {
  startRun(request: SendPromptRequest): Promise<RunSummary>;
}

export interface RawCursorEvent {
  type: AppEventType;
  payload: unknown;
  cursorEventType?: string;
  cursorEventId?: string;
}

export interface AsyncRunHandle {
  cursorRunId: string;
  cancel?(): Promise<void>;
}

export interface AsyncCursorGateway {
  executeRun(
    sessionId: string,
    runId: string,
    request: StartRunRequest,
    onEvent: (event: RawCursorEvent) => void
  ): Promise<AsyncRunHandle>;
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

export class MockCursorAgentGateway implements CursorAgentGateway, AsyncCursorGateway {
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
          'Mock run created. Set CURSOR_API_KEY, CURSOR_RUNTIME=local (or cloud), restart the stack, then try a real SDK run.'
      },
      {
        repoUrl: normalizeOptional(request.repoUrl),
        startingRef: normalizeOptional(request.startingRef),
        modelId: normalizeOptional(request.modelId)
      }
    );
  }

  async executeRun(
    _sessionId: string,
    runId: string,
    request: StartRunRequest,
    onEvent: (event: RawCursorEvent) => void
  ): Promise<AsyncRunHandle> {
    const modelId = normalizeOptional(request.modelId) ?? 'composer-2';
    const runtime = request.runtime ?? 'mock';
    setTimeout(() => {
      onEvent({ type: 'assistant.delta', payload: { text: 'Mock Cursor is processing the prompt. ' } });
      onEvent({ type: 'tool.started', payload: { name: 'write_file', callId: `tool-${runId}`, status: 'running' } });
      onEvent({ type: 'tool.completed', payload: { name: 'write_file', callId: `tool-${runId}`, status: 'completed' } });
      onEvent({ type: 'assistant.delta', payload: { text: 'Synthetic run completed.' } });
      onEvent({ type: 'run.result', payload: { resultText: `Mock run completed with ${modelId} in ${runtime} mode.` } });
      onEvent({
        type: 'run.status',
        payload: {
          runId,
          prompt: request.prompt,
          runtime,
          modelId,
          status: 'completed'
        }
      });
    }, 0);
    return { cursorRunId: `mock-${runId}` };
  }
}

export class CursorSdkGateway implements CursorAgentGateway, AsyncCursorGateway {
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

  async executeRun(
    _sessionId: string,
    runId: string,
    request: StartRunRequest,
    onEvent: (event: RawCursorEvent) => void
  ): Promise<AsyncRunHandle> {
    if (!this.config.cursorApiKey) {
      throw new Error('CURSOR_API_KEY is required for real Cursor SDK runs.');
    }
    const runtime = request.runtime ?? (this.config.runtime === 'local' ? 'local' : 'mock');
    if (runtime === 'mock') {
      return new MockCursorAgentGateway().executeRun(_sessionId, runId, request, onEvent);
    }
    if (!this.config.localCwd) {
      throw new Error('CURSOR_LOCAL_CWD is required for local Cursor SDK runs.');
    }

    const modelId = normalizeOptional(request.modelId) ?? this.config.defaultModel;
    const { Agent } = await import('@cursor/sdk');
    const agent = await Agent.create({
      apiKey: this.config.cursorApiKey,
      model: { id: modelId },
      local: { cwd: this.config.localCwd }
    });
    const streamContext = makeCursorStreamContext(runId, request, runtime, modelId);

    void (async () => {
      const thinkingCoalescer = new ThinkingCoalescer(runId);
      try {
        const run = await agent.send(request.prompt);
        for await (const message of run.stream()) {
          if (isCursorThinkingStreamMessage(message)) {
            thinkingCoalescer.push(message);
            continue;
          }
          for (const flushed of thinkingCoalescer.flush()) {
            onEvent(flushed);
          }
          mapCursorStreamMessage(message, streamContext).forEach(onEvent);
        }
        for (const flushed of thinkingCoalescer.flush()) {
          onEvent(flushed);
        }
        const result = await run.wait();
        onEvent({
          type: 'run.result',
          payload: typeof result.result === 'string' ? { resultText: result.result } : {}
        });
        onEvent({
          type: 'run.status',
          payload: {
            runId,
            prompt: request.prompt,
            runtime,
            modelId,
            status: result.status === 'finished' ? 'completed' : 'failed'
          }
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown Cursor SDK stream error.';
        onEvent({ type: 'run.error', payload: { error: message } });
        onEvent({
          type: 'run.status',
          payload: {
            runId,
            prompt: request.prompt,
            runtime,
            modelId,
            status: 'failed'
          }
        });
      } finally {
        await agent[Symbol.asyncDispose]();
      }
    })();

    return { cursorRunId: runId };
  }
}

export function createCursorGateway(config: AppConfig): CursorAgentGateway & AsyncCursorGateway {
  if (config.runtime === 'mock') {
    return new MockCursorAgentGateway();
  }
  return new CursorSdkGateway(config);
}
