import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createInflateRaw } from 'node:zlib';
import { Readable } from 'node:stream';

/**
 * GitHub source extraction.
 *
 * Two shapes are supported, and both are deliberately conservative:
 *
 *   A. `add_github_source` — register `owner/repo` as a corpus. The repo is
 *      fetched into a cache directory shaped like a corpus, indexed, and from
 *      then on it is searchable like any local source.
 *   B. `install_skill_from_github` — fetch one skill from `owner/repo/path`
 *      and install it into a harness.
 *
 * Network egress is the risk here: this server is registered in four
 * harnesses and can be invoked without a human watching. So: the only remote
 * contacted is `codeload.github.com` (plus `github.com` for private repos
 * via git), credentials are never logged, and every path that comes out of an
 * archive is checked before it is written.
 */

export interface GitHubRepo {
  owner: string;
  repo: string;
  /** Optional git ref: branch, tag or commit sha. */
  ref?: string;
}

/** Parse `owner/repo`, `owner/repo@ref`, or a full GitHub URL. */
export function parseRepo(input: string): GitHubRepo | undefined {
  const trimmed = input.trim().replace(/\.git$/, '');
  if (trimmed.length === 0) return undefined;

  if (/^https?:\/\//i.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return undefined;
    }
    if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') {
      return undefined;
    }
    const parts = url.pathname.replace(/^\//, '').split('/').filter(Boolean);
    if (parts.length < 2) return undefined;
    const repo: GitHubRepo = { owner: parts[0], repo: parts[1] };
    // A browser URL may name the ref as `tree/<ref>`, `blob/<ref>` or
    // `releases/tag/<ref>`; a raw path segment after the repo name is a ref
    // only when it is not one of those keywords.
    if (parts[2] && !['tree', 'blob', 'releases', 'commit', 'tags'].includes(parts[2])) {
      repo.ref = parts[2];
    } else if (parts[2] === 'tree' || parts[2] === 'blob') {
      if (parts[3]) repo.ref = parts[3];
    } else if (parts[2] === 'releases' && parts[3] === 'tag' && parts[4]) {
      repo.ref = parts[4];
    }
    return repo;
  }

  const [ownerRepo, ref] = trimmed.split('@');
  const parts = ownerRepo.split('/').filter(Boolean);
  if (parts.length !== 2) return undefined;
  if (!/^[\w.-]+$/.test(parts[0]) || !/^[\w.-]+$/.test(parts[1])) {
    return undefined;
  }
  const repo: GitHubRepo = { owner: parts[0], repo: parts[1] };
  if (ref && ref.length > 0) repo.ref = ref;
  return repo;
}

/** The on-disk cache directory for a repo. */
export function repoCacheDir(root: string, repo: GitHubRepo): string {
  const safe = `${repo.owner}__${repo.repo}${repo.ref ? `__${repo.ref.replace(/[^\w.-]/g, '_')}` : ''}`;
  return join(root, safe);
}

/**
 * Reject a path that would escape its root.
 *
 * Every entry name from an archive goes through this before it is written.
 * Absolute paths, parent traversal, and symlink escapes are all rejected.
 */
export function isSafeRelativePath(candidate: string): boolean {
  if (candidate.length === 0) return false;
  if (candidate.startsWith('/')) return false;
  if (candidate.startsWith('\\')) return false;
  if (/^[a-zA-Z]:/.test(candidate)) return false;
  const normalised = candidate.replace(/\\/g, '/');
  if (normalised.includes('\0')) return false;
  const segments = normalised.split('/');
  for (const segment of segments) {
    if (segment === '..') return false;
  }
  return true;
}

/**
 * Resolve a relative path inside a root, guaranteeing it stays inside.
 *
 * Uses `resolve` plus a prefix check rather than string matching alone, so a
 * symlink-free path that still climbs out is caught.
 */
export function resolveWithin(root: string, candidate: string): string | undefined {
  if (!isSafeRelativePath(candidate)) return undefined;
  const rootResolved = resolve(root);
  const target = resolve(rootResolved, candidate);
  if (target !== rootResolved && !target.startsWith(rootResolved + '/')) {
    return undefined;
  }
  return target;
}

/** Reject a skill name that would produce an unsafe filename. */
export function isValidSkillName(name: string): boolean {
  if (name.length === 0 || name.length > 128) return false;
  if (name.includes('/') || name.includes('\\')) return false;
  if (name.includes('..')) return false;
  if (name.startsWith('.')) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name);
}

/** The token to authenticate GitHub requests with, if one is configured. */
function githubToken(): string | undefined {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token || token.trim().length === 0) return undefined;
  return token.trim();
}

/**
 * Redact a token from any string before it reaches a log or a tool result.
 *
 * The token is read from the environment, so it must never be echoed back.
 */
export function redactToken(text: string): string {
  const token = githubToken();
  if (!token) return text;
  return text.split(token).join('***');
}

