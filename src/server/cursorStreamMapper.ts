import type { StartRunRequest } from '../shared/contracts.js';
import type { AppRuntime, AppRunStatus } from '../shared/events.js';
import type { RawCursorEvent } from './cursorAgent.js';

export interface CursorStreamContext {
  runId: string;
  prompt: string;
  runtime: AppRuntime;
  modelId: string;
}

interface CursorBaseMessage {
  type: string;
  agent_id?: string;
  run_id?: string;
}

interface CursorTextBlock {
  type: 'text';
  text: string;
}

interface CursorToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

interface CursorAssistantMessage extends CursorBaseMessage {
  type: 'assistant';
  message: {
    role: 'assistant';
    content: Array<CursorTextBlock | CursorToolUseBlock>;
  };
}

interface CursorThinkingMessage extends CursorBaseMessage {
  type: 'thinking';
  text: string;
  thinking_duration_ms?: number;
}

interface CursorToolCallMessage extends CursorBaseMessage {
  type: 'tool_call';
  call_id: string;
  name: string;
  status: 'running' | 'completed' | 'error';
  args?: unknown;
  result?: unknown;
  truncated?: {
    args?: boolean;
    result?: boolean;
  };
}

interface CursorStatusMessage extends CursorBaseMessage {
  type: 'status';
  status: 'CREATING' | 'RUNNING' | 'FINISHED' | 'ERROR' | 'CANCELLED' | 'EXPIRED';
  message?: string;
}

interface CursorRequestMessage extends CursorBaseMessage {
  type: 'request';
  request_id: string;
}

interface CursorTaskMessage extends CursorBaseMessage {
  type: 'task';
  status?: string;
  text?: string;
}

export function mapCursorStreamMessage(message: unknown, context: CursorStreamContext): RawCursorEvent[] {
  const cursorEventType = readCursorEventType(message);
  if (isCursorAssistantMessage(message)) {
    return message.message.content.flatMap((block) => mapAssistantBlock(block, cursorEventType));
  }
  if (isCursorThinkingMessage(message)) {
    return [
      withCursorType(
        {
          type: 'thinking.delta',
          payload: {
            text: message.text,
            ...(message.thinking_duration_ms !== undefined ? { thinkingDurationMs: message.thinking_duration_ms } : {})
          }
        },
        cursorEventType
      )
    ];
  }
  if (isCursorToolCallMessage(message)) {
    return [withCursorType(mapToolCallMessage(message), cursorEventType, message.call_id)];
  }
  if (isCursorStatusMessage(message)) {
    return [withCursorType(mapStatusMessage(message, context), cursorEventType)];
  }
  if (isCursorTaskMessage(message)) {
    return [
      withCursorType(
        {
          type: 'task.updated',
          payload: {
            ...(message.status !== undefined ? { status: message.status } : {}),
            ...(message.text !== undefined ? { text: message.text } : {})
          }
        },
        cursorEventType
      )
    ];
  }
  if (isCursorRequestMessage(message)) {
    return [
      withCursorType(
        {
          type: 'task.updated',
          payload: { requestId: message.request_id, status: 'request' }
        },
        cursorEventType,
        message.request_id
      )
    ];
  }
  if (cursorEventType === 'system' || cursorEventType === 'user') {
    return [];
  }
  return [
    withCursorType(
      {
        type: 'task.updated',
        payload: {
          status: 'unknown_cursor_event',
          ...(cursorEventType !== undefined ? { rawType: cursorEventType } : {})
        }
      },
      cursorEventType
    )
  ];
}

export function makeCursorStreamContext(
  runId: string,
  request: StartRunRequest,
  runtime: AppRuntime,
  modelId: string
): CursorStreamContext {
  return {
    runId,
    prompt: request.prompt,
    runtime,
    modelId
  };
}

function mapAssistantBlock(block: CursorTextBlock | CursorToolUseBlock, cursorEventType: string | undefined): RawCursorEvent[] {
  if (block.type === 'text') {
    return block.text.length > 0
      ? [withCursorType({ type: 'assistant.delta', payload: { text: block.text } }, cursorEventType)]
      : [];
  }
  return [
    withCursorType(
      {
        type: 'tool.started',
        payload: {
          callId: block.id,
          name: block.name,
          status: 'running',
          args: block.input
        }
      },
      cursorEventType,
      block.id
    )
  ];
}

