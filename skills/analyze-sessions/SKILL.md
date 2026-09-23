---
name: analyze-sessions
description: Analyze Paseo agent sessions across all providers (omp, pi, claude, codex, copilot, opencode, factory-droid). Use when the user asks about cost (totals, per workspace, per provider, per model, per day), wants to mine prompting patterns from past prompts, view a specific past agent's transcript, or search across all session transcripts.
---

# Analyze Sessions

Tools for querying every Paseo agent session on this machine. All scripts are stdlib Python 3, no dependencies, and read directly from `~/.paseo/agents/` plus each agent's native transcript.

## Data shape (one-liner)

Each agent is a JSON record `~/.paseo/agents/<workspace-dir>/<agentId>.json` (provider, title, cwd, model, timestamps, archived flag) plus a `persistence.nativeHandle` pointing at the provider-native transcript — for omp/pi that's a JSONL session file with `message` records (roles: `user`, `assistant`, `toolResult`), where assistant messages carry `usage.cost` split into input/output/cacheRead/cacheWrite/total. Agents whose provider keeps transcripts elsewhere (claude, codex, ...) still appear as rows, with metadata only.

## Rule: every command is BOUNDED (mandatory)

Agent context is a hard ceiling and transcripts here run to hundreds of MB (the main
learn session is 500MB+). A single unbounded command can eat the whole window.
Before running anything that touches agent records or transcripts, make sure it
has an explicit output cap — otherwise add one:

- Use the scripts' own limits: `--limit-hits N`, `--limit N`, `--since <window>`.
  Prefer the smallest window that answers the question (e.g. `--since 7d`, not all-time).
- Shell pipes: always end with `head -N` (e.g. `| head -20`), never print a raw file.
- Python one-liners: cap collections before printing (`rows[-12:]`, `text[:200]`),
  and stream files with `for line in fh` — never `read_text()` (OOM on big transcripts).
- Never `cat`/`read` a transcript JSONL wholesale; extract fields and slice.
- If a probe legitimately needs a big scan, print ONLY counts + the N matching rows.

## Rule: probe before you parse (mandatory)

The transcript shape changes across pi versions — never hand-parse from memory. Before writing
any code that reads a transcript JSONL, run exactly one verification step on the file you will
query:

    python3 scripts/paseo_probe.py <file.jsonl> [--sample 200]

It prints the record types present, the observed field paths (dot notation, `[]` marks array
elements), and the distribution of `message.role` / `message.content[].type` values. Build your
query from the paths it PRINTS — when pi changes shape, the probe reports the new shape, so there
is no frozen shape documentation here to go stale.

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

# One workspace — beware: with NO time filter, cost defaults to --since 7d.
# For true all-time pass an explicit wide bound:
python3 scripts/paseo_cost.py --workspace learn --since 1970-01-01

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
| `om-observer` / `om-consolidator` | observational-memory worker subprocesses — plain pi sessions under `~/.pi/agent/sessions/<ws>-.memory-<id>--/`, named `om-observer-*` / `om-consolidator-*`. Included automatically: cost, message counts, and prompts all roll up like any other session. Filters apply: `--provider` must be `pi` (workers are pi runs), `--cwd` matches the `.memory` bucket path.

```bash
# Cost split by session kind
python3 scripts/paseo_cost.py --since 30d --by kind
```

### `paseo_subagents.py` — per-child-run subagent cost (O1, #105)

Splits the subagent kind into PER-RUN rows with parent mapping
(labels `subagent.role` + `subagent.parent`), cost from each child's own
transcript. Double-count guards: records sharing one persistence.sessionId
count once (newest activity wins, dups reported); missing transcripts are
flagged `no-transcript`, never silently dropped. Verified 2026-09-16: total
matches `paseo_cost.py --by kind` subagent line exactly ($8.1174 / 115 runs).

```bash
python3 scripts/paseo_subagents.py --since 30d --by run --limit 10   # most expensive children
python3 scripts/paseo_subagents.py --since 30d --by role             # worker/researcher/scout rollup
python3 scripts/paseo_subagents.py --since 30d --by parent           # cost per parent agent
python3 scripts/paseo_subagents.py --since 30d --json                # machine-readable
```

Groupings: `run` (default) | `role` | `parent` | `total`. Shared filters apply.

### `ccusage_crosscheck.py` — independent audit vs ccusage (O5, #105)

`ccusage` v20+ (installed as a global external CLI, `npm i -g ccusage`)
reads pi sessions natively via its `pi` subcommand. This script diffs its
`pi session --json` totals against a direct scan of the same JSONL: token
totals MUST match exactly (both sides sum input/output/cacheRead/cacheWrite
per assistant record); $ comes from different price tables in general, so
the ratio is reported, not failed. 2026-09-16 result: 30/30 sessions
token-exact, cost ratio 1.00x (ccusage honors pi's provider-reported cost
for pi model ids).

```bash
python3 scripts/ccusage_crosscheck.py --limit 30      # newest N sessions
python3 scripts/ccusage_crosscheck.py --session <sid-prefix>
```

Exit 0 = PASS (all compared sessions token-exact), 1 = INVESTIGATE, 2 =
ccusage failed to run.

