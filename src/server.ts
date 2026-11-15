import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readdirSync, readFileSync, statSync, existsSync, mkdirSync, writeFileSync, renameSync, cpSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { homedir } from 'node:os';

import { asError, asText, guard } from './results.js';
import { Registry, defaultSources, search, sourceCounts, type SourceDefinition } from './registry.js';
import { describeSource, loadGithubSource, loadSource } from './sources.js';
import { inventoryMcpServers, summariseServers } from './mcp-servers.js';
import { missingBuiltinReport, probeAgentTypes } from './agent-types.js';
import {
  fetchRepoSparseFirst,
  fetchSkill,
  isSafeRelativePath,
  isValidSkillName,
  parseRepo,
  redactToken,
  repoCacheDir,
} from './github.js';
import {
  SkillsLibraryClient,
  corpusRoot,
  indexPath,
  libraryRoot,
  mergeSkills,
  readIndex,
  readLibraryIndex,
  writeIndex,
  type SkillIndexRecord,
} from './delegate.js';
import { ProxyPool, defaultProxyConfigPath, loadProxyTargets } from './proxy.js';
import { deriveDescription, hashFile, normaliseTools, parseFrontmatter, pick, pickString } from './frontmatter.js';
import type { EntryKind, RegistryEntry } from './types.js';

/**
 * The tool surface.
 *
 * The tool list is asserted against the registered tool names in the test
 * suite, so adding a tool without listing it here fails the suite.
 */

export const TOOLS = [
  'search_registry',
  'get_entry',
  'get_entry_bundle',
  'list_sources',
  'list_mcp_servers',
  'list_agent_types',
  'add_github_source',
  'install_skill_from_github',
  'proxy_call',
  'proxy_discover',
] as const;

export type ToolName = (typeof TOOLS)[number];

export interface Deps {
  registry: Registry;
  pool: ProxyPool;
  /** Where GitHub repos are cached. */
  cacheRoot: string;
  /** Where the proxy target config lives. */
  proxyConfigPath: string;
  /** Where fetched corpora are staged for skills-library. */
  corpusRoot: string;
}

/** The kind of entry a tool call refers to. */
const KIND_ENUM = z.enum(['skill', 'agent', 'command']);

/**
 * Format an entry as a readable block.
 *
 * Provenance is always shown: when two corpora carry the same skill name,
 * the source is what tells the caller which one they are looking at.
 */
function formatEntry(entry: RegistryEntry, body?: string): string {
  const lines: string[] = [];
  lines.push(`# ${entry.name}`);
  lines.push(`kind: ${entry.kind}`);
  lines.push(`source: ${entry.source}`);
  if (entry.aliases && entry.aliases.length > 0) {
    // Another corpus holds a byte-identical copy. Dedupe keeps one entry,
    // so this is the only place the second corpus is named.
    lines.push(`also-in: ${entry.aliases.join(', ')}`);
  }
  lines.push(`id: ${entry.id}`);
  lines.push(`path: ${entry.path}`);
  if (entry.contentHash) {
    lines.push(`digest: ${entry.contentHash.slice(0, 16)}`);
  }
  if (entry.description) {
    lines.push(`description: ${entry.description}`);
  }
  if (entry.tools.length > 0) {
    lines.push(`tools: ${entry.tools.join(', ')}`);
  }
  if (body) {
    lines.push('');
    lines.push(body.trimEnd());
  }
  return lines.join('\n');
}

/** Read the body of an entry, with its frontmatter stripped. */
function readBody(entry: RegistryEntry): string {
  try {
    const text = readFileSync(entry.path, 'utf8');
    return parseFrontmatter(text).body;
  } catch (err) {
    return `(body could not be read: ${err instanceof Error ? err.message : String(err)})`;
  }
}

