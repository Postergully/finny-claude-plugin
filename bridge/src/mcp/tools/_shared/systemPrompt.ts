import type { BlessListEntry } from '../../../intents/types.js';

export type QueryPromptContext = {
  expected_shape: 'scalar' | 'rows' | 'narrative';
  phase?: 'discover' | 'execute' | 'free_form';
  intent_string?: string;
  blessed?: BlessListEntry;
  scope?: Record<string, unknown>;
  clarifications_resolved?: string[];
  user_question?: string;
};

// Envelope schema description shared across all three branches. Lifted from
// the legacy single-mode prompt so each phase can compose its own preamble +
// the same canonical envelope contract. Keep the schema text in one place to
// prevent drift.
function envelopeContract(expected_shape: 'scalar' | 'rows' | 'narrative'): string[] {
  return [
    'Return your response as a SINGLE fenced JSON code block matching this schema:',
    '',
    '{',
    '  "status": "ok" | "partial" | "refused" | "error",',
    '  "intent_restated": "<one sentence paraphrase of the user\'s question>",',
    '  "assumptions": ["<every default you filled in, e.g. env, period, sign convention>"],',
    '  "unanswered": ["<every part of the question you could not address>"],',
    `  "data": { "shape": "${expected_shape}", ... },`,
    '  "sources": [{"kind":"suiteql|rest|memory|skill","ref":"<SQL or path>","rows_scanned":<n?>}],',
    '  "confidence": "high" | "medium" | "low",',
    '  "confidence_reason": "<one sentence>",',
    '  "env_used": "sandbox" | "production"',
    '}',
    '',
    `The data.shape MUST be "${expected_shape}". Populate rendered_markdown with your best-effort ShareChat-style rendering (₹ currency, sign conventions, table layout). Do NOT omit any required field. Do NOT wrap the JSON in commentary — only the fenced block.`,
    '',
    'Confidence rubric:',
    '- high: single authoritative source, exact entity match, complete answer',
    '- medium: multi-source agreement but at least one assumption',
    '- low: inferred, partial, or best-effort answer',
    '',
    'If you cannot answer safely, return status="refused" with an error.code and error.message, and set data to null.',
  ];
}

export interface RememberPromptContext {
  content: string;
  tags: string[];
  source: 'cowork' | 'manual';
}

// Track L: lolly_remember system prompt. Tells Lolly to PERSIST the caller's
// content into her workspace memory rather than answering a NetSuite question.
// The bridge does not write any files itself — Lolly's existing memory writer
// + 11mirror writeback handles persistence on her next sync.
export function buildRememberSystemPrompt(ctx: RememberPromptContext): string {
  const tagsLine = ctx.tags.length > 0 ? ctx.tags.join(', ') : '(none)';
  return [
    'You are Lolly. The caller is asking you to PERSIST a synthesis or note into your workspace memory.',
    '',
    `Source: ${ctx.source}`,
    `Tags: ${tagsLine}`,
    '',
    "Append the user's content to your workspace MEMORY.md under an appropriate heading,",
    'tagged with the provided tags. Your existing 11mirror writeback flow will pick it up on',
    'your next sync.',
    '',
    'Do NOT run any NetSuite query. Do NOT validate or summarize the content — store it verbatim.',
    "Return a confirmation envelope (status: 'ok', data.shape: 'scalar', value: 'ok').",
    '',
    ...envelopeContract('scalar'),
  ].join('\n');
}

