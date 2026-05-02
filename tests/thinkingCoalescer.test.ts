import { describe, expect, it } from 'vitest';
import { isCursorThinkingStreamMessage, ThinkingCoalescer } from '../src/server/thinkingFlush.js';

describe('ThinkingCoalescer', () => {
  it('returns nothing for empty buffers', () => {
    const c = new ThinkingCoalescer('run-a');
    expect(c.flush()).toEqual([]);
    c.push({ text: '   ' });
    expect(c.flush()).toEqual([]);
  });

  it('merges chunks and emits a single thinking tool pair', () => {
    const c = new ThinkingCoalescer('run-b');
    c.push({ text: 'Step A. ' });
    c.push({ text: 'Step B.', thinking_duration_ms: 42 });
    expect(c.flush()).toEqual([
      {
        type: 'tool.started',
        payload: {
          callId: 'thinking-run-b-1',
          name: 'thinking',
          status: 'running',
          args: { thinkingDurationMs: 42 }
        },
        cursorEventType: 'thinking',
        cursorEventId: 'thinking-run-b-1'
      },
      {
        type: 'tool.completed',
        payload: {
          callId: 'thinking-run-b-1',
          name: 'thinking',
          status: 'completed',
          result: 'Step A. Step B.'
        },
        cursorEventType: 'thinking',
        cursorEventId: 'thinking-run-b-1'
      }
    ]);
  });

  it('assigns incremental call ids across flushes', () => {
    const c = new ThinkingCoalescer('run-c');
    c.push({ text: 'one' });
    expect(c.flush()[1]?.payload).toMatchObject({ callId: 'thinking-run-c-1' });
    c.push({ text: 'two' });
    expect(c.flush()[1]?.payload).toMatchObject({ callId: 'thinking-run-c-2' });
  });
});

describe('isCursorThinkingStreamMessage', () => {
  it('narrows Cursor thinking envelopes', () => {
    expect(isCursorThinkingStreamMessage({ type: 'thinking', text: 'x' })).toBe(true);
    expect(isCursorThinkingStreamMessage({ type: 'assistant', message: {} })).toBe(false);
  });
});
