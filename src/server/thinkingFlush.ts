import type { AppEventType } from '../shared/events.js';

/** Matches emitted gateway events; structural superset of RawCursorEvent payloads. */
export type ThinkingFlushEvent = {
  type: AppEventType;
  payload: unknown;
  cursorEventType?: string;
  cursorEventId?: string;
};

export function isCursorThinkingStreamMessage(message: unknown): message is {
  type: 'thinking';
  text: string;
  thinking_duration_ms?: number;
} {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { type?: string }).type === 'thinking' &&
    typeof (message as { text?: unknown }).text === 'string'
  );
}

/**
 * Buffers Cursor `thinking` stream chunks and flushes them as a single synthetic
 * `thinking` tool (no per-chunk SSE); aligns with treating reasoning as one tool card.
 */
export class ThinkingCoalescer {
  private readonly parts: string[] = [];

  private durationMs: number | undefined = undefined;

  private seq = 0;

  constructor(private readonly runId: string) {}

  push(message: { text: string; thinking_duration_ms?: number }): void {
    this.parts.push(message.text);
    if (message.thinking_duration_ms !== undefined) {
      this.durationMs = message.thinking_duration_ms;
    }
  }

  flush(): ThinkingFlushEvent[] {
    const text = this.parts.join('');
    this.parts.length = 0;
    const d = this.durationMs;
    this.durationMs = undefined;
    if (!text.trim()) {
      return [];
    }
    this.seq += 1;
    const callId = `thinking-${this.runId}-${this.seq}`;
    const meta = { cursorEventType: 'thinking' as const, cursorEventId: callId };
    const startedPayload: Record<string, unknown> = {
      callId,
      name: 'thinking',
      status: 'running',
      ...(d !== undefined ? { args: { thinkingDurationMs: d } } : {})
    };
    return [
      { type: 'tool.started', payload: startedPayload, ...meta },
      {
        type: 'tool.completed',
        payload: { callId, name: 'thinking', status: 'completed', result: text },
        ...meta
      }
    ];
  }
}
