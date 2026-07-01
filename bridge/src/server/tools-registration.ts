/**
 * Shared tool registration for MCP Server instances.
 *
 * Each SSE/Streamable HTTP connection needs its own Server + Transport pair,
 * but they all register the same set of tools. This module extracts
 * that registration logic into a reusable function.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ZodTypeAny } from 'zod';

import type { InstanceRegistry } from '../hermes/registry.js';
import { SERVER_ICON_SVG_BASE64 } from '../config/constants.js';
import { log, logError } from '../utils/logger.js';
import * as tools from '../mcp/tools/index.js';
import { PROMPT_REGISTRY } from '../mcp/prompts/registry.js';
import { recordEnvelopeForLog, summarizeEnvelopeForLog } from './accessLog.js';
import type { FinnyEnvelope } from '../types/envelope.js';
import type { Session } from '../mcp/tools/_shared/principal.js';

export interface ToolRegistrationDeps {
  registry: InstanceRegistry;
  serverName: string;
  serverVersion: string;
}

// M1 semantic stubs. Each module exports { name, description, inputSchema (Zod),
// handler (async function). The handler contract here is:
//   input: unknown → parse with inputSchema → call handler → JSON-stringify
//   the envelope into MCP content[0].text.
// executeSuiteQLTool is INTENTIONALLY excluded from the MCP tool surface.
// It is kept as an internal module (used by future supervised paths and
// covered by unit tests in src/__tests__/mcp/tools/executeSuiteQL.test.ts)
// but cowork should never invoke it — Finny authors SuiteQL via her own
// netsuite skill scripts. See docs/FINNY-AS-PLUGIN-DESIGN.md M4.1 carry-forward.
const ALL_TOOLS = [
  tools.queryTool,
  tools.reportTool,
  tools.taskStatusTool,
  tools.continueTool,
  tools.rememberTool,
] as const;

type HandlerFn = (
  input: unknown,
  session?: Session
) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

export const toolHandlers = new Map<string, HandlerFn>(
  ALL_TOOLS.map((t) => {
    const fn: HandlerFn = async (input: unknown, session?: Session) => {
      const parsed = (t.inputSchema as ZodTypeAny).parse(input);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const envelope = (await (t.handler as (p: any, s?: Session) => Promise<unknown>)(
        parsed,
        session
      )) as FinnyEnvelope;
      // Record envelope shape for the per-request access log line. No-op
      // in stdio mode (no AsyncLocalStorage context set there).
      try {
        recordEnvelopeForLog(summarizeEnvelopeForLog(t.name, envelope));
      } catch {
        // Must never crash the tool response path.
      }
      return { content: [{ type: 'text', text: JSON.stringify(envelope) }] };
    };
    return [t.name, fn] as const;
  })
);

export const allTools: Tool[] = ALL_TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  // Tool.inputSchema wants a JSON schema, not a Zod object.
  inputSchema: zodToJsonSchema(t.inputSchema as ZodTypeAny, {
    target: 'jsonSchema7',
    $refStrategy: 'none',
  }) as Tool['inputSchema'],
}));

// Thin test seams used by src/__tests__/mcp/tools/stubs.test.ts.
export async function listTools(): Promise<Tool[]> {
  return allTools;
}

export async function callTool(
  name: string,
  args: unknown,
  session?: Session
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const fn = toolHandlers.get(name);
  if (!fn) throw new Error(`unknown tool: ${name}`);
  return fn(args, session);
}

/**
 * Create a new MCP Server instance with all tools registered.
 */
export function createMcpServer(deps: ToolRegistrationDeps): Server {
  const server = new Server(
    {
      name: deps.serverName,
      version: deps.serverVersion,
      icons: [
        {
          src: `data:image/svg+xml;base64,${SERVER_ICON_SVG_BASE64}`,
          mimeType: 'image/svg+xml',
          sizes: ['128x128'],
        },
      ],
    },
    { capabilities: { tools: {}, prompts: {} } }
  );

  registerTools(server, deps);
  registerPrompts(server);
  return server;
}

/**
 * Register MCP prompts handlers. Prompts serve plugin skill bodies
 * (finny_usage, finny_judging) to any harness connecting to the bridge.
 */
export function registerPrompts(server: Server): void {
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: Object.values(PROMPT_REGISTRY).map((p) => ({
      name: p.name,
      description: p.description,
      arguments: p.arguments,
    })),
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const def = PROMPT_REGISTRY[request.params.name];
    if (!def) {
      throw new Error(`Unknown prompt: ${request.params.name}`);
    }
    const args = (request.params.arguments ?? {}) as Record<string, string>;
    return {
      description: def.description,
      messages: [
        {
          role: 'user' as const,
          content: { type: 'text' as const, text: def.build(args) },
        },
      ],
    };
  });
}

// Thin test seams for prompts (used by src/__tests__/mcp/prompts.test.ts).
export async function listPrompts() {
  return Object.values(PROMPT_REGISTRY).map((p) => ({
    name: p.name,
    description: p.description,
    arguments: p.arguments,
  }));
}

export async function getPrompt(name: string, args: Record<string, string> = {}) {
  const def = PROMPT_REGISTRY[name];
  if (!def) throw new Error(`Unknown prompt: ${name}`);
  return {
    description: def.description,
    messages: [
      { role: 'user' as const, content: { type: 'text' as const, text: def.build(args) } },
    ],
  };
}

/**
 * Register all Hermes tools on an existing MCP Server instance.
 */
function registerTools(server: Server, _deps: ToolRegistrationDeps): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: allTools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: toolArgs } = request.params;
    log(`Executing tool: ${name}`);

    const handler = toolHandlers.get(name);
    if (!handler) {
      throw new Error(`Unknown tool: ${name}`);
    }

    // Task 4.3: thread verified AuthInfo (bearer token + metadata) from
    // MCP RequestHandlerExtra into the tool as `session`. Tools call
    // `derivePrincipal(session)` to enforce sealed identity and bank
    // authz. `extra.authInfo` is undefined for un-authenticated
    // transports (e.g. stdio); the transitional behaviour in
    // `derivePrincipal` handles that path.
    const session: Session | undefined = extra.authInfo
      ? { authInfo: extra.authInfo as AuthInfo }
      : undefined;

    try {
      return await handler(toolArgs, session);
    } catch (error) {
      logError(`Error executing tool ${name}`, error);
      throw error;
    }
  });
}
