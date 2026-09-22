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
 *   - #188: the gate only applies to MACHINE-MANAGED sessions (paseo record
 *     or PASEO_* env carrier). A human CLI `pi` has neither → full tools.
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
import { REPLY_DOOR_TOOL, findDoorUrlForAgent, fetchDoorTools, callDoorTool, doorSchemaToTypeBox, findMainDoorUrl, type DoorToolSpec } from "./door-tool.ts";
import {
	readArchiveRemindMinutes,
	toIdleChildren,
	shouldRemindIdleArchive,
	ARCHIVE_REMIND_REARM_MS,
} from "./idle-archive.ts";
import { roleGateApplies } from "./gate-scope.ts";
import safeBash from "./safe-bash.ts";
import registerReadonlyTools from "./readonly-tools.ts";
import { LoopGuard, loopGuardConfigFromEnv } from "./loop-guard.ts";
import { validateResearchReport, researchReportDigest } from "./research-report.ts";
import {
	replyDoorNote,
	findMcpEndpoint,
	flushKicks,
	getActivityDigest,
	getActivitySummary,
	getAgentStatus,
	isAutoReport,
	isBusy,
	abortStalledChild,
	listAgents,
	markKick,
	pendingKickIds,
	pushToQueue,
	runningChildrenOf,
	sendToMain,
	drainQueue,
	renderForPrompt,
	takeMessagesFrom,
	waitForReply,
	registerSubagent,
	resolveSubagentName,
	sweepOrphanedSubagents,
	type ChannelMessage,
	type McpEndpoint,
} from "./paseo-channel.ts";

const extensionDir = dirname(fileURLToPath(import.meta.url));
const agentsDir = join(extensionDir, "agents");
const PASEO_AGENTS_DIR = join(homedir(), ".paseo", "agents");
const ROLE_LABEL = "subagent.role";

/** Role ids that mean "the interactive main agent" (full toolset). */
export const MAIN_ROLE = "main";

/** Max concurrently-RUNNING children per parent. 0 disables. Env override:
 *  SUBAGENT_MAX_CONCURRENT (2026-09-05, user-approved backstop — the daemon
 *  itself imposes no concurrent-agent limit). */
export const SUBAGENT_MAX_CONCURRENT = Number(process.env.SUBAGENT_MAX_CONCURRENT ?? 4);

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
	// Plan tools (read-only-mode v1.4.31) are self-restricting — entering plan
	// mode NARROWS the tool set; they grant no write power. pool_status is a
	// pure read. spawn_pool/pool_resume stay OUT of the floor: unlabelled
	// headless sessions have no MCP endpoint and must not spawn agents.
	return [
		"read",
		"grep",
		"find",
		"ls",
		"message_main",
		REPLY_DOOR_TOOL,
		"enter_plan_mode",
		"write_plan",
		"exit_plan_mode",
		"plan_step_done",
		"pool_status",
	];
}

/** Resolve the active tool allowlist for a role. */
export function allowlistFor(role: string | undefined, roles: Map<string, RoleDef>, doorChild = false): string[] {
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
	// doorChild (#132/F2): a child with a scoped door does NOT receive message_main —
	// replace the legacy file-queue channel with reply_to_parent/ask_parent through one door.
	const out = [...new Set([...def.tools.map(mapToolName), REPLY_DOOR_TOOL, "message_subagent", "ask_question", "ask_parent"])] as string[];
	if (!doorChild) out.push("message_main");
	// The blocking wrapper travels with spawn_subagent (same internal role
	// gate re-checks spawnableRoles per call, so appending it here grants no
	// extra spawn power — only the call style).
	if (out.includes("spawn_subagent")) out.push("spawn_paseo_subagent");
	return out;
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
 * 01a05f8e: 47 min of work, CONCLUSION persisted, 0 message_main calls) leave
 * the main agent asleep forever. Design: PING-ONLY — wake main with a one-line
 * notice and let main pull the transcript itself (paseo_activity) only when it
 * needs it. No text duplication into main's context.
 */