### `om_worker_cost.py` — OM-worker cost rebuilt from transcripts (#32)

The `.memory/<sid>/.runs/*.cost.json` files are a durable cache; the worker transcripts
at `~/.pi/agent/sessions/<ws>-.memory-<sid>--/*.jsonl` are the SOURCE OF TRUTH (verified
5/5 exact match 2026-09-16). This script REPLACES the .runs analysis role and gates their GC:

```bash
# cost per parent bucket (default), per role (observer/consolidator), per day, total
python3 scripts/om_worker_cost.py --by role

# pre-GC gate: every .runs dollar must be covered by the transcript sum
python3 scripts/om_worker_cost.py --verify
# verdict SAFE_TO_GC = runs ≤ transcript (+0.005 tol); MISMATCH-cache-overclaims = investigate

# what a GC would delete: .runs cost files older than N days + the $ a rollup must retain
python3 scripts/om_worker_cost.py --gc-plan 7

python3 scripts/om_worker_cost.py --self-test   # 8/8
```

Role classification probes the first 4KB of each transcript (consolidator prompt marker:
"You are folding the observations") — no shape assumptions beyond the probed
`usage.cost.total` path.

### `anomaly_report.py` — deterministic anomaly analysis

Ranked anomaly report over sessions + `~/.pi/agent/sse-probe.jsonl` + `~/.pi/agent/zombie-watchdog.jsonl` + OM worker-run costs. Stdlib only, no model calls.

```bash
# Markdown report, last 7 days (default window)
python3 scripts/anomaly_report.py

# Wider window / machine-readable
python3 scripts/anomaly_report.py --days 30
python3 scripts/anomaly_report.py --json

# Append act-now findings to the ops notebook (~/.pi/agent/anomaly-notebook.md)
python3 scripts/anomaly_report.py --record

# Assert the pure statistics functions (robust z, Wilson, episode merge)
python3 scripts/anomaly_report.py --self-test
```

Design contracts (enforced in code):

- **Severity tiers**: `act-now` (only findings at most 2 days old with Wilson-supported rate separation, SSE clusters, stale critical sources) vs `trend` (older or weaker) vs `info` (raw counts where the denominator is too small to judge).
- **Unknown stays unknown**: fewer than 5 baseline points → counts only, never a flag; rates below a 10-event denominator are never reported as rates.
- **Statistics**: median/MAD robust z (x0.6745) on log-transformed cost/tokens; MAD=0 is an explicit branch; the evaluated point never sits in its own baseline; adjacent flagged hours merge into one episode.
- **Every metric carries its action** (switch provider, inspect session, check producer) — a metric with no action would not exist.
- **Attribution localizes, never convicts**: findings name the edge (provider↔agent); fault-side confirmation is human work, recorded via `--record` as UNCONFIRMED notebook lines.

Metrics: stopReason/abort rate per providerxday, empty-stop silent turns (E35 class), session cost outliers (floor $1), completion-token spikes, volume drops, SSE-drop clusters + drop↔abort join, zombie rate + watchdog silence, OM worker cost, source freshness (monitor-of-monitors).

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

Each hit prints the agent header (id prefix, provider, title) so you can drill in with `paseo_show.py <prefix>` — EXCEPT OM-worker hits: workers have no paseo record, so read their transcript directly at `~/.pi/agent/sessions/<bucket>/<worker-id>....jsonl`.

## Shared filters

Available on `paseo_cost.py`, `paseo_prompts.py`, `paseo_search.py` — NOT `paseo_show.py` (it takes only a positional id + `--max-chars`) and NOT `anomaly_report.py` (own flags: `--days/--json/--record/--self-test`):

| Flag | Meaning |
|---|---|
| `--since WHEN` / `--until WHEN` | `YYYY-MM-DD`, ISO datetime, or relative `Nd`/`Nh` ONLY (`7d`, `3h` — no `2w`/`30m`). Bounds are by LAST ACTIVITY, not creation: an old-but-still-running agent stays visible |
| `--provider NAME` | `omp`, `pi`, `claude`, `codex`, `copilot`, `opencode`, `factory-droid` |
| `--workspace SUBSTR` | Substring match on the workspace directory name (e.g. `learn`) |
| `--cwd SUBSTR` | Substring match on the agent's real `cwd` |
| `--session ID` | Agent id or prefix (8 chars usually unique) |
| `--limit N` | `paseo_cost.py` ONLY — caps groups, not agents, in group views. prompts/search have no `--limit` (search uses `--limit-hits`; a stray `--limit` gets argparse-abbreviated to it silently) |
| `--include-archived` | Include archived agents (excluded by default) |

## Common queries

| Question | Command |
|---|---|
| Total cost in the last 7 days | `python3 scripts/paseo_cost.py --since 7d --by total` |
| Daily spend trend, last 30 days | `python3 scripts/paseo_cost.py --since 30d --by day` |
| Cost split main vs subagent vs om workers | `python3 scripts/paseo_cost.py --since 30d --by kind` |
| Which parent spent what on children | `python3 scripts/paseo_subagents.py --since 30d --by parent` |
| Audit pi token/cost numbers independently | `python3 scripts/ccusage_crosscheck.py --limit 30` |
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
