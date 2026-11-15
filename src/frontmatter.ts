import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

/**
 * Tolerant frontmatter reader.
 *
 * The corpora on this machine disagree on frontmatter dialect:
 *   - `name` / `description` are near-universal, but not universal.
 *   - `allowed-tools` (ECC skills) vs `allowed_tools` (some agents).
 *   - `tools` is polymorphic: a comma-separated string, a YAML flow list,
 *     a YAML block list, or absent.
 *   - Some files carry no frontmatter at all (ECC commands in places).
 *
 * This module normalises all of that in one place so no other file has to
 * know which corpus a value came from.
 */

export interface ParsedFrontmatter {
  data: Record<string, unknown>;
  /** The body below the frontmatter block. */
  body: string;
  /** Whether a frontmatter block was present at all. */
  present: boolean;
}

const FRONTMATTER_RE = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** Parse a file's leading YAML frontmatter. Never throws. */
export function parseFrontmatter(text: string): ParsedFrontmatter {
  const match = FRONTMATTER_RE.exec(text);
  if (!match) {
    return { data: {}, body: text, present: false };
  }
  const body = text.slice(match[0].length);
  let data: Record<string, unknown> = {};
  try {
    const parsed = parseYaml(match[1]);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>;
    }
  } catch {
    // A malformed YAML block is not fatal: the entry still exists, it just has
    // no frontmatter. Treating this as "no frontmatter" is the behaviour that
    // keeps one malformed file from taking a whole corpus offline.
    return { data: {}, body: text, present: false };
  }
  return { data, body, present: true };
}

/**
 * Normalise a key so `allowed-tools` and `allowed_tools` compare equal.
 *
 * Only hyphens and underscores are folded. Case and other punctuation are
 * left alone, because several corpora use case to carry meaning.
 */
export function normaliseKey(key: string): string {
  return key.trim().toLowerCase().replace(/[-_]/g, '-');
}

/**
 * Read a frontmatter value by any of several accepted key spellings.
 *
 * Keys are compared after hyphen/underscore normalisation, so a caller asking
 * for `allowed-tools` finds `allowed_tools`.
 */
export function pick(
  data: Record<string, unknown>,
  ...keys: string[]
): unknown {
  const wanted = new Set(keys.map(normaliseKey));
  for (const [key, value] of Object.entries(data)) {
    if (wanted.has(normaliseKey(key))) {
      return value;
    }
  }
  return undefined;
}

/** Read a frontmatter value as a trimmed string. */
export function pickString(
  data: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  const value = pick(data, ...keys);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return undefined;
}

/**
 * Normalise a tool allow-list.
 *
 * Handles the three shapes found across the corpora:
 *   - comma-separated string: `"Read, Write, Edit"`
 *   - flow list: `[Read, Write]`
 *   - block list: `- Read\n- Write`
 *
 * A single bare string that is not comma-separated is treated as one tool,
 * not as a list of characters.
 */
export function normaliseTools(value: unknown): string[] {
  const out: string[] = [];
  const push = (raw: unknown) => {
    if (typeof raw !== 'string') return;
    for (const part of raw.split(',')) {
      // A block list parsed as raw text keeps its leading dash.
      const name = part.trim().replace(/^[-*]\s*/, '').trim();
      if (name.length > 0 && !out.includes(name)) {
        out.push(name);
      }
    }
  };

  if (typeof value === 'string') {
    push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string') {
        push(item);
      } else if (item && typeof item === 'object') {
        // Some corpora express tools as objects, e.g. `{ name: "Read" }`.
        const name = (item as Record<string, unknown>).name;
        if (typeof name === 'string') push(name);
      }
    }
  }
  return out;
}

/**
 * Read a tool allow-list from frontmatter, checking both the `tools` and
 * `allowed-tools` spellings.
 */
export function pickTools(data: Record<string, unknown>): string[] {
  const value = pick(data, 'tools', 'allowed-tools', 'allowed_tools', 'tool');
  return normaliseTools(value);
}

/**
 * Extract a description, falling back to the first non-heading line of the body.
 *
 * Commands frequently have no frontmatter description but do have a body that
 * says what they do.
 */
export function deriveDescription(
  data: Record<string, unknown>,
  body: string,
): string {
  const declared = pickString(data, 'description', 'desc', 'summary');
  if (declared) {
    return firstSentence(declared);
  }
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (line.startsWith('#')) continue;
    if (line.startsWith('```')) continue;
    return firstSentence(line);
  }
  return '';
}

/** Trim a description to its first sentence, capped at 400 characters. */
export function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const match = /^(.+?[.!?])(\s|$)/.exec(flat);
  const sentence = match ? match[1] : flat;
  return sentence.length > 400 ? `${sentence.slice(0, 397)}...` : sentence;
}

/** SHA-256 of a file's bytes, hex. */
export function hashFile(path: string): string {
  try {
    const bytes = readFileSync(path);
    return createHash('sha256').update(bytes).digest('hex');
  } catch {
    return '';
  }
}

/** SHA-256 of a string, hex. */
export function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Turn a display name into a filename-safe slug.
 *
 * Mirrors the convention used by the existing skill installers so a name
 * that works for one corpus works for all of them.
 */
export function slugify(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return slug.length > 0 ? slug : 'entry';
}
