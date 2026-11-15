# toolshed-mcp

One MCP server that gives **any** coding agent the tools this machine already has:
every skill, agent and slash command in every corpus on disk, plus a proxy onto
external MCP servers, plus GitHub as a runtime source.

It stands alone. It does not import, link against, spawn or proxy through
`skills-library`, `orchestrator` or `verifier` — with one deliberate exception,
the install path, described below.

---

## Install

```bash
git clone https://github.com/ashikonik/toolshed-mcp.git
cd toolshed-mcp
npm install
npm run build
bash scripts/install.sh --list     # print the resolved command per harness, write nothing
bash scripts/install.sh --apply    # register into every harness found
```

`--apply` is idempotent: it refuses to replace an existing registration of the
same name. `--force` replaces it. `--project <dir>` writes project-scoped config
for the harnesses that support it.

The server is always launched as `node <abs path>/dist/index.js` — never `npx -y`,
never `bunx`. It must start offline, from a known version.

### Harness matrix

| Harness | Config | Format |
|---|---|---|
| claude-code | `~/.claude.json` | JSON, `mcpServers` |
| puku-cli | `~/.puku-cli/puku-cli.json` | JSON, `mcpServers` |
| opencode | `~/.config/opencode/opencode.json` | JSON, `mcp` key, `type:"local"`, command as an **array** |
| codex | `~/.codex/config.toml` | TOML, `[mcp_servers.toolshed]` |

Each harness keeps its registrations in its own file with its own schema, so the
installer detects the schema per harness rather than assuming one. A `.bak` is
written before the first change to any file.

---

## The tools

| Tool | What it does |
|---|---|
| `search_registry` | Ranked BM25 search across every corpus, filtered by source or kind |
| `get_entry` | One skill, agent or command: frontmatter, body, provenance |
| `get_entry_bundle` | The entry plus its supporting files |
| `list_sources` | Every corpus, its root and how many entries it contributed |
| `list_mcp_servers` | MCP servers on this machine, installed vs configured-only |
| `list_agent_types` | Per-harness agent types actually available, and any missing built-ins |
| `add_github_source` | Register `owner/repo` as a source: fetch, index, make searchable |
| `install_skill_from_github` | Fetch one skill from `owner/repo/path` and install it into a harness |
| `proxy_call` | Invoke a tool on a connected external MCP server, as `server__tool` |
| `proxy_discover` | List the tools of a connected external server |

Every write tool takes `apply` and defaults to a dry run. Every tool declares all
four MCP annotations, and every handler returns an error result rather than
throwing.

---

## Deduplication, and why provenance matters

Several corpora on a typical machine overlap heavily — the same skill copied into
two trees. The registry collapses an entry only when **both its name and its
content hash** match, so a genuine content revision under the same name survives
as a second entry.

A byte-identical copy is collapsed, but the corpus it came from is not lost: it
is recorded on the surviving entry as an alias, and surfaces as `also-in:` in
`get_entry` and as `aliases` in `search_registry` hits. `list_sources` reports
what each corpus *contributed*, so a corpus whose skills all exist verbatim
elsewhere still shows a non-zero count instead of reading as empty.

```console
$ toolshed-mcp → get_entry skill:sna:api-design
# api-design
kind: skill
source: sna
also-in: ecc-agent-skill
id: skill:sna:api-design
```

---

## The delegation contract with `skills-library`

For a skill fetched from GitHub, the toolshed **fetches and indexes**; it never
writes into a harness directory itself. The install is delegated over MCP to
`skills-library`, which owns the path whitelist, the tier policy and the
dry-run rule — and which applies its own gates. The toolshed's own registry
handles local-corpus reads; only the GitHub install path crosses the seam.

Two details make that seam work:

- `skills-library` resolves ids against **its own** index, so a GitHub skill
  must be staged into a corpus it can see before it can be installed. The
  toolshed writes the staged corpus and points `SKILLS_LIBRARY_ROOT` at it.
- `skills-library` reads further top-level fields out of the index at startup
  (`packs`, `domains`, …) and throws on the first one that is missing. The
  toolshed therefore **merges** into the existing index document rather than
  replacing it, changing only the `skills` array and keeping `counts` in step.

