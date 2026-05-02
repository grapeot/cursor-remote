import cors from 'cors';
import express, { type Request, type Response } from 'express';
import type { ZodError } from 'zod';
import type { AppConfig } from './config.js';
import { sendPromptRequestSchema, type ErrorResponse } from '../shared/contracts.js';
import type { CursorAgentGateway } from './cursorAgent.js';
import { RunStore } from './runStore.js';

function sendError(response: Response, status: number, code: string, message: string): void {
  const body: ErrorResponse = { error: { code, message } };
  response.status(status).json(body);
}

function formatZodError(error: ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
}

export function createApp(config: AppConfig, gateway: CursorAgentGateway, store = new RunStore()) {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get('/api/health', (_request, response) => {
    response.json({
      ok: true,
      runtime: config.runtime,
      hasCursorApiKey: Boolean(config.cursorApiKey),
      localCwdConfigured: Boolean(config.localCwd)
    });
  });

  app.get('/api/runs', (_request, response) => {
    response.json({ runs: store.list() });
  });

  app.get('/api/runs/:id', (request, response) => {
    const run = store.get(request.params.id);
    if (!run) {
      sendError(response, 404, 'RUN_NOT_FOUND', `Run ${request.params.id} was not found.`);
      return;
    }
    response.json({ run });
  });

  app.post('/api/runs', async (request: Request, response: Response) => {
    try {
      const parsed = sendPromptRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        sendError(response, 400, 'INVALID_REQUEST', formatZodError(parsed.error));
        return;
      }

      const run = await gateway.startRun(parsed.data);
      store.upsert(run);
      response.status(201).json({ run });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown Cursor SDK error.';
      sendError(response, 502, 'CURSOR_SDK_ERROR', message);
    }
  });

  return app;
}