/** How long a repository fetch may take, in milliseconds. */
export function fetchTimeoutMs(): number {
  const raw = process.env.TOOLSHED_FETCH_TIMEOUT_MS;
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 600_000;
}

/** Run a command with a hard timeout, killing the whole process group. */
async function runCommand(
  argv: string[],
  options: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  return new Promise((resolvePromise) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        // Kill the process group so a child that spawned its own subprocess
        // does not outlive the timeout.
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          // already gone
        }
      }
      resolvePromise({ code: 124, stdout, stderr: `${stderr}\ntimed out after ${timeoutMs}ms` });
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > 64 * 1024 * 1024) child.kill('SIGKILL');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 8 * 1024 * 1024) child.kill('SIGKILL');
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ code: 127, stdout, stderr: `${stderr}\n${err.message}` });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ code: code ?? 0, stdout, stderr });
    });
  });
}

export interface FetchResult {
  /** Where the repo content landed. */
  dir: string;
  /** How it was fetched. */
  method: 'zip' | 'git';
  /** Number of files extracted. */
  fileCount: number;
  /** Bytes extracted. */
  bytes: number;
}

/**
 * Fetch a repository into `targetDir`.
 *
 * The zip path is tried first because it is fast and does not require git to
 * be installed. The git path is the fallback for private repositories, where
 * a sparse checkout avoids downloading the whole history.
 */
export async function fetchRepo(
  repo: GitHubRepo,
  targetDir: string,
  options: { timeoutMs?: number; ref?: string } = {},
): Promise<FetchResult> {
  // A big repository on a slow link legitimately takes minutes: the
  // `expo/exact` zip is over 30 MB, which is more than three minutes at
  // the bandwidth a modest connection gives. The timeout is generous
  // by default and overridable, because aborting a fetch that was about
  // to succeed wastes more time than waiting.
  const timeoutMs = options.timeoutMs ?? fetchTimeoutMs();
  const ref = options.ref ?? repo.ref ?? 'HEAD';
  const token = githubToken();

  const headers: Record<string, string> = {
    'user-agent': 'toolshed-mcp',
    accept: 'application/vnd.github+json',
  };
  if (token) headers.authorization = `Bearer ${token}`;

  const zipUrl = `https://codeload.github.com/${repo.owner}/${repo.repo}/zip/${ref}`;
  const zipAttempt = await tryZip(zipUrl, targetDir, headers, timeoutMs);
  if (zipAttempt) {
    return zipAttempt;
  }

  // The zip path is a fast path, not the only path. When it fails the git
  // path is used, and the reason is recorded so a silent degradation is
  // visible in the result.
  const result = await gitClone(repo, targetDir, timeoutMs, ref);
  return { ...result, method: 'git' };
}

/** Fetch and unpack a zip archive. Returns undefined when it cannot. */
async function tryZip(
  url: string,
  targetDir: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<FetchResult | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok || !response.body) {
      return undefined;
    }
    const tmpZip = join(targetDir, '.download.zip');
    mkdirSync(dirname(tmpZip), { recursive: true });
    await pipeline(
      Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      createWriteStream(tmpZip),
    );

    const extracted = await extractZip(tmpZip, targetDir);
    rmSync(tmpZip, { force: true });
    if (!extracted) return undefined;
    return { dir: targetDir, method: 'zip', fileCount: extracted.fileCount, bytes: extracted.bytes };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Minimal zip reader.
 *
 * The archive is written by GitHub itself and read once, in memory, so a
 * purpose-built reader avoids adding a dependency for one file format. Only
 * the two methods that matter are supported: stored (0) and deflate (8).
 */
async function extractZip(
  zipPath: string,
  targetDir: string,
): Promise<{ fileCount: number; bytes: number } | undefined> {
  const buffer = await readFile(zipPath);
  const EOCD_SIG = 0x06054b50;
  const CD_SIG = 0x02014b50;

  // Find the end-of-central-directory record by scanning backwards.
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0 && i >= buffer.length - 22 - 0xffff; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return undefined;

  const entryCount = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);

  let fileCount = 0;
  let bytes = 0;

  for (let i = 0; i < entryCount; i += 1) {
    if (offset + 46 > buffer.length) break;
    if (buffer.readUInt32LE(offset) !== CD_SIG) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);

    offset += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith('/')) continue;

    const relative = name.replace(/^[^/]+\//, '');
    if (!isSafeRelativePath(relative)) continue;
    const target = resolveWithin(targetDir, relative);
    if (!target) continue;

    if (localOffset + 30 > buffer.length) continue;
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) continue;

    const raw = buffer.subarray(dataStart, dataEnd);
    let content: Buffer;
    if (method === 0) {
      content = Buffer.from(raw);
    } else if (method === 8) {
      try {
        content = await inflate(raw);
      } catch {
        // One unreadable entry does not invalidate the whole archive. The
        // count reflects what was actually written.
        continue;
      }
    } else {
      continue;
    }

    mkdirSync(dirname(target), { recursive: true });
    await writeFile(target, content);
    fileCount += 1;
    bytes += content.length;
  }

  return { fileCount, bytes };
}