A delegated install looks like this — note the policy refusal, which is
`skills-library`'s, not the toolshed's:

```console
$ toolshed-mcp → install_skill_from_github {repo, path, harness, apply:true}
Installed 'docx' into claude-code via skills-library.
{ "gated": true, "rule": "SL-3", "reason": "Overwriting replaces something that is already there…" }
```

---

## The `Explore` bug, and what a registry can and cannot do

`Error: Agent type 'Explore' not found. Available agents: general-purpose` is a
bug in **puku-cli's shipped bundle**, not in any MCP server. The bundle contains

```js
function mCe(){return!1}
```

which gates `Explore` and `Plan` out of the built-in agent list. `general-purpose`
is added unconditionally, which is why only it appears in the error message. The
agent-type registry lives in the CLI's own process, so **an MCP server cannot
extend it** — no MCP server, including this one, can restore those two built-ins.

What this server does do is make the gap **visible**:

- `list_agent_types` reports, per harness, which agent types are actually
  available, and names the missing built-ins:

```console
$ toolshed-mcp → list_agent_types
puku-cli: general-purpose, code-reviewer  MISSING BUILT-IN: Explore, Plan
claude-code: general-purpose
opencode: general-purpose
codex: general-purpose, a11y-architect, agent-evaluator, …
```

- `scripts/install.sh` prints the same note when it finishes.

### The portable half, which is the one that matters

The genuinely useful half is an agent *file* any harness can load, and that does
not depend on the bundle. puku-cli reads personal agents from
`~/.puku-cli/agents/*.md`, so `skills-library`'s `install_agents` was extended to
support puku-cli:

```console
$ skills-library → install_agents {harness:"puku-cli", ids:["agent:code-reviewer"], apply:true}
{ "status": "written", "path": "~/.puku-cli/agents/code-reviewer.md" }

$ puku-cli agents
2 active agents

User agents:
  code-reviewer · inherit

Built-in agents:
  general-purpose · inherit
```

That change lives in the **authoring package**, not in the published copy of the
skills-library, because the published tree is regenerated from it and a hand edit
there would be wiped on the next rebuild.

### The one-line patch, if you want the built-ins back

For the built-ins themselves, the patch is a single byte in the installed bundle:

```bash
# at ~/.npm-global/lib/node_modules/@puku/puku-cli/dist/cli.mjs
#   function mCe(){return!1}   →   function mCe(){return!0}
```

**This is documented, not applied.** Two reasons not to apply it silently: it is a
vendor file, and `npm update -g @puku/puku-cli` will revert it. Apply it
deliberately if you want it, and re-apply after upgrades.

---

## GitHub as a runtime source

`add_github_source` fetches a repository, indexes its `SKILL.md` files and makes
them searchable like any local corpus.

### How the fetch works

The fetch is a **blobless partial clone** with a sparse checkout restricted to
the conventional skill paths. The server is asked for tree objects only, and
the blobs for the paths that matter are fetched on demand.

This matters because a GitHub archive is unbounded. The `expo/exact` archive is
**212 MB** and holds **eight skill files**. The sparse clone of the same
repository is **39 KB** of skill files and about **3 MB** on disk:

| Repository | Archive route | Sparse clone route |
|---|---|---|
| `expo/exact` | 212 MB, 8 entries | 3 MB, 8 entries |
| `anthropics/skills` | 12 MB, 20 entries | 1 MB, 20 entries |

A registry that indexes skills has no use for a repository's assets, source
code or history, so it does not download them.

The archive route from `codeload` remains as a **fallback**, for repositories
where git is unavailable or the sparse clone finds nothing.

### Safety properties, all of them tested

- **Dry run by default.** `apply: true` is required to write anything.
- **A token is never echoed.** `GITHUB_TOKEN` is read from the environment and
  redacted from every error message before it can reach a log or a tool result.
- **Path-traversal guards on every archive entry.** An entry whose resolved path
  would escape the destination is refused, and one bad entry does not kill the
  whole archive.
- **A skill path is validated** before anything is fetched or written: no
  absolute paths, no `..`, no separators.
- **A download cap.** The archive route refuses to exceed
  `TOOLSHED_MAX_DOWNLOAD_BYTES` (50 MB by default) and says what to change. The
  sparse route is bounded by the sparse checkout itself.

