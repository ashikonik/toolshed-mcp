import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { TOOLS, createServer } from '../server.js';
import { Registry } from '../registry.js';
import { ProxyPool } from '../proxy.js';

/**
 * Build a server over a throwaway corpus and connect a client to it.
 *
 * The pair runs in-process over `InMemoryTransport`, so no child process is
 * spawned and no stdio framing is exercised — that is covered by the smoke
 * test in the shell script.
 */
async function connect(overrides: {
  root?: string;
  extraSkills?: Record<string, string>;
} = {}) {
  const root = overrides.root ?? mkdtempSync(join(tmpdir(), 'toolshed-srv-'));
  if (overrides.extraSkills) {
    for (const [name, description] of Object.entries(overrides.extraSkills)) {
      const dir = join(root, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'SKILL.md'),
        `---\nname: ${name}\ndescription: ${description}\n---\n\nBody of ${name}.\n`,
      );
    }
  }

  const registry = new Registry([
    { id: 'test', label: 'Test corpus', root, origin: 'local', layout: 'skill-dirs' },
  ]);
  const pool = new ProxyPool([]);
  const server = createServer({
    registry,
    pool,
    cacheRoot: join(root, 'cache'),
    proxyConfigPath: join(root, 'proxies.json'),
    corpusRoot: join(root, 'corpus'),
  });

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  return {
    client,
    server,
    registry,
    root,
    async close() {
      await client.close();
      await server.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('the server lists exactly the tools in the TOOLS list', async () => {
  const h = await connect();
  try {
    const { tools } = await h.client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [...TOOLS].sort());
  } finally {
    await h.close();
  }
});

test('every tool declares all four annotations', async () => {
  const h = await connect();
  try {
    const { tools } = await h.client.listTools();
    for (const tool of tools) {
      assert.ok(tool.annotations, `${tool.name} has no annotations`);
      assert.equal(
        typeof tool.annotations.readOnlyHint,
        'boolean',
        `${tool.name} is missing readOnlyHint`,
      );
      assert.equal(
        typeof tool.annotations.destructiveHint,
        'boolean',
        `${tool.name} is missing destructiveHint`,
      );
      assert.equal(
        typeof tool.annotations.idempotentHint,
        'boolean',
        `${tool.name} is missing idempotentHint`,
      );
      assert.equal(
        typeof tool.annotations.openWorldHint,
        'boolean',
        `${tool.name} is missing openWorldHint`,
      );
    }
  } finally {
    await h.close();
  }
});

test('every tool description names what it does not cover', async () => {
  const h = await connect();
  try {
    const { tools } = await h.client.listTools();
    for (const tool of tools) {
      assert.match(
        tool.description ?? '',
        /Not covered by/,
        `${tool.name} does not say what it does not cover`,
      );
    }
  } finally {
    await h.close();
  }
});

test('search_registry finds an indexed skill', async () => {
  const h = await connect({ extraSkills: { 'pdf-tools': 'Extracts text from pdf files.' } });
  try {
    const result = await h.client.callTool({
      name: 'search_registry',
      arguments: { query: 'pdf' },
    });
    assert.equal(result.isError, undefined);
    const text = (result.content as { text: string }[])[0].text;
    assert.match(text, /pdf-tools/);
  } finally {
    await h.close();
  }
});

test('search_registry reports an empty query as an error', async () => {
  const h = await connect();
  try {
    const result = await h.client.callTool({
      name: 'search_registry',
      arguments: { query: '   ' },
    });
    assert.equal(result.isError, true);
  } finally {
    await h.close();
  }
});

test('get_entry returns the entry body', async () => {
  const h = await connect({ extraSkills: { demo: 'A demo entry.' } });
  try {
    const result = await h.client.callTool({
      name: 'get_entry',
      arguments: { id: 'demo' },
    });
    const text = (result.content as { text: string }[])[0].text;
    assert.match(text, /# demo/);
    assert.match(text, /Body of demo\./);
  } finally {
    await h.close();
  }
});

test('get_entry reports a miss without throwing', async () => {
  const h = await connect();
  try {
    const result = await h.client.callTool({
      name: 'get_entry',
      arguments: { id: 'no-such-entry' },
    });
    assert.equal(result.isError, true);
    const text = (result.content as { text: string }[])[0].text;
    assert.match(text, /No entry found/);
  } finally {
    await h.close();
  }
});

test('list_sources reports the corpus and its entry count', async () => {
  const h = await connect({ extraSkills: { demo: 'A demo entry.' } });
  try {
    const result = await h.client.callTool({
      name: 'list_sources',
      arguments: {},
    });
    const text = (result.content as { text: string }[])[0].text;
    assert.match(text, /test\s+Test corpus/);
    assert.match(text, /entries=1/);
    assert.match(text, /Total entries: 1/);
  } finally {
    await h.close();
  }
});

test('list_mcp_servers separates installed from configured-only', async () => {
  const h = await connect();
  try {
    const result = await h.client.callTool({
      name: 'list_mcp_servers',
      arguments: {},
    });
    const text = (result.content as { text: string }[])[0].text;
    assert.match(text, /registration\(s\)/);
    assert.match(text, /installed/);
  } finally {
    await h.close();
  }
});

test('list_agent_types reports the harnesses it probed', async () => {
  const h = await connect();
  try {
    const result = await h.client.callTool({
      name: 'list_agent_types',
      arguments: {},
    });
    const text = (result.content as { text: string }[])[0].text;
    assert.match(text, /puku-cli/);
    assert.match(text, /claude-code/);
  } finally {
    await h.close();
  }
});

test('list_agent_types rejects an unknown harness', async () => {
  const h = await connect();
  try {
    const result = await h.client.callTool({
      name: 'list_agent_types',
      arguments: { harness: 'nonesuch' },
    });
    assert.equal(result.isError, true);
  } finally {
    await h.close();
  }
});

test('add_github_source defaults to a dry run', async () => {
  const h = await connect();
  try {
    const result = await h.client.callTool({
      name: 'add_github_source',
      arguments: { repo: 'owner/repo' },
    });
    assert.equal(result.isError, undefined);
    const text = (result.content as { text: string }[])[0].text;
    assert.match(text, /Would fetch/);
    assert.match(text, /apply=true/);
  } finally {
    await h.close();
  }
});

test('add_github_source rejects a malformed repository', async () => {
  const h = await connect();
  try {
    const result = await h.client.callTool({
      name: 'add_github_source',
      arguments: { repo: 'not-a-repo' },
    });
    assert.equal(result.isError, true);
  } finally {
    await h.close();
  }
});

test('install_skill_from_github defaults to a dry run', async () => {
  const h = await connect();
  try {
    const result = await h.client.callTool({
      name: 'install_skill_from_github',
      arguments: {
        repo: 'owner/repo',
        path: 'skills/demo',
        harness: 'claude-code',
      },
    });
    assert.equal(result.isError, undefined);
    const text = (result.content as { text: string }[])[0].text;
    assert.match(text, /Would fetch skill 'demo'/);
    assert.match(text, /apply=true/);
  } finally {
    await h.close();
  }
});

test('install_skill_from_github rejects an unsafe skill path', async () => {
  const h = await connect();
  try {
    const result = await h.client.callTool({
      name: 'install_skill_from_github',
      arguments: {
        repo: 'owner/repo',
        path: '../../etc/passwd',
        harness: 'claude-code',
      },
    });
    assert.equal(result.isError, true);
  } finally {
    await h.close();
  }
});

test('proxy_discover reports that nothing is configured', async () => {
  const h = await connect();
  try {
    const result = await h.client.callTool({
      name: 'proxy_discover',
      arguments: {},
    });
    const text = (result.content as { text: string }[])[0].text;
    assert.match(text, /No external MCP servers/);
  } finally {
    await h.close();
  }
});

test('proxy_call rejects a malformed tool name', async () => {
  const h = await connect();
  try {
    const result = await h.client.callTool({
      name: 'proxy_call',
      arguments: { tool: 'nodelimiter' },
    });
    assert.equal(result.isError, true);
  } finally {
    await h.close();
  }
});

test('proxy_call rejects an unknown server', async () => {
  const h = await connect();
  try {
    const result = await h.client.callTool({
      name: 'proxy_call',
      arguments: { tool: 'nosuch__thing' },
    });
    assert.equal(result.isError, true);
  } finally {
    await h.close();
  }
});

test('an unknown tool returns an error rather than crashing the server', async () => {
  const h = await connect();
  try {
    const result = await h.client.callTool({
      name: 'no_such_tool',
      arguments: {},
    });
    assert.equal(result.isError, true);
  } finally {
    await h.close();
  }
});

test('the server survives a tool call that throws inside its handler', async () => {
  const h = await connect();
  try {
    // A source filter that is not an array reaches the handler's type check
    // rather than the schema, so the handler guard is what answers.
    const result = await h.client.callTool({
      name: 'search_registry',
      arguments: { query: 'x', sources: 'not-an-array' },
    });
    assert.ok(result.isError === true || result.isError === undefined);
    // The server is still alive afterwards.
    const after = await h.client.callTool({
      name: 'list_sources',
      arguments: {},
    });
    assert.equal(after.isError, undefined);
  } finally {
    await h.close();
  }
});
