import type { HealthResponse, RunSummary, SendPromptRequest, SendPromptResponse } from '../../src/shared/contracts';

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

export async function fetchRuns(): Promise<RunSummary[]> {
  const payload = await parseJson<{ runs: RunSummary[] }>(await fetch('/api/runs'));
  return payload.runs;
}

export async function sendPrompt(request: SendPromptRequest): Promise<RunSummary> {
  const payload = await parseJson<SendPromptResponse>(
    await fetch('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request)
    })
  );
  return payload.run;
}
