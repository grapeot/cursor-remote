import { randomUUID } from 'node:crypto';

export type Clock = () => string;
export type IdGenerator = () => string;
export type EventIdSequence = () => number;

export const realClock: Clock = () => new Date().toISOString();
export const realId: IdGenerator = () => randomUUID();

export function createEventIdSequence(start = 0): EventIdSequence {
  let current = start;
  return () => {
    current += 1;
    return current;
  };
}
