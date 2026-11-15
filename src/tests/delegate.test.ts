import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { indexPath, mergeSkills, readIndex, readLibraryIndex, writeIndex } from '../delegate.js';
import type { SkillIndexRecord } from '../delegate.js';

function record(id: string, name: string): SkillIndexRecord {
  return {
    id,
    name,
    desc: `${name} description`,
    frontmatter: {},
    provenance: { source: 'test' },
  };
}

test('readIndex returns an empty index for a missing root', () => {
  const root = mkdtempSync(join(tmpdir(), 'toolshed-idx-'));
  try {
    const index = readIndex(root);
    assert.equal(index.schema_version, 1);
    assert.deepEqual(index.skills, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('writeIndex and readIndex round-trip', () => {
  const root = mkdtempSync(join(tmpdir(), 'toolshed-idx-'));
  try {
    writeIndex(root, { schema_version: 1, skills: [record('skill:a', 'a')] });
    const index = readIndex(root);
    assert.equal(index.skills.length, 1);
    assert.equal(index.skills[0].id, 'skill:a');
    assert.equal(indexPath(root), join(root, 'mcp', 'data', 'index.json'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readIndex preserves every top-level field', () => {
  const root = mkdtempSync(join(tmpdir(), 'toolshed-idx-'));
  try {
    writeIndex(root, {
      schema_version: 1,
      skills: [],
      packs: [{ name: 'core' }],
      domains: ['x'],
      counts: { skills: 0, agents: 0 },
    } as never);
    const index = readIndex(root);
    assert.ok(index.packs, 'packs was dropped');
    assert.ok(index.domains, 'domains was dropped');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('mergeSkills keeps the base index whole', () => {
  const root = mkdtempSync(join(tmpdir(), 'toolshed-idx-'));
  try {
    const base = {
      schema_version: 1,
      skills: [record('skill:a', 'a')],
      packs: [{ name: 'core' }],
      domains: ['x'],
    } as never;
    const merged = mergeSkills(base, [record('skill:b', 'b')]);
    assert.ok(merged.index.packs, 'packs was dropped by the merge');
    assert.ok(merged.index.domains, 'domains was dropped by the merge');
    assert.equal(merged.index.skills.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('mergeSkills counts added entries', () => {
  const merged = mergeSkills({ schema_version: 1, skills: [] }, [record('skill:a', 'a')]);
  assert.equal(merged.added, 1);
  assert.equal(merged.replaced, 0);
});

test('mergeSkills replaces an entry with the same id', () => {
  const first = mergeSkills({ schema_version: 1, skills: [] }, [record('skill:a', 'a')]);
  const second = mergeSkills(first.index, [record('skill:a', 'a')]);
  assert.equal(second.added, 0);
  assert.equal(second.replaced, 1);
  assert.equal(second.index.skills.length, 1);
});

test('mergeSkills stamps generated_at', () => {
  const merged = mergeSkills({ schema_version: 1, skills: [] }, [record('skill:a', 'a')]);
  assert.ok(merged.index.generated_at);
});

test('mergeSkills keeps the counts in step with the skill list', () => {
  const merged = mergeSkills(
    { schema_version: 1, skills: [record('skill:a', 'a')] },
    [record('skill:b', 'b')],
  );
  assert.equal(merged.index.counts?.skills, 2);
});

test('readLibraryIndex returns undefined for a missing root', () => {
  const root = mkdtempSync(join(tmpdir(), 'toolshed-lib-'));
  try {
    assert.equal(readLibraryIndex(root), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readLibraryIndex returns undefined for an index with no skills array', () => {
  const root = mkdtempSync(join(tmpdir(), 'toolshed-lib-'));
  try {
    mkdirSync(join(root, 'mcp', 'data'), { recursive: true });
    writeFileSync(indexPath(root), JSON.stringify({ schema_version: 1 }));
    assert.equal(readLibraryIndex(root), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
