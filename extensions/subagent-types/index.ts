/**
 * subagent-types — role-typed subagents over Paseo, port of the amosblomqvist
 * pi-subagents philosophy (capability / observability / extensibility) to a
 * headless RPC environment.
 *
 * Design (see agents/*.md for the role definitions, kept in the author's
 * frontmatter format):
 *   - Every pi agent in this workspace gets this extension loaded (project
 *     trust). At session_start it resolves ITS OWN role from the Paseo agent
 *     record: sessionId (from ctx.sessionManager.getSessionId()) → match
 *     ~/.paseo/agents/<ws>/<id>.json runtimeInfo.sessionId → labels["subagent.role"].
 *   - DEFAULT-DENY: no role / unknown role → the read-only floor
 *     (read, grep, find, ls). The main agent must be granted "main" in its
 *     labels to get full tools; unlabelled agents (e.g. created directly via
 *     paseo_create_agent by a compromised caller) cannot escalate.
 *   - Enforcement is technical, not prompt-trust:
 *       1. pi.setActiveTools(allowlist) — tools outside the allowlist are NOT
 *          sent to the model at all (agent-session.js setActiveToolsByName).
 *       2. pi.on("tool_call") block — defense-in-depth for the window before
 *          the first setActiveTools takes effect (verify agent-loop.js:417:
 *          block:true → createErrorToolResult, tool never executes).
 *   - spawn_subagent tool: the ONLY sanctioned way to create children. Maps a
 *     role to paseo_create_agent with labels {subagent.role, subagent.parent}.
 *     Depth control mirrors the author's subagent_agents allowlist: a role may
 *     only spawn roles listed in its .md; "main" spawns everything defined.
 *
 * Model note: the .md files pin anthropic/claude-* which this machine does not
 * carry. MODEL_FALLBACK maps them onto the available cli-openai family, and
 * the .md `model:` line stays source-of-truth for machines that have Claude.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { Type } from "@sinclair/typebox";
import safeBash from "./safe-bash.ts";
import registerReadonlyTools from "./readonly-tools.ts";
import {
	createAgent,
	findMcpEndpoint,
	flushKicks,
	markKick,
	pendingKickIds,
	getAgentStatus,
	isBusy,
	pushToQueue,
	sendToMain,
	drainQueue,
	renderForPrompt,
	waitForReply,
	registerSubagent,
	resolveSubagentName,
	type ChannelMessage,
} from "./paseo-channel.ts";

const extensionDir = dirname(fileURLToPath(import.meta.url));
const agentsDir = join(extensionDir, "agents");
const PASEO_AGENTS_DIR = join(homedir(), ".paseo", "agents");
const ROLE_LABEL = "subagent.role";

/** Role ids that mean "the interactive main agent" (full toolset). */
export const MAIN_ROLE = "main";

// ---------------------------------------------------------------------------
// Role definitions (from agents/*.md frontmatter)
// ---------------------------------------------------------------------------

export interface RoleDef {
	name: string;
	description: string;
	tools: string[];
	subagentAgents?: string[];
	model?: string;
	thinking?: string;
	systemPrompt: string;
}

/** Parse one agent markdown file into a RoleDef. */
export function parseRoleMd(filename: string, raw: string): RoleDef | null {
	const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!match) return null;
	const meta: Record<string, string> = {};
	for (const line of match[1].split(/\r?\n/)) {
		const kv = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
		if (kv) meta[kv[1].toLowerCase()] = kv[2].trim();
	}
	const name = meta.name || filename.replace(/\.md$/i, "");
	if (!name) return null;
	const body = match[2].trim();
	if (!body && !meta.tools) return null;
	return {
		name,
		description: meta.description ?? "",
		tools: (meta.tools ?? "")
			.split(",")
			.map((t) => t.trim())
			.filter(Boolean),
		...(meta.subagent_agents
			? {
					subagentAgents: meta.subagent_agents
						.split(",")
						.map((t) => t.trim())
						.filter(Boolean),
				}
			: {}),
		...(meta.model ? { model: meta.model } : {}),
		...(meta.thinking ? { thinking: meta.thinking } : {}),
		systemPrompt: body,
	};
}

/** Load all roles from agents/. `main` is synthesized if no main.md exists. */
export function loadRoles(): Map<string, RoleDef> {
	const roles = new Map<string, RoleDef>();
	if (existsSync(agentsDir)) {
		for (const file of readdirSync(agentsDir)) {
			if (!file.toLowerCase().endsWith(".md")) continue;
			try {
				const role = parseRoleMd(file, readFileSync(join(agentsDir, file), "utf-8"));
				if (role) roles.set(role.name, role);
			} catch {
				// skip unreadable
			}
		}
	}
	return roles;
}

