import { describe, expect, it } from 'vitest';

import { PROMPT_REGISTRY } from '../../mcp/prompts/registry.js';
import { getPrompt, listPrompts } from '../../server/tools-registration.js';

describe('mcp prompts resource', () => {
  describe('registry', () => {
    it('exposes exactly lolly_usage and lolly_judging', () => {
      expect(Object.keys(PROMPT_REGISTRY).sort()).toEqual(['lolly_judging', 'lolly_usage']);
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
      expect(names).toEqual(['lolly_judging', 'lolly_usage']);

      const usage = prompts.find((p) => p.name === 'lolly_usage');
      expect(usage?.description).toMatch(/which lolly_\* tool/i);

      const judging = prompts.find((p) => p.name === 'lolly_judging');
      expect(judging?.description).toMatch(/envelope/i);
    });
  });

  describe('getPrompt (handler seam)', () => {
    it('lolly_usage returns a substantial text body (>500 chars)', async () => {
      const res = await getPrompt('lolly_usage');
      expect(res.messages).toHaveLength(1);
      expect(res.messages[0].role).toBe('user');
      expect(res.messages[0].content.type).toBe('text');
      const text = res.messages[0].content.text;
      expect(text.length).toBeGreaterThan(500);
      // Frontmatter should have been stripped
      expect(text.startsWith('---')).toBe(false);
    });

    it('lolly_judging returns a substantial text body (>500 chars)', async () => {
      const res = await getPrompt('lolly_judging');
      const text = res.messages[0].content.text;
      expect(text.length).toBeGreaterThan(500);
      expect(text.startsWith('---')).toBe(false);
    });

    it('throws on unknown prompt name', async () => {
      await expect(getPrompt('nonexistent')).rejects.toThrow(/Unknown prompt/);
    });
  });
});
