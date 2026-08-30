---
name: analyze-sessions
description: Analyze Paseo agent sessions across all providers (omp, pi, claude, codex, copilot, opencode, factory-droid). Use when the user asks about cost (totals, per workspace, per provider, per model, per day), wants to mine prompting patterns from past prompts, view a specific past agent's transcript, or search across all session transcripts.
---

# Analyze Sessions

Tools for querying every Paseo agent session on this machine. All scripts are stdlib Python 3, no dependencies, and read directly from `~/.paseo/agents/` plus each agent's native transcript.

## Data shape (one-liner)

Each agent is a JSON record `~/.paseo/agents/<workspace-dir>/<agentId>.json` (provider, title, cwd, model, timestamps, archived flag) plus a `persistence.nativeHandle` pointing at the provider-native transcript — for omp/pi that's a JSONL session file with `message` records (roles: `user`, `assistant`, `toolResult`), where assistant messages carry `usage.cost` split into input/output/cacheRead/cacheWrite/total. Agents whose provider keeps transcripts elsewhere (claude, codex, ...) still appear as rows, with metadata only.

## Scripts

All scripts share the same filter vocabulary (see "Shared filters" below). Run them with `python3` from the skill's `scripts/` directory:

```bash
python3 scripts/<script>.py [args]
```

Run from the skill directory, or substitute the absolute `scripts/` path.

### `paseo_cost.py` — cost rollups

```bash
# Last 7 days, broken down by day (default)
python3 scripts/paseo_cost.py

# Last 30 days, top 10 workspaces by spend
python3 scripts/paseo_cost.py --since 30d --by workspace --limit 10

# Cost-per-provider / per-model
python3 scripts/paseo_cost.py --since 30d --by provider
python3 scripts/paseo_cost.py --since 30d --by model

# The 10 most expensive agents of the last month
python3 scripts/paseo_cost.py --since 30d --by agent --limit 10

# One workspace, all time
python3 scripts/paseo_cost.py --workspace learn

# Grand total only
python3 scripts/paseo_cost.py --since 30d --by total

# Machine-readable
python3 scripts/paseo_cost.py --since 30d --by day --json
```

Groupings: `total`, `day`, `workspace`, `provider`, `model`, `kind`, `agent`. When grouping, `--limit` caps groups, not agents.

`kind` splits cost across the four session kinds on this machine:

| Kind | Meaning |
|---|---|
| `main` | Human-created agent (no subagent label) |
| `subagent` | Spawned via `spawn_subagent` (label `subagent.role`) |
| `om-observer` / `om-consolidator` | observational-memory worker subprocesses — plain pi sessions under `~/.pi/agent/sessions/<ws>-.memory-<id>--/`, named `om-observer-*` / `om-consolidator-*`. Included automatically: cost, message counts, and prompts all roll up like any other session.

```bash
# Cost split by session kind
python3 scripts/paseo_cost.py --since 30d --by kind
```

### `paseo_prompts.py` — dump user prompts for pattern mining

Output is markdown grouped by workspace (`--format jsonl` available). Prompts above `--max-chars` are dropped because they're almost always pasted context, not actual prompting.

```bash
# Default: markdown dump, max 2000 chars per prompt
python3 scripts/paseo_prompts.py --since 30d

# Tighter cap, one prompt per JSONL line
python3 scripts/paseo_prompts.py --since 7d --max-chars 1500 --format jsonl

# One workspace's prompts
python3 scripts/paseo_prompts.py --workspace learn --since 30d
```

The typical workflow for "find patterns I could turn into snippets": dump prompts, group by recurring themes (same correction repeated across sessions, same setup question, same complaint), then propose snippet files (see Notes).

### `paseo_show.py` — render one agent's transcript as markdown

```bash
# A specific agent by id prefix (8 chars is enough)
python3 scripts/paseo_show.py 019e475b

# More/less text per message
python3 scripts/paseo_show.py 019e475b --max-chars 4000
```

Prints the agent header (provider, model, workspace, cwd, timestamps, archived) followed by USER/ASSISTANT turns; each assistant message shows its own cost, and the transcript total is printed at the end.

### `paseo_search.py` — search across transcripts

Regex by default (case-insensitive), `--literal` for substring. Searches user and assistant text by default.

```bash
# Regex across everything
python3 scripts/paseo_search.py "supabase RLS"

# Only user prompts, last 60 days
python3 scripts/paseo_search.py "global instruction" --prompts-only --since 60d

# Literal string, more context per match
python3 scripts/paseo_search.py "rate limit" --literal --context 3
```

Each hit prints the agent header (id prefix, provider, title) so you can drill in with `paseo_show.py <prefix>`.

## Shared filters

Available on **all four scripts**:

| Flag | Meaning |
|---|---|
| `--since WHEN` / `--until WHEN` | `YYYY-MM-DD`, ISO datetime, or relative: `7d`, `2w`, `3h`, `30m` |
| `--provider NAME` | `omp`, `pi`, `claude`, `codex`, `copilot`, `opencode`, `factory-droid` |
| `--workspace SUBSTR` | Substring match on the workspace directory name (e.g. `learn`) |
| `--cwd SUBSTR` | Substring match on the agent's real `cwd` |
| `--session ID` | Agent id or prefix (8 chars usually unique) |
| `--limit N` | Cap items returned (caps groups, not agents, for `paseo_cost.py` group views) |
| `--include-archived` | Include archived agents (excluded by default) |

## Common queries

| Question | Command |
|---|---|
| Total cost in the last 7 days | `python3 scripts/paseo_cost.py --since 7d --by total` |
| Daily spend trend, last 30 days | `python3 scripts/paseo_cost.py --since 30d --by day` |
| Cost split main vs subagent vs om workers | `python3 scripts/paseo_cost.py --since 30d --by kind` |
| Most expensive workspaces this month | `python3 scripts/paseo_cost.py --since 30d --by workspace --limit 10` |
| Cost of one workspace | `python3 scripts/paseo_cost.py --workspace learn` |
| Patterns in my prompting | `python3 scripts/paseo_prompts.py --since 30d --max-chars 1500` → read the output |
| What did the agent do yesterday | `python3 scripts/paseo_show.py <id-prefix>` |
| Find old session about X | `python3 scripts/paseo_search.py "X"` |

## Notes

- All paths are read-only; the scripts never modify agent records or transcripts.
- The library (`scripts/paseo_sessions.py`) is reusable: import it for ad-hoc analysis.
- Cost data comes from native transcripts (omp/pi). Providers without a readable transcript contribute rows with $0.00 — totals are lower bounds for those agents.
- Turn recurring instructions into snippets: write a markdown file (frontmatter `name/description/placement: prepend|append/order`) into `.pi/extensions/snip/snippets/`. New files appear in `/snip` immediately.
