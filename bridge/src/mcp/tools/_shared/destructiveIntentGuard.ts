// Destructive-intent guard for finny_query. Analogous to suiteqlGuard but
// for natural-language questions routed through the async chat path.
//
// Posture: fail CLOSED. Finny is a read-only agent against NetSuite; any NL
// question that names a destructive verb applied to NetSuite entities is
// refused in-bridge before we ever create a taskManager task. The cost of
// a false positive is a clearer error + the user rephrases; the cost of a
// false negative is a destructive LLM delegation. Asymmetric, same as SQL
// guard.
//
// Scope of trigger: verb AND entity must both be present. "Delete this
// file" does NOT trip (no NetSuite entity). "Delete vendor bills" DOES
// trip. The verb-only heuristic is too broad (users legitimately say
// "delete this line from my response" in conversation) and the entity-only
// heuristic trivially passes every scenario. The intersection is what
// matches the intent "mutate NetSuite data".
//
// Scenario 07 ("Delete all overdue vendor bills...") fires because
// `delete` ∈ verbs AND `vendor bills` ∈ entities.
// Scenario 07b ("Archive old vendor bills...") does NOT fire because
// `archive` is intentionally NOT in the verb list — it is a softer action
// word commonly used for read-ish "show me old bills" phrasings. If it
// turns out users genuinely mean "archive = soft-delete", we add `archive`
// explicitly and accept the tighter false-positive rate. Today we err
// toward permissive on `archive` to preserve the false-positive signal.

const DESTRUCTIVE_VERBS = [
  'delete',
  'drop',
  'remove',
  'truncate',
  'purge',
  'wipe',
  'erase',
  'void',
  'cancel',
  'close out',
  'write off',
  'write-off',
  'expunge',
  'destroy',
  'nuke',
] as const;

// NetSuite entity phrases — plural AND singular forms. Match-substring;
// we don't try to be clever with stemming.
const NETSUITE_ENTITIES = [
  'bill',
  'bills',
  'vendor bill',
  'vendor bills',
  'invoice',
  'invoices',
  'journal entry',
  'journal entries',
  'purchase order',
  'purchase orders',
  'po',
  'pos',
  'payment',
  'payments',
  'vendor',
  'vendors',
  'customer',
  'customers',
  'transaction',
  'transactions',
  'record',
  'records',
  'account',
  'accounts',
  'item',
  'items',
  'employee',
  'employees',
] as const;

export interface DestructiveMatch {
  verb: string;
  entity: string;
}

/**
 * Returns a match if the question names BOTH a destructive verb and a
 * NetSuite entity. Case-insensitive whole-word-ish matching via regex
 * boundaries (space, start, end, punctuation). Order-independent — the
 * verb can appear anywhere before or after the entity.
 */
export function detectDestructiveIntent(question: string): DestructiveMatch | null {
  const q = question.toLowerCase();
  const verbFound = DESTRUCTIVE_VERBS.find((v) => {
    // Whole-phrase match with word-ish boundaries. `\b` treats `-` as a
    // boundary which we want for `write-off`.
    const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z])${escaped}([^a-z]|$)`, 'i').test(q);
  });
  if (!verbFound) return null;
  const entityFound = NETSUITE_ENTITIES.find((e) => {
    const escaped = e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z])${escaped}([^a-z]|$)`, 'i').test(q);
  });
  if (!entityFound) return null;
  return { verb: verbFound, entity: entityFound };
}
