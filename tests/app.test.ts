import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { Express } from 'express';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app.js';
import type { AsyncCursorGateway, CursorAgentGateway, RawCursorEvent } from '../src/server/cursorAgent.js';
import type { AppConfig } from '../src/server/config.js';
import type { RunSummary, SendPromptRequest, StartRunResponse } from '../src/shared/contracts.js';
import type { MessageProjection, RunProjection, SessionProjection } from '../src/shared/projections.js';

async function listen(app: Express): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolve, reject) => {
    const server = createServer(app);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Unexpected listen address'));
        return;
      }
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

async function stop(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

const config: AppConfig = {
  port: 8787,
  runtime: 'mock',
  defaultRef: 'main',
  defaultModel: 'composer-2'
};

class TestGateway implements CursorAgentGateway {
  async startRun(requestBody: SendPromptRequest): Promise<RunSummary> {
    return {
      id: 'test-run-1',
      status: 'mocked',
      runtime: 'mock',
      prompt: requestBody.prompt,
      createdAt: '2026-04-29T12:00:00.000Z',
      updatedAt: '2026-04-29T12:00:00.000Z',
      ...(requestBody.repoUrl ? { repoUrl: requestBody.repoUrl } : {}),
      ...(requestBody.startingRef ? { startingRef: requestBody.startingRef } : {}),
      ...(requestBody.modelId ? { modelId: requestBody.modelId } : {}),
      resultText: 'Created by test gateway.'
    };
  }
}

class TestAsyncGateway extends TestGateway implements AsyncCursorGateway {
  async executeRun(
    _sessionId: string,
    runId: string,
    request: { prompt: string; modelId?: string; runtime?: 'mock' | 'local' },
    onEvent: (event: RawCursorEvent) => void
  ) {
    setTimeout(() => {
      onEvent({ type: 'assistant.delta', payload: { text: 'Async mock response.' } });
      onEvent({ type: 'run.result', payload: { resultText: 'Async mock completed.' } });
      onEvent({
        type: 'run.status',
        payload: {
          runId,
          prompt: request.prompt,
          runtime: request.runtime ?? 'mock',
          modelId: request.modelId ?? 'composer-2',
          status: 'completed'
        }
      });
    }, 0);
    return { cursorRunId: `cursor-${runId}` };
  }
}

async function waitFor<T>(read: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  let lastValue = await read();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate(lastValue)) {
      return lastValue;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    lastValue = await read();
  }
  return lastValue;
}

describe('createApp', () => {
  it('returns health without exposing secrets', async () => {
    const app = createApp({ ...config, cursorApiKey: 'secret' }, new TestGateway());
    const { server, baseUrl } = await listen(app);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toEqual({
        ok: true,
        runtime: 'mock',
        hasCursorApiKey: true,
        localCwdConfigured: false
      });
    } finally {
      await stop(server);
    }
  });

  it('rejects empty prompts', async () => {
    const app = createApp(config, new TestGateway());
    const { server, baseUrl } = await listen(app);
    try {
      const response = await fetch(`${baseUrl}/api/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: '' })
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('INVALID_REQUEST');
    } finally {
      await stop(server);
    }
  });

  it('creates and lists runs', async () => {
    const app = createApp(config, new TestGateway());
    const { server, baseUrl } = await listen(app);
    try {
      const created = await fetch(`${baseUrl}/api/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: 'Fix one bug',
          repoUrl: 'https://github.com/cursor/cookbook'
        })
      });
      expect(created.status).toBe(201);
      const createdBody = (await created.json()) as { run: RunSummary };
      expect(createdBody.run.id).toBe('test-run-1');
      expect(createdBody.run.prompt).toBe('Fix one bug');

      const listed = await fetch(`${baseUrl}/api/runs`);
      expect(listed.status).toBe(200);
      const listedBody = (await listed.json()) as { runs: RunSummary[] };
      expect(listedBody.runs).toHaveLength(1);
      const listedRun = listedBody.runs[0];
      expect(listedRun).toBeDefined();
      expect(listedRun?.id).toBe('test-run-1');
    } finally {
      await stop(server);
    }
  });

  it('creates sessions and starts async session runs without waiting for completion', async () => {
    const app = createApp(config, new TestAsyncGateway());
    const { server, baseUrl } = await listen(app);
    try {
      const createdSession = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Stage 1 session' })
      });
      expect(createdSession.status).toBe(201);
      const sessionBody = (await createdSession.json()) as { session: SessionProjection };
      expect(sessionBody.session.title).toBe('Stage 1 session');

      const startedRun = await fetch(`${baseUrl}/api/sessions/${sessionBody.session.id}/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'Build the async flow' })
      });
      expect(startedRun.status).toBe(201);
      const runBody = (await startedRun.json()) as StartRunResponse;
      expect(runBody.run.status).toBe('queued');
      expect(runBody.eventsUrl).toBe(`/api/runs/${runBody.run.id}/events`);

      const completedRun = await waitFor(
        async () => {
          const response = await fetch(`${baseUrl}/api/runs/${runBody.run.id}`);
          return (await response.json()) as { run: RunProjection };
        },
        (body) => body.run.status === 'completed'
      );
      expect(completedRun.run.resultText).toBe('Async mock completed.');

      const messages = await fetch(`${baseUrl}/api/sessions/${sessionBody.session.id}/messages`);
      const messagesBody = (await messages.json()) as { messages: MessageProjection[] };
      expect(messagesBody.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
      expect(messagesBody.messages.at(-1)?.content).toBe('Async mock response.');
    } finally {
      await stop(server);
    }
  });

  it('streams replayed run events with Last-Event-ID over SSE', async () => {
    const app = createApp(config, new TestAsyncGateway());
    const { server, baseUrl } = await listen(app);
    try {
      const sessionResponse = await fetch(`${baseUrl}/api/sessions`, { method: 'POST' });
      const sessionBody = (await sessionResponse.json()) as { session: SessionProjection };
      const runResponse = await fetch(`${baseUrl}/api/sessions/${sessionBody.session.id}/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'Stream events' })
      });
      const runBody = (await runResponse.json()) as StartRunResponse;

      await waitFor(
        async () => {
          const response = await fetch(`${baseUrl}/api/runs/${runBody.run.id}`);
          return (await response.json()) as { run: RunProjection };
        },
        (body) => body.run.status === 'completed'
      );

      const eventsResponse = await fetch(`${baseUrl}${runBody.eventsUrl}`, { headers: { 'Last-Event-ID': '1' } });
      expect(eventsResponse.status).toBe(200);
      const reader = eventsResponse.body?.getReader();
      expect(reader).toBeDefined();
      const firstChunk = await reader?.read();
      reader?.cancel().catch(() => undefined);
      const text = new TextDecoder().decode(firstChunk?.value);
      expect(text).toContain('event: run.status');
      expect(text).toContain(`"runId":"${runBody.run.id}"`);
    } finally {
      await stop(server);
    }
  });
});
