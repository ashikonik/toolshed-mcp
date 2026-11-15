#!/usr/bin/env bash
#
# Run the toolshed test suite.
#
# The suite runs against the compiled output in dist/, so the build happens
# first. A run that reports zero tests is treated as a failure: a green run
# that ran nothing is worse than a red one, because it looks like coverage.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ ! -d node_modules ]; then
  echo "run-tests: node_modules missing; run 'npm install' first" >&2
  exit 1
fi

echo "run-tests: building"
npm run --silent build

echo "run-tests: running tests"
set +e
node --test --test-reporter=tap "dist/tests/" 2>&1 | tee /tmp/toolshed-test-output.txt
STATUS=${PIPESTATUS[0]}
set -e

# The TAP reporter is requested explicitly because `node --test` picks the
# spec reporter on some versions and TAP on others, and the two report
# their counts in different shapes: TAP writes `# pass 108`, the spec
# reporter writes `ℹ pass 108`. Parsing one shape and not the other makes
# the wrapper report "zero tests passed" on a green run, which then fails
# the build for a test suite that passed.
PASSED=$(grep -E '^# pass ' /tmp/toolshed-test-output.txt 2>/dev/null | tail -1 | awk '{print $3}')

if [ -z "${PASSED:-}" ] || [ "${PASSED}" = "0" ]; then
  echo "run-tests: FAILED — zero tests passed" >&2
  exit 1
fi

if [ "$STATUS" -ne 0 ]; then
  echo "run-tests: FAILED — exit code $STATUS" >&2
  exit "$STATUS"
fi

echo "run-tests: OK — $PASSED test(s) passed"