export function shouldAutoPing(role: string | undefined, calledMessageMain: boolean, resolvedIdentity: boolean, poolChild = false, doorChild = false): boolean {
	// poolChild: children spawned by spawn_pool stay silent — the pool driver
	// owns waking main (ONE aggregate message, not one ping per child).
	// doorChild (#132/F2): plugin delivery already wakes the parent with
	// [child-report] for a child with a scoped door — auto-ping would duplicate it.
	return !poolChild && !doorChild && resolvedIdentity && !!role && role !== MAIN_ROLE && !calledMessageMain;
}

/**
 * v1.4.51: is any goal run currently running. v1.4.90 (#103): moved to
 * _shared/unattended.ts (single source of truth for the unattended window -
 * the interactive ban reads the same files); re-exported so existing callers
 * and tests keep working. Auto-ping yields to goal wake.
 */
export { goalWakeActive, planWakeActive } from "../_shared/unattended.ts";
import { goalWakeActive, planWakeActive } from "../_shared/unattended.ts";
import {
	appendPending,
	buildAutoPing,
	buildBatchText,
	claimPending,
	joinMsFromEnv,
	readPending,
	windowDelayMs,
} from "./auto-report-join.ts";
export { buildAutoPing } from "./auto-report-join.ts";

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
					// Anti-spoof: the daemon stamps `paseo.parent-agent-id` AFTER merging
					// caller-supplied labels, so a spawned child claiming role "main" is
					// privilege escalation (or misconfig). A machine-spawned child can
					// never be main — fall through to the default-deny floor instead.
					const spoofedMain = machineSpawned && explicitRole === MAIN_ROLE;
					const role = explicitRole && !spoofedMain ? explicitRole : machineSpawned ? undefined : MAIN_ROLE;
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


