#!/usr/bin/env bash
#
# Register toolshed-mcp with the coding harnesses installed on this machine.
#
# Each harness keeps MCP registrations in its own file with its own schema,
# so the script detects the schema per harness rather than assuming one:
#
#   claude-code  ~/.claude.json                        JSON, "mcpServers"
#   puku-cli     ~/.puku-cli/puku-cli.json              JSON, "mcpServers"
#   opencode     ~/.config/opencode/opencode.json        JSON, "mcp", command as array
#   codex        ~/.codex/config.toml                    TOML, [mcp_servers.NAME]
#
# The command is always an absolute path to the compiled server, invoked with
# node. It is never `npx -y` and never `bunx`: the server must start offline
# and must start from a known version.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_NAME="toolshed"
ENTRY="$ROOT/dist/index.js"

MODE="apply"
PROJECT_DIR=""
FORCE=0

usage() {
  cat <<'EOF'
Usage: install.sh [--apply | --list] [--project <dir>] [--force]

  --list           print the resolved command for every harness, write nothing
  --apply          register the server in every harness found (default)
  --project <dir>  write project-scoped config for harnesses that support it
  --force          replace an existing registration of the same name
  -h, --help       show this message
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --list) MODE="list"; shift ;;
    --apply) MODE="apply"; shift ;;
    --project) PROJECT_DIR="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "install.sh: unknown argument '$1'" >&2; usage >&2; exit 2 ;;
  esac
done

if [ ! -f "$ENTRY" ]; then
  echo "install.sh: $ENTRY not found; run 'npm install && npm run build' first" >&2
  exit 1
fi

HOME_DIR="${HOME:-/root}"
COMMAND="node"
ARGS="[\"$ENTRY\"]"

# --------------------------------------------------------------------------
# JSON helpers. Python is used because it is the one interpreter that is
# guaranteed present on every machine that already has a coding agent, and
# it can write JSON without reformatting the rest of the file.
# --------------------------------------------------------------------------
PY=$(command -v python3 || command -v python || true)
if [ -z "$PY" ]; then
  echo "install.sh: python3 is required to edit the JSON configs" >&2
  exit 1
fi

write_json_entry() {
  # $1 = config path, $2 = key, $3 = server name
  "$PY" - "$1" "$2" "$3" "$ENTRY" <<'PYEOF'
import json, os, sys, tempfile

path, key, name, entry = sys.argv[1:5]

try:
    with open(path, 'r', encoding='utf-8') as fh:
        doc = json.load(fh)
except (OSError, ValueError):
    doc = {}

if not isinstance(doc, dict):
    doc = {}

bucket = doc.get(key)
if not isinstance(bucket, dict):
    bucket = {}

bucket[name] = {
    "command": "node",
    "args": [entry],
    "type": "stdio",
}

doc[key] = bucket

parent = os.path.dirname(path)
if parent:
    os.makedirs(parent, exist_ok=True)

fd, tmp = tempfile.mkstemp(dir=parent or '.', prefix='.toolshed-', suffix='.json')
try:
    with os.fdopen(fd, 'w', encoding='utf-8') as fh:
        json.dump(doc, fh, indent=2, ensure_ascii=False)
        fh.write('\n')
    os.replace(tmp, path)
except BaseException:
    if os.path.exists(tmp):
        os.unlink(tmp)
    raise
PYEOF
}

write_opencode_entry() {
  # opencode wants the command as an array and its own key.
  "$PY" - "$1" "$2" "$3" "$4" <<'PYEOF'
import json, os, sys, tempfile

path, key, name, entry = sys.argv[1:5]

try:
    with open(path, 'r', encoding='utf-8') as fh:
        doc = json.load(fh)
except (OSError, ValueError):
    doc = {}

if not isinstance(doc, dict):
    doc = {}

bucket = doc.get(key)
if not isinstance(bucket, dict):
    bucket = {}

bucket[name] = {
    "type": "local",
    "command": ["node", entry],
    "enabled": True,
}

doc[key] = bucket

parent = os.path.dirname(path)
if parent:
    os.makedirs(parent, exist_ok=True)

fd, tmp = tempfile.mkstemp(dir=parent or '.', prefix='.toolshed-', suffix='.json')
try:
    with os.fdopen(fd, 'w', encoding='utf-8') as fh:
        json.dump(doc, fh, indent=2, ensure_ascii=False)
        fh.write('\n')
    os.replace(tmp, path)
except BaseException:
    if os.path.exists(tmp):
        os.unlink(tmp)
    raise
PYEOF
}

