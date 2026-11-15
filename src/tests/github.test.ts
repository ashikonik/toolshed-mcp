import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  flattenSingleRoot,
  fetchTimeoutMs,
  isSafeRelativePath,
  isValidSkillName,
  parseRepo,
  redactToken,
  repoCacheDir,
  resolveWithin,
} from '../github.js';

test('parseRepo reads owner/repo', () => {
  const repo = parseRepo('owner/repo');
  assert.deepEqual(repo, { owner: 'owner', repo: 'repo' });
});

test('parseRepo reads owner/repo@ref', () => {
  const repo = parseRepo('owner/repo@v1.2.3');
  assert.equal(repo?.owner, 'owner');
  assert.equal(repo?.repo, 'repo');
  assert.equal(repo?.ref, 'v1.2.3');
});

test('parseRepo reads a github url', () => {
  const repo = parseRepo('https://github.com/owner/repo');
  assert.equal(repo?.owner, 'owner');
  assert.equal(repo?.repo, 'repo');
});

test('parseRepo reads a github url with a ref path', () => {
  const repo = parseRepo('https://github.com/owner/repo/tree/main');
  assert.equal(repo?.owner, 'owner');
  assert.equal(repo?.repo, 'repo');
  assert.equal(repo?.ref, 'main');
});

test('parseRepo rejects a non-github host', () => {
  assert.equal(parseRepo('https://gitlab.com/owner/repo'), undefined);
});

test('parseRepo rejects a malformed value', () => {
  assert.equal(parseRepo('owner'), undefined);
  assert.equal(parseRepo('a/b/c'), undefined);
  assert.equal(parseRepo(''), undefined);
});

test('parseRepo rejects a path traversal attempt in the owner', () => {
  assert.equal(parseRepo('../../etc/repo'), undefined);
});

test('isSafeRelativePath rejects traversal and absolute paths', () => {
  assert.equal(isSafeRelativePath('skills/demo/SKILL.md'), true);
  assert.equal(isSafeRelativePath('../escape'), false);
  assert.equal(isSafeRelativePath('a/../../b'), false);
  assert.equal(isSafeRelativePath('/etc/passwd'), false);
  assert.equal(isSafeRelativePath('C:\\windows'), false);
});

test('resolveWithin keeps a resolved path inside the root', () => {
  const root = '/tmp/toolshed-root';
  const resolved = resolveWithin(root, 'skills/demo');
  assert.equal(resolved, '/tmp/toolshed-root/skills/demo');
});

test('resolveWithin refuses a path that climbs out', () => {
  assert.equal(resolveWithin('/tmp/toolshed-root', '../outside'), undefined);
});

test('isValidSkillName accepts normal names', () => {
  assert.equal(isValidSkillName('pdf-tools'), true);
  assert.equal(isValidSkillName('pdf_tools'), true);
  assert.equal(isValidSkillName('a'), true);
});

test('isValidSkillName rejects unsafe names', () => {
  assert.equal(isValidSkillName('../escape'), false);
  assert.equal(isValidSkillName('a/b'), false);
  assert.equal(isValidSkillName('.hidden'), false);
  assert.equal(isValidSkillName(''), false);
});

test('repoCacheDir encodes the repo safely', () => {
  const dir = repoCacheDir('/cache', { owner: 'owner', repo: 'repo' });
  assert.match(dir, /owner__repo$/);
});

test('repoCacheDir includes the ref when present', () => {
  const dir = repoCacheDir('/cache', { owner: 'o', repo: 'r', ref: 'v1' });
  assert.match(dir, /o__r__v1$/);
});

test('redactToken removes the token from text', () => {
  const original = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = 'super-secret-token';
  try {
    const text = redactToken('Authorization: Bearer super-secret-token');
    assert.equal(text.includes('super-secret-token'), false);
    assert.match(text, /\*\*\*/);
  } finally {
    if (original === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = original;
  }
});

test('flattenSingleRoot descends into a single wrapping directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'toolshed-flat-'));
  try {
    mkdirSync(join(root, 'owner-repo-sha'));
    assert.equal(flattenSingleRoot(root), join(root, 'owner-repo-sha'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fetchTimeoutMs defaults to a generous window', () => {
  const original = process.env.TOOLSHED_FETCH_TIMEOUT_MS;
  delete process.env.TOOLSHED_FETCH_TIMEOUT_MS;
  try {
    // A repository of tens of megabytes takes minutes on a modest link,
    // so the default must clear three minutes.
    assert.ok(fetchTimeoutMs() > 180_000);
  } finally {
    if (original !== undefined) process.env.TOOLSHED_FETCH_TIMEOUT_MS = original;
  }
});

test('fetchTimeoutMs reads an override', () => {
  const original = process.env.TOOLSHED_FETCH_TIMEOUT_MS;
  process.env.TOOLSHED_FETCH_TIMEOUT_MS = '5000';
  try {
    assert.equal(fetchTimeoutMs(), 5000);
  } finally {
    if (original === undefined) delete process.env.TOOLSHED_FETCH_TIMEOUT_MS;
    else process.env.TOOLSHED_FETCH_TIMEOUT_MS = original;
  }
});

test('fetchTimeoutMs ignores an unusable override', () => {
  const original = process.env.TOOLSHED_FETCH_TIMEOUT_MS;
  process.env.TOOLSHED_FETCH_TIMEOUT_MS = 'not-a-number';
  try {
    assert.ok(fetchTimeoutMs() > 180_000);
  } finally {
    if (original === undefined) delete process.env.TOOLSHED_FETCH_TIMEOUT_MS;
    else process.env.TOOLSHED_FETCH_TIMEOUT_MS = original;
  }
});
