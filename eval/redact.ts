// Redaction logic shared between `redact-oracle.mjs` (oracle pre-commit) and
// `run-eval.ts` (runtime envelope normalization before diff). Both must use the
// same rules or the runner will surface `drift` results for fields that are
// in fact equivalent after redaction.
//
// Returns a JSON-serialized + replaced + re-parsed copy. We operate on the JSON
// text form so the substitutions behave identically for both files on disk and
// in-memory objects: regexes that find `finny-<uuid>` etc. match the exact same
// surface area as the on-disk pass.

export function redactEnvelope<T>(env: T): T {
  let raw = JSON.stringify(env);
  raw = raw.replace(/ShareChat/g, '<company>');
  raw = raw.replace(/\bMTPL\b/g, '<entity-1>');
  const sessions = new Map<string, string>();
  raw = raw.replace(
    /finny-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
    (m) => {
      if (!sessions.has(m)) sessions.set(m, `finny-<session-${sessions.size + 1}>`);
      return sessions.get(m)!;
    },
  );
  const tasks = new Map<string, string>();
  raw = raw.replace(/task_[a-z0-9]+_[0-9]+[a-z]*/g, (m) => {
    if (!tasks.has(m)) tasks.set(m, `task_<task-${tasks.size + 1}>`);
    return tasks.get(m)!;
  });
  // Normalize volatile timing fields. Real elapsed_ms varies run-to-run and is
  // not part of the semantic envelope being tested.
  raw = raw.replace(/"elapsed_ms":\s*[0-9]+/g, '"elapsed_ms": "<duration-ms>"');
  return JSON.parse(raw) as T;
}
