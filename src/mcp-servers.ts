import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Inventory of MCP servers on this machine.
 *
 * The distinction that matters is **installed** versus **configured only**.
 * A harness config listing a server proves the user once intended to run it;
 * it does not prove the binary or package is present. Reporting the two
 * separately is the whole point of this module — a config listing 32 servers
 * that are really 13 is a trap for anyone planning work against them.
 */

export interface McpServerRecord {
  /** Config key the server is registered under. */
  name: string;
  /** Harness the registration was found in. */
  harness: string;
  /** Transport, as declared in the config. */
  transport: string;
  /** The command to launch it, as a display string. */
  command: string;
  /** Scope: user or project. */
  scope: string;
  /** Whether the server's executable or package actually exists on disk. */
  installed: boolean;
  /** Why it is or is not considered installed. */
  evidence: string;
  /** The config file it was found in. */
  configPath: string;
}

export interface HarnessConfig {
  id: string;
  label: string;
  /** Config path, resolved for the current user. */
  path: string;
  /** Key under which servers are listed. */
  key: string;
  /** Whether the config format is JSON or TOML. */
  format: 'json' | 'toml';
}

const HOME = homedir();

export function harnessConfigs(): HarnessConfig[] {
  return [
    {
      id: 'puku-cli',
      label: 'puku-cli',
      path: join(HOME, '.puku-cli', 'puku-cli.json'),
      key: 'mcpServers',
      format: 'json',
    },
    {
      id: 'claude-code',
      label: 'claude-code',
      path: join(HOME, '.claude.json'),
      key: 'mcpServers',
      format: 'json',
    },
    {
      id: 'opencode',
      label: 'opencode',
      path: join(HOME, '.config', 'opencode', 'opencode.json'),
      key: 'mcp',
      format: 'json',
    },
    {
      id: 'codex',
      label: 'codex',
      path: join(HOME, '.codex', 'config.toml'),
      key: 'mcp_servers',
      format: 'toml',
    },
  ];
}

