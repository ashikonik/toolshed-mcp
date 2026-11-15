/**
 * Shared types for the toolshed registry.
 *
 * The registry is a union over several corpora that disagree on naming,
 * frontmatter shape and file layout. Everything here normalises those
 * disagreements into one vocabulary so the rest of the server never has to
 * ask "which corpus did this come from" except for provenance.
 */

export type EntryKind = 'skill' | 'agent' | 'command';

export type SourceId = string;

/** A single indexed entry: a skill, an agent or a slash command. */
export interface RegistryEntry {
  /** Canonical id: `<kind>:<sourceId>:<name>`. Stable across rebuilds. */
  id: string;
  kind: EntryKind;
  /** Entry name as declared in frontmatter, or the filename stem as fallback. */
  name: string;
  /** Source corpus this entry came from. */
  source: SourceId;
  /** Short description, first sentence of the body when absent. */
  description: string;
  /** Absolute path to the entry's primary file (SKILL.md, agent.md, command.md). */
  path: string;
  /** Absolute path to the directory holding the entry, when it has one. */
  dir?: string;
  /** Normalised tool allow-list. Empty means "not declared". */
  tools: string[];
  /** Raw frontmatter, retained for fidelity. */
  frontmatter: Record<string, unknown>;
  /** SHA-256 of the entry's primary file, hex. Dedupe key component. */
  contentHash: string;
  /** Extra files that belong to the entry, relative to `dir`. */
  bundle: string[];
  /**
   * Other sources that hold a byte-identical copy of this entry.
   *
   * Dedupe keeps one copy, so without this the second corpus would look
   * empty. The list is populated at dedupe time.
   */
  aliases?: SourceId[];
  /** True when the entry is a command rather than a skill/agent. */
  isCommand?: boolean;
}

/** A registered corpus. */
export interface Source {
  id: SourceId;
  /** Human-readable label. */
  label: string;
  kind: 'local' | 'github';
  /** Root directory for the corpus. */
  root: string;
  /** Where the corpus was configured from. */
  origin: string;
  /** Whether the corpus is read-only (all local corpora are). */
  readOnly: boolean;
}

/** A source that failed to load. Kept separate so one bad corpus cannot blank the registry. */
export interface SourceError {
  source: SourceId;
  message: string;
}

/** The fingerprint used to detect that a source's underlying files changed. */
export interface Fingerprint {
  mtimeMs: number;
  size: number;
  /** Extra discriminator for directory sources, where mtime of the root is not enough. */
  count?: number;
}

/** Search hit. */
export interface SearchHit {
  entry: RegistryEntry;
  score: number;
  /** Which fields matched the query. */
  matched: string[];
}

/** An external MCP server the user has configured for proxying. */
export interface ProxyTarget {
  /** Key in the toolshed proxy config. */
  name: string;
  /** Command to spawn. */
  command: string;
  args: string[];
  /** Optional environment overrides. */
  env?: Record<string, string>;
  /** Working directory. */
  cwd?: string;
  /** Milliseconds before the spawn is killed. */
  timeoutMs?: number;
}

/** Result of a tool handler. Always resolves; never throws. */
export interface ToolOutcome {
  text: string;
  isError?: boolean;
  /** Structured payload attached alongside the text. */
  data?: unknown;
}