function mapToolCallMessage(message: CursorToolCallMessage): RawCursorEvent {
  const basePayload = {
    callId: message.call_id,
    name: message.name,
    status: message.status,
    ...(message.args !== undefined ? { args: message.args } : {}),
    ...(message.result !== undefined ? { result: message.result } : {}),
    ...(message.truncated !== undefined ? { truncated: message.truncated } : {})
  };
  if (message.status === 'completed') {
    return { type: 'tool.completed', payload: basePayload };
  }
  if (message.status === 'error') {
    return { type: 'tool.error', payload: basePayload };
  }
  return { type: 'tool.started', payload: basePayload };
}

function mapStatusMessage(message: CursorStatusMessage, context: CursorStreamContext): RawCursorEvent {
  return {
    type: 'run.status',
    payload: {
      runId: context.runId,
      prompt: context.prompt,
      runtime: context.runtime,
      modelId: context.modelId,
      status: mapRunStatus(message.status),
      ...(message.message !== undefined ? { message: message.message } : {})
    }
  };
}

function mapRunStatus(status: CursorStatusMessage['status']): AppRunStatus {
  if (status === 'FINISHED') {
    return 'completed';
  }
  if (status === 'CANCELLED') {
    return 'cancelled';
  }
  if (status === 'ERROR' || status === 'EXPIRED') {
    return 'failed';
  }
  return 'running';
}

function withCursorType(event: RawCursorEvent, cursorEventType: string | undefined, cursorEventId?: string): RawCursorEvent {
  return {
    ...event,
    ...(cursorEventType !== undefined ? { cursorEventType } : {}),
    ...(cursorEventId !== undefined ? { cursorEventId } : {})
  };
}

function isCursorAssistantMessage(message: unknown): message is CursorAssistantMessage {
  if (!isRecord(message) || message.type !== 'assistant' || !isRecord(message.message)) {
    return false;
  }
  const content = message.message.content;
  return Array.isArray(content) && content.every(isAssistantBlock);
}

function isAssistantBlock(value: unknown): value is CursorTextBlock | CursorToolUseBlock {
  if (!isRecord(value)) {
    return false;
  }
  if (value.type === 'text') {
    return typeof value.text === 'string';
  }
  return value.type === 'tool_use' && typeof value.id === 'string' && typeof value.name === 'string' && 'input' in value;
}

function isCursorThinkingMessage(message: unknown): message is CursorThinkingMessage {
  return isRecord(message) && message.type === 'thinking' && typeof message.text === 'string';
}

function isCursorToolCallMessage(message: unknown): message is CursorToolCallMessage {
  return (
    isRecord(message) &&
    message.type === 'tool_call' &&
    typeof message.call_id === 'string' &&
    typeof message.name === 'string' &&
    (message.status === 'running' || message.status === 'completed' || message.status === 'error')
  );
}

function isCursorStatusMessage(message: unknown): message is CursorStatusMessage {
  return (
    isRecord(message) &&
    message.type === 'status' &&
    (message.status === 'CREATING' ||
      message.status === 'RUNNING' ||
      message.status === 'FINISHED' ||
      message.status === 'ERROR' ||
      message.status === 'CANCELLED' ||
      message.status === 'EXPIRED')
  );
}

function isCursorRequestMessage(message: unknown): message is CursorRequestMessage {
  return isRecord(message) && message.type === 'request' && typeof message.request_id === 'string';
}

function isCursorTaskMessage(message: unknown): message is CursorTaskMessage {
  return (
    isRecord(message) &&
    message.type === 'task' &&
    (message.status === undefined || typeof message.status === 'string') &&
    (message.text === undefined || typeof message.text === 'string')
  );
}

function readCursorEventType(message: unknown): string | undefined {
  return isRecord(message) && typeof message.type === 'string' ? message.type : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
