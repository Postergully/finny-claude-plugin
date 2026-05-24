// SuiteQL write-verb guard + preamble builder for finny_executeSuiteQL.
//
// Conservative posture: the regex fails CLOSED. False positives are
// acceptable — a SELECT whose column is literally named `UPDATE_TS`
// WILL match and be rejected; users rewrite the query with an alias
// (`SELECT updated_at AS ts FROM …`). False negatives (a destructive
// verb sneaking past the guard and into the gateway) are NOT
// acceptable. This tradeoff is deliberate — the guard runs in-bridge
// BEFORE any gateway call, so the cost of a false positive is a
// clearer error message, while the cost of a false negative is a
// write against production NetSuite. The asymmetry dictates the
// posture.
//
// Note on boundaries: JavaScript's `\b` treats underscore as a word
// character, so plain `\bUPDATE\b` would NOT match `UPDATE_TS` — a
// false negative on an identifier. We use an explicit non-alphanumeric
// (or string-edge) boundary `(^|[^A-Za-z0-9])VERB([^A-Za-z0-9]|$)` so
// that `UPDATE_TS`, `UPDATE-TS`, and `UPDATE.TS` all trip the guard.
// Hyphens and dots split identifiers in SQL; underscores are valid in
// identifiers but we still reject them — conservative.
//
// Comment tricks like `SELECT * FROM t -- DROP TABLE u` are ALSO
// rejected. We don't bother parsing SQL comments; if a write verb
// appears anywhere in the statement text, refuse. Again, fail closed.

const WRITE_VERB_PATTERN =
  /(^|[^A-Za-z0-9])(DROP|DELETE|UPDATE|INSERT|ALTER|TRUNCATE|CREATE|GRANT|REVOKE|MERGE|REPLACE)([^A-Za-z0-9]|$)/i;

/**
 * Returns the matched write verb (uppercased) if found, else null.
 */
export function detectWriteVerb(sql: string): string | null {
  const match = sql.match(WRITE_VERB_PATTERN);
  // Capture group 2 is the verb; group 1/3 are boundary characters.
  return match ? match[2].toUpperCase() : null;
}

export interface SuiteQLPreambleParams {
  sql: string;
  env: 'sandbox' | 'production';
  max_rows: number;
  reason: string;
}

export function buildSuiteQLPreamble(params: SuiteQLPreambleParams): string {
  return [
    `Execute the following SuiteQL against ${params.env} NetSuite, return up to ${params.max_rows} rows.`,
    `Reason given by caller: ${params.reason}`,
    ``,
    `SQL:`,
    '```sql',
    params.sql,
    '```',
    ``,
    `Return a JSON envelope per the contract:`,
    `- status: "ok" on success, "refused" if the query requests data Finny cannot access`,
    `- data.shape: "rows"`,
    `- data.columns: array of {name, type}`,
    `- data.rows: array of row arrays`,
    `- sources: the SuiteQL statement itself as one source entry`,
    `- confidence: "high" if the query ran cleanly and returned non-empty`,
  ].join('\n');
}
