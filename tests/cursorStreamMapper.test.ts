import { describe, expect, it } from 'vitest';
import { mapCursorStreamMessage, type CursorStreamContext } from '../src/server/cursorStreamMapper.js';

const context: CursorStreamContext = {
  runId: 'run-test',
  prompt: 'Test prompt',
  runtime: 'local',
  modelId: 'composer-2'
};

describe('CursorStreamMapper', () => {
  it('maps assistant text and tool_use blocks into app events', () => {
    const events = mapCursorStreamMessage(
      {
        type: 'assistant',
        agent_id: 'agent-1',
        run_id: 'cursor-run-1',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Hello ' },
            { type: 'tool_use', id: 'tool-1', name: 'write', input: { path: 'hello.txt' } },
            { type: 'text', text: 'world' }
          ]
        }
      },
      context
    );

    expect(events).toEqual([
      { type: 'assistant.delta', payload: { text: 'Hello ' }, cursorEventType: 'assistant' },
      {
        type: 'tool.started',
        payload: { callId: 'tool-1', name: 'write', status: 'running', args: { path: 'hello.txt' } },
        cursorEventType: 'assistant',
        cursorEventId: 'tool-1'
      },
      { type: 'assistant.delta', payload: { text: 'world' }, cursorEventType: 'assistant' }
    ]);
  });

  it('maps status messages to app run statuses', () => {
    const running = mapCursorStreamMessage({ type: 'status', status: 'RUNNING' }, context);
    const finished = mapCursorStreamMessage({ type: 'status', status: 'FINISHED', message: 'done' }, context);
    const expired = mapCursorStreamMessage({ type: 'status', status: 'EXPIRED' }, context);

    expect(running[0]?.payload).toMatchObject({ runId: 'run-test', status: 'running' });
    expect(finished[0]?.payload).toMatchObject({ runId: 'run-test', status: 'completed', message: 'done' });
    expect(expired[0]?.payload).toMatchObject({ runId: 'run-test', status: 'failed' });
  });

  it('drops raw thinking stream envelopes (gateway coalesces them into thinking tool events)', () => {
    expect(mapCursorStreamMessage({ type: 'thinking', text: 'Thinking', thinking_duration_ms: 120 }, context)).toEqual([]);
  });

  it('maps tool_call, task, and request messages', () => {
    expect(
      mapCursorStreamMessage(
        { type: 'tool_call', call_id: 'call-1', name: 'write', status: 'completed', result: { ok: true } },
        context
      )
    ).toEqual([
      {
        type: 'tool.completed',
        payload: { callId: 'call-1', name: 'write', status: 'completed', result: { ok: true } },
        cursorEventType: 'tool_call',
        cursorEventId: 'call-1'
      }
    ]);

    expect(mapCursorStreamMessage({ type: 'task', status: 'running', text: 'Editing file' }, context)).toEqual([
      { type: 'task.updated', payload: { status: 'running', text: 'Editing file' }, cursorEventType: 'task' }
    ]);

    expect(mapCursorStreamMessage({ type: 'request', request_id: 'request-1' }, context)).toEqual([
      {
        type: 'task.updated',
        payload: { requestId: 'request-1', status: 'request' },
        cursorEventType: 'request',
        cursorEventId: 'request-1'
      }
    ]);
  });

  it('ignores system/user messages and emits diagnostics for unknown shapes', () => {
    expect(mapCursorStreamMessage({ type: 'system', agent_id: 'agent-1' }, context)).toEqual([]);
    expect(mapCursorStreamMessage({ type: 'user', message: { role: 'user' } }, context)).toEqual([]);
    expect(mapCursorStreamMessage({ type: 'new_beta_event', value: 1 }, context)).toEqual([
      {
        type: 'task.updated',
        payload: { status: 'unknown_cursor_event', rawType: 'new_beta_event' },
        cursorEventType: 'new_beta_event'
      }
    ]);
    expect(mapCursorStreamMessage(null, context)).toEqual([
      { type: 'task.updated', payload: { status: 'unknown_cursor_event' } }
    ]);
  });
});