/**
 * Read-only floor for unlabelled/unknown roles — default-deny. grep/find/ls
 * are re-registered by readonly-tools.ts (pi 0.84 omits them from the default
 * coding toolset).
 */
export function floorTools(): string[] {
	return ["read", "grep", "find", "ls", "message_main"];
}

/** Resolve the active tool allowlist for a role. */
export function allowlistFor(role: string | undefined, roles: Map<string, RoleDef>): string[] {
	if (!role) return floorTools();
	if (role === MAIN_ROLE) {
		// main keeps every tool the session already has; caller passes "*".
		// Checked BEFORE the map lookup: "main" needs no .md file.
		return ["*"];
	}
	const def = roles.get(role);
	if (!def) return floorTools();
	// Channel tools are always available to defined roles (a subagent that
	// cannot ask its main, or a main that cannot steer its children, defeats
	// the point of the channel).
	return [...new Set([...def.tools.map(mapToolName), "message_main", "message_subagent", "ask_question"])];
}

/**
 * Main-agent tool restriction (2026-09-02, user request): let the user block
 * specific tools from the MAIN agent (e.g. safe_bash / web_* / render_*).
 * Same setActiveTools mechanism the role allowlist uses — main just gets a
 * deny-list instead of an allow-list. Opt-in via settings:
 *   { "subagentTypes": { "mainBlockedTools": ["safe_bash", ...] } }
 * Workspace .pi/settings.json wins over ~/.pi/agent/settings.json.
 */
export function mergeMainBlockedTools(
	wsCfg: Record<string, unknown> | null,
	userCfg: Record<string, unknown> | null,
): string[] {
	const pick = (cfg: Record<string, unknown> | null): string[] | null => {
		if (!cfg) return null;
		const block = (cfg as { subagentTypes?: { mainBlockedTools?: unknown } }).subagentTypes?.mainBlockedTools;
		return Array.isArray(block) ? block.filter((t): t is string => typeof t === "string") : null;
	};
	return pick(wsCfg) ?? pick(userCfg) ?? [];
}

