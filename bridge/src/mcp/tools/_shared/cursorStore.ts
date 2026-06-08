// Workstream B (2026-06-08): opaque cursor → buffered remaining rows.
// One-shot: takeCursor consumes the entry. The returned remaining[] is
// what cowork still needs to receive; if more rows than the page size
// remain after one take, finny_continue re-stores a fresh cursor.
//
// Capacity 256 entries, 10-minute idle eviction. Process-lifetime bound;
// bridge restart drops cursors (cowork sees an "expired cursor" error
// and restarts from finny_query).

import { randomUUID } from 'node:crypto';

const MAX_ENTRIES = 256;
const TTL_MS = 10 * 60 * 1000; // 10 minutes

export interface CursorEntry {
  cursor: string;
  columns: Array<string | { name: string; type: string }>;
  remaining: unknown[][];
  sessionPrincipal: string;
  createdAt: number;
}

const store = new Map<string, CursorEntry>();

function prune(now: number): void {
  for (const [key, entry] of store) {
    if (now - entry.createdAt > TTL_MS) store.delete(key);
  }
  while (store.size > MAX_ENTRIES) {
    let oldestKey: string | undefined;
    let oldestTs = Infinity;
    for (const [key, entry] of store) {
      if (entry.createdAt < oldestTs) {
        oldestTs = entry.createdAt;
        oldestKey = key;
      }
    }
    if (oldestKey === undefined) break;
    store.delete(oldestKey);
  }
}

export function storeCursor(
  init: Omit<CursorEntry, 'cursor' | 'createdAt'>
): string {
  const now = Date.now();
  const cursor = `cur-${randomUUID()}`;
  store.set(cursor, { ...init, cursor, createdAt: now });
  prune(now);
  return cursor;
}

export function takeCursor(cursor: string): CursorEntry | undefined {
  const now = Date.now();
  const entry = store.get(cursor);
  if (!entry) return undefined;
  if (now - entry.createdAt > TTL_MS) {
    store.delete(cursor);
    return undefined;
  }
  store.delete(cursor); // one-shot
  return entry;
}

export function __resetCursorStore_FOR_TEST_ONLY(): void {
  store.clear();
}

export function __backdateCursor_FOR_TEST_ONLY(cursor: string, ageMs: number): void {
  const entry = store.get(cursor);
  if (entry) entry.createdAt = Date.now() - ageMs;
}
