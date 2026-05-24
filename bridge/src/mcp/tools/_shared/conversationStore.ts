// Conversation store for needs_input → finny_continue ask-back loops.
//
// When execute-phase Finny returns status: 'needs_input', the bridge
// generates a conversation_id and stores the original RunQuery context
// here so cowork can resume via finny_continue without restarting from
// scratch. The Finny LLM session itself is preserved by sessionStore;
// this file holds the *intent + scope + clarifications* context.
//
// Capacity 1000 entries, 30-minute idle eviction. Each finny_continue
// call increments the round counter; the F4 round-cap test asserts the
// caller-side cap (3) lives in the continue handler, not here.
//
// Process-lifetime bound; bridge restart drops in-flight conversations
// (cowork retries from scratch). Disk-backed persistence is a future
// concern — out of scope for this spec.

import { randomUUID } from 'node:crypto';

import type { BlessListEntry } from '../../../intents/types.js';

const MAX_ENTRIES = 1000;
const TTL_MS = 30 * 60 * 1000; // 30 minutes

export interface ConversationEntry {
  conversation_id: string;
  // Original input context, replayed on each finny_continue call.
  intent_string?: string;
  blessed?: BlessListEntry;
  user_question: string;
  expected_shape: 'scalar' | 'rows' | 'narrative';
  scope?: Record<string, unknown>;
  clarifications_resolved: string[];
  sessionPrincipal: string;
  // Round counter; starts at 1 when first stored, increments on each
  // continue call. Caller checks against MAX_ROUNDS (defined in
  // continue.ts) to decide whether to honor or force-partial.
  round: number;
  lastUsed: number;
}

const store = new Map<string, ConversationEntry>();

function prune(now: number): void {
  for (const [key, entry] of store) {
    if (now - entry.lastUsed > TTL_MS) {
      store.delete(key);
    }
  }
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

// Create a new conversation entry (round 1) and return its id. Called from
// runQuery when Finny's first execute response is needs_input.
export function createConversation(
  init: Omit<ConversationEntry, 'conversation_id' | 'round' | 'lastUsed'>
): string {
  const now = Date.now();
  const conversation_id = `conv-${randomUUID()}`;
  store.set(conversation_id, {
    ...init,
    conversation_id,
    round: 1,
    lastUsed: now,
  });
  prune(now);
  return conversation_id;
}

export function getConversation(id: string): ConversationEntry | undefined {
  const now = Date.now();
  const entry = store.get(id);
  if (!entry) return undefined;
  if (now - entry.lastUsed > TTL_MS) {
    store.delete(id);
    return undefined;
  }
  entry.lastUsed = now;
  return entry;
}

// Bump round counter and update lastUsed. Caller sets clarifications/scope
// on the entry directly; this just advances the round.
export function advanceConversation(
  id: string,
  mutate: (e: ConversationEntry) => void
): ConversationEntry | undefined {
  const entry = getConversation(id);
  if (!entry) return undefined;
  mutate(entry);
  entry.round += 1;
  entry.lastUsed = Date.now();
  return entry;
}

export function deleteConversation(id: string): void {
  store.delete(id);
}

// Test-only helpers.
export function __resetConversationStore_FOR_TEST_ONLY(): void {
  store.clear();
}

export function __conversationStoreSize_FOR_TEST_ONLY(): number {
  return store.size;
}

// Test-only: simulate idle time for eviction tests without sleeping.
export function __backdateConversation_FOR_TEST_ONLY(id: string, ageMs: number): void {
  const entry = store.get(id);
  if (entry) entry.lastUsed = Date.now() - ageMs;
}
