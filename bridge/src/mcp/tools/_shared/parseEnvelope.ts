import type { ZodIssue } from 'zod';

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
