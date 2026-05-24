import { z } from 'zod';

// One scope variable an intent requires (or accepts as optional).
// `type` is advisory for cowork's intent-decomposer skill — the bridge
// does NOT enforce per-variable type validation. Bridge enforces presence
// only; `strict_nonempty: true` opts in to rejecting empty/whitespace-only
// strings (the v1 stress test caught that empty `entity: ''` would pass
// presence-only validation and propagate garbage into Finny's prompt).
export const ScopeVarSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['enum', 'bool', 'period', 'date', 'string', 'number']),
  options: z.array(z.string()).optional(),
  default: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
  description: z.string().optional(),
  strict_nonempty: z.boolean().default(false),
});

export type ScopeVar = z.infer<typeof ScopeVarSchema>;

// One entry in the bless-list — the small set of canonical intents where
// missing scope is a real bug and bridge-edge enforcement prevents wrong
// answers reaching the user. Per-entry `version` + `aliases[]` handle
// renames without coordinated brain-memory migrations.
//
// Notably absent: `discovery_prompt`. Discovery is Finny's job — the bridge
// does not write a paragraph for her. The bridge tells Finny "discover for
// intent X" and Finny's brain answers.
export const BlessListEntrySchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  deprecated: z.boolean().default(false),
  required_scope: z.array(ScopeVarSchema),
  optional_scope: z.array(ScopeVarSchema).default([]),
  scope_doc: z.string().min(1),
});

export type BlessListEntry = z.infer<typeof BlessListEntrySchema>;

export const BlessListFileSchema = z.object({
  entries: z.array(BlessListEntrySchema).min(1),
});
