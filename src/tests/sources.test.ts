import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadGithubSource, loadSource } from '../sources.js';

/**
 * A repository has no fixed layout for its skills. These tests cover the
 * shapes that actually occur: skills at the top level, skills under
 * `skills/`, and skills nested deeper still.
 */

function spec(root: string) {
  return {
    id: 'github:test/repo',
    label: 'test/repo',
    root,
    origin: 'github:test/repo',
    kind: 'github' as const,
    layout: 'github-tree' as const,
  };
}

function writeSkill(dir: string, name: string, description: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nBody of ${name}.\n`,
  );
}

test('loadGithubSource finds skills under a skills/ directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'toolshed-gh-'));
  try {
    writeSkill(join(root, 'skills', 'alpha'), 'alpha', 'The alpha skill.');
    writeSkill(join(root, 'skills', 'beta'), 'beta', 'The beta skill.');
    const entries = loadGithubSource(spec(root));
    assert.equal(entries.length, 2);
    const names = entries.map((e) => e.name).sort();
    assert.deepEqual(names, ['alpha', 'beta']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadGithubSource finds skills at the top level', () => {
  const root = mkdtempSync(join(tmpdir(), 'toolshed-gh-'));
  try {
    writeSkill(join(root, 'alpha'), 'alpha', 'The alpha skill.');
    const entries = loadGithubSource(spec(root));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].name, 'alpha');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadGithubSource finds skills nested deeper', () => {
  const root = mkdtempSync(join(tmpdir(), 'toolshed-gh-'));
  try {
    writeSkill(join(root, 'packs', 'core', 'gamma'), 'gamma', 'The gamma skill.');
    const entries = loadGithubSource(spec(root));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].name, 'gamma');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadGithubSource treats a skill directory as a leaf', () => {
  const root = mkdtempSync(join(tmpdir(), 'toolshed-gh-'));
  try {
    writeSkill(join(root, 'skills', 'alpha'), 'alpha', 'The alpha skill.');
    // A nested directory inside a skill is a supporting file, not a skill.
    writeSkill(join(root, 'skills', 'alpha', 'reference', 'inner'), 'inner', 'Nested.');
    const entries = loadGithubSource(spec(root));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].name, 'alpha');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadGithubSource skips .git and build directories', () => {
  const root = mkdtempSync(join(tmpdir(), 'toolshed-gh-'));
  try {
    writeSkill(join(root, '.git', 'objects', 'x'), 'x', 'Should not be found.');
    writeSkill(join(root, 'node_modules', 'y'), 'y', 'Should not be found.');
    writeSkill(join(root, 'skills', 'real'), 'real', 'A real skill.');
    const entries = loadGithubSource(spec(root));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].name, 'real');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadGithubSource picks up agents as flat files', () => {
  const root = mkdtempSync(join(tmpdir(), 'toolshed-gh-'));
  try {
    mkdirSync(join(root, 'agents'), { recursive: true });
    writeFileSync(
      join(root, 'agents', 'helper.md'),
      '---\nname: helper\ndescription: A helper agent.\n---\n\nBody.\n',
    );
    const entries = loadGithubSource(spec(root));
    const agent = entries.find((e) => e.kind === 'agent');
    assert.ok(agent, 'the agent was not indexed');
    assert.equal(agent.name, 'helper');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadGithubSource returns an empty list for an empty repository', () => {
  const root = mkdtempSync(join(tmpdir(), 'toolshed-gh-'));
  try {
    assert.equal(loadGithubSource(spec(root)).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the skill-dirs layout still reads a flat corpus', () => {
  const root = mkdtempSync(join(tmpdir(), 'toolshed-flat-'));
  try {
    writeSkill(join(root, 'alpha'), 'alpha', 'The alpha skill.');
    const entries = loadSource({
      id: 'test',
      label: 'Test',
      root,
      origin: 'local',
      kind: 'local',
      layout: 'skill-dirs',
    });
    assert.equal(entries.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
