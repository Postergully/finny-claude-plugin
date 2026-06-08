import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { DEFAULT_FINNY_UPSTREAM_URL, DEFAULT_MODEL } from './config/constants.js';
import type { InstanceConfig } from './hermes/types.js';

export interface CliArgs {
  hermesUrl: string;
  gatewayToken: string | undefined;
  model: string;
  // `'http'` is Streamable HTTP mode (serves `/mcp`). The CLI accepts `'sse'`
  // as a one-release deprecation alias on the input side; the parsed value
  // here is always `'stdio' | 'http'`.
  transport: 'stdio' | 'http';
  port: number;
  host: string;
  timeout: number;
  debug: boolean;
  authEnabled: boolean;
  clientId: string | undefined;
  clientSecret: string | undefined;
  issuerUrl: string | undefined;
  redirectUris: string[] | undefined;
  allowDcr: boolean;
  instances: InstanceConfig[];
}

export function parseArguments(version: string): CliArgs {
  const argv = yargs(hideBin(process.argv))
    .version(version)
    .option('hermes-url', {
      alias: 'u',
      type: 'string',
      description: 'Hermes gateway URL',
      default: process.env.FINNY_UPSTREAM_URL || DEFAULT_FINNY_UPSTREAM_URL,
    })
    .option('gateway-token', {
      type: 'string',
      description: 'Bearer token for Hermes gateway authentication',
      default: process.env.FINNY_UPSTREAM_TOKEN || undefined,
    })
    .option('model', {
      alias: 'm',
      type: 'string',
      description: 'Model name for chat completions',
      default: process.env.FINNY_MODEL || DEFAULT_MODEL,
    })
    .option('transport', {
      alias: 't',
      type: 'string',
      choices: ['stdio', 'sse', 'http'] as const,
      description:
        'Transport mode: stdio (local), http (remote Streamable HTTP on /mcp), sse (deprecated alias for http)',
      default: 'stdio',
    })
    .option('port', {
      alias: 'p',
      type: 'number',
      description: 'Port for SSE server',
      default: parseInt(process.env.PORT || '3000', 10),
    })
    .option('host', {
      type: 'string',
      description: 'Host for SSE server',
      default: process.env.HOST || '0.0.0.0',
    })
    .option('timeout', {
      type: 'number',
      description: 'Request timeout in milliseconds',
      default: parseInt(process.env.FINNY_TIMEOUT_MS || '120000', 10),
    })
    .option('debug', {
      type: 'boolean',
      description: 'Enable debug logging',
      default: process.env.DEBUG === 'true' || process.env.NODE_ENV === 'development',
    })
    .option('auth', {
      type: 'boolean',
      description: 'Enable OAuth authentication (SSE mode)',
      default: process.env.AUTH_ENABLED === 'true' || process.env.OAUTH_ENABLED === 'true',
    })
    .option('client-id', {
      type: 'string',
      description: 'MCP OAuth client ID',
      default: process.env.MCP_CLIENT_ID || undefined,
    })
    .option('client-secret', {
      type: 'string',
      description: 'MCP OAuth client secret',
      default: process.env.MCP_CLIENT_SECRET || undefined,
    })
    .option('issuer-url', {
      type: 'string',
      description: 'OAuth issuer URL (for HTTPS behind reverse proxy)',
      default: process.env.MCP_ISSUER_URL || undefined,
    })
    .option('redirect-uris', {
      type: 'string',
      description: 'Allowed OAuth redirect URIs (comma-separated)',
      default: process.env.MCP_REDIRECT_URIS || undefined,
    })
    .option('allow-dcr', {
      type: 'boolean',
      description:
        'Allow OAuth Dynamic Client Registration (Cursor/Windsurf compatibility, dev-only)',
      default: process.env.MCP_DANGEROUSLY_ALLOW_DCR === 'true',
    })
    .help()
    .parseSync();

  // Build instance configs: FINNY_INSTANCES takes precedence, otherwise single-instance from existing env vars
  let instances: InstanceConfig[];
  const instancesEnv = process.env.FINNY_INSTANCES;

  if (instancesEnv) {
    try {
      const parsed = JSON.parse(instancesEnv);
      if (!Array.isArray(parsed) || parsed.length === 0) {
        throw new Error('FINNY_INSTANCES must be a non-empty JSON array');
      }
      // Validate each item has required fields
      for (const item of parsed) {
        if (!item || typeof item.name !== 'string' || !item.name.trim()) {
          throw new Error('Each instance in FINNY_INSTANCES must have a non-empty string "name"');
        }
        if (typeof item.url !== 'string' || !item.url.trim()) {
          throw new Error(`Instance "${item.name}": must have a non-empty string "url"`);
        }
      }
      // Apply global timeout fallback for instances that don't specify their own
      instances = (parsed as InstanceConfig[]).map((cfg) => ({
        ...cfg,
        timeout: cfg.timeout ?? argv.timeout,
      }));
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`FINNY_INSTANCES contains invalid JSON: ${error.message}`);
      }
      throw error;
    }
  } else {
    // Backward-compatible: single instance from existing env vars / CLI args
    instances = [
      {
        name: 'default',
        url: argv['hermes-url'] as string,
        token: argv['gateway-token'] as string | undefined,
        timeout: argv.timeout,
        default: true,
      },
    ];
  }

  // Normalize transport aliases. 'sse' → 'http' (one-release deprecation).
  const rawTransport = argv.transport as 'stdio' | 'sse' | 'http';
  const transport: 'stdio' | 'http' =
    rawTransport === 'sse' ? 'http' : (rawTransport as 'stdio' | 'http');

  // Auth auto-enable: HTTP mode + an explicit issuer URL is a strong signal
  // this is a remote deployment — auth MUST be on. Stdio mode leaves auth
  // alone (stdio doesn't need bearer tokens).
  let authEnabled = argv.auth as boolean;
  const issuerUrl = argv['issuer-url'] as string | undefined;
  const authExplicit =
    process.env.AUTH_ENABLED !== undefined ||
    process.env.OAUTH_ENABLED !== undefined ||
    process.argv.some((a) => a === '--auth' || a === '--no-auth' || a.startsWith('--auth='));
  if (transport === 'http' && issuerUrl && !authEnabled && !authExplicit) {
    authEnabled = true;
    // eslint-disable-next-line no-console
    console.error(
      'Auth auto-enabled because --transport http + --issuer-url implies remote deployment.'
    );
  }

  // Fail-closed validation: HTTP mode with auth requires credentials.
  const clientId = argv['client-id'] as string | undefined;
  const clientSecret = argv['client-secret'] as string | undefined;
  if (transport === 'http' && authEnabled && (!clientId || !clientSecret)) {
    throw new Error(
      'HTTP mode with auth requires both --client-id and --client-secret (or MCP_CLIENT_ID / MCP_CLIENT_SECRET env vars).'
    );
  }

  return {
    hermesUrl: argv['hermes-url'] as string,
    gatewayToken: argv['gateway-token'] as string | undefined,
    model: argv.model as string,
    transport,
    port: argv.port,
    host: argv.host,
    timeout: argv.timeout,
    debug: argv.debug,
    authEnabled,
    clientId,
    clientSecret,
    issuerUrl,
    redirectUris: argv['redirect-uris']
      ? (argv['redirect-uris'] as string)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined,
    allowDcr: argv['allow-dcr'] as boolean,
    instances,
  };
}
