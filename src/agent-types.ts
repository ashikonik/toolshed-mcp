import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Per-harness agent-type probe.
 *
 * The `Agent type 'Explore' not found` class of error happens because each
 * harness keeps its agent-type registry in its own process, and the registry
 * contents differ. A server cannot change what a harness will spawn, but it
 * can report what each harness will actually accept — which turns a spawn
 * time surprise into a visible fact.
 */

export interface AgentTypeRecord {
  harness: string;
  /** Agent type names the harness will accept. */
  available: string[];
  /** Built-ins known to be missing from this harness. */
  missing: string[];
  /** Where the answer came from. */
  evidence: string;
}

const HOME = homedir();

/**
 * Built-in agent types the puku-cli bundle defines.
 *
 * `Explore` and `Plan` are fully specified in the shipped bundle but gated
 * behind a function that returns false, so only `general-purpose` is ever
 * registered. The gate lives in the CLI's own process, so an MCP server
 * cannot restore them — it can only report their absence.
 */
export const PUKU_BUILTIN_AGENT_TYPES = ['general-purpose', 'Explore', 'Plan'];

/** Agent types every harness is expected to provide by default. */
export const COMMON_BUILTIN_AGENT_TYPES = ['general-purpose'];

/**
 * List the agent files a harness loads from disk.
 *
 * puku-cli reads `~/.puku-cli/agents/*.md`, claude-code reads
 * `~/.claude/agents/*.md`, opencode reads `~/.config/opencode/agent/*.md`.
 * Agents defined this way are spawnable, unlike a gated built-in.
 */
function listAgentFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.replace(/\.md$/, ''))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Probe puku-cli's built-in agent types from its installed bundle.
 *
 * The bundle is a minified single file. The built-in list is built by a
 * function that returns a literal array of agent identifiers; the agent
 * definitions are referenced from nearby constants. Rather than try to
 * reverse the minified identifiers, this reads the *observable* behaviour:
 * the bundle's own list of agent names.
 */
function probePukuBuiltins(): { available: string[]; missing: string[]; evidence: string } {
  const candidates = [
    join(HOME, '.npm-global', 'lib', 'node_modules', '@puku', 'puku-cli', 'dist', 'cli.mjs'),
    join(HOME, '.npm', 'lib', 'node_modules', '@puku', 'puku-cli', 'dist', 'cli.mjs'),
    join(HOME, '.local', 'lib', 'node_modules', '@puku', 'puku-cli', 'dist', 'cli.mjs'),
  ];
  const bundle = candidates.find((p) => existsSync(p));
  if (!bundle) {
    return {
      available: [...COMMON_BUILTIN_AGENT_TYPES],
      missing: ['Explore', 'Plan'],
      evidence: 'puku-cli bundle not found in the usual npm global locations',
    };
  }

  let text: string;
  try {
    text = readFileSync(bundle, 'utf8');
  } catch (err) {
    return {
      available: [...COMMON_BUILTIN_AGENT_TYPES],
      missing: ['Explore', 'Plan'],
      evidence: `puku-cli bundle unreadable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // The bundle registers `general-purpose` unconditionally and adds `Explore`
  // and `Plan` only when a feature gate passes. A gate that is present and
  // returns a literal false is the signature of the bug; when the gate is
  // absent entirely, the built-ins are exposed.
  const gatePattern =
    /function\s+([A-Za-z_$][\w$]*)\(\)\s*\{\s*return\s*!([01])\s*\}/g;
  let match: RegExpExecArray | null;
  const falseGates: string[] = [];
  while ((match = gatePattern.exec(text)) !== null) {
    if (match[2] === '1') falseGates.push(match[1]);
  }

  // Look for the agent-id literals near the built-in list construction.
  const hasExploreLiteral = /["']Explore["']/.test(text);
  const hasPlanLiteral = /["']Plan["']/.test(text);

  if (hasExploreLiteral && hasPlanLiteral && falseGates.length > 0) {
    return {
      available: [...COMMON_BUILTIN_AGENT_TYPES],
      missing: ['Explore', 'Plan'],
      evidence:
        `puku-cli bundle defines Explore and Plan but gates them behind ${falseGates.join(', ')} returning false`,
    };
  }

  if (hasExploreLiteral && hasPlanLiteral) {
    return {
      available: ['general-purpose', 'Explore', 'Plan'],
      missing: [],
      evidence: 'puku-cli bundle exposes Explore and Plan',
    };
  }

  return {
    available: [...COMMON_BUILTIN_AGENT_TYPES],
    missing: ['Explore', 'Plan'],
    evidence: 'puku-cli bundle found, but the Explore/Plan definitions could not be confirmed',
  };
}

/** Probe a harness that loads agent definitions from a directory. */
function probeFileBased(
  dir: string,
  label: string,
): { available: string[]; missing: string[]; evidence: string } {
  const files = listAgentFiles(dir);
  const builtins = [...COMMON_BUILTIN_AGENT_TYPES];
  const available = [...new Set([...builtins, ...files])];
  return {
    available,
    missing: [],
    evidence:
      files.length > 0
        ? `${label}: ${files.length} agent file(s) in ${dir}`
        : `${label}: no agent files in ${dir}; only built-ins assumed`,
  };
}

/**
 * Probe every harness present on this machine.
 *
 * Harnesses that are not installed are reported with an empty availability
 * list rather than being omitted, so the report reflects the whole matrix.
 */
export function probeAgentTypes(): AgentTypeRecord[] {
  const records: AgentTypeRecord[] = [];

  // puku-cli
  const pukuAgents = join(HOME, '.puku-cli', 'agents');
  const pukuBuiltins = probePukuBuiltins();
  const pukuFiles = listAgentFiles(pukuAgents);
  records.push({
    harness: 'puku-cli',
    available: [...new Set([...pukuBuiltins.available, ...pukuFiles])],
    missing: pukuBuiltins.missing,
    evidence:
      pukuFiles.length > 0
        ? `${pukuBuiltins.evidence}; ${pukuFiles.length} custom agent file(s) in ${pukuAgents}`
        : pukuBuiltins.evidence,
  });

  // claude-code
  const claudeAgents = join(HOME, '.claude', 'agents');
  const claude = probeFileBased(claudeAgents, 'claude-code');
  records.push({
    harness: 'claude-code',
    available: claude.available,
    missing: [],
    evidence: claude.evidence,
  });

  // opencode
  const opencodeAgents = join(HOME, '.config', 'opencode', 'agent');
  const opencode = probeFileBased(opencodeAgents, 'opencode');
  records.push({
    harness: 'opencode',
    available: opencode.available,
    missing: [],
    evidence: opencode.evidence,
  });

  // codex
  const codexAgents = join(HOME, '.codex', 'agents');
  const codex = probeFileBased(codexAgents, 'codex');
  records.push({
    harness: 'codex',
    available: codex.available,
    missing: [],
    evidence: codex.evidence,
  });

  return records;
}

/**
 * Report the missing built-in agent types across all harnesses.
 *
 * This is the diagnostic the `Explore` bug needs: it names the harness, the
 * missing types, and the fact that only a CLI-side change can fix it.
 */
export function missingBuiltinReport(records: AgentTypeRecord[]): string[] {
  const lines: string[] = [];
  for (const record of records) {
    if (record.missing.length > 0) {
      lines.push(
        `${record.harness}: missing built-in agent type(s) ${record.missing.join(', ')} — ${record.evidence}`,
      );
    }
  }
  return lines;
}
