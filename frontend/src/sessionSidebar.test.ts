import type { SessionProjection } from '../../src/shared/projections';
import { describe, expect, it } from 'vitest';
import {
  effectiveSidebarActivityAt,
  isSidebarSessionUnread,
  maxIso,
  sidebarSessionsSorter
} from './sessionSidebar';

const session = (
  partial: Partial<SessionProjection> & Pick<SessionProjection, 'id' | 'updatedAt'>
): SessionProjection => ({
  title: 'S',
  runtime: 'mock',
  status: 'idle',
  modelId: 'composer-2',
  createdAt: partial.updatedAt,
  ...partial
});

describe('sessionSidebar', () => {
  it('maxIso picks newer timestamp lexicographically', () => {
    expect(maxIso('2026-05-01T12:00:00.000Z', '2026-05-01T12:00:01.000Z')).toBe('2026-05-01T12:00:01.000Z');
    expect(maxIso('2026-05-02T09:00:00.000Z', '2026-05-01T12:00:01.000Z')).toBe('2026-05-02T09:00:00.000Z');
    expect(maxIso('', '2026-05-01T12:00:00.000Z')).toBe('2026-05-01T12:00:00.000Z');
    expect(maxIso('2026-05-01T12:00:00.000Z', '')).toBe('2026-05-01T12:00:00.000Z');
    expect(maxIso('', '')).toBe('');
  });

  it('effectiveSidebarActivityAt merges overlay with projection updatedAt', () => {
    const s = session({ id: 'a', updatedAt: '2026-05-01T10:00:00.000Z' });
    expect(effectiveSidebarActivityAt(s, {})).toBe('2026-05-01T10:00:00.000Z');
    expect(effectiveSidebarActivityAt(s, { a: '2026-05-01T11:00:00.000Z' })).toBe('2026-05-01T11:00:00.000Z');
    expect(effectiveSidebarActivityAt(s, { a: '2026-05-01T09:00:00.000Z' })).toBe('2026-05-01T10:00:00.000Z');
  });

  it('isSidebarSessionUnread is false when ack is missing (not yet opened)', () => {
    const s = session({ id: 'x', updatedAt: '2026-05-01T10:00:00.000Z' });
    expect(
      isSidebarSessionUnread({
        session: s,
        activityOverlayBySessionId: {},
        selectedSessionId: undefined,
        readAckBySessionId: {}
      })
    ).toBe(false);
    expect(
      isSidebarSessionUnread({
        session: s,
        activityOverlayBySessionId: {},
        selectedSessionId: undefined,
        readAckBySessionId: { x: '2026-05-01T09:00:00.000Z' }
      })
    ).toBe(true);
    expect(
      isSidebarSessionUnread({
        session: s,
        activityOverlayBySessionId: {},
        selectedSessionId: 'x',
        readAckBySessionId: { x: '2026-05-01T09:00:00.000Z' }
      })
    ).toBe(false);
  });

  it('sidebarSessionsSorter orders by declining effective activity time', () => {
    const a = session({ id: 'older', updatedAt: '2026-05-01T10:00:00.000Z' });
    const b = session({ id: 'newer', updatedAt: '2026-05-01T12:00:00.000Z' });
    const overlay = {};
    expect(sidebarSessionsSorter([a, b], overlay).map((s) => s.id)).toEqual(['newer', 'older']);
    expect(sidebarSessionsSorter([b, a], overlay).map((s) => s.id)).toEqual(['newer', 'older']);
  });

  it('running + unread favors running dot only via caller; unread helper ignores selected session', () => {
    const s = session({
      id: 'r',
      status: 'running',
      updatedAt: '2026-05-01T12:00:00.000Z'
    });
    expect(
      isSidebarSessionUnread({
        session: s,
        activityOverlayBySessionId: {},
        selectedSessionId: 'other',
        readAckBySessionId: { r: '2026-05-01T11:00:00.000Z' }
      })
    ).toBe(true);
    expect(s.status).toBe('running');
  });
});
