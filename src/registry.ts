import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  describeSource,
  fingerprintSource,
  loadSource,
  loadSourceFromIndex,
  type CorpusLayout,
  type SourceSpec,
} from './sources.js';
import { normaliseKey } from './frontmatter.js';
import type {
  EntryKind,
  RegistryEntry,
  SearchHit,
  Source,
  SourceError,
} from './types.js';

/**
 * The union registry.
 *
 * Sits over several corpora that overlap. The overlap is real: every ECC
 * skill name also exists in Skills_n_Agents, and 208 of the 271 are
 * byte-identical while 63 differ in content. Deduplication therefore keys on
 * **(name, content-hash)** — never on name alone, because the same name with
 * different content is a genuine second entry and the caller needs to see
 * both with their provenance.
 */

export interface SourceDefinition {
  id: string;
  label: string;
  root: string;
  origin: string;
  layout: CorpusLayout;
  /** Prefer a prebuilt index artifact at this path over walking the corpus. */
  indexPath?: string;
  exclude?: string[];
}

interface LoadedState {
  entries: RegistryEntry[];
  errors: SourceError[];
  sources: Source[];
  fingerprints: Map<string, string>;
  loadedAt: number;
}

const EMPTY_STATE: LoadedState = {
  entries: [],
  errors: [],
  sources: [],
  fingerprints: new Map(),
  loadedAt: 0,
};

/**
 * The registry keeps the last good state in service when a rebuild fails.
 *
 * A corpus that goes missing or a file that turns unreadable must not blank
 * the registry; the error is recorded and surfaced in the "not found"
 * message so the caller knows the entry may exist on disk.
 */
export class Registry {
  private definitions: SourceDefinition[];
  private state: LoadedState = EMPTY_STATE;
  private stateError: string | undefined;
  private builds = 0;

  constructor(definitions: SourceDefinition[]) {
    this.definitions = definitions;
  }

  /** Replace the set of sources. Used when a GitHub source is added. */
  setDefinitions(definitions: SourceDefinition[]): void {
    this.definitions = definitions;
    this.state = EMPTY_STATE;
  }

  getDefinitions(): SourceDefinition[] {
    return this.definitions;
  }

  /** Number of times the registry has been built. Diagnostic only. */
  get buildCount(): number {
    return this.builds;
  }

  /** The error from the last failed rebuild, if any. */
  get lastBuildError(): string | undefined {
    return this.stateError;
  }

  /**
   * Return the current registry, rebuilding if any source has changed.
   *
   * The fingerprint is recomputed on every call, so a file edited on disk is
   * picked up without restarting the server.
   */
  get(): LoadedState {
    const fingerprints = this.computeFingerprints();
    const unchanged =
      this.state.loadedAt > 0 && this.sameFingerprints(this.state.fingerprints, fingerprints);
    if (unchanged) {
      return this.state;
    }
    return this.rebuild(fingerprints);
  }

  /** Force a rebuild on the next read. */
  invalidate(): void {
    this.state = EMPTY_STATE;
  }

  private sameFingerprints(
    a: Map<string, string>,
    b: Map<string, string>,
  ): boolean {
    if (a.size !== b.size) return false;
    for (const [key, value] of a) {
      if (b.get(key) !== value) return false;
    }
    return true;
  }

  private computeFingerprints(): Map<string, string> {
    const out = new Map<string, string>();
    for (const def of this.definitions) {
      const defs = this.toSpec(def);
      if (def.indexPath && existsSync(def.indexPath)) {
        try {
          const st = statSync(def.indexPath);
          out.set(def.id, `index:${st.mtimeMs}:${st.size}`);
          continue;
        } catch {
          // fall through to the directory walk
        }
      }
      const fp = fingerprintSource(defs);
      out.set(def.id, `dir:${fp.mtimeMs}:${fp.size}:${fp.count}`);
    }
    return out;
  }

  private toSpec(def: SourceDefinition): SourceSpec {
    return {
      id: def.id,
      label: def.label,
      root: def.root,
      origin: def.origin,
      kind: def.origin.startsWith('github:') ? 'github' : 'local',
      layout: def.layout,
      exclude: def.exclude,
    };
  }

