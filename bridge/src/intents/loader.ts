import { z } from 'zod';

// Codegen'd from bless-list.json by scripts/inline-bless-list.mjs.
// We import the inlined object so tsup bundles it with the rest of the
// code. Earlier attempt used readFileSync(import.meta.url + 'bless-list.json')
// which worked under vitest (sources on disk) but died at runtime against
// the bundle — dist/ has no JSON assets. Same pattern as INLINED_SKILLS
// in src/mcp/prompts/inlined.ts.
import { INLINED_BLESS_LIST } from './bless-list.generated.js';
import { BlessListFileSchema, type BlessListEntry } from './types.js';

type ParsedBlessListFile = z.output<typeof BlessListFileSchema>;

interface LoadedBlessList {
  byId: Map<string, BlessListEntry>;
  byAlias: Map<string, string>; // alias → canonical id
}

let cached: LoadedBlessList | null = null;

function readBlessListFile(): unknown {
  return INLINED_BLESS_LIST;
}

// Build the lookup tables. Fail fast on duplicate ids and alias collisions —
// both are real bugs the v1 stress tests caught (Map.set silently shadows the
// first entry; an unrelated alias colliding with a canonical id would silently
// route the wrong intent). Refusing to start is safer than running with a
// corrupted bless-list.
function buildTables(parsed: ParsedBlessListFile): LoadedBlessList {
  const byId = new Map<string, BlessListEntry>();
  const byAlias = new Map<string, string>();

  for (const entry of parsed.entries) {
    if (byId.has(entry.id)) {
      throw new Error(`bless-list: duplicate id "${entry.id}"`);
    }
    if (byAlias.has(entry.id)) {
      throw new Error(
        `bless-list: id "${entry.id}" collides with an alias of "${byAlias.get(entry.id)}"`
      );
    }
    byId.set(entry.id, entry);

    for (const alias of entry.aliases) {
      if (byId.has(alias)) {
        throw new Error(
          `bless-list: alias "${alias}" of "${entry.id}" collides with an existing id`
        );
      }
      if (byAlias.has(alias)) {
        throw new Error(
          `bless-list: alias "${alias}" of "${entry.id}" collides with an alias of "${byAlias.get(alias)}"`
        );
      }
      byAlias.set(alias, entry.id);
    }
  }

  return { byId, byAlias };
}

export function loadBlessList(): LoadedBlessList {
  if (cached) return cached;
  const parsed = BlessListFileSchema.parse(readBlessListFile());
  cached = buildTables(parsed);
  return cached;
}

// Returns null when intent is not blessed. Caller treats null as "open string"
// and routes to Lolly without scope validation.
export function lookupIntent(id: string | undefined): BlessListEntry | null {
  if (!id) return null;
  const { byId, byAlias } = loadBlessList();
  const direct = byId.get(id);
  if (direct) return direct;
  const aliasedId = byAlias.get(id);
  return aliasedId ? (byId.get(aliasedId) ?? null) : null;
}

export function listBlessedIds(): string[] {
  return Array.from(loadBlessList().byId.keys());
}

// Test-only helpers. _resetBlessListCache lets tests reload after changing
// fixture files; _loadBlessListFromObject lets tests inject synthetic
// fixtures without touching the on-disk file.
export function _resetBlessListCache(): void {
  cached = null;
}

export function _loadBlessListFromObject(raw: unknown): void {
  const parsed = BlessListFileSchema.parse(raw);
  cached = buildTables(parsed);
}