`install_skill_from_github` fetches one skill and hands the install to
`skills-library`, as described above. The requested path is added to the sparse
checkout patterns, so a skill in an unusual location is still found.

---

## The proxy

The proxy is what makes this a shed rather than a viewer. It connects to
**external** MCP servers you list in `~/.toolshed/proxies.json` and exposes their
tools under a `server__` namespace.

```json
{
  "targets": [
    {
      "name": "library",
      "command": "node",
      "args": ["/path/to/skills-library-mcp/dist/index.js"],
      "timeoutMs": 15000
    }
  ]
}
```

```console
$ toolshed-mcp → proxy_discover {server:"library"}
library__search_library  Rank skills and agents by relevance to a query…
library__get_skill       Returns one skill: its SKILL.md body…

$ toolshed-mcp → proxy_call {server:"library", tool:"library__search_library", arguments:{…}}
```

A server that hangs is timed out and **killed**, process group and all, so it
cannot outlive the call or linger as an orphan. The timeout is per target.

The proxy does not reach the already-connected local servers: the toolshed is
independent of them by design.

---

## Configuration

Paths are runtime configuration, never build artefacts, so the published package
carries no absolute path to any machine.

| Variable | Meaning |
|---|---|
| `TOOLSHED_SNA_ROOT` | Root of the skills-and-agents corpus |
| `TOOLSHED_ECC_ROOT` | Root of the ECC corpus |
| `TOOLSHED_EXACT_ROOT` | Root of the expo/exact corpus |
| `TOOLSHED_SOURCES` | JSON array of extra source definitions |
| `TOOLSHED_HOME` | Where the cache and the source registry live (default `~/.toolshed`) |
| `TOOLSHED_CACHE_ROOT` | Where fetched repositories are cached |
| `TOOLSHED_PROXY_CONFIG` | Where the proxy target list lives (default `~/.toolshed/proxies.json`) |
| `TOOLSHED_FETCH_TIMEOUT_MS` | How long a repository fetch may take (default 600000) |
| `TOOLSHED_MAX_DOWNLOAD_BYTES` | The largest archive the fallback route will download (default 52428800) |

`TOOLSHED_SOURCES` takes a JSON array of source definitions:

```json
[
  { "id": "mine", "label": "My skills", "root": "/path/to/skills", "origin": "local", "layout": "skill-dirs" }
]
```

Layouts: `skill-dirs`, `skill-files`, `agent-files`, `command-files`,
`agent-skill-dirs`, `github-tree`.

---

## Live reload

The registry is derived from files on disk, so it must not go stale. Each source
is fingerprinted (`mtimeMs` + `size` + file count) on every call, and the
registry is rebuilt when a fingerprint changes. A corpus that fails to load keeps
serving its last known entries, and the error is surfaced in the "not found"
message so the caller knows the entry may exist on disk.

The skills-and-agents corpus is read through its `index.json` artefact, which is
a *build output*. If that index is stale, so is the registry's view of that
corpus — rebuild the library and the toolshed picks the change up on the next
call, with no restart.

---

## Development

```bash
npm run build
bash scripts/run-tests.sh
```

The test suite runs in-process over the MCP SDK's `InMemoryTransport`. The
wrapper **fails when zero tests ran**, because a green run that ran nothing is
worse than a red one.

Layout:

```
src/
  index.ts         # the only file that knows stdio
  server.ts        # the tool surface
  registry.ts      # the union index, dedupe, BM25 search
  sources.ts       # per-corpus discovery and parsing
  frontmatter.ts   # tolerant YAML reader, key normalisation
  mcp-servers.ts   # local MCP servers, installed vs configured-only
  agent-types.ts   # per-harness agent-type probe
  github.ts        # fetch, cache and index a GitHub source
  proxy.ts         # stdio client for external MCP servers
  delegate.ts      # the skills-library delegation seam
  results.ts       # asText / asError helpers
  types.ts
  tests/
```

stdout carries protocol traffic only; diagnostics go to stderr with a
`[toolshed]` prefix.

---

## Licence

MIT. See [LICENSE](LICENSE).