  private rebuild(fingerprints: Map<string, string>): LoadedState {
    const entries: RegistryEntry[] = [];
    const errors: SourceError[] = [];
    const sources: Source[] = [];

    for (const def of this.definitions) {
      const spec = this.toSpec(def);
      sources.push(describeSource(spec));
      // A source whose root has disappeared is a failure, not an empty
      // corpus. The distinction matters: an empty corpus is legitimate, but
      // a vanished directory usually means a mount went away or a path was
      // mistyped, and silently serving nothing hides that.
      if (!existsSync(spec.root)) {
        errors.push({
          source: def.id,
          message: `source root does not exist: ${spec.root}`,
        });
        continue;
      }
      try {
        let loaded: RegistryEntry[] | undefined;
        if (def.indexPath && existsSync(def.indexPath)) {
          loaded = loadSourceFromIndex(spec, def.indexPath);
          if (loaded === undefined) {
            errors.push({
              source: def.id,
              message: `index at ${def.indexPath} could not be read; fell back to directory walk`,
            });
          }
        }
        if (!loaded) {
          loaded = loadSource(spec);
        }
        entries.push(...loaded);
      } catch (err) {
        errors.push({
          source: def.id,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const deduped = dedupeEntries(entries);

    // A source that failed to load keeps serving its last known entries.
    // Only that source's entries are held over — the others are rebuilt
    // normally, so one broken corpus does not freeze the whole registry.
    const failedSources = new Set(errors.map((e) => e.source));
    if (failedSources.size > 0 && this.state.entries.length > 0) {
      const held = this.state.entries.filter((e) => failedSources.has(e.source));
      if (held.length > 0) {
        const rebuiltIds = new Set(deduped.map((e) => e.id));
        for (const entry of held) {
          if (!rebuiltIds.has(entry.id)) {
            deduped.push(entry);
          }
        }
        deduped.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      }
    }

    this.stateError =
      errors.length > 0
        ? errors.map((e) => `${e.source}: ${e.message}`).join('; ')
        : undefined;
    this.builds += 1;
    this.state = {
      entries: deduped,
      errors,
      sources,
      fingerprints,
      loadedAt: Date.now(),
    };
    return this.state;
  }

  /** All entries. */
  all(): RegistryEntry[] {
    return this.get().entries;
  }

  /** Entries of one kind. */
  byKind(kind: EntryKind): RegistryEntry[] {
    return this.all().filter((e) => e.kind === kind);
  }

  /** Find one entry by id, or by a bare name. */
  find(idOrName: string): RegistryEntry | undefined {
    const entries = this.all();
    const exact = entries.find((e) => e.id === idOrName);
    if (exact) return exact;
    const normalised = normaliseKey(idOrName);
    const byNormalisedId = entries.find((e) => normaliseKey(e.id) === normalised);
    if (byNormalisedId) return byNormalisedId;
    const byName = entries.filter((e) => normaliseKey(e.name) === normalised);
    return byName.length > 0 ? byName[0] : undefined;
  }

  /** All entries sharing a name, across sources. */
  findAllByName(name: string): RegistryEntry[] {
    const normalised = normaliseKey(name);
    return this.all().filter((e) => normaliseKey(e.name) === normalised);
  }

  /** The most recent state, for the tool surface. */
  snapshot() {
    return this.get();
  }
}

/**
 * Remove exact duplicates while preserving genuinely distinct variants.
 *
 * Two entries collapse only when both their name and their content hash
 * match. The survivor is the one whose source sorts first, which makes the
 * choice deterministic across rebuilds.
 *
 * A collapsed entry is not lost: its source is recorded as an alias of the
 * survivor, so a corpus that holds only byte-identical copies still shows
 * up in the source report rather than reading as empty.
 */
export function dedupeEntries(entries: RegistryEntry[]): RegistryEntry[] {
  const seen = new Map<string, RegistryEntry>();
  const out: RegistryEntry[] = [];
  for (const entry of entries) {
    const key = `${normaliseKey(entry.name)}::${entry.contentHash}`;
    const existing = seen.get(key);
    if (existing) {
      // The duplicate is a different file in a different corpus. Record
      // where it came from, so the survivor can name its other sources.
      const aliases = existing.aliases ?? (existing.aliases = []);
      if (!aliases.includes(entry.source)) aliases.push(entry.source);
      continue;
    }
    seen.set(key, entry);
    out.push(entry);
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

/**
 * How many entries each source contributed, including the ones that were
 * collapsed into another source's entry as byte-identical duplicates.
 *
 * Without this, a corpus whose skills all exist verbatim in another corpus
 * reports zero entries and looks empty, which hides the fact that it was
 * read at all.
 */
export function sourceCounts(entries: RegistryEntry[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    counts.set(entry.source, (counts.get(entry.source) ?? 0) + 1);
    for (const alias of entry.aliases ?? []) {
      counts.set(alias, (counts.get(alias) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * BM25 over the union index.
 *
 * The corpus is small enough that a full scan per query is fine; the ranking
 * quality is what matters here, and BM25 handles the case where a query term
 * appears in one entry's name and in every entry's description.
 */

const K1 = 1.5;
const B = 0.75;

interface IndexedEntry {
  entry: RegistryEntry;
  nameTokens: string[];
  descTokens: string[];
  sourceTokens: string[];
  allTokens: string[];
  length: number;
}

export interface SearchOptions {
  query: string;
  /** Restrict to these source ids. Empty means every source. */
  sources?: string[];
  /** Restrict to these kinds. Empty means every kind. */
  kinds?: EntryKind[];
  /** Maximum hits. */
  limit?: number;
}

export function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

export function buildSearchIndex(entries: RegistryEntry[]): IndexedEntry[] {
  return entries.map((entry) => {
    const nameTokens = tokenise(entry.name);
    const descTokens = tokenise(entry.description);
    const sourceTokens = tokenise(entry.source);
    const allTokens = [...nameTokens, ...descTokens, ...sourceTokens];
    return {
      entry,
      nameTokens,
      descTokens,
      sourceTokens,
      allTokens,
      length: allTokens.length,
    };
  });
}

/**
 * Search the index.
 *
 * Field weighting favours name matches over description matches, so
 * searching "pdf" ranks the skill named "pdf" above a skill whose description
 * merely mentions PDFs.
 */
export function search(
  entries: RegistryEntry[],
  options: SearchOptions,
): SearchHit[] {
  const queryTokens = tokenise(options.query);
  if (queryTokens.length === 0) {
    return [];
  }

  let candidates = entries;
  if (options.sources && options.sources.length > 0) {
    const wanted = new Set(options.sources);
    candidates = candidates.filter((e) => wanted.has(e.source));
  }
  if (options.kinds && options.kinds.length > 0) {
    const wanted = new Set(options.kinds);
    candidates = candidates.filter((e) => wanted.has(e.kind));
  }
  if (candidates.length === 0) {
    return [];
  }

  const index = buildSearchIndex(candidates);
  const avgLength =
    index.reduce((sum, doc) => sum + doc.length, 0) / Math.max(index.length, 1);

  const docFreq = new Map<string, number>();
  for (const doc of index) {
    for (const token of new Set(doc.allTokens)) {
      docFreq.set(token, (docFreq.get(token) ?? 0) + 1);
    }
  }

  const N = index.length;
  const hits: SearchHit[] = [];

  for (const doc of index) {
    const counts = new Map<string, number>();
    for (const token of doc.allTokens) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }

    let score = 0;
    const matched = new Set<string>();
    for (const term of queryTokens) {
      const df = docFreq.get(term) ?? 0;
      if (df === 0) continue;
      const tf = counts.get(term) ?? 0;
      if (tf === 0) continue;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      const denom = tf + K1 * (1 - B + (B * doc.length) / Math.max(avgLength, 1));
      let contribution = idf * ((tf * (K1 + 1)) / denom);
      if (doc.nameTokens.includes(term)) contribution *= 2.5;
      else if (doc.descTokens.includes(term)) contribution *= 1.0;
      else if (doc.sourceTokens.includes(term)) contribution *= 0.4;
      score += contribution;
      matched.add(term);
    }
    if (score > 0) {
      hits.push({ entry: doc.entry, score, matched: [...matched] });
    }
  }

  hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0;
  });

  return hits.slice(0, options.limit ?? 20);
}

/**
 * The default corpus set, resolved from environment variables.
 *
 * Paths are runtime configuration, never build artifacts: the published
 * package must not carry absolute paths to any machine.
 */
export function defaultSources(): SourceDefinition[] {
  const sources: SourceDefinition[] = [];
  const snaRoot = process.env.TOOLSHED_SNA_ROOT ??
    join(process.env.HOME ?? '', 'Projects', 'Skills_n_Agents');
  if (existsSync(snaRoot)) {
    sources.push({
      id: 'sna',
      label: 'Skills_n_Agents',
      root: snaRoot,
      origin: 'local',
      layout: 'skill-dirs',
      indexPath: join(snaRoot, 'mcp', 'data', 'index.json'),
    });
  }

  const eccRoot = process.env.TOOLSHED_ECC_ROOT ??
    join(process.env.HOME ?? '', 'Projects', 'ECC');
  if (existsSync(eccRoot)) {
    const agentsRoot = join(eccRoot, '.agents');
    if (existsSync(agentsRoot)) {
      sources.push({
        id: 'ecc-agent-skill',
        label: 'ECC .agents/skills',
        root: join(agentsRoot, 'skills'),
        origin: 'local',
        layout: 'agent-skill-dirs',
      });
    }
    if (existsSync(join(eccRoot, 'agents'))) {
      sources.push({
        id: 'ecc-agent',
        label: 'ECC agents',
        root: join(eccRoot, 'agents'),
        origin: 'local',
        layout: 'agent-files',
      });
    }
    if (existsSync(join(eccRoot, 'commands'))) {
      sources.push({
        id: 'ecc-command',
        label: 'ECC commands',
        root: join(eccRoot, 'commands'),
        origin: 'local',
        layout: 'command-files',
      });
    }
    if (existsSync(join(eccRoot, 'skills'))) {
      sources.push({
        id: 'ecc-skill',
        label: 'ECC skills',
        root: join(eccRoot, 'skills'),
        origin: 'local',
        layout: 'skill-dirs',
      });
    }
  }

  const exactRoot = process.env.TOOLSHED_EXACT_ROOT ??
    join(process.env.HOME ?? '', 'Projects', 'exact');
  if (existsSync(exactRoot)) {
    const claudeSkills = join(exactRoot, '.claude', 'skills');
    if (existsSync(claudeSkills)) {
      sources.push({
        id: 'exact-claude',
        label: 'exact .claude/skills',
        root: claudeSkills,
        origin: 'local',
        layout: 'skill-dirs',
      });
    }
    if (existsSync(join(exactRoot, 'skills'))) {
      sources.push({
        id: 'exact-local',
        label: 'exact skills',
        root: join(exactRoot, 'skills'),
        origin: 'local',
        layout: 'skill-dirs',
      });
    }
  }

  // A user-supplied list of extra sources, as JSON.
  const extra = process.env.TOOLSHED_SOURCES;
  if (extra) {
    try {
      const parsed = JSON.parse(extra) as SourceDefinition[];
      if (Array.isArray(parsed)) {
        sources.push(...parsed);
      }
    } catch {
      // A malformed override must not stop the server from starting.
    }
  }

  // Sources registered through `add_github_source`. The registration is
  // persisted so a GitHub source survives a restart of the server; without
  // this, a registered source would vanish with the process.
  sources.push(...registeredSources());

  return sources;
}

/**
 * Read the persisted source registry.
 *
 * The file holds paths and labels, not content: it records *where* a
 * registered corpus lives so the server can find it again.
 */
export function registeredSources(): SourceDefinition[] {
  const home =
    process.env.TOOLSHED_HOME ??
    join(process.env.HOME ?? '', '.toolshed');
  const path = join(home, 'sources.json');
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as { sources?: SourceDefinition[] };
    if (!Array.isArray(parsed.sources)) return [];
    return parsed.sources.filter(
      (s) =>
        s &&
        typeof s.id === 'string' &&
        typeof s.root === 'string' &&
        typeof s.layout === 'string',
    );
  } catch {
    return [];
  }
}
