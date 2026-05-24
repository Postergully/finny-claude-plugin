// In-memory session store with 64-entry LRU + 1-hour TTL.
// Maps principal -> stable session id so Finny threads conversation memory
// across calls from the same caller within a bridge process lifetime.

import { randomUUID } from 'node:crypto';

const MAX_ENTRIES = 64;
const TTL_MS = 60 * 60 * 1000; // 1 hour

type Entry = {
  sessionId: string;
  lastUsed: number;
};

const store = new Map<string, Entry>();

function prune(now: number): void {
  // Evict expired entries first.
  for (const [key, entry] of store) {
    if (now - entry.lastUsed > TTL_MS) {
      store.delete(key);
    }
  }
  // If still over capacity, evict oldest by lastUsed.
  while (store.size > MAX_ENTRIES) {
    let oldestKey: string | undefined;
    let oldestTs = Infinity;
    for (const [key, entry] of store) {
      if (entry.lastUsed < oldestTs) {
        oldestTs = entry.lastUsed;
        oldestKey = key;
      }
    }
    if (oldestKey === undefined) break;
    store.delete(oldestKey);
  }
}

export function getOrCreateSession(principal: string): string {
  const now = Date.now();
  const existing = store.get(principal);
  if (existing && now - existing.lastUsed <= TTL_MS) {
    existing.lastUsed = now;
    // Re-insert to mark recency (Map preserves insertion order).
    store.delete(principal);
    store.set(principal, existing);
    return existing.sessionId;
  }
  if (existing) {
    store.delete(principal);
  }
  const sessionId = `finny-${randomUUID()}`;
  store.set(principal, { sessionId, lastUsed: now });
  prune(now);
  return sessionId;
}

export function __resetSessionStore_FOR_TEST_ONLY(): void {
  store.clear();
}
