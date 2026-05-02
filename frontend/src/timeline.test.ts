import { describe, expect, it } from 'vitest';
import type { AppEvent } from '../../src/shared/events';
import type { MessageProjection, RunProjection } from '../../src/shared/projections';
import { buildTimeline, eventToTimelineItem, flattenJsonForDisplay } from './timeline';

describe('chat timeline projection', () => {
  it('combines projected messages, run status, synthetic thinking tools, and tool cards in chronological order', () => {
    const messages: MessageProjection[] = [
      message({ id: 'assistant-1', role: 'assistant', content: 'Done.', status: 'completed', createdAt: '2026-05-01T10:00:04.000Z' }),
      message({ id: 'user-1', role: 'user', content: 'Create hello.txt', status: 'completed', createdAt: '2026-05-01T10:00:00.000Z' })
    ];
    const runs: RunProjection[] = [
      {
        id: 'run-1234567890abcdef',
        sessionId: 'session-1',
        status: 'completed',
        prompt: 'Create hello.txt',
        runtime: 'mock',
        modelId: 'composer-2',
        createdAt: '2026-05-01T10:00:00.000Z',
        updatedAt: '2026-05-01T10:00:05.000Z',
        completedAt: '2026-05-01T10:00:05.000Z'
      }
    ];
    const events: AppEvent[] = [
      event({
        id: 2,
        type: 'tool.completed',
        payload: { callId: 'think-1', name: 'thinking', status: 'completed', result: 'Checking files.' },
        createdAt: '2026-05-01T10:00:01.000Z'
      }),
      event({
        id: 3,
        type: 'tool.started',
        payload: { callId: 'tool-1', name: 'write_file', args: { path: 'hello.txt' } },
        createdAt: '2026-05-01T10:00:02.000Z'
      }),
      event({
        id: 4,
        type: 'tool.completed',
        payload: { callId: 'tool-1', name: 'write_file', result: 'Wrote hello.txt' },
        createdAt: '2026-05-01T10:00:03.000Z'
      })
    ];

    expect(buildTimeline(messages, runs, events)).toMatchObject([
      { kind: 'user', text: 'Create hello.txt', status: 'sent' },
      { kind: 'tool', name: 'thinking', status: 'completed', summary: 'Checking files.' },
      { kind: 'tool', name: 'write_file', status: 'completed', summary: 'Wrote hello.txt', detail: { path: 'hello.txt' } },
      { kind: 'assistant', text: 'Done.', status: 'completed' },
      { kind: 'status', text: 'Run run-1234…abcdef is completed', tone: 'success' }
    ]);
  });

  it('projects a coalesced thinking tool completion', () => {
    const events: AppEvent[] = [
      event({
        id: 1,
        type: 'tool.completed',
        payload: { callId: 'thinking-run-x-1', name: 'thinking', status: 'completed', result: 'Step A. Step B.' },
        createdAt: '2026-05-01T10:00:03.000Z'
      })
    ];
    const thinkingTool = buildTimeline([], [], events).find((item) => item.kind === 'tool');
    expect(thinkingTool).toMatchObject({
      kind: 'tool',
      name: 'thinking',
      status: 'completed',
      summary: 'Step A. Step B.'
    });
  });

  it('merges tool.started args into tool.completed so detail survives completion', () => {
    const events: AppEvent[] = [
      event({
        id: 1,
        type: 'tool.started',
        payload: { callId: 'c1', name: 'bash', args: { cmd: 'ls' } },
        createdAt: '2026-05-01T10:00:01.000Z'
      }),
      event({
        id: 2,
        type: 'tool.completed',
        payload: { callId: 'c1', name: 'bash', result: 'ok' },
        createdAt: '2026-05-01T10:00:02.000Z'
      })
    ];
    const tool = buildTimeline([], [], events).find((item) => item.kind === 'tool');
    expect(tool).toMatchObject({
      kind: 'tool',
      status: 'completed',
      summary: 'ok',
      detail: { cmd: 'ls' }
    });
  });

  it('eventToTimelineItem ignores task.updated with only whitespace text', () => {
    expect(
      eventToTimelineItem(
        event({ id: 1, type: 'task.updated', payload: { text: '   ', status: '' }, createdAt: '2026-05-01T10:00:01.000Z' })
      )
    ).toBeUndefined();
  });

  it('eventToTimelineItem ignores legacy thinking deltas and streaming tool stubs (merge handles tools)', () => {
    expect(eventToTimelineItem(event({ id: 1, type: 'thinking.delta', payload: { text: '   ' } }))).toBeUndefined();
    expect(eventToTimelineItem(event({ id: 2, type: 'thinking.delta', payload: { text: 'x' } }))).toBeUndefined();
    expect(
      eventToTimelineItem(
        event({
          id: 3,
          type: 'tool.started',
          payload: { callId: 't', name: 'n', args: {} }
        })
      )
    ).toBeUndefined();
    expect(eventToTimelineItem(event({ id: 4, type: 'run.error', payload: { error: 'Cursor failed.' } }))).toMatchObject({
      kind: 'status',
      text: 'Cursor failed.',
      tone: 'error'
    });
  });
});

describe('flattenJsonForDisplay', () => {
  it('flattens nested objects with dotted keys and JSON leaves', () => {
    expect(flattenJsonForDisplay({ path: 'a.txt', nested: { x: 1, y: { z: false } } })).toEqual([
      'nested.x: 1',
      'nested.y.z: false',
      'path: "a.txt"'
    ]);
  });

  it('handles arrays as JSON leaves', () => {
    expect(flattenJsonForDisplay({ items: [1, 2], empty: {} })).toEqual(['empty: {}', 'items: [1,2]']);
  });
});
function message(overrides: Partial<MessageProjection>): MessageProjection {
  return {
    id: 'message-1',
    sessionId: 'session-1',
    runId: 'run-1234567890abcdef',
    role: 'user',
    content: 'Prompt',
    status: 'completed',
    createdAt: '2026-05-01T10:00:00.000Z',
    updatedAt: '2026-05-01T10:00:00.000Z',
    ...overrides
  };
}

function event(overrides: Partial<AppEvent>): AppEvent {
  return {
    id: 1,
    sessionId: 'session-1',
    runId: 'run-1234567890abcdef',
    type: 'run.status',
    payload: {},
    createdAt: '2026-05-01T10:00:00.000Z',
    ...overrides
  };
}
