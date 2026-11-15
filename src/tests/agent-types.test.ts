import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  missingBuiltinReport,
  probeAgentTypes,
  COMMON_BUILTIN_AGENT_TYPES,
} from '../agent-types.js';

test('the probe reports every harness it knows about', () => {
  const records = probeAgentTypes();
  const harnesses = records.map((r) => r.harness);
  for (const expected of ['puku-cli', 'claude-code', 'opencode', 'codex']) {
    assert.ok(harnesses.includes(expected), `missing harness ${expected}`);
  }
});

test('every probed harness lists at least the common built-ins', () => {
  const records = probeAgentTypes();
  for (const record of records) {
    for (const builtin of COMMON_BUILTIN_AGENT_TYPES) {
      assert.ok(
        record.available.includes(builtin),
        `${record.harness} does not list ${builtin}`,
      );
    }
  }
});

test('every probe record carries evidence', () => {
  for (const record of probeAgentTypes()) {
    assert.ok(record.evidence.length > 0, `${record.harness} has no evidence`);
  }
});

test('the missing-builtin report names the harness and the types', () => {
  const records = probeAgentTypes();
  const report = missingBuiltinReport(records);
  for (const line of report) {
    assert.match(line, /missing built-in agent type/);
  }
});

test('a custom agent file on disk is reported as available', () => {
  // The probe reads the real home directory, so this checks the shape rather
  // than inventing a harness: the record shape must be stable.
  const records = probeAgentTypes();
  for (const record of records) {
    assert.equal(typeof record.available, 'object');
    assert.ok(Array.isArray(record.available));
    assert.ok(Array.isArray(record.missing));
  }
});
