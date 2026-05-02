import { describe, expect, it } from 'vitest';
import { RunStore } from '../src/server/runStore.js';
import type { RunSummary } from '../src/shared/contracts.js';

function run(id: string, createdAt: string): RunSummary {
  return {
    id,
    status: 'mocked',
    runtime: 'mock',
    prompt: `Prompt ${id}`,
    createdAt,
    updatedAt: createdAt
  };
}

describe('RunStore', () => {
  it('stores and returns runs in reverse chronological order', () => {
    const store = new RunStore();
    store.upsert(run('older', '2026-04-29T10:00:00.000Z'));
    store.upsert(run('newer', '2026-04-29T11:00:00.000Z'));

    expect(store.list().map((item) => item.id)).toEqual(['newer', 'older']);
    expect(store.get('older')?.prompt).toBe('Prompt older');
  });
});
