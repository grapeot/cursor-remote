import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { Express } from 'express';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app.js';
import type { CursorAgentGateway } from '../src/server/cursorAgent.js';
import type { AppConfig } from '../src/server/config.js';
import type { RunSummary, SendPromptRequest } from '../src/shared/contracts.js';

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
});