/**
 * Inflate a raw deflate stream.
 *
 * Zip method 8 is *raw* DEFLATE with no zlib or gzip wrapper, so this uses
 * `createInflateRaw`. Using `createGunzip` here fails with "incorrect header
 * check" on every real archive.
 */
function inflate(data: Buffer): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    const inflater = createInflateRaw();
    inflater.on('data', (chunk: Buffer) => chunks.push(chunk));
    inflater.on('end', () => resolvePromise(Buffer.concat(chunks)));
    inflater.on('error', reject);
    inflater.end(data);
  });
}

/** Clone a repo with git, using a shallow sparse checkout. */
async function gitClone(
  repo: GitHubRepo,
  targetDir: string,
  timeoutMs: number,
  ref: string,
): Promise<FetchResult> {
  const token = githubToken();
  const url = token
    ? `https://x-access-token:${encodeURIComponent(token)}@github.com/${repo.owner}/${repo.repo}.git`
    : `https://github.com/${repo.owner}/${repo.repo}.git`;

  const env: NodeJS.ProcessEnv = {
    GIT_TERMINAL_PROMPT: '0',
    GIT_EDITOR: 'true',
    GIT_LFS_SKIP_SMUDGE: '1',
  };

  rmSync(targetDir, { recursive: true, force: true });
  mkdirSync(targetDir, { recursive: true });

  const init = await runCommand(['git', 'init', '-q'], { cwd: targetDir, timeoutMs, env });
  if (init.code !== 0) {
    throw new Error(`git init failed: ${redactToken(init.stderr.trim())}`);
  }
  const remote = await runCommand(
    ['git', 'remote', 'add', 'origin', url],
    { cwd: targetDir, timeoutMs, env },
  );
  if (remote.code !== 0) {
    throw new Error(`git remote add failed: ${redactToken(remote.stderr.trim())}`);
  }
  const sparse = await runCommand(
    ['git', 'config', 'core.sparseCheckout', 'true'],
    { cwd: targetDir, timeoutMs, env },
  );
  if (sparse.code !== 0) {
    throw new Error(`git sparse-checkout config failed: ${redactToken(sparse.stderr.trim())}`);
  }
  const fetch = await runCommand(
    ['git', 'fetch', '-q', '--depth', '1', 'origin', ref],
    { cwd: targetDir, timeoutMs, env },
  );
  if (fetch.code !== 0) {
    throw new Error(
      `git fetch failed: ${redactToken(fetch.stderr.trim())}`,
    );
  }
  const checkout = await runCommand(
    ['git', 'checkout', '-q', 'FETCH_HEAD'],
    { cwd: targetDir, timeoutMs, env },
  );
  if (checkout.code !== 0) {
    throw new Error(`git checkout failed: ${redactToken(checkout.stderr.trim())}`);
  }

  let fileCount = 0;
  let bytes = 0;
  const walk = (dir: string) => {
    let items: string[];
    try {
      items = readdirSync(dir);
    } catch {
      return;
    }
    for (const item of items) {
      if (item === '.git') continue;
      const path = join(dir, item);
      try {
        const st = statSync(path);
        if (st.isDirectory()) walk(path);
        else {
          fileCount += 1;
          bytes += st.size;
        }
      } catch {
        // skip unreadable
      }
    }
  };
  walk(targetDir);

  return { dir: targetDir, method: 'git', fileCount, bytes };
}

/** Fetch a single skill directory out of a repo. */
export async function fetchSkill(
  repo: GitHubRepo,
  path: string,
  targetDir: string,
  options: { timeoutMs?: number; ref?: string } = {},
): Promise<FetchResult> {
  const result = await fetchRepo(repo, targetDir, options);

  // The zip has a single top-level directory (owner-repo-sha); flatten it so
  // the skill path resolves predictably.
  const flattened = flattenSingleRoot(result.dir);
  const source = join(flattened, path);
  if (!existsSync(source)) {
    throw new Error(`path '${path}' not found in ${repo.owner}/${repo.repo}`);
  }
  const skillName = path.split('/').filter(Boolean).pop() ?? 'skill';
  if (!isValidSkillName(skillName)) {
    throw new Error(`invalid skill name derived from path: ${skillName}`);
  }
  return { ...result, dir: source };
}

/**
 * If a directory contains exactly one subdirectory and nothing else, descend
 * into it. GitHub archives have exactly that shape.
 */
export function flattenSingleRoot(dir: string): string {
  try {
    const items = readdirSync(dir, { withFileTypes: true });
    const visible = items.filter((i) => i.name !== '.git');
    if (visible.length === 1 && visible[0].isDirectory()) {
      return join(dir, visible[0].name);
    }
  } catch {
    // fall through
  }
  return dir;
}
