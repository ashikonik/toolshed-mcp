import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { join, basename, extname } from 'node:path';
import {
  deriveDescription,
  hashFile,
  hashText,
  normaliseKey,
  parseFrontmatter,
  pickString,
  pickTools,
  slugify,
} from './frontmatter.js';
import type { EntryKind, RegistryEntry, Source } from './types.js';

/**
 * Corpus discovery.
 *
 * Each corpus on this machine has its own layout. This module turns each into
 * `RegistryEntry` records with identical shape, so the registry layer never
 * branches on which corpus produced an entry.
 */

export interface SourceSpec {
  id: string;
  label: string;
  root: string;
  /** Where the corpus was configured from, for provenance. */
  origin: string;
  kind: 'local' | 'github';
  /** Which layout the corpus uses. */
  layout: CorpusLayout;
  /** Directories under `root` to skip, relative paths. */
  exclude?: string[];
}

export type CorpusLayout =
  /** `<root>/<name>/SKILL.md` — a directory per skill. */
  | 'skill-dirs'
  /** `<root>/<name>.md` — one file per skill. */
  | 'skill-files'
  /** `<root>/<name>.md` — one file per agent. */
  | 'agent-files'
  /** `<root>/<name>.md` — one file per slash command. */
  | 'command-files'
  /** `<root>/<name>/SKILL.md` plus optional `<root>/<name>/agents/*.md`. */
  | 'agent-skill-dirs'
  /** The tree is walked for `SKILL.md` files at any depth. */
  | 'github-tree';

const DEFAULT_EXCLUDES = [
  'node_modules',
  '.git',
  'dist',
  'build',
  '.venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.next',
  'coverage',
  '.turbo',
  'vendor',
];

/** Files that are never an entry even though they sit in a corpus directory. */
const NON_ENTRY_FILES = new Set([
  'README.md',
  'LICENSE',
  'LICENSE.txt',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'index.json',
  'package.json',
]);

function isExcluded(name: string, excludes: string[]): boolean {
  return DEFAULT_EXCLUDES.includes(name) || excludes.includes(name);
}

