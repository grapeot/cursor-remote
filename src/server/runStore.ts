import type { RunSummary } from '../shared/contracts.js';

export class RunStore {
  private readonly runs = new Map<string, RunSummary>();

  upsert(run: RunSummary): RunSummary {
    this.runs.set(run.id, run);
    return run;
  }

  list(): RunSummary[] {
    return Array.from(this.runs.values()).sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt)
    );
  }

  get(id: string): RunSummary | undefined {
    return this.runs.get(id);
  }
}
