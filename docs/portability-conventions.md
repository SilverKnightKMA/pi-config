# Portability & provider conventions (from audit #46)

Companion to `docs/audit-46/report.md`. Contracts contributors must know.

## Model fleet conventions

### Capability tags in models.json display names

`subagent-types` parses bracketed tags from the model `name` field, e.g.
`[DSeek-V4-Flash][FCI][T]`:

| tag | meaning |
|---|---|
| `[T]` | thinking/reasoning capable |
| `[V]` | vision capable (image input) |
| `[XL]` | extra-long context |

When you add models to `~/.pi/agent/models.json`, tag the `name` accordingly —
the spawn prompt picks `[V]`-tagged models for image tasks. Untagged models are
treated as text-only, no reasoning.

### Model fallback table (settings, not code)

`.md` role files may pin models that don't exist on this machine. The fallback
map lives in settings (workspace `.pi/settings.json` wins over user-wide
`~/.pi/agent/settings.json`):

```json
{
  "subagentModelFallback": [
    { "match": "^anthropic/claude-haiku", "fallback": "cli-openai/zaicp/glm-5.3-flash" }
  ]
}
```

`match` is a regex source; the first matching row whose `fallback` exists in the
machine's model list wins. A non-empty table **replaces** the built-in default
(below). Invalid regex rows are skipped, not fatal.

Built-in default (v1.4.x): haiku→`cli-openai/zaicp/glm-5.3-flash`,
sonnet/claude→`cli-openai/zaicp/glm-5.3`, `openrouter/z-ai/glm-5.3`→`cli-openai/zaicp/glm-5.3`.

Pinned defaults elsewhere (all individually overridable):
- task judge: `TASK_JUDGE_MODEL` env > `taskJudgeModel` settings > `cli-openai/fci/deepseek-v4-flash`
- OM workers: `observational-memory.models` in settings (observer/consolidator, each provider+id+thinking)
- paseo-subagents plugin roles: spawn-request `model` param > per-role default

### sse-probe is a zaicp-specific diagnostic

`extensions/sse-probe` probes the zaicp SSE route shape. It is a diagnostic
tool by design — **exclude it from portability gates**; provider-specific
behavior there is expected.

## Windows / cross-platform contributor notes

- **Line endings**: the repo pins LF in the working tree via `.gitattributes`
  (`* text=auto eol=lf`). This intentionally overrides a machine's
  `core.autocrlf=true`; test fixtures compare multi-line strings and assume LF.
- **bun not on PATH is normal**: run tools by absolute path or rely on
  `process.execPath`. Scripts/tests must never spawn bare `"bun"`/`"cat"`/
  `"mkdir"` (Windows has no such executables; npm `.cmd` shims won't spawn
  without a shell). Use `node:fs` (`writeFileSync`, `mkdirSync`) and
  `process.execPath` instead.
- **No POSIX mode bits on NTFS**: `statSync().mode` is always 0666; `chmod` is
  a no-op. Tests asserting `0o600` skip on `win32`.
- **Symlinks**: Windows Git checks out symlinks as plain files
  (`core.symlinks=false` default). Never commit symlinks — share code by copy
  or real installs (the repo's last tracked symlink was removed in
  paseo-plugins v1.0.80 after it broke Windows installs).
- **Path separators**: `node:path` joins for anything touching the filesystem;
  normalize to `/` only for on-disk format contracts read back across
  platforms (see OM INDEX.md rendering).
- **readdir order is not creation order**: ext4 returns hash order, overlayfs
  creation order — always `.sort()` before indexing directory listings.
- **Await file writes in tests**: an un-awaited `Bun.write` truncates the file
  concurrently with subsequent reads; NTFS timing exposes it as flaky tests.
  Use `writeFileSync` in synchronous test bodies.