function readSettingsJson(path: string): Record<string, unknown> | null {
	try {
		if (!existsSync(path)) return null;
		const d = JSON.parse(readFileSync(path, "utf-8"));
		return typeof d === "object" && d !== null ? (d as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

/**
 * Auto-report backstop (2026-09-02, user request): the 2026-09-01 fix dropped
 * notifyOnFinish on spawns, which also killed the daemon's automatic
 * "child finished" forwarding. Children that simply conclude (researcher
 * 01a05f8e: 47 min of work, KẾT LUẬN persisted, 0 message_main calls) leave
 * the main agent asleep forever. Design: PING-ONLY — wake main with a one-line
 * notice and let main pull the transcript itself (paseo_activity) only when it
 * needs it. No text duplication into main's context.
 */
export function shouldAutoPing(role: string | undefined, calledMessageMain: boolean, resolvedIdentity: boolean): boolean {
	return resolvedIdentity && !!role && role !== MAIN_ROLE && !calledMessageMain;
}

export function buildAutoPing(role: string, agentId: string, title: string | undefined): string {
	const who = title ? `${role} "${title}"` : role;
	return `[auto-report] Subagent ${who} (${agentId}) đã hoàn thành và về idle mà không gọi message_main. Dùng paseo_activity(agentId) nếu cần đọc kết quả của nó.`;
}

/** Identity mapping retained for call sites; .md files now use live names. */
export function mapToolName(tool: string): string {
	return tool;
}

/** Which roles may `role` spawn? Main may spawn any defined role. */
export function spawnableRoles(role: string | undefined, roles: Map<string, RoleDef>): string[] {
	if (role === MAIN_ROLE) return [...roles.keys()];
	const def = role ? roles.get(role) : undefined;
	return def?.subagentAgents ?? [];
}

// ---------------------------------------------------------------------------
// Self-identification: sessionId → Paseo agent record → labels
// ---------------------------------------------------------------------------

export interface SelfInfo {
	agentId: string | null;
	role: string | undefined;
	labels: Record<string, string>;
	title?: string;
}

/**
 * Role resolution priority:
 *   1. explicit `subagent.role` label → that role
 *   2. agent created BY ANOTHER AGENT (daemon-stamped `paseo.parent-agent-id`
 *      label, which the model cannot forge — it is written at creation time
 *      into a record the model cannot rewrite) without a role label → floor
 *      (default-deny for machine-spawned children)
 *   3. human-created agent (no parent-agent label): the main agent by
 *      definition — full tools.
 */
export function resolveSelf(sessionId: string, paseoDir = PASEO_AGENTS_DIR): SelfInfo {
	if (!existsSync(paseoDir) || !sessionId) {
		return { agentId: null, role: undefined, labels: {} };
	}
	for (const wsDir of readdirSync(paseoDir)) {
		const wsPath = join(paseoDir, wsDir);
		try {
			if (!readdirSync(wsPath).length) continue;
		} catch {
			continue;
		}
		for (const rec of readdirSync(wsPath)) {
			if (!rec.endsWith(".json")) continue;
			try {
				const d = JSON.parse(readFileSync(join(wsPath, rec), "utf-8"));
				const ri = d.runtimeInfo ?? {};
				if (ri.sessionId === sessionId || (d.persistence ?? {}).sessionId === sessionId) {
					const labels = d.labels ?? {};
					const explicitRole = typeof labels[ROLE_LABEL] === "string" ? labels[ROLE_LABEL] : undefined;
					const machineSpawned = typeof labels["paseo.parent-agent-id"] === "string";
					const role = explicitRole ?? (machineSpawned ? undefined : MAIN_ROLE);
					return {
						agentId: d.id ?? rec.replace(/\.json$/, ""),
						role,
						labels,
						title: typeof d.title === "string" ? d.title : undefined,
					};
				}
			} catch {
				// skip bad record
			}
		}
	}
	return { agentId: null, role: undefined, labels: {} };
}

// ---------------------------------------------------------------------------
// Model fallback for .md-pinned models unavailable on this machine
// ---------------------------------------------------------------------------

const MODEL_FALLBACK: Array<[RegExp, string]> = [
	[/anthropic\/claude-haiku[\w.-]*/, "cli-openai/zaicp/glm-5.3-flash"],
	[/anthropic\/claude-sonnet[\w.-]*/, "cli-openai/zaicp/glm-5.3"],
	[/anthropic\/claude[\w.-]*/, "cli-openai/zaicp/glm-5.3"],
	[/openrouter\/z-ai\/glm-5\.3/, "cli-openai/zaicp/glm-5.3"],
];

/** Map a .md model pin onto a model this machine actually has. Strict: returns
 * undefined when nothing matches — the caller refuses the spawn. */
export function resolveModel(model: string | undefined, available: string[]): string | undefined {
	if (!model) return undefined;
	if (available.includes(model)) return model;
	for (const [pattern, fallback] of MODEL_FALLBACK) {
		if (pattern.test(model) && available.includes(fallback)) return fallback;
	}
	return undefined;
}

/**
 * Resolve the provider string for paseo_create_agent from a model id.
 * Paseo expects "pi/<provider>/<model>"; a model id like "cli-openai/zaicp/glm-5.3"
 * becomes "pi/cli-openai/zaicp/glm-5.3". A string already prefixed with the
 * provider family ("pi/...", "omp/...") passes through untouched.
 */
export function providerStringFor(model: string, providerFamily = "pi"): string {
	if (model.startsWith(`${providerFamily}/`)) return model;
	return `${providerFamily}/${model}`;
}

/** Model capability info derived from the catalog (name tags come from models.json). */
export interface ModelInfo {
	id: string;
	vision: boolean;
	reasoning: boolean;
}

/** Parse capability back out of a tagged display name ([GLM-5.3-Flash][ZAI][T][V][XL]). */
export function parseModelTags(name: string | undefined): { vision: boolean; reasoning: boolean } {
	return {
		vision: (name ?? "").includes("[V]"),
		reasoning: (name ?? "").includes("[T]"),
	};
}

/**
 * Thinking levels each provider family understands, for payload validation.
 * Fail-closed: a provider missing from this dict rejects the spawn instead of
 * passing an unvalidated string through.
 */
export const THINKING_BY_PROVIDER: Record<string, readonly string[]> = {
	pi: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
};

/** Validate a thinking level against the provider family's enum. */
export function thinkingValid(level: string | undefined, providerFamily: string): boolean {
	if (!level) return false;
	const allowed = THINKING_BY_PROVIDER[providerFamily];
	if (!allowed) return false;
	return allowed.includes(level);
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

const SpawnParams = Type.Object({
	role: Type.String({ description: "Role id from the agents/ definitions (scout, researcher, worker, mermaid-maker, svg-maker)" }),
	task: Type.String({ description: "Self-contained task description — the child has no other context." }),
	name: Type.Optional(Type.String({ description: "Optional display title for the child agent." })),
	model: Type.Optional(Type.String({ description: "Optional model override for this spawn (model id from paseo_list_models). Ignored when the role pins a model in its .md." })),
	thinking: Type.Optional(Type.String({ description: "Thinking level for this spawn when the role does not pin one: off | minimal | low | medium | high | xhigh | max." })),
});

interface SpawnDetails {
	spawnable?: string[];
	role?: string;
	model?: string;
	thinking?: string;
}

/** Guidance shown when the role does not pin a model — generic, never pins specific models. */
export const MODEL_GUIDANCE = [
	"How to pick a model for this subagent (the role does not pin one):",
	"",
	"- Simple lookup / code recon tasks: pick a fast, cheap model — names containing \"flash\", \"mini\", \"haiku\"-style suffixes usually fit.",
	"- Multi-source research and synthesis: pick a balanced mid-tier model.",
	"- Critical code writing or complex reasoning: pick the strongest available model, higher thinking is better here.",
	"- The task involves looking at images or diagrams: you MUST pick a model tagged [V] (vision) — text-only models cannot see images at all.",
	"- Longer outputs (big refactors, long documents): prefer a model tagged [XL] or [L] (larger max output).",
	"- Unsure: reuse the current session's model.",
	"",
	"Thinking level guidance (settings.thinkingOptionId):",
	"- off/minimal/low: quick lookups, trivial edits — speed over depth.",
	"- medium: default for most work.",
	"- high/xhigh/max: complex reasoning, tricky debugging, architecture decisions — only when the task genuinely needs it (slower and more expensive).",
	"",
	"Rule of thumb: cheap and fast for cheap tasks, strong for hard ones; thinking level scales with task difficulty, not habit.",
].join("\n");

export default function subagentTypes(pi: ExtensionAPI) {
	// safe-bash registers the filtered `safe_bash` tool (bash wrapper with
	// dangerous-command blocking) — loaded here because directory extensions
	// only mount index.ts.
	safeBash(pi);
	registerReadonlyTools(pi); // grep/find/ls — pi 0.84 omits them from default coding tools
	const roles = loadRoles();
	// Main-tool restriction config: workspace overrides user-wide (2026-09-02).
	const mainBlockedTools = mergeMainBlockedTools(
		readSettingsJson(join(process.cwd(), ".pi", "settings.json")),
		readSettingsJson(join(homedir(), ".pi", "agent", "settings.json")),
	);
	let myRole: string | undefined;
	let myAgentId: string | null = null;
	let messageMainCalledThisRun = false;
	const sessionIdRef = { value: "" };

	let resolved = false;
	function applyRole(ctx: { ui: { notify: (m: string, t?: "info" | "warning" | "error") => void }; sessionManager: { getSessionId: () => string } }): void {
		if (!resolved) {
			const sessionId = ctx.sessionManager.getSessionId();
			sessionIdRef.value = sessionId;
			const self = resolveSelf(sessionId);
			if (!self.agentId) return; // record not written yet — retry on next event
			myRole = self.role;
			myAgentId = self.agentId;
			resolved = true;

			const allowed = allowlistFor(myRole, roles);
			if (allowed[0] === "*") {
				ctx.ui.notify(`subagent-types: main agent (full tools)${roles.size ? ` — ${roles.size} roles loadable` : ""}`, "info");
			} else {
				// Harden: drop everything not in the allowlist.
				const active = pi.getActiveTools().filter((t) => allowed.includes(t));
				pi.setActiveTools(active);
				ctx.ui.notify(`subagent-types: role=${myRole ?? "(none)"} — tools locked to ${active.join(", ")}`, "info");
			}
		}
		// Main-tool restriction: re-applied on EVERY event (session_start, input)
		// so tools registered after session_start are still filtered. Idempotent:
		// the toast only fires when a tool was actually removed.
		if (resolved && myRole === MAIN_ROLE && mainBlockedTools.length > 0) {
			const before = pi.getActiveTools();
			const active = before.filter((t) => !mainBlockedTools.includes(t));
			if (active.length !== before.length) {
				pi.setActiveTools(active);
				ctx.ui.notify(
					`subagent-types: main — đã chặn ${before.length - active.length} tool theo cấu hình (${mainBlockedTools.join(", ")}). Cần chạy thì giao cho subagent.`,
					"info",
				);
			}
		}
	}

	// ── Inbound drain (turn-boundary pickup) ─────────────────────────────
	// The file queue written by sendToMain/sendToSubagent is drained by the
	// TARGET's own process here. Three events, one atomic drain (rename-based
	// — only the first caller to arrive gets entries):
	//   turn_end          mid-run: injected right after the current round
	//   before_agent_start idle + new prompt: injected before the loop runs
	//   agent_settled      final net after retries/compaction/follow-ups
	let drainInFlight = false;
	function flushInbound(): ChannelMessage[] {
		if (drainInFlight || !myAgentId) return [];
		drainInFlight = true;
		try {
			return drainQueue(myAgentId);
		} finally {
			drainInFlight = false;
		}
	}

/**
 * Deliver pending MAIN->CHILD kicks. Runs only at turn_end / agent_settled:
 * a daemon kick notifies the parent session, and if that notification lands
 * while the parent is still streaming the parent's request is aborted
 * (2026-09-01 chat-workspace reproductions, 4/4 aborts right after kicks).
 */
let kicksRunning = false;
async function kickOutbound(): Promise<void> {
	if (kicksRunning || pendingKickIds().length === 0) return;
	kicksRunning = true;
	try {
		const endpoint = findMcpEndpoint(myAgentId);
		if (endpoint) await flushKicks(endpoint, { mainAgentId: myAgentId ?? undefined });
	} catch {
		// never throw from an event handler; the next flush retries
	} finally {
		kicksRunning = false;
	}
}

	pi.on("turn_end", () => {
		void kickOutbound();
		const msgs = flushInbound();
		if (msgs.length === 0) return;
		pi.sendMessage({ customType: "subagent-message", content: renderForPrompt(msgs), display: true, details: {} });
	});

	pi.on("before_agent_start", () => {
		const msgs = flushInbound();
		if (msgs.length === 0) return undefined;
		return { message: { customType: "subagent-message", content: renderForPrompt(msgs), display: true, details: {} } };
	});

	pi.on("agent_settled", () => {
		void kickOutbound();
		const msgs = flushInbound();
		if (msgs.length > 0) {
			pi.sendMessage({ customType: "subagent-message", content: renderForPrompt(msgs), display: true, details: {} });
		}
		void autoPingOnSettle();
	});

	// Auto-report backstop (2026-09-02): a subagent that settled WITHOUT calling
	// message_main still pings its parent — one line, no payload — so main can
	// wake and pull the transcript itself (see shouldAutoPing for history).
	async function autoPingOnSettle(): Promise<void> {
		if (!shouldAutoPing(myRole, messageMainCalledThisRun, resolved)) return;
		if (!myRole) return; // belt-and-suspenders narrowing for TS
		const self = resolveSelf(sessionIdRef.value);
		const mainId = self.labels["subagent.parent"] ?? self.labels["paseo.parent-agent-id"];
		if (!mainId || !myAgentId) return;
		const endpoint = findMcpEndpoint(myAgentId);
		if (!endpoint) return;
		const text = buildAutoPing(myRole, myAgentId, self.title);
		const msg: ChannelMessage = {
			id: `${Date.now()}-ap`,
			from: myAgentId,
			fromRole: myRole ?? "?",
			text,
			ts: new Date().toISOString(),
		};
		try {
			await sendToMain(endpoint, mainId, msg); // busy-main → queue; idle-main → wake now
		} catch {
			// never let a reporting backstop break settlement
		}
	}

	pi.on("session_start", (_event, ctx) => {
		// First boot races the daemon writing runtimeInfo into the agent
		// record — if the lookup misses now, before_input retries before any
		// prompt is processed.
		applyRole(ctx);
	});

	pi.on("input", (_event, ctx) => {
		applyRole(ctx);
	});

	// Defense in depth: block anything outside the allowlist even if it slips
	// through before setActiveTools applies (first turn race).
	pi.on("tool_call", (event) => {
		if (myRole === MAIN_ROLE) return;
		const allowed = allowlistFor(myRole, roles);
		if (allowed.includes("*")) return;
		const toolName =
			"toolName" in event && typeof event.toolName === "string" ? event.toolName : undefined;
		if (toolName && !allowed.includes(toolName) && toolName !== "spawn_subagent") {
			if (myRole && roles.get(myRole)?.tools.some((t) => mapToolName(t) === toolName)) return;
			if (!myRole && floorTools().includes(toolName)) return;
			if (myRole && !roles.get(myRole)) {
				// unknown role → floor only
				if (!floorTools().includes(toolName)) {
					return { block: true, reason: `subagent-types: role "${myRole}" is not defined; only read-only tools are available` };
				}
				return;
			}
			return {
				block: true,
				reason: `subagent-types: tool "${toolName}" is not in the allowlist for role "${myRole ?? "unlabelled"}"`,
			};
		}
		return;
	});

	// The sanctioned spawn path.
	pi.registerTool<typeof SpawnParams, SpawnDetails>({
		name: "spawn_subagent",
		label: "spawn_subagent",
		description:
			"Spawn a role-typed subagent as a new Paseo agent. The child gets exactly the tools its role allows (enforced, not requested). Returns the new agent's id; the child's result arrives via its own timeline, or block by asking the parent to read the child's activity.",
		promptSnippet:
			"Use spawn_subagent to delegate exploration (scout), web research (researcher), or implementation (worker) — the child's context stays separate from yours.",
		promptGuidelines: [
			"Prefer spawn_subagent over exploring large unfamiliar code yourself — the child burns its own context, not yours.",
			"task must be self-contained: the child sees no prior conversation.",
			"You may only spawn roles your own role permits (e.g. worker → scout, researcher).",
		],
		parameters: SpawnParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const spawnable = spawnableRoles(myRole, roles);
			if (!spawnable.includes(params.role)) {
				return {
					content: [{ type: "text" as const, text: `Role "${params.role}" is not spawnable from role "${myRole ?? "(none)"}". Allowed: ${spawnable.join(", ") || "(none)"}` }],
					details: { spawnable },
				};
			}
			const def = roles.get(params.role);
			if (!def) {
				return { content: [{ type: "text" as const, text: `Unknown role "${params.role}"` }], details: {} };
			}

			// ── Model resolution ────────────────────────────────────────────
			// Pin in .md: strict. Override param is ignored. Unresolvable → refuse.
			// No pin: optional override param, else the caller picks from the list.
			const scoped = (ctx.scopedModels ?? []).map((s: { model: { provider: string; id: string } }) => `${s.model.provider}/${s.model.id}`);
			const names = new Map<string, string>();
			for (const s of ctx.scopedModels ?? []) {
				names.set(`${s.model.provider}/${s.model.id}`, s.model.name ?? "");
			}

			let modelId: string | undefined;
			let modelChosenBy = "";
			if (def.model) {
				const resolved = resolveModel(def.model, scoped);
				if (!resolved) {
					return {
						content: [{ type: "text" as const, text: `Role "${params.role}" pins model "${def.model}" which is not available on this machine (no fallback matched). Refusing to spawn — fix the model: line in agents/${params.role}.md or make the model available.` }],
						details: { role: params.role },
					};
				}
				modelId = resolved;
				modelChosenBy = "role pin";
			} else if (params.model) {
				if (!scoped.includes(params.model)) {
					return {
						content: [{ type: "text" as const, text: `Model "${params.model}" is not in the available models list: ${scoped.join(", ")}. Call paseo_list_models to see ids.` }],
						details: { role: params.role },
					};
				}
				modelId = params.model;
				modelChosenBy = "caller override";
			}
			// else: no pin, no override → caller must pick (placeholder below).

			// ── Thinking resolution ─────────────────────────────────────────
			// Always present in the payload. Pin → fixed. No pin → REQUIRED enum
			// placeholder. Non-reasoning model ([T] absent) → forced "off".
			const providerFamily = "pi";
			let thinking: string | undefined;
			let thinkingFixed = false;
			if (modelId) {
				const caps = parseModelTags(names.get(modelId));
				if (!caps.reasoning) {
					thinking = "off";
					thinkingFixed = true; // non-reasoning model: off is the only sane value
				}
			}
			if (!thinkingFixed && params.thinking) {
			if (!thinkingValid(params.thinking, providerFamily)) {
				return {
					content: [{ type: "text" as const, text: `thinking "${params.thinking}" is not a valid ${providerFamily} level (${THINKING_BY_PROVIDER[providerFamily].join("|")}).` }],
					details: { role: params.role },
				};
			}
			thinking = params.thinking;
			thinkingFixed = true;
		}
		if (!thinkingFixed && def.thinking) {
				if (!thinkingValid(def.thinking, providerFamily)) {
					return {
						content: [{ type: "text" as const, text: `Role "${params.role}" pins thinking "${def.thinking}" which is not a valid ${providerFamily} level (${THINKING_BY_PROVIDER[providerFamily].join("|")}). Fix agents/${params.role}.md.` }],
						details: { role: params.role },
					};
				}
				thinking = def.thinking;
				thinkingFixed = true;
			}

			const title = params.name ?? `${params.role}: ${params.task.slice(0, 40)}`;
			const initialPrompt = `${def.systemPrompt}\n\n---\nTASK:\n${params.task}`;
			const labels = { [ROLE_LABEL]: params.role, ...(myAgentId ? { "subagent.parent": myAgentId } : {}) };

			// ── Ready: model known → create the child directly (one call) ────
			if (modelId) {
				if (!thinkingFixed || !thinking) {
					return {
						content: [{ type: "text" as const, text: `Role "${params.role}" needs a thinking level. Re-call with the model parameter set, or fix the role's thinking: pin.` }],
						details: { role: params.role },
					};
				}
				const endpoint = findMcpEndpoint(myAgentId);
				if (!endpoint) {
					return {
						content: [{ type: "text" as const, text: "Paseo MCP endpoint not found (is this session running under Paseo?). Cannot create the child here." }],
						details: { role: params.role },
					};
				}
				const spawned = await createAgent(
					{
						provider: providerStringFor(modelId, providerFamily),
						title,
						labels,
						initialPrompt,
						thinkingOptionId: thinking,
					},
					endpoint,
				);
				if (!spawned.ok) {
					return {
						content: [{ type: "text" as const, text: `Spawn failed: ${spawned.error ?? "unknown error"}` }],
						details: { role: params.role, model: modelId, thinking },
					};
				}
				if (params.name && spawned.agentId) {
					// Name registry: re-address this child by name later
					// (message_subagent name=..., resume after it finishes).
					registerSubagent(params.name, {
						agentId: spawned.agentId,
						role: params.role,
						title: params.name,
						createdAt: new Date().toISOString(),
					});
				}
				return {
					content: [
						{
							type: "text" as const,
							text: `Spawned ${params.role} agent ${spawned.agentId} (status: ${spawned.status ?? "running"}). Its result arrives via notification; poll with paseo_get_agent_activity("${spawned.agentId}") when needed.`,
						},
					],
					details: { role: params.role, model: modelId, thinking, agentId: spawned.agentId },
				};
			}

			// ── No model decided → guided choice, then RE-CALL with the model ──
		// The caller never assembles the create payload itself: labels must
		// come from this extension or the child's allowlist cannot be trusted.
		return {
			content: [
				{
					type: "text" as const,
					text: [
						`Role "${params.role}" has no pinned model or thinking. Pick both, then call spawn_subagent AGAIN with the same role/task plus model and thinking parameters — the extension creates the child for you.`,
						"",
						`Available models (tags: [T]=reasoning, [V]=vision, [XL]/[L]=large output):`,
						...scoped.map((id) => `- ${id}${names.get(id) ? `  ${names.get(id)}` : ""}`),
						"",
						MODEL_GUIDANCE,
					].join("\n"),
				},
			],
			details: { role: params.role },
		};		},
	});

	// ── Two-way channel ──────────────────────────────────────────────────
	// MAIN → CHILD: turn-boundary pickup by default (busy child receives at
	// its next round; idle child gets a new/resumed turn). `interrupt: true`
	// opts into daemon interrupt-and-replace for urgent redirects.
	pi.registerTool({
		name: "message_subagent",
		label: "message_subagent",
		description:
			"Send a message to a subagent you spawned. By default it is picked up at the child's next turn boundary (its current turn is not interrupted); if the child is idle a new turn starts. Set interrupt true only for urgent redirects — that replaces the child's current turn immediately.",
		parameters: Type.Object({
			agentId: Type.Optional(Type.String({ description: "The child agent id returned by spawn_subagent. Omit when using name." })),
			name: Type.Optional(Type.String({ description: "Registry name the child was spawned with (latest spawn wins). Alternative to agentId." })),
			message: Type.String({ description: "Self-contained message — the child has no other fresh context." }),
			kind: Type.Optional(Type.String({ description: '"message" (default) or "reply" when answering the child\'s ask_question.' })),
			interrupt: Type.Optional(Type.Boolean({ description: "Urgent: interrupt-and-replace the child's current turn instead of waiting for its turn boundary. Default false." })),
		}),
		async execute(_id, params) {
			const endpoint = findMcpEndpoint(myAgentId);
			if (!endpoint) {
				return { content: [{ type: "text" as const, text: "Paseo MCP endpoint not found." }], details: {} };
			}
			const targetId = params.agentId ?? (params.name ? resolveSubagentName(params.name)?.agentId : undefined);
			if (!targetId) {
				return { content: [{ type: "text" as const, text: params.name ? `No subagent registered under name "${params.name}".` : "Provide agentId or name." }], details: {} };
			}
			const msg: ChannelMessage = {
				id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
				from: myAgentId ?? "main",
				fromRole: myRole ?? "main",
				text: params.message,
				ts: new Date().toISOString(),
				kind: params.kind === "reply" ? "reply" : "message",
			};
			// Deferred kick (2026-09-01): never send_agent_prompt while the parent is
			// streaming — the daemon's child-start notification aborts THIS request.
			pushToQueue(targetId, msg);
			markKick(targetId, params.interrupt === true);
			const st = await getAgentStatus(endpoint, targetId);
			const busy = st.ok && isBusy(st.status);
			const label = params.name ?? targetId;
			const text = busy
				? `Queued — ${label} is mid-turn and will pick this up at its next turn boundary.`
				: `Queued for ${label} — kick deferred to the end of your current turn (kicking now is what aborts your own stream; ${params.interrupt === true ? "interrupt semantics apply when it fires" : "the child starts then"}).`;
			return { content: [{ type: "text" as const, text }], details: {} };
		},
	});

	// CHILD → MAIN: never interrupts. Busy main → persistent file queue,
	// delivered at the main's next turn boundary by its own drain. Idle main
	// → steer-back as a new turn.
	pi.registerTool({
		name: "message_main",
		label: "message_main",
		description:
			"Send a message/question to the main agent that spawned you. Its work is never interrupted: if it is mid-run your message is queued and delivered at its next turn boundary; if it is idle a new turn starts immediately. Ask questions or report findings early here instead of guessing.",
		parameters: Type.Object({
			message: Type.String({ description: "Your question or update for the main agent." }),
		}),
		async execute(_id, params) {
			messageMainCalledThisRun = true;
			const parent = myAgentId ? (resolveSelf(sessionIdRef.value).labels["subagent.parent"] ?? null) : null;
			const mainId = parent ?? (myAgentId ? (resolveSelf(sessionIdRef.value).labels["paseo.parent-agent-id"] ?? null) : null);
			if (!mainId) {
				return { content: [{ type: "text" as const, text: "No main agent on record for this session." }], details: {} };
			}
			const endpoint = findMcpEndpoint(myAgentId);
			if (!endpoint) {
				return { content: [{ type: "text" as const, text: "Paseo MCP endpoint not found." }], details: {} };
			}
			const msg: ChannelMessage = {
				id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
				from: myAgentId ?? "?",
				fromRole: myRole ?? "?",
				text: params.message,
				ts: new Date().toISOString(),
			};
			const r = await sendToMain(endpoint, mainId, msg);
			return {
				content: [{ type: "text" as const, text: r.ok ? (r.delivered === "queued" ? "Queued — the main agent picks this up at its next turn boundary (its current work is never interrupted)." : "Delivered to main agent (new turn started).") : `Send failed: ${r.error}` }],
				details: {},
			};
		},
	});

	// ── ask_question (child → main, park/wait/absorb) ────────────────────
	// interactive-subagents semantics on Paseo infra: the child asks, then
	// (a) a reply landing within wait_seconds is ABSORBED into the child's
	//     current turn as this tool's result, or
	// (b) on timeout the child PARKS — it ends its turn and the main's later
	//     reply starts its next turn (resume via the idle send path).
	pi.registerTool({
		name: "ask_question",
		label: "ask_question",
		description:
			"Subagents only: ask the main agent a question and wait for its reply. If the reply arrives within the wait window it is returned here (your current turn continues with the answer); otherwise your session parks — end your turn and the reply will start your next turn. The main agent should use ask_user_question to ask the human instead.",
		parameters: Type.Object({
			question: Type.String({ description: "Self-contained question — the main agent has no other fresh context than what you report." }),
			wait_seconds: Type.Optional(Type.Number({ description: "How long to wait for the reply before parking. Default 300 (max)." })),
		}),
		async execute(_id, params) {
			if (!myRole || myRole === MAIN_ROLE) {
				return { content: [{ type: "text" as const, text: "You are the main agent — use ask_user_question to ask the human user. ask_question is for subagents to ask their main agent." }], details: {} };
			}
			const parent = myAgentId ? (resolveSelf(sessionIdRef.value).labels["subagent.parent"] ?? null) : null;
			const mainId = parent ?? (myAgentId ? (resolveSelf(sessionIdRef.value).labels["paseo.parent-agent-id"] ?? null) : null);
			if (!mainId || !myAgentId) {
				return { content: [{ type: "text" as const, text: "No main agent on record for this session." }], details: {} };
			}
			const endpoint = findMcpEndpoint(myAgentId);
			if (!endpoint) {
				return { content: [{ type: "text" as const, text: "Paseo MCP endpoint not found." }], details: {} };
			}
			const details: { asked?: string; repliedBy?: string; parked?: boolean } = {};
			const waitMs = Math.min(Math.max(params.wait_seconds ?? 300, 1), 300) * 1000;
			const ask: ChannelMessage = {
				id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
				from: myAgentId,
				fromRole: myRole,
				text: params.question,
				ts: new Date().toISOString(),
				kind: "ask",
			};
			const sent = await sendToMain(endpoint, mainId, ask);
			if (!sent.ok) {
				return { content: [{ type: "text" as const, text: `Send failed: ${sent.error}` }], details: {} };
			}
			const reply = await waitForReply(myAgentId, waitMs);
			if (reply) {
				details.asked = params.question;
				details.repliedBy = reply.from;
				return {
					content: [{ type: "text" as const, text: `Reply from main (${reply.fromRole}):

${reply.text}` }],
					details,
				};
			}
			details.asked = params.question;
			details.parked = true;
			return {
				content: [{ type: "text" as const, text: `No reply within ${Math.round(waitMs / 1000)}s — you are now parked. END YOUR TURN immediately and wait: the main agent's reply will arrive as your next turn.` }],
				details,
			};
		},
	});

	// Smoke hook.
	pi.registerCommand("subagent-types-dev", {
		description: "Verify subagent-types extension is loaded",
		handler: async (_args, ctx) => {
			ctx.ui.notify(`subagent-types active — role=${myRole ?? "(none)"}, roles=[${[...roles.keys()].join(", ")}]`, "info");
		},
	});
}
