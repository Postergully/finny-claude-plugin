import { describe, it, expect, beforeEach } from 'vitest';

import {
  loadBlessList,
  lookupIntent,
  listBlessedIds,
  _resetBlessListCache,
  _loadBlessListFromObject,
} from '../../intents/loader.js';
import { validateScope } from '../../intents/validateScope.js';
import { BlessListFileSchema, type BlessListEntry } from '../../intents/types.js';

beforeEach(() => _resetBlessListCache());

describe('bless-list — seed file', () => {
  it('parses without error and exposes the four canonical intents', () => {
    const ids = listBlessedIds();
    expect(ids).toEqual(
      expect.arrayContaining([
        'p&l_statement',
        'vendor_balance',
        'cash_position',
        'transaction_lookup',
      ])
    );
    expect(ids.length).toBe(4);
  });

  it('every entry has version, scope_doc, and at least one required scope var', () => {
    for (const id of listBlessedIds()) {
      const entry = lookupIntent(id);
      expect(entry).toBeDefined();
      expect(entry!.version.length).toBeGreaterThan(0);
      expect(entry!.scope_doc.length).toBeGreaterThan(0);
      expect(entry!.required_scope.length).toBeGreaterThan(0);
    }
  });

  it('lookupIntent returns null for unknown intents (open-string signal)', () => {
    expect(lookupIntent('totally_unknown_intent')).toBeNull();
    expect(lookupIntent(undefined)).toBeNull();
    expect(lookupIntent('')).toBeNull();
  });

  it('loadBlessList caches across calls', () => {
    const a = loadBlessList();
    const b = loadBlessList();
    expect(a).toBe(b);
  });

  it("seed entries have NO discovery_prompt field — discovery is Finny's job", () => {
    for (const id of listBlessedIds()) {
      const entry = lookupIntent(id) as unknown as Record<string, unknown>;
      expect(entry.discovery_prompt).toBeUndefined();
    }
  });
});

describe('bless-list — alias resolution', () => {
  function loadFixtureWithAliases(): void {
    _loadBlessListFromObject({
      entries: [
        {
          id: 'p&l_statement',
          version: '1.0',
          aliases: ['pl_statement', 'profit_and_loss'],
          deprecated: false,
          required_scope: [{ name: 'env', type: 'enum', options: ['sandbox', 'production'] }],
          optional_scope: [],
          scope_doc: 'fixture',
        },
        {
          id: 'cash_position',
          version: '1.0',
          aliases: [],
          deprecated: false,
          required_scope: [{ name: 'env', type: 'string' }],
          optional_scope: [],
          scope_doc: 'fixture',
        },
      ],
    });
  }

  it('aliases route to the canonical entry', () => {
    loadFixtureWithAliases();
    const direct = lookupIntent('p&l_statement');
    const viaAlias1 = lookupIntent('pl_statement');
    const viaAlias2 = lookupIntent('profit_and_loss');
    expect(direct?.id).toBe('p&l_statement');
    expect(viaAlias1).toBe(direct);
    expect(viaAlias2).toBe(direct);
  });
});

describe('bless-list — load-time integrity (stress-test fix #1)', () => {
  it('throws on duplicate canonical ids', () => {
    expect(() =>
      _loadBlessListFromObject({
        entries: [
          {
            id: 'dup',
            version: '1.0',
            aliases: [],
            deprecated: false,
            required_scope: [{ name: 'x', type: 'string' }],
            optional_scope: [],
            scope_doc: 'a',
          },
          {
            id: 'dup',
            version: '1.0',
            aliases: [],
            deprecated: false,
            required_scope: [{ name: 'x', type: 'string' }],
            optional_scope: [],
            scope_doc: 'b',
          },
        ],
      })
    ).toThrow(/duplicate id "dup"/);
  });

  it("throws when an alias collides with another entry's canonical id", () => {
    expect(() =>
      _loadBlessListFromObject({
        entries: [
          {
            id: 'foo',
            version: '1.0',
            aliases: [],
            deprecated: false,
            required_scope: [{ name: 'x', type: 'string' }],
            optional_scope: [],
            scope_doc: 'a',
          },
          {
            id: 'bar',
            version: '1.0',
            aliases: ['foo'], // collides with canonical id "foo"
            deprecated: false,
            required_scope: [{ name: 'x', type: 'string' }],
            optional_scope: [],
            scope_doc: 'b',
          },
        ],
      })
    ).toThrow(/alias "foo".*collides with an existing id/);
  });

  it('throws when two entries share an alias', () => {
    expect(() =>
      _loadBlessListFromObject({
        entries: [
          {
            id: 'a',
            version: '1.0',
            aliases: ['shared'],
            deprecated: false,
            required_scope: [{ name: 'x', type: 'string' }],
            optional_scope: [],
            scope_doc: 'a',
          },
          {
            id: 'b',
            version: '1.0',
            aliases: ['shared'],
            deprecated: false,
            required_scope: [{ name: 'x', type: 'string' }],
            optional_scope: [],
            scope_doc: 'b',
          },
        ],
      })
    ).toThrow(/alias "shared".*collides/);
  });

  it("throws when a canonical id collides with another entry's alias", () => {
    expect(() =>
      _loadBlessListFromObject({
        entries: [
          {
            id: 'first',
            version: '1.0',
            aliases: ['second'],
            deprecated: false,
            required_scope: [{ name: 'x', type: 'string' }],
            optional_scope: [],
            scope_doc: 'a',
          },
          {
            id: 'second', // canonical id collides with first entry's alias
            version: '1.0',
            aliases: [],
            deprecated: false,
            required_scope: [{ name: 'x', type: 'string' }],
            optional_scope: [],
            scope_doc: 'b',
          },
        ],
      })
    ).toThrow(/id "second" collides with an alias/);
  });
});