/** Read a JSON config, returning undefined when it is absent or unparseable. */
function readJson(path: string): Record<string, unknown> | undefined {
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Extract `[mcp_servers.NAME]` blocks from a TOML config.
 *
 * A full TOML parser is deliberately avoided: the codex config is the only
 * TOML surface, and its `[mcp_servers.X]` blocks have a fixed shape.
 */
function readTomlServers(
  path: string,
): Map<string, { command?: string; args?: string[]; url?: string }> {
  const out = new Map<string, { command?: string; args?: string[]; url?: string }>();
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return out;
  }
  const lines = raw.split(/\r?\n/);
  let current: string | undefined;
  let buffer: Record<string, unknown> = {};

  const flush = () => {
    if (!current) return;
    out.set(current, {
      command: typeof buffer.command === 'string' ? buffer.command : undefined,
      args: Array.isArray(buffer.args)
        ? buffer.args.filter((a): a is string => typeof a === 'string')
        : undefined,
      url: typeof buffer.url === 'string' ? buffer.url : undefined,
    });
    current = undefined;
    buffer = {};
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) {
      flush();
      const mcp = /^\[mcp_servers\.([^\]]+)\]/.exec(trimmed);
      if (mcp) {
        current = mcp[1].replace(/^["']|["']$/g, '');
      }
      continue;
    }
    if (!current) continue;
    const kv = /^([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(.+)$/.exec(trimmed);
    if (!kv) continue;
    const key = kv[1];
    const rawValue = kv[2].trim();
    if (rawValue.startsWith('[')) {
      const inner = rawValue.slice(1, rawValue.lastIndexOf(']'));
      buffer[key] = inner
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter((s) => s.length > 0);
    } else {
      buffer[key] = rawValue.replace(/^["']|["']$/g, '');
    }
  }
  flush();
  return out;
}

/**
 * Decide whether a server is actually installed.
 *
 * The evidence rules, in order:
 *   1. An `npx`-style command resolves to a package present in the npx cache.
 *   2. A `node <path>` command resolves to a file that exists.
 *   3. A bare command resolves on PATH.
 *   4. A `uvx`/`python`-style command is treated as installed when the
 *      interpreter exists, because the package is fetched on demand.
 */
export function checkInstalled(
  command: string,
  args: string[],
): { installed: boolean; evidence: string } {
  if (command.length === 0) {
    return { installed: false, evidence: 'no command declared' };
  }

  const isNode = command === 'node' || command.endsWith('/node');
  const firstArg = args[0] ?? '';

  if (isNode && firstArg.length > 0) {
    const resolved = firstArg.startsWith('/') ? firstArg : null;
    if (resolved && existsSync(resolved)) {
      try {
        if (statSync(resolved).isFile()) {
          return { installed: true, evidence: `node target exists: ${resolved}` };
        }
      } catch {
        // fall through
      }
    }
    return { installed: false, evidence: `node target missing: ${firstArg}` };
  }

  const isNpx = command === 'npx' || command.endsWith('/npx');
  if (isNpx) {
    const pkg = firstArg.replace(/^-y$/, '');
    const found = findInNpxCache(pkg);
    if (found) {
      return { installed: true, evidence: `npx cache contains ${pkg}` };
    }
    return {
      installed: false,
      evidence: `npx package not in cache: ${pkg} (would be fetched on first use)`,
    };
  }

  const isUvx = command === 'uvx' || command.endsWith('/uvx');
  if (isUvx) {
    const uvxPath = which(command);
    if (uvxPath) {
      return {
        installed: true,
        evidence: `uvx available at ${uvxPath}; package ${firstArg} fetched on demand`,
      };
    }
    return { installed: false, evidence: 'uvx not found on PATH' };
  }

  // bunx resolves a package on demand, but only when bun is installed. On a
  // machine without bun the registration cannot run at all.
  const isBunx = command === 'bunx' || command.endsWith('/bunx');
  if (isBunx) {
    const bunxPath = which(command);
    if (bunxPath) {
      return {
        installed: true,
        evidence: `bunx available at ${bunxPath}; package ${firstArg} fetched on demand`,
      };
    }
    return {
      installed: false,
      evidence: `bunx not found on PATH: ${firstArg} cannot be fetched without bun`,
    };
  }

  const path = which(command);
  if (path) {
    return { installed: true, evidence: `command resolves to ${path}` };
  }
  return { installed: false, evidence: `command not on PATH: ${command}` };
}

/** Locate an executable on PATH. */
function which(command: string): string | undefined {
  const dirs = (process.env.PATH ?? '').split(':').filter((d) => d.length > 0);
  for (const dir of dirs) {
    const candidate = join(dir, command);
    try {
      if (statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // keep looking
    }
  }
  return undefined;
}

/**
 * Search the npx cache for a package.
 *
 * The cache lives under `~/.npm/_npx/<hash>/node_modules/<pkg>`, so a
 * directory glob is enough. The npx cache is only consulted for packages
 * that were actually run at least once.
 */
function findInNpxCache(pkg: string): string | undefined {
  const root = join(HOME, '.npm', '_npx');
  let dirs: string[];
  try {
    dirs = readdirSync(root);
  } catch {
    return undefined;
  }
  for (const dir of dirs) {
    const candidate = join(root, dir, 'node_modules', pkg);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/** Read every harness config and report the servers each declares. */
export function inventoryMcpServers(): McpServerRecord[] {
  const records: McpServerRecord[] = [];

  for (const cfg of harnessConfigs()) {
    if (!existsSync(cfg.path)) continue;

    if (cfg.format === 'json') {
      const doc = readJson(cfg.path);
      if (!doc) continue;
      const bucket = doc[cfg.key];
      if (!bucket || typeof bucket !== 'object') continue;
      for (const [name, raw] of Object.entries(bucket as Record<string, unknown>)) {
        if (!raw || typeof raw !== 'object') continue;
        const entry = raw as Record<string, unknown>;

        // claude-code and puku-cli use `command` as a string plus `args`.
        // opencode uses `command` as an array with no separate `args`.
        let command = '';
        let args: string[] = [];
        if (typeof entry.command === 'string') {
          command = entry.command;
          args = Array.isArray(entry.args)
            ? entry.args.filter((a): a is string => typeof a === 'string')
            : [];
        } else if (Array.isArray(entry.command)) {
          const parts = entry.command.filter(
            (a): a is string => typeof a === 'string',
          );
          command = parts[0] ?? '';
          args = parts.slice(1);
        }

        const transport = typeof entry.type === 'string' ? entry.type : 'stdio';
        const { installed, evidence } = checkInstalled(command, args);
        records.push({
          name,
          harness: cfg.id,
          transport,
          command: [command, ...args].join(' ').trim(),
          scope: 'user',
          installed,
          evidence,
          configPath: cfg.path,
        });
      }
    } else {
      const servers = readTomlServers(cfg.path);
      for (const [name, entry] of servers) {
        const command = entry.command ?? '';
        const args = entry.args ?? [];
        const transport = entry.url ? 'http' : 'stdio';
        const { installed, evidence } = checkInstalled(command, args);
        records.push({
          name,
          harness: cfg.id,
          transport,
          command: [command, ...args].join(' ').trim(),
          scope: 'user',
          installed,
          evidence,
          configPath: cfg.path,
        });
      }
    }
  }

  return records;
}

/** Summarise the inventory: what is installed, what is only configured. */
export function summariseServers(records: McpServerRecord[]): {
  total: number;
  installed: number;
  configuredOnly: number;
  byName: Map<string, McpServerRecord[]>;
} {
  const byName = new Map<string, McpServerRecord[]>();
  for (const record of records) {
    const list = byName.get(record.name) ?? [];
    list.push(record);
    byName.set(record.name, list);
  }
  const installed = records.filter((r) => r.installed).length;
  return {
    total: records.length,
    installed,
    configuredOnly: records.length - installed,
    byName,
  };
}
