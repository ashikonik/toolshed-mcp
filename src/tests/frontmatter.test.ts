import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveDescription,
  normaliseKey,
  normaliseTools,
  parseFrontmatter,
  pick,
  pickString,
  pickTools,
  slugify,
} from '../frontmatter.js';

test('parseFrontmatter reads a yaml block and separates the body', () => {
  const text = '---\nname: demo\ndescription: A demo entry.\n---\n\n# Body\n\nSome text.\n';
  const { data, body, present } = parseFrontmatter(text);
  assert.equal(present, true);
  assert.equal(data.name, 'demo');
  assert.match(body, /# Body/);
});

test('parseFrontmatter tolerates a file with no frontmatter', () => {
  const { data, body, present } = parseFrontmatter('# Just a heading\n');
  assert.equal(present, false);
  assert.deepEqual(data, {});
  assert.match(body, /# Just a heading/);
});

test('parseFrontmatter tolerates malformed yaml without throwing', () => {
  const { data, present } = parseFrontmatter('---\nname: [unclosed\n---\nbody\n');
  assert.equal(present, false);
  assert.deepEqual(data, {});
});

test('pick matches across hyphen and underscore spellings', () => {
  const data = { 'allowed-tools': 'Read, Write' };
  assert.equal(pick(data, 'allowed_tools'), 'Read, Write');
  assert.equal(pickString(data, 'allowed-tools'), 'Read, Write');
});

test('normaliseKey folds hyphens and underscores only', () => {
  assert.equal(normaliseKey('allowed_tools'), 'allowed-tools');
  assert.equal(normaliseKey('Allowed-Tools'), 'allowed-tools');
  assert.equal(normaliseKey('DESCRIPTION'), 'description');
});

test('normaliseTools handles a comma separated string', () => {
  assert.deepEqual(normaliseTools('Read, Write, Edit'), ['Read', 'Write', 'Edit']);
});

test('normaliseTools handles a flow list', () => {
  assert.deepEqual(normaliseTools(['Read', 'Grep']), ['Read', 'Grep']);
});

test('normaliseTools handles a block list', () => {
  assert.deepEqual(normaliseTools(['- Read', '- Grep']), ['Read', 'Grep']);
});

test('normaliseTools treats a bare string as one tool', () => {
  assert.deepEqual(normaliseTools('Bash'), ['Bash']);
});

test('normaliseTools handles tool objects', () => {
  assert.deepEqual(normaliseTools([{ name: 'Read' }]), ['Read']);
});

test('normaliseTools drops duplicates and empty names', () => {
  assert.deepEqual(normaliseTools('Read, , Read'), ['Read']);
});

test('pickTools accepts tools and allowed-tools', () => {
  assert.deepEqual(pickTools({ tools: ['Read'] }), ['Read']);
  assert.deepEqual(pickTools({ 'allowed-tools': 'Read, Grep' }), ['Read', 'Grep']);
  assert.deepEqual(pickTools({}), []);
});

test('deriveDescription falls back to the first body line', () => {
  const description = deriveDescription({}, '# Heading\n\nDoes a thing.\n');
  assert.equal(description, 'Does a thing.');
});

test('deriveDescription uses the declared description when present', () => {
  assert.equal(deriveDescription({ description: 'Declared.' }, 'Ignored.'), 'Declared.');
});

test('slugify produces a filename-safe name', () => {
  assert.equal(slugify('My Skill Name'), 'my-skill-name');
  assert.equal(slugify('../escape'), 'escape');
  assert.equal(slugify(''), 'entry');
});