/** List immediate subdirectories of a directory. */
function listDirs(root: string): string[] {
  try {
    const items = readdirSync(root, { withFileTypes: true, encoding: 'utf8' });
    return items
      .filter((d) => d.isDirectory() && !d.isSymbolicLink())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

/** List immediate files of a directory, filtered by extension. */
function listFiles(root: string, exts: string[]): string[] {
  try {
    const items = readdirSync(root, { withFileTypes: true, encoding: 'utf8' });
    return items
      .filter((f) => f.isFile() && exts.includes(extname(f.name)))
      .map((f) => f.name)
      .sort();
  } catch {
    return [];
  }
}

/** Files belonging to a skill directory, relative to that directory. */
function bundleFor(dir: string, primary: string): string[] {
  const out: string[] = [];
  const walk = (current: string, depth: number) => {
    if (depth > 3) return;
    let items: Dirent[];
    try {
      items = readdirSync(current, { withFileTypes: true, encoding: 'utf8' });
    } catch {
      return;
    }
    for (const item of items) {
      if (item.isSymbolicLink()) continue;
      if (item.isDirectory()) {
        if (isExcluded(item.name, [])) continue;
        walk(join(current, item.name), depth + 1);
        continue;
      }
      const rel = join(current, item.name).slice(dir.length + 1);
      if (rel === primary) continue;
      out.push(rel);
    }
  };
  walk(dir, 0);
  return out.slice(0, 200);
}

/**
 * Build a registry entry from a file on disk.
 *
 * `kind` decides which frontmatter fields are meaningful; the rest are
 * normalised the same way regardless of kind.
 */
function entryFromFile(
  spec: SourceSpec,
  kind: EntryKind,
  file: string,
  dir: string | undefined,
): RegistryEntry | undefined {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  const { data, body } = parseFrontmatter(text);
  const stem = basename(file, extname(file));
  const declaredName = pickString(data, 'name');
  const name = declaredName ?? (kind === 'command' ? stem : stem);
  if (!name) return undefined;

  const description = deriveDescription(data, body);
  const tools = pickTools(data);
  const contentHash = hashFile(file) || hashText(text);

  const bundle = dir ? bundleFor(dir, basename(file)) : [];

  return {
    id: `${kind}:${spec.id}:${slugify(name)}`,
    kind,
    name,
    source: spec.id,
    description,
    path: file,
    dir,
    tools,
    frontmatter: data,
    contentHash,
    bundle,
    isCommand: kind === 'command',
  };
}

/**
 * Load every entry a source contributes.
 *
 * Returns an empty list rather than throwing when the root is missing: a
 * corpus that was uninstalled should leave a gap in the registry, not take
 * the server down.
 */
export function loadSource(spec: SourceSpec): RegistryEntry[] {
  const excludes = spec.exclude ?? [];
  const entries: RegistryEntry[] = [];
  const root = spec.root;

  if (!existsSync(root)) {
    return entries;
  }

  switch (spec.layout) {
    case 'skill-dirs': {
      for (const name of listDirs(root)) {
        if (isExcluded(name, excludes)) continue;
        const dir = join(root, name);
        const primary = join(dir, 'SKILL.md');
        if (!existsSync(primary)) continue;
        const entry = entryFromFile(spec, 'skill', primary, dir);
        if (entry) entries.push(entry);
      }
      break;
    }
    case 'skill-files': {
      for (const name of listFiles(root, ['.md'])) {
        if (NON_ENTRY_FILES.has(name)) continue;
        const entry = entryFromFile(spec, 'skill', join(root, name), undefined);
        if (entry) entries.push(entry);
      }
      break;
    }
    case 'agent-files': {
      for (const name of listFiles(root, ['.md'])) {
        if (NON_ENTRY_FILES.has(name)) continue;
        const entry = entryFromFile(spec, 'agent', join(root, name), undefined);
        if (entry) entries.push(entry);
      }
      break;
    }
    case 'command-files': {
      for (const name of listFiles(root, ['.md'])) {
        if (NON_ENTRY_FILES.has(name)) continue;
        const entry = entryFromFile(spec, 'command', join(root, name), undefined);
        if (entry) entries.push(entry);
      }
      break;
    }
    case 'agent-skill-dirs': {
      for (const name of listDirs(root)) {
        if (isExcluded(name, excludes)) continue;
        const dir = join(root, name);
        const primary = join(dir, 'SKILL.md');
        if (existsSync(primary)) {
          const entry = entryFromFile(spec, 'skill', primary, dir);
          if (entry) entries.push(entry);
        }
        // An agent-skill directory may also carry its own agents.
        const agentsDir = join(dir, 'agents');
        if (existsSync(agentsDir)) {
          for (const agentName of listFiles(agentsDir, ['.md'])) {
            if (NON_ENTRY_FILES.has(agentName)) continue;
            const entry = entryFromFile(
              spec,
              'agent',
              join(agentsDir, agentName),
              agentsDir,
            );
            if (entry) entries.push(entry);
          }
        }
      }
      break;
    }
    case 'github-tree': {
      entries.push(...loadGithubSource(spec));
      break;
    }
  }

  return entries;
}

/**
 * Load a source described by an index artifact rather than by directory walk.
 *
 * The Skills_n_Agents corpus ships a prebuilt `index.json` that carries the
 * provenance of every entry. Reading it is faster and more accurate than
 * re-walking 1000+ directories, so it is the preferred path when present.
 */
export function loadSourceFromIndex(
  spec: SourceSpec,
  indexPath: string,
): RegistryEntry[] | undefined {
  let raw: string;
  try {
    raw = readFileSync(indexPath, 'utf8');
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const doc = parsed as Record<string, unknown>;
  const skills = Array.isArray(doc.skills) ? doc.skills : [];
  const agents = Array.isArray(doc.agents) ? doc.agents : [];
  const entries: RegistryEntry[] = [];

  const push = (item: unknown, kind: EntryKind) => {
    if (!item || typeof item !== 'object') return;
    const rec = item as Record<string, unknown>;
    const name = typeof rec.name === 'string' ? rec.name : undefined;
    if (!name) return;
    const absPath = typeof rec.abs_path === 'string' ? rec.abs_path : undefined;
    const relPath = typeof rec.path === 'string' ? rec.path : undefined;
    const skillMd = typeof rec.skill_md === 'string' ? rec.skill_md : undefined;

    // `abs_path` in the index is not always absolute: it may be relative to
    // the corpus root. A path is resolved against the root first, and only
    // then treated as absolute.
    let file: string | undefined;
    if (absPath) {
      const candidate = absPath.startsWith('/')
        ? absPath
        : join(spec.root, absPath);
      if (existsSync(candidate)) {
        try {
          file = statSync(candidate).isDirectory()
            ? join(candidate, 'SKILL.md')
            : candidate;
        } catch {
          file = undefined;
        }
      }
    }
    if (!file && skillMd) {
      const candidate = skillMd.startsWith('/')
        ? skillMd
        : join(spec.root, skillMd);
      if (existsSync(candidate)) file = candidate;
    }
    if (!file && relPath) {
      const candidate = relPath.startsWith('/')
        ? relPath
        : join(spec.root, relPath);
      if (existsSync(candidate)) {
        try {
          file = statSync(candidate).isDirectory()
            ? join(candidate, 'SKILL.md')
            : candidate;
        } catch {
          file = undefined;
        }
      }
    }
    if (!file || !existsSync(file)) return;

    const provenance = rec.provenance;
    const frontmatter =
      provenance && typeof provenance === 'object'
        ? (provenance as Record<string, unknown>)
        : {};

    const rawTools = pickTools(frontmatter);
    const contentHash =
      typeof rec.digest === 'string' && rec.digest.length > 0
        ? rec.digest
        : hashFile(file);

    const bundleRaw = rec.bundle;
    let bundle: string[] = [];
    if (bundleRaw && typeof bundleRaw === 'object' && !Array.isArray(bundleRaw)) {
      const files = (bundleRaw as Record<string, unknown>).files;
      if (Array.isArray(files)) {
        bundle = files
          .map((f) =>
            f && typeof f === 'object'
              ? (f as Record<string, unknown>).path
              : undefined,
          )
          .filter((p): p is string => typeof p === 'string');
      }
    } else if (Array.isArray(bundleRaw)) {
      bundle = bundleRaw.filter((b): b is string => typeof b === 'string');
    }

    entries.push({
      id: `${kind}:${spec.id}:${slugify(name)}`,
      kind,
      name,
      source: spec.id,
      description:
        (typeof rec.desc === 'string' && rec.desc) ||
        deriveDescription(frontmatter, ''),
      path: file,
      dir: (() => {
        try {
          return statSync(file).isDirectory() ? file : undefined;
        } catch {
          return undefined;
        }
      })(),
      tools: rawTools,
      frontmatter,
      contentHash,
      bundle,
    });
  };

  for (const s of skills) push(s, 'skill');
  for (const a of agents) push(a, 'agent');

  return entries;
}

/**
 * Load a fetched GitHub repository.
 *
 * A repository has no fixed layout for its skills: they may sit at the top
 * level, under `skills/`, under `.claude/skills/`, or nested deeper. Rather
 * than guessing, this walks the tree and treats every directory containing a
 * `SKILL.md` as a skill. Files under `.git` and the usual build directories
 * are skipped.
 */
export function loadGithubSource(
  spec: SourceSpec,
  maxDepth = 5,
): RegistryEntry[] {
  const entries: RegistryEntry[] = [];

  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth) return;
    let items: string[];
    try {
      items = readdirSync(dir);
    } catch {
      return;
    }
    for (const item of items) {
      if (isExcluded(item, spec.exclude ?? [])) continue;
      const path = join(dir, item);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(path);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;

      const primary = join(path, 'SKILL.md');
      if (existsSync(primary)) {
        const entry = entryFromFile(spec, 'skill', primary, path);
        if (entry) entries.push(entry);
        // A skill directory is a leaf for this purpose: nested directories
        // are its supporting files, not separate skills.
        continue;
      }
      walk(path, depth + 1);
    }
  };

  walk(spec.root, 0);

  // A repository may also hold agents as flat `.md` files under `agents/`.
  const agentsDir = join(spec.root, 'agents');
  if (existsSync(agentsDir)) {
    for (const name of listFiles(agentsDir, ['.md'])) {
      if (NON_ENTRY_FILES.has(name)) continue;
      const entry = entryFromFile(
        spec,
        'agent',
        join(agentsDir, name),
        agentsDir,
      );
      if (entry) entries.push(entry);
    }
  }

  return entries;
}

/** Describe a source for the `list_sources` tool. */
export function describeSource(spec: SourceSpec): Source & { layout: CorpusLayout } {
  return {
    id: spec.id,
    label: spec.label,
    kind: spec.kind,
    root: spec.root,
    origin: spec.origin,
    readOnly: spec.kind === 'local',
    layout: spec.layout,
  };
}

/**
 * A stable fingerprint of a source's files.
 *
 * For directory corpora the recursive mtime is the useful signal: touching a
 * nested file bumps the containing directory's mtime on most filesystems, but
 * not reliably, so the entry count is folded in as well.
 */
export function fingerprintSource(spec: SourceSpec): { mtimeMs: number; size: number; count: number } {
  let mtimeMs = 0;
  let size = 0;
  let count = 0;
  const visit = (path: string, depth: number) => {
    if (depth > 6) return;
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(path);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      let items: string[];
      try {
        items = readdirSync(path);
      } catch {
        return;
      }
      for (const item of items) {
        if (isExcluded(item, spec.exclude ?? [])) continue;
        visit(join(path, item), depth + 1);
      }
      return;
    }
    count += 1;
    size += st.size;
    if (st.mtimeMs > mtimeMs) mtimeMs = st.mtimeMs;
  };
  visit(spec.root, 0);
  return { mtimeMs, size, count };
}

/** Normalised frontmatter key lookup used by the registry for provenance lookups. */
export function frontmatterValue(
  data: Record<string, unknown>,
  key: string,
): unknown {
  const wanted = normaliseKey(key);
  for (const [k, v] of Object.entries(data)) {
    if (normaliseKey(k) === wanted) return v;
  }
  return undefined;
}
