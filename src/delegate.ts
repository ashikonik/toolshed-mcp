import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * The delegation seam to `skills-library`.
 *
 * The rule the toolshed follows: **it fetches, `skills-library` decides and
 * writes.**
 *
 * The seam is real and it is narrow. `skills-library`'s `install_skills`
 * handler resolves an id against *its own* index and installs from
 * `libraryRoot`. A skill that was fetched from GitHub is in no local corpus,
 * so it cannot be installed until it is indexed into a corpus that
 * `skills-library` can see. That index path is fixed:
 * `<libraryRoot>/mcp/data/index.json`.
 *
 * Two ways to bridge it exist:
 *
 *   (a) Write the fetched skill into a merged corpus root and rewrite that
 *       root's `mcp/data/index.json` so it lists the new entries.
 *   (b) Teach `skills-library` to accept an explicit absolute path.
 *
 * This module implements (a). The reason is that (b) means changing the
 * install path of a server that is already registered in four harnesses,
 * where a mistake breaks installs for everyone. (a) touches only files the
 * toolshed owns, and `skills-library` keeps full ownership of the policy
 * layer — the path whitelist, the tier rules, the dry-run rule — because the
 * toolshed still hands the install to `skills-library` and never writes into
 * a harness directory itself.
 */

export interface SkillIndexRecord {
  id: string;
  kind?: string;
  name: string;
  title?: string;
  desc: string;
  desc_source?: string;
  tokens?:
    | number
    | {
        desc?: string[];
        name?: string[];
        total?: number;
      };
  frontmatter: Record<string, unknown>;
  provenance: Record<string, unknown>;
  bundle?:
    | string[]
    | {
        file_count?: number;
        files?: { path: string; bytes: number; digest: string }[];
        refs?: unknown[];
        refs_dangling?: unknown[];
        refs_resolved?: unknown[];
        refs_total?: number;
        total_bytes?: number;
      };
  skills?: Record<string, unknown>;
  abs_path?: string;
  /** Relative to the corpus root. */
  path?: string;
  /** Relative to the corpus root; skills-library joins it with the root. */
  skill_md?: string;
  tier?: number;
  domain?: string;
  copies?: number;
  locale_only?: boolean;
  rescued_from_tmp?: boolean;
  source?: string;
  digest?: string;
}

export interface SkillsLibraryIndex {
  schema_version: number;
  generated_at?: string;
  skills: SkillIndexRecord[];
  agents?: SkillIndexRecord[];
  held_aside?: unknown[];
  /**
   * skills-library reads further top-level fields at startup (`packs`,
   * `domains`, `search`) and throws on the first one that is missing, so
   * the document is carried whole. These are declared for the ones the
   * toolshed itself reads or asserts on; any other field survives the
   * round-trip through the index type.
   */
  packs?: unknown[];
  domains?: string[];
  /** Required by skills-library's startup path. */
  counts?: {
    skills: number;
    agents: number;
    by_tier?: Record<string, number>;
    skill_by_tier?: Record<string, number>;
    held_aside?: number;
  };
}

/** Where the merged corpus root lives. */
export function corpusRoot(): string {
  return (
    process.env.TOOLSHED_CORPUS_ROOT ??
    join(process.env.HOME ?? homedir(), '.toolshed', 'corpora')
  );
}

/** The index path inside a corpus root. Fixed, because skills-library reads it. */
export function indexPath(root: string): string {
  return join(root, 'mcp', 'data', 'index.json');
}

/**
 * Read an existing index, tolerating absence and malformed content.
 *
 * A missing index is normal for a fresh corpus root. The whole document is
 * preserved, because skills-library reads top-level fields beyond
 * `skills` and `agents`.
 */
export function readIndex(root: string): SkillsLibraryIndex {
  let raw: string;
  try {
    raw = readFileSync(indexPath(root), 'utf8');
  } catch {
    return { schema_version: 1, skills: [] };
  }
  try {
    const parsed = JSON.parse(raw) as SkillsLibraryIndex;
    if (!parsed || typeof parsed !== 'object') {
      return { schema_version: 1, skills: [] };
    }
    if (!Array.isArray(parsed.skills)) parsed.skills = [];
    return parsed;
  } catch {
    return { schema_version: 1, skills: [] };
  }
}

