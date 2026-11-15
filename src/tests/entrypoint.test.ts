import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Lifecycle tests for the stdio entry point.
 *
 * These spawn the built server and talk to it over real pipes, because the
 * behaviour under test is exactly what a pipe does: the framing, the
 * response, and what happens when the client closes its end.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, '..', 'index.js');

interface RpcResult {
  id: number;
  text: string;
}

function startServer(env: NodeJS.ProcessEnv = {}): {
  child: ReturnType<typeof spawn>;
  stdin: NonNullable<ReturnType<typeof spawn>['stdin']>;
  next: (timeoutMs: number) => Promise<RpcResult>;
} {
  const child = spawn(process.execPath, [SERVER], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
  const stdin = child.stdin;
  if (!stdin) throw new Error('the server was spawned without a stdin pipe');

  const queue: RpcResult[] = [];
  const waiting: ((result: RpcResult) => void)[] = [];
  let buffer = '';
  child.stdout!.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (!line) continue;
      try {
        const message = JSON.parse(line) as {
          id?: number;
          result?: { content?: { text?: string }[] };
        };
        if (typeof message.id === 'number') {
          const result: RpcResult = {
            id: message.id,
            text: message.result?.content?.[0]?.text ?? '',
          };
          const waiter = waiting.shift();
          if (waiter) waiter(result);
          else queue.push(result);
        }
      } catch {
        // A non-JSON line on stdout would be a protocol violation; the
        // framing test below is what asserts against it.
      }
    }
  });

  const next = (timeoutMs: number): Promise<RpcResult> => {
    const queued = queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise<RpcResult>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('timed out waiting for a response')),
        timeoutMs,
      );
      waiting.push((result) => {
        clearTimeout(timer);
        resolve(result);
      });
    });
  };

  return { child, stdin, next };
}

test('the server answers a tools/list over real stdio', async () => {
  const { child, stdin, next } = startServer();
  try {
    stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'test', version: '1' },
        },
      })}\n`,
    );
    stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`,
    );
    stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`,
    );

    const seen: RpcResult[] = [];
    for (let i = 0; i < 2; i += 1) {
      seen.push(await next(20_000));
    }
    assert.ok(seen.some((r) => r.id === 2));
  } finally {
    child.kill('SIGKILL');
  }
});

test('the server exits when its client closes stdin', async () => {
  // The SDK's stdio transport listens for `data` and `error` on stdin but
  // not for `end`. Without an explicit handler the server outlives its
  // client, held open by a proxied child.
  const { child, stdin } = startServer();
  try {
    stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'test', version: '1' },
        },
      })}\n`,
    );
    await new Promise((r) => setTimeout(r, 500));
    stdin.end();

    const exited = await Promise.race([
      new Promise<number>((resolve) => child.on('exit', (code) => resolve(code ?? 0))),
      new Promise<number>((_, reject) =>
        setTimeout(() => reject(new Error('the server did not exit after stdin closed')), 15_000),
      ),
    ]);
    assert.equal(exited, 0);
  } finally {
    child.kill('SIGKILL');
  }
});

test('a proxied call is answered before the server exits', async () => {
  // The two behaviours have to hold together: the response must be written
  // *and* the process must exit. Exiting first loses the response; never
  // exiting leaves a stray process behind.
  const { child, stdin, next } = startServer({
    TOOLSHED_PROXY_CONFIG: '/nonexistent-proxy-config.json',
  });
  try {
    stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'test', version: '1' },
        },
      })}\n`,
    );
    stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`,
    );
    stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'search_registry', arguments: { query: 'test', limit: 3 } },
      })}\n`,
    );
    await new Promise((r) => setTimeout(r, 800));
    stdin.end();

    const seen: RpcResult[] = [];
    for (let i = 0; i < 2; i += 1) {
      seen.push(await next(20_000));
    }
    assert.ok(seen.some((r) => r.id === 2 && r.text.length > 0));

    const exited = await Promise.race([
      new Promise<number>((resolve) => child.on('exit', (code) => resolve(code ?? 0))),
      new Promise<number>((_, reject) =>
        setTimeout(() => reject(new Error('the server did not exit after stdin closed')), 15_000),
      ),
    ]);
    assert.equal(exited, 0);
  } finally {
    child.kill('SIGKILL');
  }
});