/** Build the tool definitions. */
function toolDefinitions() {
  return {
    search_registry: {
      title: 'Search the registry',
      description:
        'Search skills, agents and commands across every corpus registered on this machine. ' +
        'Returns ranked hits with the source each came from. ' +
        'Not covered by search_library, which searches one corpus only.',
      inputSchema: {
        query: z.string().describe('Free-text query.'),
        sources: z
          .array(z.string())
          .optional()
          .describe('Restrict to these source ids. Every source when omitted.'),
        kinds: z
          .array(KIND_ENUM)
          .optional()
          .describe('Restrict to these entry kinds. Every kind when omitted.'),
        limit: z.number().int().min(1).max(100).optional().describe('Maximum hits.'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    get_entry: {
      title: 'Read one entry',
      description:
        'Read one skill, agent or command by id or name, including its frontmatter and body. ' +
        'Not covered by get_entry_bundle, which also returns supporting files.',
      inputSchema: {
        id: z.string().describe('Entry id or name.'),
        source: z
          .string()
          .optional()
          .describe('Restrict to one source id when the name is ambiguous.'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    get_entry_bundle: {
      title: 'Read an entry and its supporting files',
      description:
        'Read one entry together with the files that belong to it, such as reference ' +
        'documents or scripts. ' +
        'Not covered by get_entry, which returns only the entry itself.',
      inputSchema: {
        id: z.string().describe('Entry id or name.'),
        max_files: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe('Maximum supporting files to include.'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    list_sources: {
      title: 'List registry sources',
      description:
        'List every corpus registered on this machine with its kind, root and entry count. ' +
        'Counts are read at the time of the call. ' +
        'Not covered by list_mcp_servers, which lists MCP servers rather than corpora.',
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    list_mcp_servers: {
      title: 'List MCP servers',
      description:
        'List MCP servers registered in the harness configs on this machine, distinguishing ' +
        'those whose executable is present from those that are configured only. ' +
        'Not covered by list_sources, which lists corpora of skills and agents.',
      inputSchema: {
        installed_only: z
          .boolean()
          .optional()
          .describe('Report only servers whose command resolves on this machine.'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    list_agent_types: {
      title: 'List available agent types',
      description:
        'Report which agent types each harness on this machine can actually spawn, and name any ' +
        'built-in types that are missing. ' +
        'Not covered by list_mcp_servers, which lists server registrations rather than agent types.',
      inputSchema: {
        harness: z
          .string()
          .optional()
          .describe('Restrict the report to one harness id.'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    add_github_source: {
      title: 'Register a GitHub repository as a source',
      description:
        'Fetch a GitHub repository, index its skills and agents, and register it as a registry ' +
        'source so its entries become searchable. ' +
        'Not covered by install_skill_from_github, which installs a single skill into a harness.',
      inputSchema: {
        repo: z
          .string()
          .describe('owner/repo, owner/repo@ref, or a github.com URL.'),
        label: z.string().optional().describe('Display name for the source.'),
        apply: z
          .boolean()
          .optional()
          .describe('When false, the fetch is described but nothing is written.'),
        ref: z.string().optional().describe('Branch, tag or commit to fetch.'),
        timeout_ms: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('How long the fetch may take, in milliseconds.'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    install_skill_from_github: {
      title: 'Install a skill from GitHub',
      description:
        'Fetch one skill from a GitHub repository and install it into a coding harness, with the ' +
        'install performed by the skills-library server so its path and tier policy applies. ' +
        'Not covered by add_github_source, which registers a whole repository as a source.',
      inputSchema: {
        repo: z.string().describe('owner/repo, owner/repo@ref, or a github.com URL.'),
        path: z.string().describe('Path to the skill within the repository.'),
        harness: z
          .enum(['claude-code', 'puku-cli', 'opencode', 'agentsmd'])
          .describe('Harness to install into.'),
        mode: z.enum(['symlink', 'copy']).optional().describe('How the entry is installed.'),
        apply: z
          .boolean()
          .optional()
          .describe('When false, the install is described but nothing is written.'),
        ref: z.string().optional().describe('Branch, tag or commit to fetch.'),
        timeout_ms: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('How long the fetch may take, in milliseconds.'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    proxy_call: {
      title: 'Call a tool on a proxied MCP server',
      description:
        'Invoke a tool on an external MCP server that this server proxies, addressed as ' +
        'server__tool. ' +
        'Not covered by proxy_discover, which lists the tools without calling them.',
      inputSchema: {
        tool: z.string().describe('Tool name in server__tool form.'),
        arguments: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Arguments for the call.'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    proxy_discover: {
      title: 'List the tools of a proxied MCP server',
      description:
        'List the tools exposed by an external MCP server that this server proxies, or list ' +
        'the proxied servers themselves when no server is named. ' +
        'Not covered by proxy_call, which invokes a tool rather than listing them.',
      inputSchema: {
        server: z
          .string()
          .optional()
          .describe('Server name. Every proxied server when omitted.'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
  };
}

/**
 * Turn a source definition into a source record plus its loaded entries.
 *
 * Used by `add_github_source` to preview what a registration would contain.
 */
function describeEntries(entries: RegistryEntry[]) {
  return entries.map((e) => ({
    id: e.id,
    kind: e.kind,
    name: e.name,
    description: e.description,
    path: e.path,
  }));
}

/**
 * Read the GitHub registry of sources the toolshed has registered.
 *
 * Registration is persisted so that the sources survive a restart of the
 * server. The file holds paths, not content.
 */
function readSourceRegistry(path: string): SourceDefinition[] {
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as { sources?: SourceDefinition[] };
    if (Array.isArray(parsed.sources)) return parsed.sources;
  } catch {
    // no registry yet
  }
  return [];
}

function writeSourceRegistry(path: string, sources: SourceDefinition[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const payload = { version: 1, sources };
  // Write via a temp file and rename so a crash cannot leave a truncated file.
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

/** The registry file path. */
function sourceRegistryPath(): string {
  return join(
    process.env.TOOLSHED_HOME ?? join(homedir(), '.toolshed'),
    'sources.json',
  );
}

/**
 * Tokenise a string the way skills-library's search index expects.
 *
 * The index reads `tokens.desc` and `tokens.name` as arrays of words. A
 * record whose `tokens` is a number makes the search index throw at
 * construction, which stops skills-library before it can serve anything.
 */
function tokeniseWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

/**
 * Build the skill index records for a fetched skill directory.
 *
 * The shape matches what `skills-library` reads from
 * `mcp/data/index.json`, so the merged index is a valid index for it. The
 * paths must be **relative to the corpus root**: skills-library resolves
 * `join(root, s.skill_md)`, so an absolute path here would produce a
 * doubled-up path and the install would fail.
 */
function indexRecordsForSkill(
  skillDir: string,
  name: string,
  repoLabel: string,
  root: string,
): SkillIndexRecord[] {
  const primary = join(skillDir, 'SKILL.md');
  if (!existsSync(primary)) return [];
  const text = readFileSync(primary, 'utf8');
  const { data, body } = parseFrontmatter(text);
  const description = pickString(data, 'description') ?? deriveDescription(data, body);

  const bundleFiles: {
    path: string;
    bytes: number;
    digest: string;
  }[] = [];
  let totalBytes = 0;
  const walk = (dir: string, depth: number) => {
    if (depth > 3) return;
    let items: string[];
    try {
      items = readdirSync(dir);
    } catch {
      return;
    }
    for (const item of items) {
      const path = join(dir, item);
      try {
        const st = statSync(path);
        if (st.isDirectory()) {
          walk(path, depth + 1);
          continue;
        }
        const rel = relative(skillDir, path).split('\\').join('/');
        if (rel === 'SKILL.md') continue;
        totalBytes += st.size;
        bundleFiles.push({
          path: rel,
          bytes: st.size,
          digest: `sha256:${hashFile(path)}`,
        });
      } catch {
        // skip unreadable
      }
    }
  };
  walk(skillDir, 0);

  const digest = hashFile(primary);
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const relDir = relative(root, skillDir).split('\\').join('/');
  const frontmatter = {
    ...data,
    allowed_tools: normaliseTools(pick(data, 'allowed-tools', 'allowed_tools', 'tools')),
    parse_ok: true,
    parse_error: null,
    raw_keys: Object.keys(data),
  };

  return [
    {
      id: `skill:${slug}`,
      kind: 'skill',
      name,
      title: name,
      desc: description,
      desc_source: 'yaml',
      tokens: {
        desc: tokeniseWords(description),
        name: tokeniseWords(name),
        total: Math.ceil(text.length / 4),
      },
      frontmatter,
      provenance: {
        source: 'github',
        repo: repoLabel,
        path: relDir,
        license: pickString(data, 'license') ?? 'unknown',
        license_source: 'frontmatter',
        owner: repoLabel.split('/')[0],
        digest,
        verdict: 'unknown',
        redistributable: null,
        reason: 'Fetched from GitHub on request; not audited by the library.',
      },
      bundle: {
        file_count: bundleFiles.length,
        files: bundleFiles,
        refs: [],
        refs_dangling: [],
        refs_resolved: [],
        refs_total: 0,
        total_bytes: totalBytes,
      },
      skills: {
        name,
        name_override: null,
        description,
        description_truncated: description.length > 1024,
        frontmatter,
        problems: [],
        resources: [],
        uri: `github:${repoLabel}/${relDir}`,
      },
      abs_path: skillDir,
      path: relDir,
      skill_md: `${relDir}/SKILL.md`,
      tier: 3,
      domain: 'GitHub',
      copies: 1,
      locale_only: false,
      rescued_from_tmp: false,
      source: `github:${repoLabel}`,
      digest,
    },
  ];
}

/**
 * Create the MCP server and register every tool.
 *
 * The tool names are taken from the same list the test suite asserts against,
 * so the two cannot drift. `registerTool` is used rather than the low-level
 * `Server` class because it converts the Zod input shape into the JSON Schema
 * the protocol requires.
 */
export function createServer(deps: Deps): McpServer {
  const server = new McpServer(
    { name: 'toolshed-mcp', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  const defs = toolDefinitions();

  for (const name of TOOLS) {
    const def = defs[name];
    // The schema shape is built from Zod fields, but the SDK's generic
    // inference cannot see through a dynamic record of them. The handler is
    // typed explicitly so the registration is checked at runtime by the SDK
    // rather than at compile time.
    server.registerTool(
      name,
      {
        title: def.title,
        description: def.description,
        inputSchema: def.inputSchema,
        annotations: def.annotations,
      } as never,
      (async (args: Record<string, unknown>) => {
        const outcome = await handleCall(
          deps,
          name,
          (args ?? {}) as Record<string, unknown>,
        );
        const result: {
          content: { type: 'text'; text: string }[];
          isError?: boolean;
        } = {
          content: [{ type: 'text', text: outcome.text }],
        };
        if (outcome.isError) {
          result.isError = true;
        }
        return result;
      }) as never,
    );
  }

  return server;
}

/**
 * Route one tool call.
 *
 * Every branch is wrapped in `guard`, so a throw inside a handler becomes a
 * readable error rather than a dropped connection.
 */
async function handleCall(
  deps: Deps,
  name: ToolName,
  args: Record<string, unknown>,
): Promise<{ text: string; isError?: boolean }> {
  {
    switch (name) {
      case 'search_registry':
        return guard('search_registry', () => {
          const query = String(args.query ?? '');
          if (query.trim().length === 0) {
            return asError('query is required');
          }
          const hits = search(deps.registry.all(), {
            query,
            sources: Array.isArray(args.sources)
              ? (args.sources as string[])
              : undefined,
            kinds: Array.isArray(args.kinds)
              ? (args.kinds as EntryKind[])
              : undefined,
            limit: typeof args.limit === 'number' ? args.limit : undefined,
          });
          if (hits.length === 0) {
            const snapshot = deps.registry.snapshot();
            const errorNote = snapshot.errors.length > 0
              ? ` Some sources failed to load: ${snapshot.errors.map((e) => `${e.source} (${e.message})`).join('; ')}.`
              : '';
            return asText(
              `No entries matched '${query}'.${errorNote}`,
              { hits: [] },
            );
          }
          const lines = hits.map(
            (h) =>
              `${h.entry.kind}  ${h.entry.name}  [${h.entry.source}]  score=${h.score.toFixed(2)}  ${h.entry.description}`,
          );
          return asText(lines.join('\n'), {
            hits: hits.map((h) => ({
              id: h.entry.id,
              kind: h.entry.kind,
              name: h.entry.name,
              source: h.entry.source,
              // The other corpora that hold a byte-identical copy. The
              // dedupe keeps one entry, so this is where the second
              // corpus's provenance survives.
              aliases: h.entry.aliases ?? [],
              score: h.score,
              description: h.entry.description,
              path: h.entry.path,
            })),
          });
        });

      case 'get_entry':
        return guard('get_entry', () => {
          const id = String(args.id ?? '');
          if (id.trim().length === 0) return asError('id is required');
          const source = typeof args.source === 'string' ? args.source : undefined;
          let entry = deps.registry.find(id);
          if (!entry || (source && entry.source !== source)) {
            const all = source
              ? deps.registry.all().filter((e) => e.source === source)
              : deps.registry.all();
            const normalised = id.trim().toLowerCase().replace(/[-_]/g, '-');
            const matches = all.filter(
              (e) =>
                e.name.toLowerCase().replace(/[-_]/g, '-') === normalised ||
                e.id.toLowerCase() === id.trim().toLowerCase(),
            );
            if (matches.length === 0) {
              const errors = deps.registry.snapshot().errors;
              const hint =
                errors.length > 0
                  ? `Some sources failed to load, so the entry may exist on disk: ${errors.map((e) => `${e.source}: ${e.message}`).join('; ')}`
                  : `Known sources: ${deps.registry.all().length} entries across ${deps.registry.snapshot().sources.length} corpora.`;
              return asError(`No entry found for '${id}'.`, hint);
            }
            entry = matches[0];
          }
          return asText(formatEntry(entry, readBody(entry)), { entry });
        });

      case 'get_entry_bundle':
        return guard('get_entry_bundle', () => {
          const id = String(args.id ?? '');
          if (id.trim().length === 0) return asError('id is required');
          const entry = deps.registry.find(id);
          if (!entry) {
            return asError(`No entry found for '${id}'.`);
          }
          const maxFiles =
            typeof args.max_files === 'number' ? args.max_files : 20;
          const files: { path: string; content: string }[] = [];
          if (entry.dir) {
            for (const rel of entry.bundle.slice(0, maxFiles)) {
              const abs = join(entry.dir, rel);
              try {
                const st = statSync(abs);
                if (st.size > 512 * 1024) continue;
                files.push({ path: rel, content: readFileSync(abs, 'utf8') });
              } catch {
                // skip unreadable
              }
            }
          }
          const text = [
            formatEntry(entry),
            '',
            `Supporting files (${files.length}):`,
            ...files.map((f) => `--- ${f.path} ---\n${f.content}`),
          ].join('\n');
          return asText(text, { entry, files });
        });

      case 'list_sources':
        return guard('list_sources', () => {
          const snapshot = deps.registry.snapshot();
          // The count is what the source *contributed*, which includes the
          // entries that dedupe collapsed into another corpus's copy. A
          // corpus whose skills all exist verbatim elsewhere still read.
          const counts = sourceCounts(snapshot.entries);
          const lines = snapshot.sources.map((s) => {
            const count = counts.get(s.id) ?? 0;
            return `${s.id}  ${s.label}  kind=${s.kind}  entries=${count}  root=${s.root}`;
          });
          const errors =
            snapshot.errors.length > 0
              ? ['', 'Sources that failed to load:', ...snapshot.errors.map((e) => `  ${e.source}: ${e.message}`)]
              : [];
          return asText(
            [
              `Total entries: ${snapshot.entries.length}`,
              '',
              ...lines,
              ...errors,
            ].join('\n'),
            { sources: snapshot.sources, errors: snapshot.errors },
          );
        });

      case 'list_mcp_servers':
        return guard('list_mcp_servers', () => {
          const records = inventoryMcpServers();
          const installedOnly = args.installed_only === true;
          const filtered = installedOnly
            ? records.filter((r) => r.installed)
            : records;
          const summary = summariseServers(records);
          const lines = filtered.map(
            (r) =>
              `${r.installed ? 'installed  ' : 'configured'}  ${r.name}  harness=${r.harness}  ${r.transport}  ${r.command}`,
          );
          const text = [
            `${summary.total} registration(s); ${summary.installed} installed, ${summary.configuredOnly} configured only.`,
            '',
            ...lines,
          ].join('\n');
          return asText(text, { records: filtered, summary });
        });

      case 'list_agent_types':
        return guard('list_agent_types', () => {
          const records = probeAgentTypes();
          const harness = typeof args.harness === 'string' ? args.harness : undefined;
          const filtered = harness
            ? records.filter((r) => r.harness === harness)
            : records;
          if (filtered.length === 0) {
            return asError(
              `No harness named '${harness}'.`,
              `Known harnesses: ${records.map((r) => r.harness).join(', ')}`,
            );
          }
          const lines = filtered.map(
            (r) =>
              `${r.harness}: ${r.available.length > 0 ? r.available.join(', ') : '(none)'}${r.missing.length > 0 ? `  MISSING BUILT-IN: ${r.missing.join(', ')}` : ''}`,
          );
          const missing = missingBuiltinReport(filtered);
          const note =
            missing.length > 0
              ? [
                  '',
                  'A missing built-in agent type cannot be restored by an MCP server: the agent-type',
                  'registry lives in the harness process. A custom agent definition loaded from disk',
                  'is the durable alternative.',
                ]
              : [];
          return asText([...lines, ...note].join('\n'), { records: filtered });
        });

      case 'add_github_source':
        return guard('add_github_source', async () => {
          const repo = parseRepo(String(args.repo ?? ''));
          if (!repo) {
            return asError(
              `Could not parse repository '${String(args.repo ?? '')}'.`,
              'Use owner/repo, owner/repo@ref, or a github.com URL.',
            );
          }
          const target = repoCacheDir(deps.cacheRoot, repo);
          const label =
            typeof args.label === 'string' && args.label.length > 0
              ? args.label
              : `${repo.owner}/${repo.repo}`;

          if (args.apply !== true) {
            return asText(
              [
                `Would fetch ${repo.owner}/${repo.repo}${repo.ref ? `@${repo.ref}` : ''} into ${target}.`,
                'Re-run with apply=true to fetch, index and register it.',
              ].join('\n'),
              { repo, target, apply: false },
            );
          }

          let result;
          try {
            result = await fetchRepoSparseFirst(repo, target, {
              ref: typeof args.ref === 'string' ? args.ref : undefined,
              timeoutMs:
                typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined,
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return asError(`Fetch failed: ${redactToken(message)}`);
          }

          // Index the fetched repo the way a corpus is indexed.
          const spec = {
            id: `github:${repo.owner}/${repo.repo}`,
            label,
            root: target,
            origin: `github:${repo.owner}/${repo.repo}`,
            kind: 'github' as const,
            layout: 'skill-dirs' as const,
          };
          // A repository has no fixed skills layout, so the tree is walked
          // for SKILL.md files rather than guessing a directory.
          const entries = loadGithubSource(spec);
          if (entries.length === 0) {
            // Some repositories hold flat `.md` files instead of directories.
            const flat = loadSource({ ...spec, layout: 'skill-files' });
            entries.push(...flat);
          }

          const definition: SourceDefinition = {
            id: spec.id,
            label,
            root: target,
            origin: spec.origin,
            layout: 'github-tree',
          };
          const registryPath = sourceRegistryPath();
          const existing = readSourceRegistry(registryPath).filter(
            (s) => s.id !== definition.id,
          );
          existing.push(definition);
          writeSourceRegistry(registryPath, existing);

          deps.registry.setDefinitions([
            ...deps.registry.getDefinitions().filter((s) => s.id !== definition.id),
            definition,
          ]);

          return asText(
            [
              `Registered ${repo.owner}/${repo.repo} as source '${spec.id}'.`,
              `Fetched via ${result.method}: ${result.fileCount} file(s), ${result.bytes} byte(s).`,
              `Indexed ${entries.length} entry/entries.`,
              `Search it with search_registry, sources=["${spec.id}"].`,
            ].join('\n'),
            { source: spec, entries: describeEntries(entries), fetch: result },
          );
        });

      case 'install_skill_from_github':
        return guard('install_skill_from_github', async () => {
          const repo = parseRepo(String(args.repo ?? ''));
          if (!repo) {
            return asError(
              `Could not parse repository '${String(args.repo ?? '')}'.`,
              'Use owner/repo, owner/repo@ref, or a github.com URL.',
            );
          }
          const skillPath = String(args.path ?? '').trim();
          if (skillPath.length === 0) {
            return asError('path is required');
          }
          // The path travels into a filesystem location, so it is checked for
          // traversal before anything else happens with it.
          if (!isSafeRelativePath(skillPath)) {
            return asError(
              `Unsafe path '${skillPath}'.`,
              'The path must be relative and must not contain a parent traversal.',
            );
          }
          const skillName = skillPath.split('/').filter(Boolean).pop() ?? '';
          if (!isValidSkillName(skillName)) {
            return asError(`Invalid skill name '${skillName}' in path.`);
          }
          const harness = String(args.harness ?? '');
          const mode = (typeof args.mode === 'string' ? args.mode : 'symlink') as
            | 'symlink'
            | 'copy';

          if (args.apply !== true) {
            return asText(
              [
                `Would fetch skill '${skillName}' from ${repo.owner}/${repo.repo} at '${skillPath}'.`,
                `Would then ask skills-library to install it into ${harness} (mode=${mode}).`,
                'Re-run with apply=true to perform the install.',
              ].join('\n'),
              { repo, skillPath, skillName, harness, mode, apply: false },
            );
          }

          // Stage the skill into a corpus root that skills-library can see.
          //
          // The root is a *merged* one: skills-library's own index, with the
          // fetched skill added. skills-library reads its index from a fixed
          // path under its root, and the root is overridable, so a merged
          // root is what lets skills-library resolve the fetched skill's id
          // while keeping every skill it already had.
          const stageRoot = join(
            deps.corpusRoot,
            `github__${repo.owner}__${repo.repo}`.replace(/[^A-Za-z0-9_-]/g, '_'),
          );
          mkdirSync(stageRoot, { recursive: true });

          let staged;
          try {
            staged = await fetchSkill(repo, skillPath, join(stageRoot, '.fetch'), {
              ref: typeof args.ref === 'string' ? args.ref : undefined,
              timeoutMs:
                typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined,
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return asError(`Fetch failed: ${redactToken(message)}`);
          }

          // Copy the skill into the corpus shape skills-library indexes.
          const skillDest = join(stageRoot, 'skills', skillName);
          mkdirSync(skillDest, { recursive: true });
          cpSync(staged.dir, skillDest, { recursive: true });

          // Merge into the corpus index at the fixed path skills-library reads.
          const records = indexRecordsForSkill(
            skillDest,
            skillName,
            `${repo.owner}/${repo.repo}`,
            stageRoot,
          );
          if (records.length === 0) {
            return asError(
              `The fetched path '${skillPath}' has no SKILL.md.`,
              'A skill directory must contain a SKILL.md file.',
            );
          }

          // The base index is skills-library's own, so the merged root keeps
          // the whole library installable alongside the fetched skill.
          const baseIndex = readLibraryIndex(libraryRoot()) ?? readIndex(stageRoot);
          const merged = mergeSkills(baseIndex, records);
          writeIndex(stageRoot, merged.index);

          // Delegate the write. skills-library owns the policy layer.
          const client = new SkillsLibraryClient(stageRoot);
          try {
            await client.connect();
            const result = await client.callTool('install_skills', {
              harness,
              ids: [records[0].id],
              mode,
              apply: true,
            });
            const text = renderContent(result.content);
            if (result.isError) {
              return asError(
                `skills-library refused the install: ${text}`,
                `The skill was fetched into ${skillDest} and indexed at ${indexPath(stageRoot)}.`,
              );
            }
            return asText(
              [
                `Installed '${skillName}' into ${harness} via skills-library.`,
                text,
              ].join('\n'),
              { skill: records[0], harness, mode, corpusRoot: stageRoot },
            );
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return asError(
              `Could not reach skills-library: ${redactToken(message)}`,
              `The skill was fetched into ${skillDest} and indexed at ${indexPath(stageRoot)}. It can be installed once skills-library is available.`,
            );
          } finally {
            await client.close();
          }
        });

      case 'proxy_call':
        return guard('proxy_call', async () => {
          const tool = String(args.tool ?? '');
          const separator = tool.indexOf('__');
          if (separator <= 0) {
            return asError(
              `Invalid tool name '${tool}'.`,
              'Use server__tool form, for example myserver__do_thing.',
            );
          }
          const serverName = tool.slice(0, separator);
          const toolName = tool.slice(separator + 2);
          const target = deps.pool.get(serverName);
          if (!target) {
            return asError(
              `No proxied server named '${serverName}'.`,
              `Proxied servers: ${deps.pool.list().map((t) => t.name).join(', ') || '(none configured)'}.`,
            );
          }
          try {
            const session = await deps.pool.session(serverName);
            const result = await session.request('tools/call', {
              name: toolName,
              arguments: (args.arguments as Record<string, unknown>) ?? {},
            });
            return asText(renderContent(result), { result });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return asError(`proxy_call failed: ${redactToken(message)}`);
          }
        });

      case 'proxy_discover':
        return guard('proxy_discover', async () => {
          const serverName = typeof args.server === 'string' ? args.server : undefined;
          if (!serverName) {
            const lines = deps.pool.list().map(
              (t) => `${t.name}: ${t.command} ${t.args.join(' ')}`.trim(),
            );
            return asText(
              lines.length > 0
                ? ['Proxied servers:', ...lines].join('\n')
                : 'No external MCP servers are configured for proxying.',
              { servers: deps.pool.list() },
            );
          }
          const target = deps.pool.get(serverName);
          if (!target) {
            return asError(
              `No proxied server named '${serverName}'.`,
              `Proxied servers: ${deps.pool.list().map((t) => t.name).join(', ') || '(none configured)'}.`,
            );
          }
          try {
            const session = await deps.pool.session(serverName);
            const result = (await session.request('tools/list', {})) as {
              tools?: { name: string; description?: string; inputSchema?: unknown }[];
            };
            const tools = result?.tools ?? [];
            return asText(
              tools.map((t) => `${serverName}__${t.name}  ${t.description ?? ''}`).join('\n'),
              { server: serverName, tools },
            );
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return asError(`proxy_discover failed: ${redactToken(message)}`);
          }
        });

      default:
        return asError(`Unknown tool '${name}'.`);
    }
  }
}

/** Render MCP content blocks as plain text. */
function renderContent(content: unknown): string {
  if (!Array.isArray(content)) {
    return typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  }
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object') {
      const b = block as { type?: string; text?: string };
      if (b.type === 'text' && typeof b.text === 'string') {
        parts.push(b.text);
        continue;
      }
      parts.push(JSON.stringify(block));
    } else {
      parts.push(String(block));
    }
  }
  return parts.join('\n');
}

/**
 * Build the default dependency set.
 *
 * Everything is resolved from the environment or from paths relative to the
 * user's home, never from `process.cwd()`, so the server behaves the same
 * however it is launched.
 */
export function defaultDeps(): Deps {
  const registry = new Registry(defaultSources());
  const proxyConfigPath =
    process.env.TOOLSHED_PROXY_CONFIG ?? defaultProxyConfigPath();
  const pool = new ProxyPool(loadProxyTargets(proxyConfigPath));
  const cacheRoot =
    process.env.TOOLSHED_CACHE_ROOT ??
    join(process.env.TOOLSHED_HOME ?? join(homedir(), '.toolshed'), 'cache');
  const corpus = corpusRoot();
  mkdirSync(corpus, { recursive: true });
  mkdirSync(cacheRoot, { recursive: true });
  return {
    registry,
    pool,
    cacheRoot,
    proxyConfigPath,
    corpusRoot: corpus,
  };
}

export { basename };