export default function subagentTypes(pi: ExtensionAPI) {
	// safe-bash registers the filtered `safe_bash` tool (bash wrapper with
	// dangerous-command blocking) — loaded here because directory extensions
	// only mount index.ts.
	safeBash(pi, { getRole: () => myRole });
	registerReadonlyTools(pi); // grep/find/ls — pi 0.84 omits them from default coding tools
	const roles = loadRoles();
	// Main-tool restriction config: workspace overrides user-wide (2026-09-02).
	const mainBlockedTools = mergeMainBlockedTools(
		readSettingsJson(join(process.cwd(), ".pi", "settings.json")),
		readSettingsJson(join(homedir(), ".pi", "agent", "settings.json")),
	);
	// #129 idle-archive reminder: minutes of collective child idleness before
	// nudging the parent to archive (15 default, 0 disables, workspace wins).
	const archiveRemindMinutes = readArchiveRemindMinutes(
		readSettingsJson(join(process.cwd(), ".pi", "settings.json")),
		readSettingsJson(join(homedir(), ".pi", "agent", "settings.json")),
	);
	// #131 spawner mode: ONE DOOR — when the paseo-subagents plugin is enabled,
	// the extension does NOT register spawn tools (the plugin owns spawning through
	// the door). auto (default) reads daemon config; fail-open keeps the extension
	// active if the config is invalid.
	// #187 standalone-clean (#44 regression after the one-door port): both
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
			// NOTE (#128 E2E post-mortem): role=undefined for a machine-spawned
			// record is the ANTI-SPOOF guard working (resolveSelf: parent-stamped
			// children can never be main), NOT a labels race — lock immediately.
			myRole = self.role;
			myAgentId = self.agentId;
			resolved = true;

			// #128: one universal child→parent door — pi children get it as a
			// native extension tool (pi 0.85.1 does not register http MCP
			// servers); foreign children already see it over MCP.
			if (myAgentId) {
				const doorUrl = findDoorUrlForAgent(PASEO_AGENTS_DIR, myAgentId);
				if (doorUrl) registerReplyDoorTool(doorUrl);
			}

			// spec v12 L2 (#160): MAIN has no door in its record when created before
			// the plugin. It receives PASEO_SUBAGENTS_DOOR from session_open — register
			// native door proxies for main (spawn_subagent/spawn_pool/answer_child… based
			// on token capabilities). Env BEFORE record; record is the fallback for a
			// main agent that normally receives a door.
			if (myRole === MAIN_ROLE && myAgentId) {
				const mainDoor = findMainDoorUrl(PASEO_AGENTS_DIR, myAgentId);
				if (mainDoor) registerMainDoorTools(mainDoor);
			}

			const allowed = allowlistFor(myRole, roles, Boolean(myRole !== MAIN_ROLE && myAgentId && findDoorUrlForAgent(PASEO_AGENTS_DIR, myAgentId)));
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
					`subagent-types: main — blocked ${before.length - active.length} tools per config (${mainBlockedTools.join(", ")}). Delegate to a subagent when needed.`,
					"info",
				);
			}
		}
	}

	// #128: the universal child→parent door, registered for spawned children
	// whose agent record carries the scoped door URL (written by the
	// subagent-reply plugin at spawn time). Main agents never match the door
	// shape (/mcp + caller token), so they never see this tool.
	const registerReplyDoorTool = (doorUrl: string): void => {
		// #132 (plan step 15) race fix (E2E 2026-09-21): dang ky SYNC hai tool
		// tinh truoc - setActiveTools chay ngay sau applyRole va se chup snapshot
		// TRUOC khi fetch tools/list ve (child tung mat ca reply_to_parent).
		// Child door luon canSpawn=false -> dung 2 tool; async fetch chi bo sung
		// tool la (neu co) cho an toan.
		registerDoorProxy(doorUrl, { name: REPLY_DOOR_TOOL });
		registerDoorProxy(doorUrl, {
			name: "ask_parent",
			description: "Ask the parent agent a blocking question; the answer arrives as a [parent-answer] message.",
			inputSchema: {
				type: "object",
				properties: { question: { type: "string" } },
				required: ["question"],
			},
		});
		void (async () => {
			const list = await fetchDoorTools(doorUrl);
			if (!list.ok) return; // hai tool tinh da du floor - fetch loi khong mat kenh
			const done = new Set([REPLY_DOOR_TOOL, "ask_parent"]);
			for (const t of list.tools) {
				if (done.has(t.name) || !/^[a-z][a-z0-9_]*$/.test(t.name)) continue;
				registerDoorProxy(doorUrl, t);
			}
		})();
	};

	/** v1.4.103 behavior — one hardcoded reply_to_parent (fallback path). */
	const registerSingleDoorTool = (doorUrl: string): void => {
		registerDoorProxy(doorUrl, { name: REPLY_DOOR_TOOL });
	};

	/** spec v12 L2 (#160): main's PRIMARY door — tools/list from the door is
	 *  already filtered by token capabilities (spawn_subagent/spawn_pool/answer_child…);
	 *  do NOT hardcode the child floor (reply_to_parent/ask_parent do not belong
	 *  to main). On fetch failure, log directly; main stays alive (without native
	 *  door tools, the URL can still be used directly). */
	const registerMainDoorTools = (doorUrl: string): void => {
		void (async () => {
			const list = await fetchDoorTools(doorUrl);
			if (!list.ok) {
				console.error(`[subagent-types] main door tools/list failed: ${list.error} — URL=${doorUrl}`);
				return;
			}
			let added = 0;
			for (const t of list.tools) {
				if (!/^[a-z][a-z0-9_]*$/.test(t.name)) continue;
				registerDoorProxy(doorUrl, t);
				added++;
			}
			console.log(`[subagent-types] main door proxies: ${added} tools from ${doorUrl.slice(0, 48)}… (spec v12 L2)`);
		})();
	};

	const registerDoorProxy = (doorUrl: string, spec: DoorToolSpec): void => {
		const isReply = spec.name === REPLY_DOOR_TOOL;
		pi.registerTool({
			name: spec.name,
			label: spec.name,
			description:
				isReply
					? "Deliver your report/question to the parent agent that spawned you. Universal channel — identical on every harness; the caller token in your door URL pins the destination, you cannot address anyone else. If message_main is also available, send each report through exactly ONE of them, never duplicate."
					: spec.description ?? `Paseo subagent door tool '${spec.name}' (proxied through the scoped door of this agent).`,
			parameters: doorSchemaToTypeBox(spec.inputSchema, isReply),
			async execute(_id, params) {
				const r = await callDoorTool(doorUrl, spec.name, params as Record<string, unknown>);
				return {
					content: [{ type: "text" as const, text: r.ok ? `DELIVERED to parent: ${r.text}` : `DELIVERY FAILED — ${r.error}` }],
					details: {},
				};
		},
		});
	};

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

	// #129 idle-archive reminder: REMIND, never auto-archive (user-approved
	// 2026-09-20). Fires when every child is quiescent (no running/initializing,
	// no parked/attention child) and the NEWEST has been idle ≥ the configured
	// minutes; one steer-injected line with a paste-ready command — it lands in
	// the CURRENT run and never wakes an idle parent for housekeeping.
	// Archive safety (verified live 2026-09-20): soft-delete; sending to an
	// archived child auto-unarchives it, so reminders can never strand work.
	let archiveRemindArmed = true;
	let lastArchiveRemindAt = 0;
	let archiveRemindInFlight = false;
	async function maybeRemindIdleArchive(): Promise<void> {
		if (archiveRemindInFlight || !myAgentId || archiveRemindMinutes <= 0) return;
		if (!archiveRemindArmed && Date.now() - lastArchiveRemindAt < ARCHIVE_REMIND_REARM_MS) return;
		const endpoint = findMcpEndpoint(myAgentId);
		if (!endpoint) return;
		archiveRemindInFlight = true;
		try {
			const children = toIdleChildren(await listAgents(endpoint, { limit: 200 }), myAgentId);
			const r = shouldRemindIdleArchive(children, Date.now(), archiveRemindMinutes);
			if (!r) return;
			archiveRemindArmed = false;
			lastArchiveRemindAt = Date.now();
			pi.sendUserMessage(
				`[housekeeping] ${children.length} subagents have been idle for ≥${archiveRemindMinutes} minutes, and none are running/parked. Archive them to keep the list tidy (soft delete — messaging a child automatically unarchives it, verified):
${r.command}`,
				{ deliverAs: "steer" },
			);
		} catch {
			// never throw from an event handler; the next turn retries
		} finally {
			archiveRemindInFlight = false;
		}
	}

