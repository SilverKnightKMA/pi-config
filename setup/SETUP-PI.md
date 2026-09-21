# SETUP-PI — install pi + the pi-config pack from scratch (part 1/2)

> **⚠️ Two-repo system — this repo does NOT work on its own.**
> The pack's extensions (subagent-types, task, goal, plan, snip…) communicate with the Paseo daemon through disk + MCP channels. Without Paseo and its plugins: subagents cannot spawn, task/goal/plan wakes do not run, and markers do not appear in panels.
> **After finishing this file, you must continue with:** [`SETUP-PASEO.md` in the paseo-plugins repo](https://github.com/SilverKnightKMA/paseo-plugins/blob/main/setup/SETUP-PASEO.md)

This guide is for an **agent** to read and execute on a clean machine. It covers **Linux, macOS, and native Windows** (PowerShell).

## 0. Prerequisites

| Requirement | Linux/macOS | Native Windows |
|---|---|---|
| Node.js ≥ 20 + npm | nodejs.org or package manager | nodejs.org installer (select *Add to PATH*) |
| Git | git | **Git for Windows** (git-scm.com) — includes both `git` and `bash.exe`; some extensions invoke bash, which Git for Windows provides through PATH |

Check: `node --version`, `npm --version`, `git --version` — all three must run in your current shell (PowerShell on Windows).

Config paths by OS:

| OS | pi config path |
|---|---|
| Linux/macOS | `~/.pi/agent/…` and `~/.pi/web-search.json` |
| Native Windows | `%USERPROFILE%\.pi\agent\…` and `%USERPROFILE%\.pi\web-search.json` |

## 1. Install pi (always latest — not pinned)

```bash
npm install -g @earendil-works/pi-coding-agent
pi --version
```

## 2. Get this pack

```bash
git clone https://github.com/SilverKnightKMA/pi-config.git
cd pi-config
```

## 3. Install the pack (extensions + skills + external npm packages)

```bash
node scripts/install-pack.mjs
```

One command does all three: syncs `extensions/` (15 extensions) + `skills/` (10 skills) into the pi directory, then installs two external packages (`pi-mcp-adapter`, `pi-web-access`). The script detects the environment: it uses rsync when available, otherwise (on native Windows) it uses a pure-Node mirror, with the same result.

## 4. Set up config from samples

Copy three files from `setup/samples/` to the pi config directory (use the path table in step 0), then fill in the `<PLACEHOLDER>` values according to the FILL-IN table below. **The agent must ask the user for these values — never invent them.**

| Destination file | Sample source | Placeholders to fill in |
|---|---|---|
| `~/.pi/agent/settings.json` | `setup/samples/pi-settings.json` | `<FAST-MODEL-ID>`, `<MAIN-MODEL-ID>`, `<REASONING-MODEL-ID>` (IDs of models registered in the models file) |
| `~/.pi/agent/models.json` | `setup/samples/pi-models.json` | `<YOUR-API-KEY>`, `<YOUR-OPENAI-COMPATIBLE-ENDPOINT>`, `<THINKING-FORMAT>`, `<MODEL-ID>`, `<MODEL-NAME>` (+ actual pricing) |
| `~/.pi/web-search.json` | `setup/samples/pi-web-search.json` | `<YOUR-EXA-API-KEY>`, `<YOUR-JINA-API-KEY>`, `<YOUR-SEARXNG-HOST>:<PORT>` (omit this file if web search is not used) |

Shape notes:
- `models.json`: an OpenAI-compatible provider entry (`api: "openai-completions"`). Add as many models as needed — one object per model in the `models` array. `THINKING-FORMAT` tells pi how to send reasoning for reasoning-model families — see the pi docs for supported values; omit the key for non-reasoning models.
- `settings.json` → `observational-memory`: the observer should be a cheap/fast model, while the consolidator should be a strong reasoning model — this is the long-term memory engine, and with the right configuration the system learns after every session.
- Leave `packages` unchanged — the installer has already registered them.

## 5. Verify pi

```bash
pi -p "reply OK"
```

Must pass: pi replies with no loader stack trace. Check that the tree is complete:

```bash
ls ~/.pi/agent/extensions        # 15 extension directories (Windows: dir %USERPROFILE%\.pi\agent\extensions)
```

## 6. Required: install Paseo next

At this point pi runs, but **the pack is not operational yet** — subagent/task/goal/plan require the Paseo daemon and plugin panels. Continue with:

**➡️ [SETUP-PASEO.md — repo paseo-plugins](https://github.com/SilverKnightKMA/paseo-plugins/blob/main/setup/SETUP-PASEO.md)**

---

## Migrate personal data (optional, not stored in the repo)

The repo contains only the configuration skeleton. The following data must NOT be committed to any repo — copy it manually from the old machine if available:

| Data | Path | If lost |
|---|---|---|
| Provider OAuth tokens | `~/.pi/agent/auth.json` | Log in to each provider again (`/login`) |
| Folded lessons | `~/.pi/agent/lessons.md` | Lost permanently — OM builds these over time |
| OM memory | `<workspace>/.memory/` | Lost permanently |
| Board task/goal | `~/.pi/agent/task-status/`, `goal-status/`, `plan-control/` | Fresh start |
| Paseo state | see the corresponding table in SETUP-PASEO.md | — |
