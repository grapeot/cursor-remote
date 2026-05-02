import type { SessionProjection } from '../../src/shared/projections';

export const SESSION_READ_ACK_STORAGE_KEY = 'cursor-cloud-remote-poc.sessionReadAck';

export function loadSessionReadAckFromStorage(): Record<string, string> {
  if (typeof window === 'undefined') {
    return {};
  }
  try {
    const raw = window.localStorage.getItem(SESSION_READ_ACK_STORAGE_KEY);
    if (raw === null || raw === '') {
      return {};
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') {
        out[key] = value;
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function persistSessionReadAckToStorage(map: Record<string, string>): void {
  if (typeof window === 'undefined') {
    return;
  }
  window.localStorage.setItem(SESSION_READ_ACK_STORAGE_KEY, JSON.stringify(map));
}

/** Lexicographic max for RFC3339 / ISO timestamps from one clock source. */
export function maxIso(a: string, b: string): string {
  if (a === '') return b;
  if (b === '') return a;
  return a.localeCompare(b) >= 0 ? a : b;
}

/** Activity used for sidebar ordering when server `updatedAt` lags streamed body text. */
export function effectiveSidebarActivityAt(
  session: SessionProjection,
  activityOverlayBySessionId: Record<string, string>
): string {
  const overlay = activityOverlayBySessionId[session.id];
  return overlay !== undefined ? maxIso(session.updatedAt, overlay) : session.updatedAt;
}

/** Non-selected sessions with visible activity newer than last visit ack render as unread. */
export function isSidebarSessionUnread(params: {
  session: SessionProjection;
  activityOverlayBySessionId: Record<string, string>;
  selectedSessionId: string | undefined;
  readAckBySessionId: Record<string, string>;
}): boolean {
  const { session, activityOverlayBySessionId, selectedSessionId, readAckBySessionId } = params;
  if (selectedSessionId === session.id) {
    return false;
  }
  const activity = effectiveSidebarActivityAt(session, activityOverlayBySessionId);
  const ack = readAckBySessionId[session.id];
  if (ack === undefined || ack === '') {
    return false;
  }
  return activity.localeCompare(ack) > 0;
}

export function sidebarSessionsSorter(
  sessions: SessionProjection[],
  activityOverlayBySessionId: Record<string, string>
): SessionProjection[] {
  return [...sessions].sort((a, b) => {
    const atA = effectiveSidebarActivityAt(a, activityOverlayBySessionId);
    const atB = effectiveSidebarActivityAt(b, activityOverlayBySessionId);
    return atB.localeCompare(atA);
  });
}
