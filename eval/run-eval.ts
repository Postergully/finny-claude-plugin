// Eval runner for Finny canonical queries.
// Decision: inline structural diff (no `just-diff` dependency) — keeps the eval surface
// dependency-free, smaller blast radius. The rubric only requires "diff payload non-empty
// on drift", which a path/value diff trivially satisfies.

export interface EvalQuery {
  id: string;
  tool: string;
  input: unknown;
  expected_envelope_shape: string;
}

export interface EvalEnvelope {
  shape: string;
  data?: unknown;
  // Real envelopes carry more fields (error_code, required_vars, etc). We accept any extras.
  [k: string]: unknown;
}

export interface EvalArgs {
  queries: EvalQuery[];
  fetchEnvelope: (q: EvalQuery) => Promise<EvalEnvelope>;
  oracle: Record<string, EvalEnvelope>;
}

export type EvalStatus = 'pass' | 'fail' | 'drift';

export interface DiffEntry {
  path: string;
  oracle: unknown;
  got: unknown;
}

export interface EvalResult {
  id: string;
  status: EvalStatus;
  // diff is:
  //   - [] on pass
  //   - DiffEntry[] on drift (non-empty by construction)
  //   - string explanation on fail (e.g. "no oracle", "shape ok != error")
  diff: DiffEntry[] | string;
}

/** JSON-deep-equal. Treats arrays and plain objects structurally; primitives by ===. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  const bk = Object.keys(bo);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(bo, k)) return false;
    if (!deepEqual(ao[k], bo[k])) return false;
  }
  return true;
}

/** Walk two values and emit a list of {path, oracle, got} for each leaf-level mismatch. */
function structuralDiff(oracle: unknown, got: unknown, path = ''): DiffEntry[] {
  if (deepEqual(oracle, got)) return [];

  // Type mismatch or primitive mismatch: report at this level.
  const bothObjects =
    oracle !== null &&
    got !== null &&
    typeof oracle === 'object' &&
    typeof got === 'object' &&
    Array.isArray(oracle) === Array.isArray(got);

  if (!bothObjects) return [{ path: path || '$', oracle, got }];

  const out: DiffEntry[] = [];
  if (Array.isArray(oracle) && Array.isArray(got)) {
    const max = Math.max(oracle.length, got.length);
    for (let i = 0; i < max; i++) {
      out.push(...structuralDiff(oracle[i], got[i], `${path}[${i}]`));
    }
    return out;
  }

  const ao = oracle as Record<string, unknown>;
  const go = got as Record<string, unknown>;
  const keys = new Set([...Object.keys(ao), ...Object.keys(go)]);
  for (const k of keys) {
    const child = path ? `${path}.${k}` : k;
    out.push(...structuralDiff(ao[k], go[k], child));
  }
  return out;
}

export async function runEval(args: EvalArgs): Promise<EvalResult[]> {
  const out: EvalResult[] = [];
  for (const q of args.queries) {
    const got = await args.fetchEnvelope(q);
    const oracleEnv = args.oracle[q.id];

    if (!oracleEnv) {
      out.push({ id: q.id, status: 'fail', diff: 'no oracle' });
      continue;
    }

    if (got.shape !== oracleEnv.shape) {
      out.push({
        id: q.id,
        status: 'fail',
        diff: `shape ${got.shape} != ${oracleEnv.shape}`,
      });
      continue;
    }

    const d = structuralDiff(oracleEnv, got);
    out.push({
      id: q.id,
      status: d.length === 0 ? 'pass' : 'drift',
      diff: d,
    });
  }
  return out;
}