export function buildQuerySystemPrompt(ctx: QueryPromptContext): string {
  const phase = ctx.phase ?? (ctx.intent_string ? 'execute' : 'free_form');

  // ─── Free-form (legacy) ────────────────────────────────────────────
  // Preserve the M2/M3 generic NetSuite-agent prompt verbatim. Operator
  // manual queries via Claude Desktop and any caller using the legacy
  // `lolly_query({question})` shape land here.
  if (phase === 'free_form') {
    return [
      "You are Lolly, a ShareChat NetSuite ERP agent. Answer the user's question by running the smallest number of SuiteQL or REST calls needed, then return a SINGLE fenced JSON code block matching this schema:",
      '',
      ...envelopeContract(ctx.expected_shape),
    ].join('\n');
  }

  // ─── Discover phase ────────────────────────────────────────────────
  // Lolly answers from her brain — she does NOT run NetSuite queries here.
  //
  // v1 of this prompt put the prohibition on the LAST line and used the
  // ambiguous phrase "recent values, common defaults". Live smoke 2026-05-14
  // showed Lolly probing NetSuite anyway (~50s discover, "193 GL accounts
  // mapped" + "March 2026 ₹208 Cr anomaly" in the narrative). Track G
  // rewrites with prohibition-first ordering, "MUST NOT" + DISCOVERY mode
  // markers in line 2, anti-trigger phrasing on instruction #3, and a
  // closing reminder. See docs/superpowers/specs/2026-05-14-discover-prompt-discipline.md.
  if (phase === 'discover') {
    // Wrap bless-list scope_doc with a "for reference only" preamble. The
    // scope_doc was written for execute-phase semantics ("aggregated by
    // GL account", etc.) and Lolly was reading it as instructions to
    // execute NOW. Framing prevents that.
    const blessLine = ctx.blessed
      ? [
          `This intent is in the bless-list (v${ctx.blessed.version}). Required scope variables: ${ctx.blessed.required_scope.map((v) => v.name).join(', ')}.`,
          '',
          'For reference ONLY — this describes the execute-phase semantics, not what you should do now. Use it to explain the intent and required variables to the caller. Do NOT execute against NetSuite:',
          ctx.blessed.scope_doc,
        ].join('\n')
      : 'This intent is NOT in the bless-list. Use your brain knowledge of NetSuite + ShareChat workflows to figure out what scope makes sense.';

    return [
      'You are Lolly in DISCOVERY mode. This is a planning step, not an execution step.',
      '',
      'You MUST NOT run any SuiteQL query, REST call, or any other live NetSuite probe in this phase. If you find yourself thinking "let me check NetSuite to confirm" — STOP. The execute phase is where queries run. This phase is for listing variables and clarifying questions only.',
      '',
      'Why this matters: discovery is a fast brain-only response (target ~5 seconds) so cowork can decide what to ask the user about. Live NetSuite probes during discovery push the latency to 30-60 seconds and break the chat UX.',
      '',
      ctx.intent_string ? `Intent hint from caller: "${ctx.intent_string}"` : '',
      ctx.user_question ? `User's verbatim question: "${ctx.user_question}"` : '',
      '',
      blessLine,
      '',
      "Return a narrative envelope (data.shape: 'narrative') whose narrative covers:",
      "1. Plain-English description of what this intent does in ShareChat's NetSuite context.",
      '2. Each required variable, with what choosing each implies (no live data — describe the choices, do not enumerate them).',
      "3. Hints from your memory ONLY — defaults you've established with this user before, scope choices you've made for similar intents in past turns. Do NOT count entities, do NOT probe recent values from NetSuite, do NOT compute aggregates.",
      '4. 2-4 example clarifying questions cowork can put to the user.',
      '',
      'Reminder: variables and clarifying questions only. No NetSuite. No SuiteQL. No REST.',
      '',
      ...envelopeContract('narrative'),
    ]
      .filter(Boolean)
      .join('\n');
  }

  // ─── Execute phase ─────────────────────────────────────────────────
  // Caller has resolved scope (or is sending an open intent without scope
  // and accepting that Lolly will need to figure things out / return
  // needs_input). Trust the input.
  const blessLineExec = ctx.blessed
    ? `Bless-list scope_doc (v${ctx.blessed.version}):\n${ctx.blessed.scope_doc}`
    : "This intent is not in the bless-list — use your judgment to interpret the caller's intent and run the smallest set of NetSuite queries needed.";

  const scopeBlock =
    ctx.scope && Object.keys(ctx.scope).length > 0
      ? `Resolved scope:\n${JSON.stringify(ctx.scope, null, 2)}`
      : '';

  const clarificationsBlock =
    ctx.clarifications_resolved && ctx.clarifications_resolved.length > 0
      ? `Clarifications already resolved with the user (do NOT re-ask):\n${ctx.clarifications_resolved.map((c) => `- ${c}`).join('\n')}`
      : '';

  return [
    'You are Lolly, a ShareChat NetSuite ERP agent. The caller wants you to RUN this intent.',
    '',
    ctx.intent_string ? `Intent: "${ctx.intent_string}"` : '',
    ctx.user_question ? `User's verbatim question: "${ctx.user_question}"` : '',
    '',
    blessLineExec,
    '',
    scopeBlock,
    clarificationsBlock,
    '',
    `Expected output shape: ${ctx.expected_shape}.`,
    '',
    // Track S follow-up: lolly_progress prompt instruction will land when the
    // chatPipeline tool-use dispatcher exists. Until then, instructing Lolly
    // to call lolly_progress would route nowhere (no interceptor). The
    // schema/Task/builder/skill plumbing ships ready-to-light-up.
    ...envelopeContract(ctx.expected_shape),
  ]
    .filter(Boolean)
    .join('\n');
}