/** [contract-error] footer for a nudged child that still auto-reports instead
 *  of a durable submission (moved out of pool.ts when ext pools died — #220). */
function contractErrorNote(nudgedAt?: string): string {
	return `[contract-error] the child never submitted a report${nudgedAt ? ` (1 reminder sent ${nudgedAt})` : ""} — the task demanded a durable submission.`;
}

/** Label ext-pool children used to carry (v1.4.30 pool machinery, removed
 *  2026-09-22) — kept so OLD records still read as pool children. */
const POOL_LABEL = "subagent.pool";

	// v1.2.7 delivery pivot — user-role instead of custom messages.
	// Custom messages are turn-start cut points in pi core: injected mid-run
	// they desync the daemon's turn state (app shows no STOP while streaming,
	// queued user input then hits "Agent is already processing"). user-role
	// delivery renders as a user_message the app + plugins can transform.
	const nudgedOnce = new Set<string>();
	// A nudged child that auto-reports (activity instead of a durable
	// submission) gets the contract-error footer stitched in.
	function annotateNudged(m: ChannelMessage): ChannelMessage {
		if (nudgedOnce.has(m.from) && isAutoReport(m)) {
			return { ...m, text: `${m.text}\n${contractErrorNote()}` };
		}
		return m;
	}

	pi.on("turn_end", () => {
		void kickOutbound();
		void maybeRemindIdleArchive();
		const msgs = flushInbound().map(annotateNudged);
		if (msgs.length === 0) return;
		// steer keeps the report inside the CURRENT run (flushed at the next
		// turn boundary) without starting a new one.
		pi.sendUserMessage(renderForPrompt(msgs), { deliverAs: "steer" });
	});

	pi.on("agent_settled", () => {
		void kickOutbound();
		const msgs = flushInbound().map(annotateNudged);
		if (msgs.length > 0) {
			// settled + pending report: deliver as a queued prompt so the agent
			// wakes to process the payload (beats the auto-ping text-only ping;
			// shouldAutoPing still covers subagents that never called
			// message_main).
			pi.sendUserMessage(renderForPrompt(msgs), { deliverAs: "followUp" });
		}
		void autoPingOnSettle();
	});

	// Auto-report backstop (2026-09-02): a subagent that settled WITHOUT calling
	// message_main still pings its parent — one line, no payload — so main can
	// wake and pull the transcript itself (see shouldAutoPing for history).
	//
	// v1.4.51 single-waker (#37) + v1.4.69 (#61 Phase C): while a goal OR a
	// bridged plan with open steps IS running on main, that kind's continuation
	// loop owns main's wake cadence — auto-ping yields, avoiding two wakers
	// racing over one idle main. The child result gets pulled in by the next
	// wake settle (board/projection); the only loss is one round of latency.
	async function autoPingOnSettle(): Promise<void> {
		if (goalWakeActive() || planWakeActive()) return;
		const self = resolveSelf(sessionIdRef.value);
		// Pool children skip the backstop entirely — their pool driver in main
		// owns the wake (one aggregate, not one ping per child; v1.4.44).
		if (!shouldAutoPing(myRole, messageMainCalledThisRun, resolved, Boolean(self.labels[POOL_LABEL]), doorChildOf())) return;
		if (!myRole) return; // belt-and-suspenders narrowing for TS
		const mainId = self.labels["subagent.parent"] ?? self.labels["paseo.parent-agent-id"];
		if (!mainId || !myAgentId) return;
		const endpoint = findMcpEndpoint(myAgentId);
		if (!endpoint) return;
		const ep: McpEndpoint = endpoint; // narrowed copy — closures keep the guard's guarantee (BORROW #111 from @tintinweb/pi-subagents): batch
		// sibling settles into ONE combined [auto-report] so an ad-hoc fan-out
		// (N spawn_subagent finishing near each other) wakes main once instead
		// of shredding it into N turns. Window = AUTO_REPORT_JOIN_MS (default
		// 10s) from the FIRST pending line; every appender arms the same
		// absolute end; rename-claim picks one flusher; latecomers open the next
		// window (straggler re-batch). JOIN_MS=0 → legacy immediate send.
		const joinMs = joinMsFromEnv(process.env.AUTO_REPORT_JOIN_MS);
		if (joinMs > 0) {
			appendPending(mainId, { agentId: myAgentId, role: myRole, title: self.title, ts: new Date().toISOString() });
			const delay = windowDelayMs(readPending(mainId), joinMs);
			const t = setTimeout(() => {
				void flushJoinWindow(mainId, ep);
			}, delay);
			t.unref?.(); // never hold the process open for a backstop
			return;
		}

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

	/** Claim the window and send ONE combined notice; null-safe and
	 *  throw-safe by design (a backstop must never break settlement). */
	async function flushJoinWindow(mainId: string, endpoint: McpEndpoint): Promise<void> {
		try {
			const pings = claimPending(mainId);
			if (!pings || pings.length === 0) return; // a sibling flushed first / empty window
			const text = buildBatchText(pings);
			const last = pings[pings.length - 1];
			const msg: ChannelMessage = {
				id: `${Date.now()}-apj`,
				from: last.agentId,
				fromRole: last.role,
				text,
				ts: new Date().toISOString(),
			};
			await sendToMain(endpoint, mainId, msg);
		} catch {
			// never let a reporting backstop break settlement
		}
	}

	pi.on("session_start", (_event, ctx) => {
		// First boot races the daemon writing runtimeInfo into the agent
		// record — if the lookup misses now, before_input retries before any
		// prompt is processed.
		applyRole(ctx);
		// Orphan sweep (main role only, once per process): cancel still-running
		// subagents whose parent agent is gone. Backstop for the daemon's
		// archive-cascade (which never runs on kill/crash). Best-effort, async,
		// never blocks the session.
		if (myRole === MAIN_ROLE && myAgentId) {
			const endpoint = findMcpEndpoint(myAgentId);
			if (endpoint) void sweepOrphanedSubagents(endpoint).catch(() => {});
		}
	});

	pi.on("input", (_event, ctx) => {
		applyRole(ctx);
	});

	// Defense in depth: block anything outside the allowlist even if it slips
	// through before setActiveTools applies (first turn race).
	// doorChild (#132/F2): for a child with a scoped door, omit message_main from
	// the allowlist (replacement channel: reply_to_parent/ask_parent through the door).
	const doorChildOf = (): boolean =>
		Boolean(myAgentId && myRole && myRole !== MAIN_ROLE && findDoorUrlForAgent(PASEO_AGENTS_DIR, myAgentId));
	pi.on("tool_call", (event) => {
		if (myRole === MAIN_ROLE) return;
		// #188 standalone-clean layer 2: a session with NO paseo record and NO
		// machine env carrier is a human CLI session — the gate is a CHILD
		// containment mechanism and does not apply to it.
		if (!roleGateApplies(myAgentId)) return;
		const allowed = allowlistFor(myRole, roles, doorChildOf());
		if (allowed.includes("*")) return;
		const toolName =
			"toolName" in event && typeof event.toolName === "string" ? event.toolName : undefined;
		const SPAWN_TOOLS = ["spawn_subagent", "spawn_paseo_subagent"];
		if (toolName && !allowed.includes(toolName) && !SPAWN_TOOLS.includes(toolName)) {
			if (myRole && roles.get(myRole)?.tools.some((t) => mapToolName(t) === toolName)) return;
			if (!myRole && floorTools().includes(toolName)) return;
			if (myRole && !roles.get(myRole)) {
				// unknown role → floor only
				if (!floorTools().includes(toolName)) {
					// #43 envelope: role-undefined denial names the legitimate door.
					return {
						block: true,
						reason: [
							`⛔ subagent-types denied — tool "${toolName}" for role "${myRole}"`,
							`WHY: the role is not defined in agents/ — unknown roles get the read-only floor, and this tool is outside it`,
							`WHERE: tool_call gate (defense-in-depth layer, before execution)`,
							`NEXT: the parent should re-spawn with a defined role (see agents/*.md), or message_main asking the parent to run this step itself`,
						].join("\n"),
					};
				}
				return;
			}
			return {
				block: true,
				reason: [
					`⛔ subagent-types denied — tool "${toolName}" is not in the allowlist for role "${myRole ?? "unlabelled"}"`,
					`WHY: each role carries a fixed toolset (agents/*.md); this tool is outside yours`,
					`WHERE: tool_call gate (defense-in-depth layer, before execution)`,
					`NEXT: message_main the result/finding and let the parent (who owns this tool) act on it`,
				].join("\n"),
			};
		}
		return;
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
	// #133 FROZEN (bugfix-only): message_main is the legacy channel — new children
	// use the door (reply_to_parent/ask_parent, #132 F2); keep this handler for
	// safe backports to children without a door.
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
			// #132/F2: for a child with a scoped door, proxy directly through the door
			// (do not write to the file queue; plugin-delivered [child-report] wakes the parent).
			const doorUrl = myAgentId ? findDoorUrlForAgent(PASEO_AGENTS_DIR, myAgentId) : null;
			if (doorUrl) {
				const r = await callDoorTool(doorUrl, "reply_to_parent", { prompt: params.message });
				return { content: [{ type: "text" as const, text: r.ok ? "(sent through the reply_to_parent door) " + r.text : `door delivery failed: ${r.error ?? "unknown"}` }], details: {} };
			}
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

	// ── research_report (#51) — verified submission for read-only researchers ──
	// Replaces the "write the brief via bash" instruction that pushed children
	// into heredoc workarounds: the report IS the artifact, validated here and
	// delivered to the main over the channel. The pool expect-gate reads the
	// completion token from the same string this tool verified.
	pi.registerTool({
		name: "research_report",
		label: "research_report",
		description:
			"Researchers: submit your FINAL research report through this tool — never write report files via bash. Validated: 400-20000 chars, '## Summary' + at least 2 sections, and the task's completion token (if any) must appear verbatim (put it on the first line). On success the full report is delivered to your main agent; you may end your turn.",
		parameters: Type.Object({
			report: Type.String({ description: "The full report text, starting with the completion token line if the task gave one (e.g. LANDSCAPE-WATCHDOG), then ## Summary / ## Findings / ## Sources / ## Gaps." }),
			token: Type.Optional(Type.String({ description: "The completion token the task demanded, if any (e.g. LANDSCAPE-WATCHDOG)." })),
		}),
		async execute(_id, params) {
			const v = validateResearchReport({ report: params.report, token: params.token });
			if (!v.ok) {
				// #43 denial envelope: WHAT/WHY/NEXT — never a workaround.
				return {
					content: [
						{
							type: "text" as const,
							text: `⛔ research_report rejected — fix the report and call again.
WHAT: ${v.problems.map((p, i) => `${i + 1}. ${p}`).join("\n")}
WHY: the main agent gates your completion on this report's shape; a malformed submission reads as half-done work.
NEXT: revise the report text (sections per template, token on first line) and call research_report again. For questions mid-research use message_main, not this tool.`,
						},
				],
				details: { accepted: false, problems: v.problems, chars: v.stats.chars, sections: v.stats.sections, tokenVerified: false },
				};
			}
			const digest = researchReportDigest(params.report, params.token);
			let delivered = "channel unavailable — report validated but NOT delivered";
			if (myRole && myRole !== MAIN_ROLE && myAgentId) {
				const parent = myAgentId ? (resolveSelf(sessionIdRef.value).labels["subagent.parent"] ?? null) : null;
				const mainId = parent ?? (myAgentId ? (resolveSelf(sessionIdRef.value).labels["paseo.parent-agent-id"] ?? null) : null);
				const endpoint = mainId ? findMcpEndpoint(myAgentId) : null;
				if (mainId && endpoint) {
					const msg: ChannelMessage = {
						id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
						from: myAgentId,
						fromRole: myRole,
						text: digest,
						ts: new Date().toISOString(),
						kind: "message",
					};
					const sent = await sendToMain(endpoint, mainId, msg);
					delivered = sent.ok ? `delivered to main (${mainId})` : `delivery failed: ${sent.error} — retry research_report, or message_main the report directly`;
				}
			}
			return {
				content: [
					{
						type: "text" as const,
						text: `Report accepted — ${v.stats.chars} chars, ${v.stats.sections} sections${v.stats.tokenVerified ? `, token verified` : ""}. ${delivered}. You may end your turn now.`,
					},
				],
				details: { accepted: true, problems: [], chars: v.stats.chars, sections: v.stats.sections, tokenVerified: v.stats.tokenVerified },
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
