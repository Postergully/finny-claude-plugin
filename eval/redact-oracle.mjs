#!/usr/bin/env node
// Redact PII and normalize volatile fields in oracle/*.json IN PLACE.
// Idempotent. The substitution rules are kept in sync with `redact.ts`
// (which the runner applies to runtime envelopes); if you change one,
// change the other. See `eval/oracle/REDACTION-MAP.md` for policy.

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

function redactRaw(raw) {
  let out = raw;
  out = out.replace(/ShareChat/g, '<company>');
  out = out.replace(/\bMTPL\b/g, '<entity-1>');
  const sessions = new Map();
  out = out.replace(
    /finny-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
    (m) => {
      if (!sessions.has(m)) sessions.set(m, `finny-<session-${sessions.size + 1}>`);
      return sessions.get(m);
    },
  );
  const tasks = new Map();
  out = out.replace(/task_[a-z0-9]+_[0-9]+[a-z]*/g, (m) => {
    if (!tasks.has(m)) tasks.set(m, `task_<task-${tasks.size + 1}>`);
    return tasks.get(m);
  });
  out = out.replace(/"elapsed_ms":\s*[0-9]+/g, '"elapsed_ms": "<duration-ms>"');
  // Mirror of redact.ts: normalize conversation_id (raw UUID from discover
  // short-circuit OR `conv-<uuid>` from conversationStore). Volatile, not
  // semantic.
  out = out.replace(
    /"conversation_id":\s*"(?:conv-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"/g,
    '"conversation_id":"<conversation-id>"',
  );
  return { out, sessions: sessions.size, tasks: tasks.size };
}

const dir = resolve(process.argv[2] ?? 'eval/oracle');
const files = readdirSync(dir).filter((f) => f.endsWith('.json') && f.startsWith('q'));

for (const f of files) {
  const path = join(dir, f);
  const raw = readFileSync(path, 'utf8');
  const { out, sessions, tasks } = redactRaw(raw);
  writeFileSync(path, out);
  console.error(`redacted ${f} (sessions=${sessions}, tasks=${tasks})`);
}
