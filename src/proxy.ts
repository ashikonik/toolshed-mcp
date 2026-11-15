import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ProxyTarget } from './types.js';

/**
 * A stdio client for external MCP servers.
 *
 * The toolshed proxies servers the *user* configures, so that any harness
 * gets one namespace of tools regardless of which servers it has registered
 * itself. It deliberately does not proxy the local built servers — that
 * would couple it to servers it is meant to stand apart from.
 *
 * The risk with spawning a process from an MCP handler is a hang: a server
 * that never answers would hang the toolshed, and through it, the harness.
 * Every spawn therefore has a timeout and a hard kill of the process group.
 */

const DEFAULT_TIMEOUT_MS = 60_000;

export interface ProxyTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface ProxyConnection {
  target: ProxyTarget;
  child: ChildProcessWithoutNullStreams;
  /** Buffered stderr, truncated. */
  stderr: string;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * A live connection to one external MCP server.
 *
 * The JSON-RPC framing for MCP stdio is newline-delimited JSON, so the
 * reader splits on newlines and parses each line.
 */
export class ProxySession {
  private pending = new Map<number, PendingCall>();
  private nextId = 1;
  private buffer = '';
  private closed = false;

  constructor(
    readonly target: ProxyTarget,
    private child: ChildProcessWithoutNullStreams,
  ) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onData(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-16 * 1024);
    });
    child.on('exit', (code) => {
      this.closed = true;
      const error = new Error(
        `proxy server '${target.name}' exited with code ${code ?? 'unknown'}`,
      );
      for (const [, call] of this.pending) {
        clearTimeout(call.timer);
        call.reject(error);
      }
      this.pending.clear();
    });
  }

  stderr = '';

  private onData(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf('\n');
    while (index !== -1) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line.length > 0) {
        this.dispatch(line);
      }
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
      const err = message.error as { message?: string; code?: number };
      call.reject(new Error(err.message ?? `proxy error ${err.code ?? 'unknown'}`));
      return;
    }
    call.resolve(message.result);
  }

  /** Send a JSON-RPC request and wait for its response. */
  async request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    if (this.closed) {
      throw new Error(`proxy server '${this.target.name}' is not running`);
    }
    const id = this.nextId;
    this.nextId += 1;
    const timeout = timeoutMs ?? this.target.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const payload = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`proxy call '${method}' timed out after ${timeout}ms`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.child.stdin.write(payload, 'utf8');
    return promise;
  }

  /** Send a notification, which takes no response. */
  notify(method: string, params: unknown): void {
    if (this.closed) return;
    this.child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`,
      'utf8',
    );
  }

  /** Kill the server and drop every pending call. */
  async close(): Promise<void> {
    this.closed = true;
    for (const [, call] of this.pending) {
      clearTimeout(call.timer);
      call.reject(new Error(`proxy server '${this.target.name}' closed`));
    }
    this.pending.clear();
    if (this.child.exitCode === null && this.child.signalCode === null) {
      await killProcessTree(this.child);
    }
  }
}

/**
 * Kill a child and everything it spawned.
 *
 * The child is spawned detached, so it leads its own process group and the
 * whole group can be signalled at once.
 */
export async function killProcessTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (!pid) return;
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      // already gone
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
  if (child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
  }
}

/**
 * Spawn an external MCP server.
 *
 * The command must exist. A missing command is reported here rather than as
 * an opaque spawn error at call time.
 */
export function spawnProxy(target: ProxyTarget): ProxySession {
  if (!existsSync(target.command) && !isOnPath(target.command)) {
    throw new Error(
      `proxy command not found for '${target.name}': ${target.command}`,
    );
  }
  const child = spawn(target.command, target.args, {
    cwd: target.cwd,
    env: { ...process.env, ...(target.env ?? {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  }) as ChildProcessWithoutNullStreams;
  return new ProxySession(target, child);
}

function isOnPath(command: string): boolean {
  if (command.includes('/')) return false;
  const dirs = (process.env.PATH ?? '').split(':').filter((d) => d.length > 0);
  for (const dir of dirs) {
    try {
      if (statSync(join(dir, command)).isFile()) return true;
    } catch {
      // keep looking
    }
  }
  return false;
}

/**
 * A pool of live proxy sessions, keyed by target name.
 *
 * Sessions are kept open between calls so a proxy call does not pay the
 * handshake cost every time, and are closed when the server shuts down.
 */
export class ProxyPool {
  private sessions = new Map<string, ProxySession>();

  constructor(private targets: ProxyTarget[]) {}

  /** The configured targets. */
  list(): ProxyTarget[] {
    return this.targets;
  }

  /** A target by name. */
  get(name: string): ProxyTarget | undefined {
    return this.targets.find((t) => t.name === name);
  }

  /** Get or create a session for a target. */
  async session(name: string): Promise<ProxySession> {
    const existing = this.sessions.get(name);
    if (existing) return existing;
    const target = this.get(name);
    if (!target) {
      throw new Error(`no proxy target named '${name}'`);
    }
    const session = spawnProxy(target);
    this.sessions.set(name, session);
    try {
      await session.request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'toolshed-mcp', version: '0.1.0' },
      });
      session.notify('notifications/initialized', {});
    } catch (err) {
      this.sessions.delete(name);
      await session.close();
      throw err;
    }
    return session;
  }

  /** Close every session. */
  async closeAll(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(sessions.map((s) => s.close()));
  }
}

/**
 * Read proxy targets from the toolshed's own config file.
 *
 * The file lives beside the toolshed's runtime state and is created on
 * demand. Only external servers belong here — the built servers are separate
 * registrations in each harness.
 */
export function loadProxyTargets(path: string): ProxyTarget[] {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const doc = parsed as Record<string, unknown>;
  const list = Array.isArray(doc.targets) ? doc.targets : [];
  const out: ProxyTarget[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    const name = typeof entry.name === 'string' ? entry.name : '';
    const command = typeof entry.command === 'string' ? entry.command : '';
    if (!name || !command) continue;
    out.push({
      name,
      command,
      args: Array.isArray(entry.args)
        ? entry.args.filter((a): a is string => typeof a === 'string')
        : [],
      env:
        entry.env && typeof entry.env === 'object'
          ? (entry.env as Record<string, string>)
          : undefined,
      cwd: typeof entry.cwd === 'string' ? entry.cwd : undefined,
      timeoutMs:
        typeof entry.timeoutMs === 'number' ? entry.timeoutMs : undefined,
    });
  }
  return out;
}

/** The default config path for proxy targets. */
export function defaultProxyConfigPath(): string {
  return join(homedir(), '.toolshed', 'proxies.json');
}
