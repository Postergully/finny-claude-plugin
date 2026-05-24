/**
 * MCP prompts registry — exposes plugin skill bodies as MCP prompts so any
 * harness (Claude Desktop, Cursor, raw MCP clients) connecting to this bridge
 * gets a minimum baseline without the plugin installed.
 *
 * Bodies are inlined at build time via bridge/scripts/inline-skills.mjs so
 * there are no runtime filesystem reads and no post-bundle path fragility.
 */

import { INLINED_SKILLS } from './inlined.js';

export interface PromptDef {
  name: string;
  description: string;
  arguments: Array<{ name: string; description: string; required: boolean }>;
  build: (args: Record<string, string>) => string;
}

function loadSkillBody(key: string): string {
  const body = INLINED_SKILLS[key];
  if (!body) {
    throw new Error(
      `prompts/registry: missing inlined skill body for "${key}". Did bridge/scripts/inline-skills.mjs run?`
    );
  }
  return body;
}

export const PROMPT_REGISTRY: Record<string, PromptDef> = {
  lolly_usage: {
    name: 'lolly_usage',
    description:
      'How to decide when to call Lolly and which lolly_* tool to pick. Load on connect for any harness using the bridge.',
    arguments: [],
    build: () => loadSkillBody('lolly_usage'),
  },
  lolly_judging: {
    name: 'lolly_judging',
    description:
      'How to read a Lolly envelope and decide trust/retry/surface. Load after every lolly_* tool call.',
    arguments: [],
    build: () => loadSkillBody('lolly_judging'),
  },
};
