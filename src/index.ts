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

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;

    // A client that closes stdin expects the server to stop, but a request
    // may still be in flight — a proxied call spawns a child process and
    // takes a moment. Exiting on the spot abandons that call with no
    // response, so the outstanding requests are awaited first.
    const pending = [...(deps.inFlight ?? [])];
    if (pending.length > 0) {
      process.stderr.write(
        `[toolshed] ${signal}, waiting for ${pending.length} in-flight call(s)\n`,
      );
      await Promise.allSettled(pending);
    }

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

  // The SDK's stdio transport listens for `data` and `error` on stdin but
  // not for `end`, so a client that closes its end of the pipe never
  // triggers the transport's close. Without this the server would keep
  // running after its client is gone, held open by a proxied child.
  process.stdin.on('end', () => {
    void shutdown('stdin closed');
  });

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
