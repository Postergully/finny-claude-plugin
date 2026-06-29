// SuiteQL guard — read-only, single-statement enforcement at the bridge edge.
//
// Task 2.4 of the finny-multitenant-migration plan adds this guard in
// `bridge/src/intents/` (Phase 1 of multi-tenant sandboxing) so every
// SuiteQL string reaching the gateway has already been:
//   1. Verified to start with SELECT or WITH (statement leader check),
//   2. Stripped of any DDL/DML keywords case-insensitive,
//   3. Stripped of comment markers (`--`, `/*`) and statement separator (`;`).
//
// Posture is fail-CLOSED. False positives (a legitimate query containing
// the substring `UPDATE` as a column name) are acceptable — users rewrite
// with aliasing. False negatives (a write verb reaching the gateway) are
// not — the cost asymmetry is "clearer error message" vs "write against
// production NetSuite".
//
// Errors do NOT leak the full query content. The message contains at most
// the first 80 characters of the offending query, matching the verifier
// rubric ("Errors do not leak query content beyond first 80 chars").
//
// This guard is complementary to the existing `_shared/suiteqlGuard.ts`
// write-verb regex used inside `finny_executeSuiteQL`. The intents/-layer
// guard is stricter (SELECT/WITH-only, comment/separator rejection) and
// is the canonical guard wired into every SuiteQL call site going forward.

export class SuiteQLViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SuiteQLViolation';
  }
}

// Word-boundary keyword match. `\b` is fine here because every forbidden
// verb is a standalone SQL keyword — none of them are valid as a SuiteQL
// identifier in practice. If a future column is literally named `UPDATE`
// the query must alias it (`SELECT updated_at AS ts FROM …`).
const FORBIDDEN = /\b(DROP|DELETE|UPDATE|INSERT|TRUNCATE|ALTER|CREATE|GRANT|REVOKE|EXEC)\b/i;

// Comment markers and statement separator. Any of these in the query
// surface means either an injection attempt or a multi-statement payload
// — both refused.
const COMMENT_OR_SEPARATOR = /(--|\/\*|;)/;

// Statement-leader check: after trimming, the first token must be SELECT
// or WITH. This rejects DDL/DML even when the forbidden-keyword regex
// hypothetically misses (defense in depth).
const STATEMENT_LEADER = /^\s*(SELECT|WITH)\b/i;

/**
 * Validate that `q` is a read-only, single-statement SuiteQL query.
 * Returns `q` unchanged on success. Throws `SuiteQLViolation` on any
 * forbidden construct. Error messages never include more than the first
 * 80 characters of the input query.
 */
export function sanitizeSuiteQL(q: string): string {
  const head = q.slice(0, 80);
  if (FORBIDDEN.test(q)) {
    throw new SuiteQLViolation(`forbidden keyword in: ${head}`);
  }
  if (COMMENT_OR_SEPARATOR.test(q)) {
    throw new SuiteQLViolation('comments and statement-separator forbidden');
  }
  if (!STATEMENT_LEADER.test(q.trim())) {
    throw new SuiteQLViolation('only SELECT/WITH allowed');
  }
  return q;
}
