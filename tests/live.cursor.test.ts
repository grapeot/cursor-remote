import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app.js';
import type { AppConfig } from '../src/server/config.js';
import { CursorSdkGateway } from '../src/server/cursorAgent.js';
import { appEventSchema, isRunStatusPayload, type AppEvent } from '../src/shared/events.js';
import type { CreateSessionResponse, StartRunResponse } from '../src/shared/contracts.js';
import type { RunProjection } from '../src/shared/projections.js';

const runLiveTests = process.env.RUN_CURSOR_LIVE_TESTS === '1';
const describeLive = runLiveTests ? describe : describe.skip;

interface StartedServer {
  server: http.Server;
  baseUrl: string;
}

describeLive('live Cursor local integration', () => {
  let sandboxDir = '';
  let started: StartedServer | undefined;

  beforeAll(async () => {
    sandboxDir = await mkdtemp(join(tmpdir(), 'cursor-live-'));
    await writeFile(join(sandboxDir, 'README.md'), '# Cursor live sandbox\n', 'utf8');

    const config: AppConfig = {
      port: 0,
      runtime: 'local',
      cursorApiKey: readRequiredEnv('CURSOR_API_KEY'),
      localCwd: sandboxDir,
      defaultRef: 'main',
      defaultModel: process.env.CURSOR_DEFAULT_MODEL?.trim() || 'composer-2'
    };

    const app = createApp(config, new CursorSdkGateway(config));
    started = await listen(app);
  }, 30_000);

  afterAll(async () => {
    if (started !== undefined) {
      await stop(started.server);
    }
    if (sandboxDir.length > 0) {
      await rm(sandboxDir, { recursive: true, force: true });
    }
  });

  it(
    'streams real Cursor events through the app SSE endpoint and writes inside sandbox cwd',
    async () => {
      if (started === undefined) {
        throw new Error('Live server did not start.');
      }

      const sessionResponse = await fetch(`${started.baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Live Cursor sandbox' })
      });
      expect(sessionResponse.status).toBe(201);
      const sessionBody = (await sessionResponse.json()) as CreateSessionResponse;

      const prompt =
        'Create or overwrite hello.txt in the current working directory with exactly: Hello from Cursor live test';
      const runResponse = await fetch(`${started.baseUrl}/api/sessions/${sessionBody.session.id}/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, modelId: process.env.CURSOR_DEFAULT_MODEL?.trim() || 'composer-2', runtime: 'local' })
      });
      expect(runResponse.status).toBe(201);
      const runBody = (await runResponse.json()) as StartRunResponse;

      const events = await collectRunEvents(`${started.baseUrl}${runBody.eventsUrl}`, 120_000);
      const eventTypes = new Set(events.map((event) => event.type));
      expect(eventTypes.has('run.status')).toBe(true);
      expect(eventTypes.has('assistant.delta') || eventTypes.has('tool.started') || eventTypes.has('task.updated')).toBe(true);
      expect(events.some((event) => event.type === 'run.result')).toBe(true);

      const runProjection = await waitForRun(started.baseUrl, runBody.run.id, 30_000);
      expect(runProjection.status).toBe('completed');

      const fileText = await readFile(join(sandboxDir, 'hello.txt'), 'utf8');
      expect(fileText.trim()).toBe('Hello from Cursor live test');
    },
    150_000
  );
});

function readRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required when RUN_CURSOR_LIVE_TESTS=1.`);
  }
  return value;
}

async function listen(app: ReturnType<typeof createApp>): Promise<StartedServer> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Server did not bind to a TCP port.');
  }
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function stop(server: http.Server): Promise<void> {
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

async function collectRunEvents(url: string, timeoutMs: number): Promise<AppEvent[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const events: AppEvent[] = [];
  let sawTerminalStatus = false;
  let sawRunResult = false;
  try {
    const response = await fetch(url, { signal: controller.signal });
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('SSE response did not expose a readable body.');
    }
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split('\n\n');
      buffer = chunks.pop() ?? '';
      for (const chunk of chunks) {
        const event = parseSseAppEvent(chunk);
        if (event !== undefined) {
          events.push(event);
          sawTerminalStatus = sawTerminalStatus || isTerminalRunEvent(event);
          sawRunResult = sawRunResult || event.type === 'run.result';
          if (sawTerminalStatus && sawRunResult) {
            await reader.cancel();
            return events;
          }
        }
      }
    }
  } finally {
    clearTimeout(timeout);
  }
  return events;
}

function parseSseAppEvent(chunk: string): AppEvent | undefined {
  const dataLine = chunk.split('\n').find((line) => line.startsWith('data: '));
  if (!dataLine) {
    return undefined;
  }
  const parsedJson: unknown = JSON.parse(dataLine.slice('data: '.length));
  const parsedEvent = appEventSchema.safeParse(parsedJson);
  if (!parsedEvent.success || !Object.prototype.hasOwnProperty.call(parsedEvent.data, 'payload')) {
    return undefined;
  }
  const data = parsedEvent.data;
  return {
    id: data.id,
    sessionId: data.sessionId,
    ...(data.runId !== undefined ? { runId: data.runId } : {}),
    type: data.type,
    ...(data.cursorEventType !== undefined ? { cursorEventType: data.cursorEventType } : {}),
    ...(data.cursorEventId !== undefined ? { cursorEventId: data.cursorEventId } : {}),
    payload: data.payload,
    createdAt: data.createdAt
  };
}

function isTerminalRunEvent(event: AppEvent): boolean {
  return (
    event.type === 'run.status' &&
    isRunStatusPayload(event.payload) &&
    (event.payload.status === 'completed' || event.payload.status === 'failed' || event.payload.status === 'cancelled')
  );
}

async function waitForRun(baseUrl: string, runId: string, timeoutMs: number): Promise<RunProjection> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/runs/${runId}`);
    const body = (await response.json()) as { run: RunProjection };
    if (body.run.status === 'completed' || body.run.status === 'failed' || body.run.status === 'cancelled') {
      return body.run;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Run ${runId} did not reach a terminal state within ${timeoutMs}ms.`);
}
