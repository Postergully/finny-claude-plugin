import { describe, expect, it } from 'vitest';

import { PROMPT_REGISTRY } from '../../mcp/prompts/registry.js';
import { getPrompt, listPrompts } from '../../server/tools-registration.js';

describe('mcp prompts resource', () => {
  describe('registry', () => {
    it('exposes exactly finny_usage and finny_judging', () => {
      expect(Object.keys(PROMPT_REGISTRY).sort()).toEqual(['finny_judging', 'finny_usage']);
    });

    it('each entry has non-empty description and empty arguments', () => {
      for (const def of Object.values(PROMPT_REGISTRY)) {
        expect(def.description.length).toBeGreaterThan(20);
        expect(def.arguments).toEqual([]);
      }
    });
  });

  describe('listPrompts (handler seam)', () => {
    it('returns both prompts with correct names + descriptions', async () => {
      const prompts = await listPrompts();
      expect(prompts).toHaveLength(2);
      const names = prompts.map((p) => p.name).sort();
      expect(names).toEqual(['finny_judging', 'finny_usage']);

      const usage = prompts.find((p) => p.name === 'finny_usage');
      expect(usage?.description).toMatch(/which finny_\* tool/i);

      const judging = prompts.find((p) => p.name === 'finny_judging');
      expect(judging?.description).toMatch(/envelope/i);
    });
  });

  describe('getPrompt (handler seam)', () => {
    it('finny_usage returns a substantial text body (>500 chars)', async () => {
      const res = await getPrompt('finny_usage');
      expect(res.messages).toHaveLength(1);
      expect(res.messages[0].role).toBe('user');
      expect(res.messages[0].content.type).toBe('text');
      const text = res.messages[0].content.text;
      expect(text.length).toBeGreaterThan(500);
      // Frontmatter should have been stripped
      expect(text.startsWith('---')).toBe(false);
    });

    it('finny_judging returns a substantial text body (>500 chars)', async () => {
      const res = await getPrompt('finny_judging');
      const text = res.messages[0].content.text;
      expect(text.length).toBeGreaterThan(500);
      expect(text.startsWith('---')).toBe(false);
    });

    it('throws on unknown prompt name', async () => {
      await expect(getPrompt('nonexistent')).rejects.toThrow(/Unknown prompt/);
    });
  });
});