write_codex_entry() {
  # codex uses TOML, which python's tomllib can read but not write.
  # The block is appended textually, inside a managed region, so the rest of
  # the file is never rewritten.
  "$PY" - "$1" "$2" "$3" <<'PYEOF'
import os, re, sys

path, name, entry = sys.argv[1:4]

BEGIN = "# >>> toolshed-mcp >>>"
END = "# <<< toolshed-mcp <<<"

block = (
    f"{BEGIN}\n"
    f"[mcp_servers.{name}]\n"
    f'command = "node"\n'
    f'args = ["{entry}"]\n'
    f"{END}\n"
)

try:
    with open(path, 'r', encoding='utf-8') as fh:
        text = fh.read()
except OSError:
    text = ""

pattern = re.compile(
    re.escape(BEGIN) + r'.*?' + re.escape(END) + r'\n?',
    re.DOTALL,
)
if pattern.search(text):
    text = pattern.sub(block, text)
else:
    if text and not text.endswith('\n'):
        text += '\n'
    text += '\n' + block

parent = os.path.dirname(path)
if parent:
    os.makedirs(parent, exist_ok=True)

tmp = path + '.toolshed.tmp'
with open(tmp, 'w', encoding='utf-8') as fh:
    fh.write(text)
os.replace(tmp, path)
PYEOF
}

# --------------------------------------------------------------------------
# Harness table.
# --------------------------------------------------------------------------

HARNESSES=()
if [ -n "$PROJECT_DIR" ]; then
  HARNESSES=(
    "claude-code|$PROJECT_DIR/.mcp.json|mcpServers|json"
    "puku-cli|$PROJECT_DIR/.puku-cli/mcp.json|mcpServers|json"
  )
else
  HARNESSES=(
    "claude-code|$HOME_DIR/.claude.json|mcpServers|json"
    "puku-cli|$HOME_DIR/.puku-cli/puku-cli.json|mcpServers|json"
    "opencode|$HOME_DIR/.config/opencode/opencode.json|mcp|opencode"
    "codex|$HOME_DIR/.codex/config.toml|mcp_servers|toml"
  )
fi

if [ "$MODE" = "list" ]; then
  echo "toolshed-mcp server entry: $ENTRY"
  echo
  for row in "${HARNESSES[@]}"; do
    IFS='|' read -r harness path key fmt <<<"$row"
    if [ -f "$path" ]; then
      state="config found"
    else
      state="config absent (will be created)"
    fi
    case "$fmt" in
      opencode) cmd="node $ENTRY (command array)" ;;
      toml) cmd="node $ENTRY ([mcp_servers.$SERVER_NAME])" ;;
      *) cmd="node $ENTRY ($key)" ;;
    esac
    printf '%-12s %s\n' "$harness" "$path"
    printf '%-12s   %s\n' "" "$cmd"
    printf '%-12s   %s\n' "" "$state"
  done
  exit 0
fi

# --------------------------------------------------------------------------
# Apply.
# --------------------------------------------------------------------------

CHANGED=0
SKIPPED=0

for row in "${HARNESSES[@]}"; do
  IFS='|' read -r harness path key fmt <<<"$row"

  if [ -f "$path" ] && [ "$FORCE" -eq 0 ]; then
    # The probe must match the format the harness actually stores the name in:
    # JSON quotes it, TOML puts it in a table header.
    already=0
    case "$fmt" in
      toml) grep -q "^\[mcp_servers\.$SERVER_NAME\]" "$path" 2>/dev/null && already=1 ;;
      *) grep -q "\"$SERVER_NAME\"" "$path" 2>/dev/null && already=1 ;;
    esac
    if [ "$already" -eq 1 ]; then
      echo "  $harness: already registered in $path — skipped (use --force to replace)"
      SKIPPED=$((SKIPPED + 1))
      continue
    fi
  fi

  # Keep a backup before the first write to a given file.
  if [ -f "$path" ]; then
    cp -p "$path" "$path.bak"
  fi

  case "$fmt" in
    opencode) write_opencode_entry "$path" "$key" "$SERVER_NAME" "$ENTRY" ;;
    toml) write_codex_entry "$path" "$SERVER_NAME" "$ENTRY" ;;
    *) write_json_entry "$path" "$key" "$SERVER_NAME" "$ENTRY" ;;
  esac

  echo "  $harness: registered in $path"
  CHANGED=$((CHANGED + 1))
done

echo
echo "toolshed-mcp: $CHANGED harness(s) written, $SKIPPED skipped."
echo
echo "The server only reads the corpora it can find. To point it elsewhere:"
echo "  TOOLSHED_SNA_ROOT=/path/to/Skills_n_Agents"
echo "  TOOLSHED_ECC_ROOT=/path/to/ECC"
echo "  TOOLSHED_SOURCES='[{\"id\":\"mine\",\"label\":\"Mine\",\"root\":\"/path\",\"origin\":\"local\",\"layout\":\"skill-dirs\"}]'"
echo
echo "Note: puku-cli's built-in Explore and Plan agent types are gated inside the CLI"
echo "bundle and cannot be restored by any MCP server. See the README for details."
