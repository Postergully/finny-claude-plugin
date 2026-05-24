import { z } from 'zod';

// Track O (2026-05-15): data interiors + sources + needs_input options use
// .passthrough() so Finny's natural extras (data.summary, column hints, etc.)
// flow through. Treat passthrough fields as UNTRUSTED Finny output: cowork
// must JSON-serialize for rendering — never eval, template-inject, or
// shell-interpolate. BaseEnvelope + ErrorSchema stay strict (wire contract).
const SourceSchema = z
  .object({
    kind: z.enum(['suiteql', 'rest', 'memory', 'skill']),
    ref: z.string(),
    rows_scanned: z.number().int().nonnegative().optional(),
  })
  .passthrough();

const DataScalar = z
  .object({
    shape: z.literal('scalar'),
    value: z.union([z.string(), z.number()]),
    rendered_markdown: z.string().optional(),
  })
  .passthrough();

const DataRows = z
  .object({
    shape: z.literal('rows'),
    // Finny's natural emission is bare strings: ["p1_category", "p2_bucket", ...].
    // Schema also accepts the structured form [{name, type}, ...]. Passthrough
    // on the structured form so {nullable, precision, width, ...} hints ride.
    // .min(1) still enforces presence (catches missing-key typos).
    columns: z
      .array(z.union([z.string(), z.object({ name: z.string(), type: z.string() }).passthrough()]))
      .min(1),
    rows: z.array(z.array(z.unknown())),
    rendered_markdown: z.string().optional(),
  })
  .passthrough();

const DataNarrative = z
  .object({
    shape: z.literal('narrative'),
    narrative: z.string(),
    rendered_markdown: z.string().optional(),
  })
  .passthrough();

const DataSchema = z.discriminatedUnion('shape', [DataScalar, DataRows, DataNarrative]);

// Error code enum added per Phase 0 learnings §6.2 — downstream judge-loop
// (M3 `judging-output` skill) branches on these values.
//
// Split per §10.3: the first 7 values are bridge/gateway *infrastructure*
// failure modes — closed + exhaustive so skills can match-branch on them.
// `'other'` is the escape valve for agent-semantic self-reports Finny emits
// (e.g. `approval_required`, `needs_clarification`) that aren't infra
// failures. The specific semantic code rides in `error.message`; the
// `judging-output` skill parses the message on the `'other'` branch.
// Without this escape valve, Finny's semantic codes trip the Zod enum,
// triggering a correction retry that re-fails and masks the signal as
// `envelope_parse_failed` — destroying the drift fixture from M2.
const ErrorCodeSchema = z.enum([
  'envelope_parse_failed',
  'gateway_rejected', // HTTP 4xx from the Hermes gateway
  'gateway_unreachable', // network error / DNS / connection refused
  'timeout', // deadline_ms exceeded on sync path
  'unauthorized', // 401 from the gateway
  'refused', // Finny refused the task (policy / safety)
  'internal', // catch-all for unexpected bridge errors
  'wrong_tool', // execute-phase scope missing required vars; caller should re-call with phase: 'discover'
  'other', // agent-semantic self-report; specific code in error.message (§10.3)
]);

const ErrorSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
  retryable: z.boolean(),
});

const StatusSchema = z.enum(['ok', 'partial', 'refused', 'error', 'running', 'needs_input']);

// Track F: when execute-phase Finny hits residual ambiguity that resolved
// scope didn't cover (e.g. 3 vendors named "Acme"), she returns
// status: 'needs_input' carrying a question + optional finite-set options +
// a conversation_id cowork uses to call finny_continue. round is the
// 1-indexed clarification turn — the bridge caps at 3 to prevent infinite
// loops and forces a `partial` envelope after that.
const NeedsInputSchema = z.object({
  question: z.string().min(1),
  options: z
    .array(z.object({ id: z.string().min(1), label: z.string().min(1) }).passthrough())
    .optional(),
  conversation_id: z.string().min(1),
  round: z.number().int().min(1),
});

const BaseEnvelope = z.object({
  status: StatusSchema,
  intent_restated: z.string().min(1),
  assumptions: z.array(z.string()),
  unanswered: z.array(z.string()),
  data: DataSchema.nullable(),
  sources: z.array(SourceSchema),
  confidence: z.enum(['high', 'medium', 'low']),
  confidence_reason: z.string(),
  error: ErrorSchema.optional(),
  task_id: z.string().optional(),
  needs_input: NeedsInputSchema.optional(),
  // Track S: progress strings on running envelopes. Finny emits via
  // finny_progress(text) during long execute phases; the bridge writes
  // them to the task record; finny_task_status surfaces the latest on
  // each poll. Optional + max 500 chars to bound payload size.
  progress: z.string().max(500).optional(),
  elapsed_ms: z.number().int().nonnegative(),
  env_used: z.enum(['sandbox', 'production']),
  bridge_version: z.string(),
  finny_session_id: z.string(),
});

export const FinnyEnvelopeSchema = BaseEnvelope.superRefine((env, ctx) => {
  // status=ok / partial → data must be present
  if ((env.status === 'ok' || env.status === 'partial') && env.data === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `data must not be null when status=${env.status}`,
      path: ['data'],
    });
  }
  // status=running → task_id required
  if (env.status === 'running' && !env.task_id) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'task_id required when status=running',
      path: ['task_id'],
    });
  }
  // status=error → error field required
  if (env.status === 'error' && !env.error) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'error required when status=error',
      path: ['error'],
    });
  }
  // status=needs_input → needs_input field required, data must be null
  if (env.status === 'needs_input') {
    if (!env.needs_input) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'needs_input field required when status=needs_input',
        path: ['needs_input'],
      });
    }
    if (env.data !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'data must be null when status=needs_input',
        path: ['data'],
      });
    }
  }
});

export type FinnyEnvelope = z.infer<typeof FinnyEnvelopeSchema>;
