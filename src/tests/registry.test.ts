import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry, dedupeEntries, search, sourceCounts, tokenise } from '../registry.js';
import type { RegistryEntry } from '../types.js';

function makeEntry(
  name: string,
  contentHash: string,
  source: string,
  description = 'A test entry.',
): RegistryEntry {
  return {
    id: `skill:${source}:${name}`,
    kind: 'skill',
    name,
    source,
    description,
    path: `/tmp/${source}/${name}/SKILL.md`,
    dir: `/tmp/${source}/${name}`,
    tools: [],
    frontmatter: {},
    contentHash,
    bundle: [],
  };
}

test('dedupeEntries collapses entries with the same name and hash', () => {
  const entries = [
    makeEntry('alpha', 'hash1', 'a'),
    makeEntry('alpha', 'hash1', 'b'),
  ];
  const deduped = dedupeEntries(entries);
  assert.equal(deduped.length, 1);
});

test('dedupeEntries keeps same-name entries with different hashes', () => {
  const entries = [
    makeEntry('alpha', 'hash1', 'a'),
    makeEntry('alpha', 'hash2', 'b'),
  ];
  const deduped = dedupeEntries(entries);
  assert.equal(deduped.length, 2);
});

test('dedupeEntries output is sorted deterministically', () => {
  const entries = [
    makeEntry('zeta', 'h1', 'a'),
    makeEntry('alpha', 'h2', 'a'),
  ];
  const first = dedupeEntries(entries).map((e) => e.id);
  const second = dedupeEntries([...entries].reverse()).map((e) => e.id);
  assert.deepEqual(first, second);
});

test('dedupeEntries records the source of a collapsed copy', () => {
  const entries = [
    makeEntry('alpha', 'hash1', 'a'),
    makeEntry('alpha', 'hash1', 'b'),
  ];
  const deduped = dedupeEntries(entries);
  assert.deepEqual(deduped[0].aliases, ['b']);
});

test('sourceCounts credits a source whose entries were collapsed', () => {
  // A corpus that holds only byte-identical copies of another corpus's
  // skills still contributed them. Counting only the survivors would make
  // it look empty.
  const entries = [
    makeEntry('alpha', 'hash1', 'a'),
    makeEntry('beta', 'hash2', 'a'),
    makeEntry('alpha', 'hash1', 'b'),
  ];
  const counts = sourceCounts(dedupeEntries(entries));
  assert.equal(counts.get('a'), 2);
  assert.equal(counts.get('b'), 1);
});

test('search ranks a name match above a description match', () => {
  const entries = [
    makeEntry('pdf', 'h1', 'a', 'Handles documents'),
    makeEntry('docx', 'h2', 'a', 'Converts pdf files to text'),
  ];
  const hits = search(entries, { query: 'pdf' });
  assert.equal(hits.length, 2);
  assert.equal(hits[0].entry.name, 'pdf');
});

test('search filters by source', () => {
  const entries = [
    makeEntry('alpha', 'h1', 'a'),
    makeEntry('beta', 'h2', 'b'),
  ];
  const hits = search(entries, { query: 'alpha', sources: ['b'] });
  assert.equal(hits.length, 0);
});

test('search filters by kind', () => {
  const entries = [makeEntry('alpha', 'h1', 'a')];
  const hits = search(entries, { query: 'alpha', kinds: ['agent'] });
  assert.equal(hits.length, 0);
});

test('search returns nothing for an empty query', () => {
  assert.equal(search([makeEntry('a', 'h', 's')], { query: '   ' }).length, 0);
});

test('tokenise splits on non-alphanumeric characters', () => {
  assert.deepEqual(tokenise('Hello, World!'), ['hello', 'world']);
});

test('registry loads a skill directory corpus', () => {
  const root = mkdtempSync(join(tmpdir(), 'toolshed-src-'));
  try {
    const skillDir = join(root, 'demo');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: demo\ndescription: Does demo things.\n---\n\nBody.\n',
    );
    const registry = new Registry([
      { id: 'test', label: 'Test', root, origin: 'local', layout: 'skill-dirs' },
    ]);
    const entries = registry.all();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].name, 'demo');
    assert.equal(entries[0].description, 'Does demo things.');
    assert.ok(entries[0].contentHash.length > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findLoose resolves the kind-and-name form of an id', () => {
  // The documented id form is `skill:<name>`; the stored id is
  // `skill:<source>:<name>`. Both must resolve.
  const root = mkdtempSync(join(tmpdir(), 'toolshed-loose-'));
  try {
    const skillDir = join(root, 'demo');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: demo\ndescription: Does demo things.\n---\n\nBody.\n',
    );
    const registry = new Registry([
      { id: 'test', label: 'Test', root, origin: 'local', layout: 'skill-dirs' },
    ]);
    assert.equal(registry.findLoose('skill:demo')?.name, 'demo');
    assert.equal(registry.findLoose('demo')?.name, 'demo');
    assert.equal(registry.findLoose('skill:test:demo')?.name, 'demo');
    assert.equal(registry.findLoose('skill:other:demo'), undefined);
    assert.equal(registry.findLoose('agent:demo'), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('registry picks up a change to a source without a restart', () => {  const root = mkdtempSync(join(tmpdir(), 'toolshed-live-'));
  try {
    const skillDir = join(root, 'demo');
    mkdirSync(skillDir, { recursive: true });
    const file = join(skillDir, 'SKILL.md');
    writeFileSync(file, '---\nname: demo\ndescription: First version.\n---\nBody.\n');

    const registry = new Registry([
      { id: 'test', label: 'Test', root, origin: 'local', layout: 'skill-dirs' },
    ]);
    assert.equal(registry.all()[0].description, 'First version.');

    // A different size guarantees the fingerprint changes even on a coarse clock.
    writeFileSync(
      file,
      '---\nname: demo\ndescription: Second version, longer than the first.\n---\nBody.\n',
    );
    const future = new Date(Date.now() + 5000);
    utimesSync(file, future, future);
    utimesSync(skillDir, future, future);
    utimesSync(root, future, future);

    assert.equal(registry.all()[0].description, 'Second version, longer than the first.');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('registry keeps serving the previous state when a rebuild fails', () => {
  const root = mkdtempSync(join(tmpdir(), 'toolshed-fail-'));
  try {
    const skillDir = join(root, 'demo');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: demo\n---\nBody.\n');
    const registry = new Registry([
      { id: 'test', label: 'Test', root, origin: 'local', layout: 'skill-dirs' },
    ]);
    assert.equal(registry.all().length, 1);

    // Remove the corpus entirely: the rebuild finds nothing and records an
    // error. The previous entries stay in service.
    rmSync(root, { recursive: true, force: true });
    const entries = registry.all();
    assert.equal(entries.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('registry returns an empty list for a missing corpus', () => {
  const registry = new Registry([
    {
      id: 'missing',
      label: 'Missing',
      root: '/nonexistent/path/for/tests',
      origin: 'local',
      layout: 'skill-dirs',
    },
  ]);
  assert.equal(registry.all().length, 0);
});
