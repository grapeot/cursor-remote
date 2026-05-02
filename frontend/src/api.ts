import type {
  CreateSessionResponse,
  HealthResponse,
  ListMessagesResponse,
  ListSessionRunsResponse,
  ListSessionsResponse,
  StartRunRequest,
  StartRunResponse
} from '../../src/shared/contracts';
import type { MessageProjection, RunProjection, SessionProjection } from '../../src/shared/projections';

async function parseJson<T>(response: Response): Promise<T> {
  const payload = await response.json();
  if (!response.ok) {
    const message =
      typeof payload?.error?.message === 'string' ? payload.error.message : response.statusText;
    throw new Error(message);
  }
  return payload as T;
}

export async function fetchHealth(): Promise<HealthResponse> {
  return parseJson<HealthResponse>(await fetch('/api/health'));
}

export async function createSession(title?: string): Promise<SessionProjection> {
  const payload = await parseJson<CreateSessionResponse>(
    await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(title === undefined ? {} : { title })
    })
  );
  return payload.session;
}

export async function listSessions(): Promise<SessionProjection[]> {
  const payload = await parseJson<ListSessionsResponse>(await fetch('/api/sessions'));
  return payload.sessions;
}

export async function getSession(sessionId: string): Promise<SessionProjection> {
  const payload = await parseJson<{ session: SessionProjection }>(await fetch(`/api/sessions/${sessionId}`));
  return payload.session;
}

export async function startSessionRun(sessionId: string, request: StartRunRequest): Promise<StartRunResponse> {
  return parseJson<StartRunResponse>(
    await fetch(`/api/sessions/${sessionId}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request)
    })
  );
}

export async function listSessionRuns(sessionId: string): Promise<RunProjection[]> {
  const payload = await parseJson<ListSessionRunsResponse>(await fetch(`/api/sessions/${sessionId}/runs`));
  return payload.runs;
}

export async function listSessionMessages(sessionId: string): Promise<MessageProjection[]> {
  const payload = await parseJson<ListMessagesResponse>(await fetch(`/api/sessions/${sessionId}/messages`));
  return payload.messages;
}
