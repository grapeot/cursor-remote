import type { Request, Response } from 'express';
import type { SseClient, SseEvent } from './eventBroker.js';

export function parseLastEventId(request: Request): number | undefined {
  const header = request.header('last-event-id');
  if (!header) {
    return undefined;
  }
  const parsed = Number(header);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export function createResponseSseClient(response: Response): SseClient {
  let closed = false;
  response.status(200);
  response.setHeader('Content-Type', 'text/event-stream');
  response.setHeader('Cache-Control', 'no-cache, no-transform');
  response.setHeader('Connection', 'keep-alive');
  response.flushHeaders?.();

  response.on('close', () => {
    closed = true;
  });

  return {
    send(event: SseEvent): void {
      if (closed || response.writableEnded) {
        closed = true;
        return;
      }
      response.write(`id: ${event.id}\n`);
      response.write(`event: ${event.event}\n`);
      response.write(`data: ${event.data}\n\n`);
    },
    close(): void {
      if (!closed && !response.writableEnded) {
        closed = true;
        response.end();
      }
    },
    isClosed(): boolean {
      return closed || response.writableEnded;
    }
  };
}
