import cors from 'cors';
import express, { type Request, type Response } from 'express';
import type { ZodError } from 'zod';
import type { AppConfig } from './config.js';
import {
  createSessionRequestSchema,
  sendPromptRequestSchema,
  startRunRequestSchema,
  type ErrorResponse
} from '../shared/contracts.js';
import { MockCursorAgentGateway, type AsyncCursorGateway, type CursorAgentGateway } from './cursorAgent.js';
import { InMemoryEventBroker, type EventBroker } from './eventBroker.js';
import { InMemoryEventStore, type EventStore } from './eventStore.js';
import { InMemoryProjectionStore, type ProjectionStore } from './projectionStore.js';
import { RunStore } from './runStore.js';
import { RunService } from './runService.js';
import { SessionService } from './sessionService.js';
import { createResponseSseClient, parseLastEventId } from './sseHelpers.js';

function sendError(response: Response, status: number, code: string, message: string): void {
  const body: ErrorResponse = { error: { code, message } };
  response.status(status).json(body);
}

function formatZodError(error: ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
}

export interface AppDependencies {
  legacyRunStore?: RunStore;
  eventStore?: EventStore;
  projectionStore?: ProjectionStore;
  eventBroker?: EventBroker;
  sessionService?: SessionService;
  runService?: RunService;
}

export function createApp(config: AppConfig, gateway: CursorAgentGateway, dependencies: AppDependencies = {}) {
  const store = dependencies.legacyRunStore ?? new RunStore();
  const eventStore = dependencies.eventStore ?? new InMemoryEventStore();
  const projectionStore = dependencies.projectionStore ?? new InMemoryProjectionStore();
  const eventBroker = dependencies.eventBroker ?? new InMemoryEventBroker(eventStore);
  const asyncGateway = ensureAsyncGateway(gateway);
  const sessionService = dependencies.sessionService ?? new SessionService(config, eventStore, projectionStore, eventBroker);
  const runService = dependencies.runService ?? new RunService(config, asyncGateway, eventStore, projectionStore, eventBroker);
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

  app.get('/api/runs/:id/events', (request, response) => {
    const runId = readParam(request, 'id');
    const run = runService.getRun(runId);
    if (!run) {
      sendError(response, 404, 'RUN_NOT_FOUND', `Run ${runId} was not found.`);
      return;
    }
    const client = createResponseSseClient(response);
    const lastEventId = parseLastEventId(request);
    eventBroker.subscribe(client, {
      ...(lastEventId !== undefined ? { lastEventId } : {}),
      filter: (event) => event.runId === runId
    });
    request.on('close', () => {
      eventBroker.unsubscribe(client);
    });
  });

  app.get('/api/runs/:id', (request, response) => {
    const runId = readParam(request, 'id');
    const projectedRun = runService.getRun(runId);
    if (projectedRun) {
      response.json({ run: projectedRun });
      return;
    }
    const run = store.get(runId);
    if (!run) {
      sendError(response, 404, 'RUN_NOT_FOUND', `Run ${runId} was not found.`);
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

  app.post('/api/sessions', (request: Request, response: Response) => {
    const parsed = createSessionRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      sendError(response, 400, 'INVALID_REQUEST', formatZodError(parsed.error));
      return;
    }
    const session = sessionService.createSession(parsed.data);
    response.status(201).json({ session });
  });

  app.get('/api/sessions', (_request, response) => {
    response.json({ sessions: sessionService.listSessions() });
  });

  app.get('/api/sessions/:sessionId', (request, response) => {
    const sessionId = readParam(request, 'sessionId');
    const session = sessionService.getSession(sessionId);
    if (!session) {
      sendError(response, 404, 'SESSION_NOT_FOUND', `Session ${sessionId} was not found.`);
      return;
    }
    response.json({ session });
  });

  app.get('/api/sessions/:sessionId/runs', (request, response) => {
    const sessionId = readParam(request, 'sessionId');
    if (!sessionService.getSession(sessionId)) {
      sendError(response, 404, 'SESSION_NOT_FOUND', `Session ${sessionId} was not found.`);
      return;
    }
    response.json({ runs: runService.listRuns(sessionId) });
  });

  app.get('/api/sessions/:sessionId/messages', (request, response) => {
    const sessionId = readParam(request, 'sessionId');
    if (!sessionService.getSession(sessionId)) {
      sendError(response, 404, 'SESSION_NOT_FOUND', `Session ${sessionId} was not found.`);
      return;
    }
    response.json({ messages: runService.getMessages(sessionId) });
  });

  app.post('/api/sessions/:sessionId/runs', async (request: Request, response: Response) => {
    try {
      const parsed = startRunRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        sendError(response, 400, 'INVALID_REQUEST', formatZodError(parsed.error));
        return;
      }
      const result = await runService.startRun(readParam(request, 'sessionId'), parsed.data);
      response.status(201).json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to start run.';
      const status = message.includes('was not found') ? 404 : 502;
      sendError(response, status, status === 404 ? 'SESSION_NOT_FOUND' : 'CURSOR_SDK_ERROR', message);
    }
  });

  return app;
}

function ensureAsyncGateway(gateway: CursorAgentGateway): CursorAgentGateway & AsyncCursorGateway {
  if (isAsyncCursorGateway(gateway)) {
    return gateway;
  }
  return new MockCursorAgentGateway();
}

function isAsyncCursorGateway(gateway: CursorAgentGateway): gateway is CursorAgentGateway & AsyncCursorGateway {
  return 'executeRun' in gateway && typeof gateway.executeRun === 'function';
}

function readParam(request: Request, name: string): string {
  const value = request.params[name];
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}
