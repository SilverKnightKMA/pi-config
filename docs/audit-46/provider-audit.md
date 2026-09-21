# Audit #46 — Model-provider audit (step 5/6)

Question (user requirement 2026-09-13): extensions must not depend on any specific model provider.

## Static map — every model/provider reference in runtime code

| site | reference | override path | verdict |
|---|---|---|---|
| `extensions/task/index.ts:71` | `DEFAULT_JUDGE_MODEL = "cli-openai/fci/deepseek-v4-flash"` | `TASK_JUDGE_MODEL` env > `taskJudgeModel` settings (index.ts:88-92, 4-line chain verified in source) | pinned DEFAULT, **overridable** — adapt (cosmetic) |
| `extensions/observational-memory/src/config.ts:60-61` | observer+consolidator default `{provider:"openrouter", id:"z-ai/glm-5.3"}` | settings `observational-memory.models` per role | pinned DEFAULT, **overridable — LIVE PROOF: production settings run observer=`fci/deepseek-v4-flash`, consolidator=`mmcp/MiniMax-M3`** (heterogeneous fleet in daily use) |
| `paseo-plugins/.../server/roles.ts:132-136` | 5 role defaults `model:"fci/deepseek-v4-flash"` | spawn request `model` param (roles.ts:170 `override.model`) | pinned DEFAULT, overridable |
| `extensions/subagent-types/index.ts:382-385` | `MODEL_ALIASES`: `anthropic/claude*` + `openrouter/z-ai/glm-5.3` → `cli-openai/zaicp/glm-5.3` | none (table constant) | **real provider assumption** — alias targets specific proxy model ids; a provider without them breaks the alias path — adapt |
| `extensions/subagent-types/index.ts:410-420` | capability tags `[T]/[V]/[XL]` parsed from models.json display names | convention (models.json naming) | provider-agnostic mechanism, **convention dependency** — document |
| `extensions/sse-probe/index.ts` | zaicp SSE-route diagnostics | n/a (diagnostic tool by design) | provider-specific BY PURPOSE — note |
| `extensions/facts/src/curator-run.ts:86` | `FACTS_CURATOR_MODEL` → `--model` passthrough | env | clean passthrough |
| `settings.json defaultProvider/defaultModel` | `cli-openai/zaicp/glm-5.3-flash` | pi config | user-level, expected |

No plugin hardcodes provider URL or API key; no extension reads `auth.json`.

## Dynamic proof — container (real calls)

1. **Full swap**: added temp provider `swap46` (baseUrl `https://llm.tungvuthanh.com/v1` — same service, DIFFERENT transport/endpoint than the docker-DNS one) with model `zaicp/glm-5.2` → `pi -p --no-extensions --model swap46/zaicp/glm-5.2` real completion → **`PROVIDER46-OK`, exit 0**. models.json restored after (providers: `cli-openai` only, verified).
2. **Judge path**: `resolveJudgeModel` (index.ts:88-92) is env-first (`TASK_JUDGE_MODEL` read at call time, trim-check) then settings then DEFAULT; judge spawns `pi -p --model <resolved>` — the spawn target is the same `pi -p` proven in (1). Core conclusion: no code path inspects model NAMES beyond passing them through.

## Endpoints — same service, 3 transports, 3 machines (all HTTP 200 with shared key)

| machine | endpoint | verified |
|---|---|---|
| container | `http://cli-proxy-api:8317/v1` (docker DNS) | live config + PROVIDER46-OK run |
| hcm10 | `https://llm.tungvuthanh.com/v1` (public HTTPS) | 200 (re-verified this step) |
| Windows .160 | `http://192.168.10.54:8317/v1` (LAN IP) | 200 (re-verified this step) |

## Verdict — TRỤC 2 (provider independence)

**PASS with 4 findings**: the core and every model-consuming extension pass model identity through config/env; nothing breaks when provider+endpoint+model all change at once. Findings to fix (proposals for user):
1. `MODEL_ALIASES` in subagent-types hardcodes zaicp/glm target ids (make data-driven from settings).
2. Three pinned DEFAULTS (judge, OM workers, plugin roles) — all overridable; consider reading one `defaults.models` settings block instead.
3. Capability-tag convention `[T]/[V]/[XL]` undocumented as a models.json contract — document.
4. `sse-probe` is zaicp-specific by design — label as diagnostic, exclude from portability gates.