describe('bless-list — schema validation', () => {
  it('rejects empty entries array', () => {
    const result = BlessListFileSchema.safeParse({ entries: [] });
    expect(result.success).toBe(false);
  });

  it('rejects an entry with empty id', () => {
    const result = BlessListFileSchema.safeParse({
      entries: [
        {
          id: '',
          version: '1.0',
          aliases: [],
          deprecated: false,
          required_scope: [{ name: 'x', type: 'string' }],
          optional_scope: [],
          scope_doc: 'a',
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects an entry with empty scope_doc', () => {
    const result = BlessListFileSchema.safeParse({
      entries: [
        {
          id: 'x',
          version: '1.0',
          aliases: [],
          deprecated: false,
          required_scope: [{ name: 'x', type: 'string' }],
          optional_scope: [],
          scope_doc: '',
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects an entry with empty version', () => {
    const result = BlessListFileSchema.safeParse({
      entries: [
        {
          id: 'x',
          version: '',
          aliases: [],
          deprecated: false,
          required_scope: [{ name: 'x', type: 'string' }],
          optional_scope: [],
          scope_doc: 'doc',
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('forwards-compat: extra unknown top-level keys are stripped, not rejected', () => {
    const result = BlessListFileSchema.safeParse({
      entries: [
        {
          id: 'x',
          version: '1.0',
          aliases: [],
          deprecated: false,
          required_scope: [{ name: 'x', type: 'string' }],
          optional_scope: [],
          scope_doc: 'doc',
        },
      ],
      _comment: 'future field',
      version: '2.0',
    });
    expect(result.success).toBe(true);
  });
});

describe('validateScope — presence + strict_nonempty', () => {
  it('passes when every required var is present', () => {
    const entry = lookupIntent('p&l_statement')!;
    const result = validateScope(entry, {
      entity: 'sharechat',
      consolidated: false,
      period: { from: '2026-04-01', to: '2026-04-30' },
      env: 'production',
    });
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('reports missing vars when scope is partial', () => {
    const entry = lookupIntent('p&l_statement')!;
    const result = validateScope(entry, { entity: 'sharechat' });
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(expect.arrayContaining(['consolidated', 'period', 'env']));
  });

  it('treats null and undefined as missing', () => {
    const entry = lookupIntent('p&l_statement')!;
    const result = validateScope(entry, {
      entity: null,
      consolidated: undefined,
      period: { from: '2026-04-01', to: '2026-04-30' },
      env: 'production',
    });
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(expect.arrayContaining(['entity', 'consolidated']));
  });

  it('reports all required vars when scope is undefined entirely', () => {
    const entry = lookupIntent('vendor_balance')!;
    const result = validateScope(entry, undefined);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['vendor_ref', 'env']);
  });

  // Stress-test fix #2: strict_nonempty rejects empty / whitespace strings.
  it('rejects empty string when strict_nonempty is set on the var', () => {
    const entry = lookupIntent('p&l_statement')!;
    // entity has strict_nonempty: true
    const result = validateScope(entry, {
      entity: '',
      consolidated: false,
      period: { from: '2026-04-01', to: '2026-04-30' },
      env: 'production',
    });
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['entity']);
  });

  it('rejects whitespace-only string when strict_nonempty is set', () => {
    const entry = lookupIntent('p&l_statement')!;
    const result = validateScope(entry, {
      entity: '   ',
      consolidated: false,
      period: { from: '2026-04-01', to: '2026-04-30' },
      env: 'production',
    });
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['entity']);
  });

  it('accepts empty string when strict_nonempty is NOT set (backcompat)', () => {
    // consolidated is bool; it doesn't have strict_nonempty. period is an
    // object, so test the principle directly with a synthetic entry.
    const synthetic: BlessListEntry = {
      id: 'synthetic',
      version: '1.0',
      aliases: [],
      deprecated: false,
      required_scope: [
        {
          name: 'lax',
          type: 'string',
          strict_nonempty: false,
          options: undefined,
          default: undefined,
          description: undefined,
        },
      ],
      optional_scope: [],
      scope_doc: 'synthetic',
    };
    const result = validateScope(synthetic, { lax: '' });
    expect(result.ok).toBe(true);
  });
});

describe('bless-list — perf at scale', () => {
  it('100 lookups across the seed bless-list stays under 50ms', () => {
    const ids = listBlessedIds();
    const t0 = Date.now();
    for (let i = 0; i < 100; i++) {
      lookupIntent(ids[i % ids.length]!);
    }
    expect(Date.now() - t0).toBeLessThan(50);
  });
});
