import { describe, it, expect } from 'vitest';

import { buildQuerySystemPrompt } from '../../../../mcp/tools/_shared/systemPrompt.js';
import { lookupIntent } from '../../../../intents/loader.js';

// Track G: discover-phase prompt shape assertions.
//
// These tests don't prove Finny will obey the prompt — that's a runtime
// behavior question that prompt-shape tests can't answer. What they DO
// prove: the prompt has the structural properties Track G specifies, so
// future drift (someone removes "MUST NOT", reorders the prohibition,
// etc.) is caught at CI time.
//
// Spec: docs/superpowers/specs/2026-05-14-discover-prompt-discipline.md §3.4

describe('buildQuerySystemPrompt — discover phase shape (Track G)', () => {
  it('renders prohibition-first preamble: DISCOVERY + MUST NOT in the first 400 chars', () => {
    const prompt = buildQuerySystemPrompt({
      expected_shape: 'narrative',
      phase: 'discover',
      intent_string: 'p&l_statement',
      blessed: lookupIntent('p&l_statement')!,
      user_question: 'give me P&L',
    });
    // Mode marker arrives in line 1 — before any positive instruction can
    // mentally commit Finny to producing live data.
    expect(prompt.slice(0, 400)).toMatch(/DISCOVERY mode/);
    // Capitalized prohibition arrives in line 2 (well within first 400c).
    expect(prompt.slice(0, 400)).toMatch(/MUST NOT/);
  });

  it('states the consequence (UX latency / chat UX break)', () => {
    const prompt = buildQuerySystemPrompt({
      expected_shape: 'narrative',
      phase: 'discover',
      intent_string: 'cash_position',
      blessed: lookupIntent('cash_position')!,
    });
    // Why-this-matters paragraph is part of the rewrite — gives Finny a
    // reason, not just a rule. Check for either of the framing phrases.
    expect(prompt).toMatch(/break the chat UX|UX latency|fast brain-only/i);
  });

  it('does NOT use the v1 anti-trigger phrase "recent values, common defaults"', () => {
    // The v1 wording invited live-data fetches because "recent values"
    // reads as "go look up recent values". Track G replaces it with
    // "memory ONLY" plus explicit anti-examples.
    const prompt = buildQuerySystemPrompt({
      expected_shape: 'narrative',
      phase: 'discover',
      intent_string: 'p&l_statement',
      blessed: lookupIntent('p&l_statement')!,
    });
    expect(prompt).not.toMatch(/recent values, common defaults/);
    expect(prompt).toContain('memory ONLY');
    // Anti-examples that name what live-data probes look like.
    // Sentence-internal case is "Do NOT count..., do NOT probe..., do NOT compute..."
    expect(prompt).toMatch(/Do NOT count entities/);
    expect(prompt).toMatch(/do NOT probe recent values/);
    expect(prompt).toMatch(/do NOT compute aggregates/);
  });

  it('renders a closing reminder at the end (defense in depth)', () => {
    const prompt = buildQuerySystemPrompt({
      expected_shape: 'narrative',
      phase: 'discover',
      intent_string: 'vendor_balance',
      blessed: lookupIntent('vendor_balance')!,
    });
    // Reminder is between instructions and envelope contract.
    expect(prompt).toMatch(/variables and clarifying questions only/);
    expect(prompt).toMatch(/No NetSuite\. No SuiteQL\. No REST\./);
  });

  it('wraps blessed scope_doc with "for reference only" preamble', () => {
    const prompt = buildQuerySystemPrompt({
      expected_shape: 'narrative',
      phase: 'discover',
      intent_string: 'p&l_statement',
      blessed: lookupIntent('p&l_statement')!,
    });
    // Track G framing: scope_doc is reference, not instructions.
    expect(prompt).toMatch(/For reference ONLY/);
    expect(prompt).toMatch(/Do NOT execute against NetSuite/);
    // Original scope_doc content still present (Finny needs it to explain
    // the intent to cowork — she just shouldn't act on it).
    expect(prompt).toMatch(/Profit & loss/);
  });

  it('open-string intent skips the bless-list scope_doc preamble but keeps the prohibition', () => {
    const prompt = buildQuerySystemPrompt({
      expected_shape: 'narrative',
      phase: 'discover',
      intent_string: 'cash_decline_root_cause',
      blessed: undefined,
    });
    expect(prompt).toMatch(/NOT in the bless-list/);
    // No scope_doc to wrap, so no "For reference ONLY" preamble.
    expect(prompt).not.toMatch(/For reference ONLY/);
    // Prohibition still applies on every discover call regardless of
    // bless-list match.
    expect(prompt).toContain('MUST NOT');
    expect(prompt).toMatch(/No NetSuite\. No SuiteQL\. No REST\./);
  });

  it('execute phase is unaffected — no DISCOVERY marker, no prohibition reminder', () => {
    const prompt = buildQuerySystemPrompt({
      expected_shape: 'rows',
      phase: 'execute',
      intent_string: 'p&l_statement',
      blessed: lookupIntent('p&l_statement')!,
      scope: {
        entity: 'sharechat',
        consolidated: false,
        period: { from: '2026-04-01', to: '2026-04-30' },
        env: 'production',
      },
    });
    expect(prompt).not.toMatch(/DISCOVERY mode/);
    expect(prompt).not.toMatch(/No NetSuite\. No SuiteQL\. No REST\./);
    // Execute prompt asks Finny to RUN — opposite of discover.
    expect(prompt).toMatch(/caller wants you to RUN/);
  });
});
