# extensions/ — dev ↔ live layout

## Tier 1: has a dev copy under `extensions/` (edit here → sync to live)

| Dev copy | Live | Upstream origin |
|---|---|---|
| `subagent-types/` | `~/.pi/agent/extensions/subagent-types/` | amosblomqvist/pi-subagents + roles/extensions from amosblomqvist/learn; the two-way channel + ask_question + name registry are original Paseo-specific design (interactive-subagents semantics) |
| `snip/` | `~/.pi/agent/extensions/snip/` | amosblomqvist/pi-config (prompt-snippets) |
| `quiz/` | `~/.pi/agent/extensions/quiz/` | amosblomqvist/learn (extensions/quiz.ts) |
| `ask-user-question/` | `~/.pi/agent/extensions/ask-user-question/` | amosblomqvist/pi-config, deliberate fork |
| `observational-memory/` | `~/.pi/agent/extensions/observational-memory/` | amosblomqvist/pi-observational-memory, near-verbatim port |

Sync (idempotent, hardened after the 2026-09-04 incident — see `sync-live.mjs`):

```bash
node extensions/sync-live.mjs            # sync every ext that has a dev copy
node extensions/sync-live.mjs snip quiz  # just a few exts
```

Anti-recurrence rules (consequences of the old `cp {*.ts,tests}` command):
- Per-ext `rsync --delete` — never `cp` into an existing dst (that nested `x/x/`).
- `--exclude '*.test.ts' --exclude 'node_modules'` at the live TOP LEVEL — the loader scans top-level `*.ts` + `*/index.ts`; a top-level test file kills pi (`bun:test` not found).
- Important: live IS `~/.pi/agent/extensions/` (not `.pi/extensions/` — the table above kept the old-workspace spelling for historical reference).
- Run `bun test` in the dev repo before syncing; after sync run `pi -p "reply OK"` to verify the loader is clean.

## Tier 2: live-only (self-contained packages, do NOT create a dev copy)

| Live | Why no dev copy | Upstream origin |
|---|---|---|
| `~/.pi/agent/extensions/visual-tools/` | own `node_modules` (@mermaid-js/mermaid-cli + chrome) — wasteful to duplicate; edit the live copy directly | amosblomqvist/learn (extensions/visual-tools) |
| `~/.pi/agent/extensions/web-fetch/` | own `node_modules` (readability/linkedom/turndown) | amosblomqvist/pi-config (extensions/web-fetch) |
| `~/.pi/agent/extensions/md-log.ts` | single file, no dependencies — edit directly | amosblomqvist/learn (extensions/md-log.ts) |

Tier-2 convention: edit the live copy directly, note the origin in the header comment (already there), never auto-create a dev copy.

## Important notes

- **Nothing comes from thin air**: every ext traces back to its author's repo (reference clones lived in `/tmp/ext-audit-2` — temporary; each file's header is the permanent record).
- Each file's header records origin + relation to neighboring tools (e.g. web-fetch vs the `pi-web-access` package in `~/.pi/agent/settings.json`).

## Blocking tools for the main agent (2026-09-02)

`subagent-types` supports a deny-list for the **main agent** (empty by default — opt-in). Add to the workspace `.pi/settings.json` (takes precedence) or `~/.pi/agent/settings.json` (everywhere):

```jsonc
{
  "subagentTypes": {
    "mainBlockedTools": ["safe_bash", "web_search", "web_fetch", "render_mermaid", "render_svg", "write_svg", "write_mermaid"]
  }
}
```

- Workspace beats user-wide. Applies to main only — subagent roles keep their own allowlists.
- The block is re-applied on every input, so tools registered late still get filtered.
- A toast confirms how many tools were blocked when it actually applies (idempotent, no spam).
- Do NOT block `spawn_subagent` / `message_subagent` / `message_main` — main would lose its communication path to children.
