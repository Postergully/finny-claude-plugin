import type { ZodIssue } from 'zod';

const MAX_DIAGNOSTIC_CHARS = 500;
const MAX_ISSUES_REPORTED = 3;

// Build a structured diagnostic string for envelope_parse_failed envelopes.
// Surfaces the literal Zod issue paths plus the discriminant fields Finny
// emitted (status, data.shape) so cowork can see exactly which branch of the
// discriminated union was selected and which required field went missing.
// Without this, error.message reads "Required" with no path — which is what
// led to the cross-team confusion about whether `narrative` was conditionally
// or unconditionally required (it's conditional on data.shape='narrative').
//
// Caps total length and number of issues so a giant union error can't blow
// the wire envelope size. Does NOT echo the full payload — that risks
// leaking GL/PII data into cowork-rendered error text.
export function formatValidationDiagnostic(
  parsedPayload: unknown,
  issues: ZodIssue[],
  prefix: string
): string {
  const status = readShallowString(parsedPayload, 'status');
  const dataShape = readNestedString(parsedPayload, 'data', 'shape');

  const issuesPart = issues
    .slice(0, MAX_ISSUES_REPORTED)
    .map((i) => `${i.path.length > 0 ? i.path.join('.') : '<root>'}: ${i.message}`)
    .join('; ');
  const moreIssues =
    issues.length > MAX_ISSUES_REPORTED ? ` (+${issues.length - MAX_ISSUES_REPORTED} more)` : '';

  const ctx: string[] = [];
  if (status !== null) ctx.push(`status=${status}`);
  if (dataShape !== null) ctx.push(`data.shape=${dataShape}`);
  const ctxPart = ctx.length > 0 ? ` [${ctx.join(', ')}]` : '';

  const full = `${prefix}${ctxPart} ${issuesPart}${moreIssues}`;
  return full.length > MAX_DIAGNOSTIC_CHARS
    ? full.slice(0, MAX_DIAGNOSTIC_CHARS - 3) + '...'
    : full;
}

function readShallowString(payload: unknown, key: string): string | null {
  if (payload === null || typeof payload !== 'object') return null;
  const val = (payload as Record<string, unknown>)[key];
  return typeof val === 'string' ? val : null;
}

function readNestedString(payload: unknown, outer: string, inner: string): string | null {
  if (payload === null || typeof payload !== 'object') return null;
  const obj = (payload as Record<string, unknown>)[outer];
  if (obj === null || typeof obj !== 'object') return null;
  const val = (obj as Record<string, unknown>)[inner];
  return typeof val === 'string' ? val : null;
}

export function extractEnvelopeJSON(raw: string): unknown | null {
  // 1) fenced ```json block
  const fence = raw.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fence && fence[1]) {
    try {
      return JSON.parse(fence[1]);
    } catch {
      return null;
    }
  }
  // 2) first {...} object in the text
  const firstBrace = raw.indexOf('{');
  const lastBrace = raw.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(raw.slice(firstBrace, lastBrace + 1));
    } catch {
      return null;
    }
  }
  return null;
}

export function buildCorrectionPrompt(rawPrevious: string, issues: ZodIssue[] | string): string {
  // Two callers: structured Zod issues from a partial-shape failure, or a
  // static string when the first response had no extractable JSON at all.
  // Structured form lets Finny see the exact field paths to repair — the
  // legacy `issues[0]?.message` form gave her "Required" with no path,
  // which is why she'd regenerate the same broken shape on the second
  // pass and trip envelope_parse_failed (M3 Scenario 08).
  const issuesBlock =
    typeof issues === 'string'
      ? issues
      : issues
          .map((i) => `- ${i.path.length > 0 ? i.path.join('.') : '<root>'}: ${i.message}`)
          .join('\n');

  return [
    'Your previous response did not match the required envelope schema.',
    '',
    'Validation issues:',
    issuesBlock,
    '',
    'Return the response again as a SINGLE fenced JSON code block (```json ... ```) with every required field populated. Pay specific attention to the field paths listed above. No prose outside the fence.',
    '',
    'Here is your previous output for reference:',
    '---',
    rawPrevious,
    '---',
  ].join('\n');
}