/** Write an index back, creating the directory if needed. */
export function writeIndex(root: string, index: SkillsLibraryIndex): void {
  const path = indexPath(root);
  mkdirSync(join(root, 'mcp', 'data'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
}

/**
 * Read the skills-library index from a corpus root.
 *
 * The whole document is returned, not a reduced subset. skills-library's
 * startup path reads several top-level fields (`counts`, `packs`, `domains`,
 * `search`) and will throw on the first one that is missing, so an index
 * that carries only `skills` and `agents` makes the server exit before it
 * can be asked to do anything.
 */
export function readLibraryIndex(root: string): SkillsLibraryIndex | undefined {
  let raw: string;
  try {
    raw = readFileSync(indexPath(root), 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as SkillsLibraryIndex;
    if (!parsed || typeof parsed !== 'object') return undefined;
    if (!Array.isArray(parsed.skills)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * Merge new skill records into an index.
 *
 * The base index is preserved whole — every top-level field survives — and
 * only the skill list changes. An entry with the same id replaces the old
 * one, so re-fetching a skill updates it rather than duplicating it.
 */
export function mergeSkills(
  index: SkillsLibraryIndex,
  incoming: SkillIndexRecord[],
): { index: SkillsLibraryIndex; added: number; replaced: number } {
  const byId = new Map(index.skills.map((s) => [s.id, s]));
  let added = 0;
  let replaced = 0;
  for (const record of incoming) {
    if (byId.has(record.id)) {
      replaced += 1;
    } else {
      added += 1;
    }
    byId.set(record.id, record);
  }
  const skills = [...byId.values()];
  const merged: SkillsLibraryIndex = {
    ...index,
    generated_at: new Date().toISOString(),
    skills,
  };
  // The counts must follow the skills, or skills-library reports a count
  // that does not match what it can install.
  const byTier: Record<string, number> = {};
  const skillByTier: Record<string, number> = {};
  for (const skill of skills) {
    const tier = String(
      skill.tier ?? (skill.frontmatter as { tier?: unknown }).tier ?? 3,
    );
    byTier[tier] = (byTier[tier] ?? 0) + 1;
    skillByTier[tier] = (skillByTier[tier] ?? 0) + 1;
  }
  const base = (index.counts ?? {}) as Record<string, unknown>;
  merged.counts = {
    ...base,
    skills: skills.length,
    agents: index.agents?.length ?? 0,
    by_tier: byTier,
    skill_by_tier: skillByTier,
    held_aside: index.held_aside?.length ?? 0,
  } as SkillsLibraryIndex['counts'];
  return {
    index: merged,
    added,
    replaced,
  };
}

/** The skills-library server entry point, as registered in the harnesses. */
export function skillsLibraryEntry(): { command: string; args: string[] } | undefined {
  const candidates = [
    join(
      process.env.HOME ?? homedir(),
      'Projects',
      'Skills_n_Agents',
      'mcp',
      'dist',
      'index.js',
    ),
    join(
      process.env.HOME ?? homedir(),
      'Projects',
      'skills-library-mcp-public',
      'mcp',
      'dist',
      'index.js',
    ),
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) return undefined;
  return { command: process.execPath, args: [found] };
}

/**
 * The root skills-library reads its index from.
 *
 * This is the same override skills-library itself honours, so the toolshed
 * points it at a merged root rather than at its own corpus.
 */
export function libraryRoot(): string {
  return (
    process.env.SKILLS_LIBRARY_ROOT ??
    join(
      process.env.HOME ?? homedir(),
      'Projects',
      'Skills_n_Agents',
    )
  );
}

/**
 * A minimal MCP stdio client, used only to call `skills-library`.
 *
 * This is the one place the toolshed talks to another MCP server, and it does
 * so over the same stdio protocol any harness would use — not by importing
 * its code. If the server is not present, the caller degrades to a clear
 * message rather than failing silently.
 */
export class SkillsLibraryClient {
  private child: ReturnType<typeof spawn> | undefined;
  private buffer = '';
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private nextId = 1;

  /**
   * @param root the corpus root skills-library should read. When omitted,
   *   skills-library uses its own default.
   * @param timeoutMs how long to wait for a response.
   */
  constructor(
    private root?: string,
    private timeoutMs = 60_000,
  ) {}

  async connect(): Promise<void> {
    const entry = skillsLibraryEntry();
    if (!entry) {
      throw new Error(
        'skills-library server not found on this machine; expected it under Skills_n_Agents/mcp/dist/index.js',
      );
    }
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (this.root) {
      env.SKILLS_LIBRARY_ROOT = this.root;
    }
    this.child = spawn(entry.command, entry.args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    this.child.stdout?.setEncoding('utf8');
    this.child.stdout?.on('data', (chunk: string) => this.onData(chunk));
    this.child.stderr?.setEncoding('utf8');
    this.child.stderr?.on('data', () => {
      // stderr is progress output; it is not part of the protocol.
    });
    this.child.on('exit', () => {
      for (const [, call] of this.pending) {
        clearTimeout(call.timer);
        call.reject(new Error('skills-library connection closed'));
      }
      this.pending.clear();
    });

    await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'toolshed-mcp', version: '0.1.0' },
    });
    this.notify('notifications/initialized', {});
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf('\n');
    while (index !== -1) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line.length > 0) this.dispatch(line);
      index = this.buffer.indexOf('\n');
    }
  }

  private dispatch(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const id = message.id;
    if (typeof id !== 'number') return;
    const call = this.pending.get(id);
    if (!call) return;
    this.pending.delete(id);
    clearTimeout(call.timer);
    if (message.error) {
      const err = message.error as { message?: string };
      call.reject(new Error(err.message ?? 'skills-library error'));
      return;
    }
    call.resolve(message.result);
  }

  async request(method: string, params: unknown): Promise<unknown> {
    if (!this.child?.stdin) throw new Error('skills-library is not connected');
    const id = this.nextId;
    this.nextId += 1;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`skills-library call '${method}' timed out`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`,
      'utf8',
    );
    return promise;
  }

  notify(method: string, params: unknown): void {
    this.child?.stdin?.write(
      `${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`,
      'utf8',
    );
  }

  /** Call a tool and return its content blocks. */
  async callTool(name: string, args: unknown): Promise<{ content: unknown; isError: boolean }> {
    const result = (await this.request('tools/call', {
      name,
      arguments: args,
    })) as { content?: unknown; isError?: boolean } | undefined;
    return {
      content: result?.content ?? [],
      isError: result?.isError === true,
    };
  }

  async close(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (!child || child.exitCode !== null) return;
    try {
      if (child.pid) process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
  }
}
