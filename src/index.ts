#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer, defaultDeps } from './server.js';

/**
 * The entry point.
 *
 * This is the only file in the server that knows about stdio. Everything else
 * is transport-independent and testable in-process. stdout carries protocol
 * traffic only; diagnostics go to stderr with a `[toolshed]` prefix, because
 * anything else on stdout corrupts the JSON-RPC framing.
 */

async function main(): Promise<void> {
  const deps = defaultDeps();
  const server = createServer(deps);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write(
    `[toolshed] ready: ${deps.registry.all().length} entries, ${deps.pool.list().length} proxy target(s)\n`,
  );

  const shutdown = async (signal: string) => {
    process.stderr.write(`[toolshed] ${signal}, shutting down\n`);
    try {
      await deps.pool.closeAll();
    } catch {
      // best effort
    }
    try {
      await server.close();
    } catch {
      // best effort
    }
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}

main().catch((err) => {
  process.stderr.write(
    `[toolshed] fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
