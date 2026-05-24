import type { BlessListEntry } from './types.js';

export interface ScopeValidationResult {
  ok: boolean;
  missing: string[];
}

// Presence-only check, plus opt-in `strict_nonempty` for vars where empty
// strings are garbage (e.g., entity name). Per-variable type validation is
// deliberately advisory — the bridge's job is to fail fast when scope is
// *missing*, not to second-guess cowork's typing decisions on values it
// already chose to send.
export function validateScope(
  entry: BlessListEntry,
  scope: Record<string, unknown> | undefined
): ScopeValidationResult {
  const provided = scope ?? {};
  const missing: string[] = [];

  for (const v of entry.required_scope) {
    const value = provided[v.name];
    if (value === undefined || value === null) {
      missing.push(v.name);
      continue;
    }
    if (v.strict_nonempty && typeof value === 'string' && value.trim() === '') {
      missing.push(v.name);
    }
  }

  return { ok: missing.length === 0, missing };
}
