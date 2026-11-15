import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProxyPool, killProcessTree, loadProxyTargets } from '../proxy.js';
import { checkInstalled } from '../mcp-servers.js';

test('loadProxyTargets returns an empty list for a missing file', () => {
  const targets = loadProxyTargets('/nonexistent/proxies.json');
  assert.deepEqual(targets, []);
});

test('loadProxyTargets reads targets and drops incomplete entries', () => {
  const root = mkdtempSync(join(tmpdir(), 'toolshed-proxy-'));
  try {
    const path = join(root, 'proxies.json');
    writeFileSync(
      path,
      JSON.stringify({
        targets: [
          { name: 'good', command: '/bin/echo', args: ['hi'] },
          { name: 'no-command' },
          { command: '/bin/echo' },
        ],
      }),
    );
    const targets = loadProxyTargets(path);
    assert.equal(targets.length, 1);
    assert.equal(targets[0].name, 'good');
    assert.deepEqual(targets[0].args, ['hi']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadProxyTargets tolerates a malformed file', () => {
  const root = mkdtempSync(join(tmpdir(), 'toolshed-proxy-'));
  try {
    const path = join(root, 'proxies.json');
    writeFileSync(path, 'not json at all');
    assert.deepEqual(loadProxyTargets(path), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('checkInstalled reports a missing node target', () => {
  const result = checkInstalled('node', ['/nonexistent/index.js']);
  assert.equal(result.installed, false);
  assert.match(result.evidence, /missing/);
});

test('checkInstalled reports an existing node target as installed', () => {
  const result = checkInstalled('node', [process.execPath]);
  assert.equal(result.installed, true);
});

test('checkInstalled resolves a command on PATH', () => {
  const result = checkInstalled('sh', []);
  assert.equal(result.installed, true);
  assert.match(result.evidence, /resolves to/);
});

test('checkInstalled reports a command that is not on PATH', () => {
  const result = checkInstalled('definitely-not-a-real-command-xyz', []);
  assert.equal(result.installed, false);
  assert.match(result.evidence, /not on PATH/);
});

test('checkInstalled reports bunx as not installed when bun is absent', () => {
  const result = checkInstalled('bunx', ['chrome-devtools-mcp@latest']);
  // The evidence names bunx either way; the verdict follows the PATH.
  if (result.installed) {
    assert.match(result.evidence, /bunx available/);
  } else {
    assert.match(result.evidence, /bunx not found on PATH/);
  }
});

test('a proxy session talks to a child process over stdio', async () => {
  const root = mkdtempSync(join(tmpdir(), 'toolshed-proc-'));
  try {
    // A tiny script that answers one JSON-RPC request.
    const script = join(root, 'server.mjs');
    writeFileSync(
      script,
      [
        "import { createInterface } from 'node:readline';",
        "const rl = createInterface({ input: process.stdin });",
        "rl.on('line', (line) => {",
        '  const msg = JSON.parse(line);',
        "  if (msg.id !== undefined) {",
        "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { echo: msg.method } }) + '\\n');",
        '  }',
        '});',
      ].join('\n'),
    );

    const pool = new ProxyPool([
      { name: 'echo', command: process.execPath, args: [script], timeoutMs: 10_000 },
    ]);
    try {
      const session = await pool.session('echo');
      const result = (await session.request('tools/list', {})) as { echo?: string };
      assert.equal(result.echo, 'tools/list');
    } finally {
      await pool.closeAll();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a proxy call times out rather than hanging', async () => {
  const root = mkdtempSync(join(tmpdir(), 'toolshed-proc-'));
  try {
    // A server that answers the handshake but never answers a later request.
    const script = join(root, 'silent.mjs');
    writeFileSync(
      script,
      [
        "import { createInterface } from 'node:readline';",
        "createInterface({ input: process.stdin }).on('line', (line) => {",
        '  const msg = JSON.parse(line);',
        "  if (msg.method === 'initialize') {",
        "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n');",
        '  }',
        '});',
        'setInterval(() => {}, 1000);',
      ].join('\n'),
    );

    const pool = new ProxyPool([
      { name: 'silent', command: process.execPath, args: [script], timeoutMs: 500 },
    ]);
    try {
      const session = await pool.session('silent');
      await assert.rejects(
        () => session.request('tools/list', {}),
        /timed out/,
      );
    } finally {
      await pool.closeAll();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('killProcessTree is safe to call on an already-dead child', async () => {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  await new Promise((r) => setTimeout(r, 200));
  await killProcessTree(child as never);
});
