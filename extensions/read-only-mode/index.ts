/**
 * read-only mode for pi — daemon port of amosblomqvist/pi-config
 * zz-read-only-mode.ts (2026-08-25 snapshot) + plan mode (v1.4.31).
 *
 * Usage (pi slash commands in Paseo):
 *   /read-only        -> toggle
 *   /read-only on     -> enable
 *   /read-only off    -> disable
 *   /read-only status -> show current state
 *   /plan             -> plan mode: status
 *   /plan on          -> enter plan mode (read-only + write_plan only)
 *   /plan approve     -> USER-ONLY: approve the submitted plan (implements here)
 *   /plan revise      -> back to planning
 *   /plan off         -> discard (plan file stays in the library)
 *   /plan list        -> list .pi/plans/
 *   /plan open <m>    -> load a past plan as the tracking cursor
 *
 * Mechanism (all daemon-compatible APIs, verified on pi 0.84.4):
 * - Hard-enforces a tiny tool allowlist: read, grep, find, ls
 * - pi.setActiveTools() restricts the active tool set
 * - tool_call hook blocks anything outside the allowlist with a reason
 * - before_agent_start injects a system-prompt note while enabled
 *
 * Plan mode (v1.4.31, ported from @pify/plan-mode@0.4.2 per the 2026-09-09
 * eval — the daemon-viable third):
 * - ACTIVE: allowlist = read-only core + write_plan/exit_plan_mode; the ONLY
 *   write path is write_plan, which the extension itself writes to
 *   .pi/plans/YYYY-MM-DD-<slug>.md. No write tool is ever unblocked.
 * - exit_plan_mode (model) only SUBMITS → awaiting. Approval is USER-ONLY:
 *   /plan approve or the plan-control file (panel-ready bridge). The model
 *   can never approve its own plan — the ui.select dead-end of upstream is
 *   replaced by doors outside the model's reach.
 * - tracking after approval: plan_step_done(index, evidence) cursor,
 *   full-snapshot persistence in the session ledger, replay on respawn.
 * - control file ~/.pi/agent/plan-control/<sessionId>.json (v:1 action
 *   on|approve|revise|off) — same bridge pattern as the task extension.
 *
 * Deliberate divergences from upstream (2026-09-06 port + 2026-09-09 plan):
 * - import scope @earendil-works (our pi package) instead of @mariozechner
 * - TUI surfaces removed (no ui.select/confirm/setStatus in the daemon)
 * - NO tool re-registration: subagent-types owns read/grep/find/ls
 * - session_switch/session_fork re-bound to before_switch/before_fork
 * - NOT ported: 3-tier bash classifier (plan mode blocks bash outright),
 *   ctrl+alt+p, --plan flag, HTML export, ctx.newSession fresh-handoff
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, watch, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	PLANS_DIR,
	PLAN_STATE,
	PLAN_CONTROL_DIR,
	applyControlAction,
	emptyPlan,
	markStepDone,
	parseControlPayload,
	parseSteps,
	planFilePath,
	planStatusText,
	replayPlan,
	slugFromPlan,
	type PlanControlPayload,
	type PlanState,
} from "./plan.ts";

export const COMMAND_NAME = "read-only";
export const PLAN_COMMAND_NAME = "plan";
export const READ_ONLY_TOOL_NAMES = ["read", "grep", "find", "ls"] as const;

/** Plan-mode additions to the read-only core (all registered by this ext). */
export const PLAN_TOOL_NAMES = ["write_plan", "exit_plan_mode", "enter_plan_mode", "plan_step_done"] as const;

export function getReadOnlyToolNames(pi: ExtensionAPI): string[] {
	const allToolNames = new Set(pi.getAllTools().map((tool) => tool.name));
	return READ_ONLY_TOOL_NAMES.filter((name) => allToolNames.has(name));
}

function applyReadOnlyTools(pi: ExtensionAPI): void {
	pi.setActiveTools(getReadOnlyToolNames(pi));
}

export function restoreTools(pi: ExtensionAPI, toolsBeforeReadOnly?: string[]): string[] {
	const allToolNames = new Set(pi.getAllTools().map((tool) => tool.name));
	const toolNames = (toolsBeforeReadOnly ?? pi.getAllTools().map((tool) => tool.name)).filter((toolName) =>
		allToolNames.has(toolName),
	);
	pi.setActiveTools(toolNames);
	return toolNames;
}

export default function readOnlyModeExtension(pi: ExtensionAPI) {
	let enabled = false;
	let toolsBeforeReadOnly: string[] | undefined;

	// ── Plan state (ledger-persisted; full snapshots) ─────────────────────
	let plan: PlanState = emptyPlan();
	let toolsBeforePlan: string[] | undefined;
	let sessionId = "";
	let controlSessionBound = false;

	const plansDir = (): string => join(process.cwd(), PLANS_DIR);
	const planActive = (): boolean => plan.mode === "active" || plan.mode === "awaiting";

	function persistPlan(): void {
		try {
			pi.appendEntry(PLAN_STATE, JSON.parse(JSON.stringify(plan)) as never);
		} catch {
			// Ledger failures never break mode changes.
		}
	}

	function applyPlanTools(pi2: ExtensionAPI): void {
		const allToolNames = new Set(pi2.getAllTools().map((t) => t.name));
		const names = [...READ_ONLY_TOOL_NAMES, ...PLAN_TOOL_NAMES].filter((n) => allToolNames.has(n));
		pi2.setActiveTools(names);
	}

	function saveThinking(): void {
		if (plan.thinkingBefore === undefined) {
			try {
				plan.thinkingBefore = String(pi.getThinkingLevel());
			} catch {
				// keep undefined
			}
		}
		try {
			pi.setThinkingLevel("high");
		} catch {
			// clamp per model — best effort
		}
	}

	function restoreThinking(): void {
		if (plan.thinkingBefore !== undefined) {
			try {
				pi.setThinkingLevel(plan.thinkingBefore as never);
			} catch {
				// best effort
			}
			plan.thinkingBefore = undefined;
		}
	}

	function enterPlanMode(ctx: ExtensionContext): void {
		if (planActive()) {
			ctx.ui.notify(`Plan mode already ${plan.mode}.`, "info");
			return;
		}
		toolsBeforePlan = pi.getActiveTools();
		plan.mode = "active";
		saveThinking();
		applyPlanTools(pi);
		persistPlan();
		ctx.ui.notify("Plan mode ON — the model plans via write_plan; nothing else can write. Exit is user-only (/plan off).", "info");
	}

	function leavePlanMode(ctx: ExtensionContext, keepTracking: boolean): void {
		if (!planActive() && plan.mode !== "tracking") {
			ctx.ui.notify("Plan mode already off.", "info");
			return;
		}
		if (!keepTracking) plan.steps = [];
		plan.mode = "inactive";
		restoreThinking();
		restoreTools(pi, toolsBeforePlan);
		toolsBeforePlan = undefined;
		persistPlan();
		ctx.ui.notify(keepTracking ? "Plan mode OFF — tracking cleared; plan file kept." : "Plan mode OFF.", "info");
	}

	/** Shared user-side actions (slash command + control file). */
	function runControlAction(action: PlanControlPayload["action"], ctx: ExtensionContext): string {
		if (action === "on") {
			enterPlanMode(ctx);
			return planStatusText(plan);
		}
		if (action === "approve" && plan.mode === "awaiting") {
			plan = applyControlAction(plan, "approve").state;
			restoreThinking();
			restoreTools(pi, toolsBeforePlan);
			toolsBeforePlan = undefined;
			persistPlan();
			// APPROVE_HERE semantics: a user-role message starts the
			// implementation turn in THIS session (upstream used sendUserMessage
			// followUp too; fresh-session handoff is not ported to the daemon).
			try {
				pi.sendUserMessage(
					`The user APPROVED your plan (${plan.planFile}). Implement it now. After each step call plan_step_done(index, evidence) with real evidence — same verify discipline as task tools. Open steps: ${plan.steps.filter((s) => !s.done).length}/${plan.steps.length}.`,
					{ deliverAs: "followUp" },
				);
			} catch {
				ctx.ui.notify("Approved, but the kick message failed — tell the model to start implementing.", "warning");
			}
			return "Approved — implementation turn started.";
		}
		if (action === "revise" && plan.mode === "awaiting") {
			plan = applyControlAction(plan, "revise").state;
			applyPlanTools(pi);
			persistPlan();
			return "Back to planning — the model keeps editing via write_plan.";
		}
		if (action === "off") {
			leavePlanMode(ctx, false);
			return "Plan mode OFF.";
		}
		return applyControlAction(plan, action).note;
	}

	// ── Control-file bridge (panel-ready, user-only doors) ────────────────
	function controlFilePath(sid: string): string {
		return join(homedir(), ".pi", "agent", PLAN_CONTROL_DIR, `${sid}.json`);
	}

	function consumeControlFile(sid: string, ctx: ExtensionContext): void {
		const file = controlFilePath(sid);
		if (!existsSync(file)) return;
		let payload: PlanControlPayload | null = null;
		try {
			payload = parseControlPayload(JSON.parse(readFileSync(file, "utf8")));
		} catch {
			return;
		}
		if (!payload) return;
		const note = runControlAction(payload.action, ctx);
		ctx.ui.notify(`plan-control: ${payload.action} — ${note}`, "info");
		try {
			writeFileSync(file, `${JSON.stringify({ ...payload, ackAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
		} catch {
			// ack best effort
		}
	}

	function bindControlWatcher(ctx: ExtensionContext): void {
		if (controlSessionBound || !sessionId) return;
		controlSessionBound = true;
		const dir = join(homedir(), ".pi", "agent", PLAN_CONTROL_DIR);
		try {
			mkdirSync(dir, { recursive: true });
		} catch {
			return;
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			watch(dir, () => {
				clearTimeout(timer);
				timer = setTimeout(() => {
					const file = controlFilePath(sessionId);
					if (!existsSync(file)) return;
					let seen = "";
					try {
						seen = readFileSync(file, "utf8");
					} catch {
						return;
					}
					if (seen.includes('"ackAt"')) return; // already consumed
					consumeControlFile(sessionId, ctx);
				}, 150);
			});
		} catch {
			// watcher best effort
		}
	}

	// ── Plain read-only mode (unchanged core) ─────────────────────────────

	function enableReadOnlyMode(ctx: ExtensionContext): void {
		if (enabled) {
			ctx.ui.notify("Read-only mode is already enabled.", "info");
			return;
		}

		enabled = true;
		toolsBeforeReadOnly = pi.getActiveTools();
		applyReadOnlyTools(pi);

		const tools = getReadOnlyToolNames(pi).join(", ");
		ctx.ui.notify(`Read-only mode enabled. Tools: ${tools || "(none)"}.`, "info");
	}

	function disableReadOnlyMode(ctx: ExtensionContext): void {
		if (!enabled) {
			ctx.ui.notify("Read-only mode is already disabled.", "info");
			return;
		}

		enabled = false;
		restoreTools(pi, toolsBeforeReadOnly);
		toolsBeforeReadOnly = undefined;
		ctx.ui.notify("Read-only mode disabled. Previous tool access restored.", "info");
	}

	function toggleReadOnlyMode(ctx: ExtensionContext): void {
		if (enabled) disableReadOnlyMode(ctx);
		else enableReadOnlyMode(ctx);
	}

	pi.registerCommand(COMMAND_NAME, {
		description: "Toggle hard-enforced read-only mode (allowlist: read, grep, find, ls)",
		getArgumentCompletions(prefix) {
			const actions = ["toggle", "on", "off", "status"];
			const items = actions
				.filter((action) => action.startsWith(prefix.toLowerCase()))
				.map((action) => ({ value: action, label: action }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();

			switch (action) {
				case "":
				case "toggle":
					toggleReadOnlyMode(ctx);
					return;
				case "on":
				case "enable":
					enableReadOnlyMode(ctx);
					return;
				case "off":
				case "disable":
					disableReadOnlyMode(ctx);
					return;
				case "status": {
					const tools = getReadOnlyToolNames(pi).join(", ");
					ctx.ui.notify(
						enabled
							? `Read-only mode is ON. Allowed tools: ${tools || "(none)"}.`
							: "Read-only mode is OFF.",
						"info",
					);
					return;
				}
				default:
					ctx.ui.notify(`Usage: /${COMMAND_NAME} [on|off|toggle|status]`, "warning");
			}
		},
	});

	// ── /plan command ─────────────────────────────────────────────────────

	pi.registerCommand(PLAN_COMMAND_NAME, {
		description: "Plan mode: read-only planning with a user-only approve gate (/plan on|approve|revise|off|status|list|open)",
		getArgumentCompletions(prefix) {
			const actions = ["on", "approve", "revise", "off", "status", "list", "open"];
			const items = actions
				.filter((action) => action.startsWith(prefix.toLowerCase()))
				.map((action) => ({ value: action, label: action }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const [verb, ...rest] = args.trim().split(/\s+/);
			switch (verb ?? "") {
				case "":
				case "status":
					ctx.ui.notify(planStatusText(plan), "info");
					return;
				case "on":
					ctx.ui.notify(runControlAction("on", ctx), "info");
					return;
				case "approve":
				case "revise":
				case "off":
					ctx.ui.notify(runControlAction(verb as "approve" | "revise" | "off", ctx), "info");
					return;
				case "list": {
					try {
						const files = readdirSync(plansDir()).filter((f) => f.endsWith(".md")).sort().reverse();
						ctx.ui.notify(files.length > 0 ? `Plans:\n${files.map((f) => `- ${f}`).join("\n")}` : "No plans yet (.pi/plans/).", "info");
					} catch {
						ctx.ui.notify("No plans yet (.pi/plans/).", "info");
					}
					return;
				}
				case "open": {
					const needle = rest.join(" ").toLowerCase();
					if (!needle) {
						ctx.ui.notify("Usage: /plan open <fragment of filename>", "warning");
						return;
					}
					try {
						const files = readdirSync(plansDir()).filter((f) => f.endsWith(".md")).sort().reverse();
						const hit = files.find((f) => f.toLowerCase().includes(needle));
						if (!hit) {
							ctx.ui.notify(`No plan matching "${needle}".`, "warning");
							return;
						}
						const full = join(plansDir(), hit);
						plan = { mode: "tracking", planFile: full, steps: parseSteps(readFileSync(full, "utf8")) };
						persistPlan();
						ctx.ui.notify(`Loaded ${hit} — tracking ${plan.steps.length} steps (read-only mode NOT restored; upstream behavior).\n${planStatusText(plan)}`, "info");
					} catch {
						ctx.ui.notify("Failed to read the plans directory.", "warning");
					}
					return;
				}
				default:
					ctx.ui.notify(`Usage: /${PLAN_COMMAND_NAME} [on|approve|revise|off|status|list|open <match>]`, "warning");
			}
		},
	});

	// ── Plan tools ────────────────────────────────────────────────────────

	const EnterParams = Type.Object({});
	type EnterDetails = { mode?: string };
	const WritePlanParams = Type.Object({
		content: Type.String({ description: "Complete plan markdown. First `# heading` names the plan; top-level list items become trackable steps." }),
	});
	type WriteDetails = { file?: string; steps?: number };
	const ExitParams = Type.Object({});
	type ExitDetails = { mode?: string; steps?: number };
	const StepDoneParams = Type.Object({
		index: Type.Number({ description: "1-based step index from the plan." }),
		evidence: Type.String({ description: "What proves this step is done (command run, file written, output seen)." }),
	});
	type StepDetails = { open?: number; total?: number };

	pi.registerTool<typeof EnterParams, EnterDetails>({
		name: "enter_plan_mode",
		label: "enter_plan_mode",
		description:
			"Enter plan mode: read-only exploration + write_plan for the plan file, nothing else. Plan first when the task is risky or the user asks for a plan. Exiting is user-only — exit_plan_mode submits the plan for approval.",
		promptSnippet: "Call enter_plan_mode before non-trivial implementation when a plan adds value; the user approves before anything executes.",
		parameters: EnterParams,
		async execute() {
			if (planActive()) {
				return { content: [{ type: "text" as const, text: `Plan mode already ${plan.mode}.` }], details: {} };
			}
			plan.mode = "active";
			saveThinking();
			toolsBeforePlan = pi.getActiveTools();
			applyPlanTools(pi);
			persistPlan();
			return {
				content: [{ type: "text" as const, text: "Plan mode ON. Explore with read/grep/find/ls, then author the plan with write_plan (steps = top-level numbered/bulleted lines, max 40). When the plan is ready, call exit_plan_mode — the USER approves it; you cannot approve your own plan." }],
				details: { mode: plan.mode },
			};
		},
	});

	pi.registerTool<typeof WritePlanParams, WriteDetails>({
		name: "write_plan",
		label: "write_plan",
		description:
			"Write the full plan markdown (plan mode only). The extension writes .pi/plans/YYYY-MM-DD-<slug>.md — the ONLY write path in plan mode. Re-writes replace the plan; steps are top-level numbered/bulleted lines (≤40, ≤200 chars).",
		parameters: WritePlanParams,
		async execute(_id, params) {
			if (plan.mode !== "active") {
				return { content: [{ type: "text" as const, text: `write_plan is only available in plan mode (current: ${plan.mode}).` }], details: {} };
			}
			try {
				mkdirSync(plansDir(), { recursive: true });
				const existing = existsSync(plansDir()) ? readdirSync(plansDir()).filter((f) => f.endsWith(".md")) : [];
				const name = plan.planFile ? plan.planFile.split(/[\\/]/).pop()! : planFilePath(existing, slugFromPlan(params.content));
				const full = join(plansDir(), name);
				const tmp = `${full}.tmp-${Date.now().toString(36)}`;
				writeFileSync(tmp, params.content, "utf8");
				renameSync(tmp, full);
				plan.planFile = full;
				plan.steps = parseSteps(params.content);
				persistPlan();
				return {
					content: [{ type: "text" as const, text: `Plan written: ${name} — ${plan.steps.length} steps parsed. Revise freely; when ready call exit_plan_mode (the user approves).` }],
					details: { file: name, steps: plan.steps.length },
				};
			} catch (e) {
				return { content: [{ type: "text" as const, text: `Failed to write the plan: ${String(e)}` }], details: {} };
			}
		},
	});

	pi.registerTool<typeof ExitParams, ExitDetails>({
		name: "exit_plan_mode",
		label: "exit_plan_mode",
		description:
			"Submit the plan for USER approval (plan mode only). There is no self-approve: this only marks the plan as awaiting the user's /plan approve (or the panel button / plan-control file). Stay available for questions until then.",
		parameters: ExitParams,
		async execute() {
			if (plan.mode !== "active") {
				return { content: [{ type: "text" as const, text: `exit_plan_mode needs plan mode active (current: ${plan.mode}).` }], details: {} };
			}
			if (!plan.planFile || plan.steps.length === 0) {
				return { content: [{ type: "text" as const, text: "No plan written yet — call write_plan first." }], details: {} };
			}
			plan.mode = "awaiting";
			plan.submittedAt = new Date().toISOString();
			persistPlan();
			return {
				content: [{ type: "text" as const, text: "Plan submitted — waiting for the USER. Doors: /plan approve (start implementing here), /plan revise (keep editing), /plan off (discard). You cannot approve your own plan. End your turn and wait." }],
				details: { mode: plan.mode, steps: plan.steps.length },
			};
		},
	});

	pi.registerTool<typeof StepDoneParams, StepDetails>({
		name: "plan_step_done",
		label: "plan_step_done",
		description:
			"Mark a plan step done (after approval) with real evidence. Same verify discipline as task evidence: cite the command/file/output that proves the step.",
		parameters: StepDoneParams,
		async execute(_id, params) {
			if (plan.steps.length === 0) {
				return { content: [{ type: "text" as const, text: "No plan loaded — /plan open <match> or approve a plan first." }], details: {} };
			}
			const r = markStepDone(plan, params.index, params.evidence);
			if (!r.ok) return { content: [{ type: "text" as const, text: r.error }], details: {} };
			persistPlan();
			const openList = plan.steps.filter((s) => !s.done).map((s) => `#${s.index} ${s.text}`).join("\n");
			return {
				content: [{ type: "text" as const, text: `Step #${params.index} done — ${r.total - r.open}/${r.total} complete. Open:\n${openList || "(none — plan complete)"}` }],
				details: { open: r.open, total: r.total },
			};
		},
	});

	// ── Hooks ─────────────────────────────────────────────────────────────

	pi.on("before_agent_start", async (event) => {
		if (planActive()) {
			applyPlanTools(pi);
			return {
				systemPrompt:
					event.systemPrompt +
					`\n\n[Plan mode is active (${plan.mode})]\n` +
					`- Read-only exploration: read, grep, find, ls.\n` +
					`- The ONLY write path is write_plan → ${plan.planFile ?? ".pi/plans/<date>-<slug>.md"} (extension-written).\n` +
					`- When the plan is ready, call exit_plan_mode. The USER approves — never claim approval yourself.\n` +
					(plan.mode === "awaiting" ? `- Plan submitted; answer questions but change nothing until the user decides.\n` : ""),
			};
		}
		if (!enabled) return;

		applyReadOnlyTools(pi);

		const tools = getReadOnlyToolNames(pi).join(", ") || "(none)";
		return {
			systemPrompt:
				event.systemPrompt +
				`\n\n[Read-only mode is active]\n` +
				`- You may only use these tools: ${tools}.\n` +
				`- You must not attempt any action that changes local files, processes, git state, dependencies, databases, remote systems, or any other external state.\n` +
				`- If the user asks for any write or side-effecting action, explain that read-only mode is enabled and tell them to run /${COMMAND_NAME} off first.`,
		};
	});

	pi.on("tool_call", async (event) => {
		if (planActive()) {
			const allowed = new Set<string>([...READ_ONLY_TOOL_NAMES, ...PLAN_TOOL_NAMES]);
			if (allowed.has(event.toolName)) return;
			return {
				block: true,
				reason:
					`Plan mode (${plan.mode}) is active. Tool "${event.toolName}" is blocked. ` +
					`Allowed: read, grep, find, ls, write_plan, exit_plan_mode. ` +
					`The user lifts this gate with /plan approve or /plan off.`,
			};
		}
		if (!enabled) return;

		const allowedToolNames = new Set(getReadOnlyToolNames(pi));
		if (allowedToolNames.has(event.toolName)) return;

		return {
			block: true,
			reason:
				`Read-only mode is active. Tool "${event.toolName}" is blocked. ` +
				`Allowed tools: ${Array.from(allowedToolNames).join(", ") || "(none)"}. ` +
				`Use /${COMMAND_NAME} off to restore full tool access.`,
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		// Replay plan state (compaction-safe full snapshots, last wins).
		try {
			const branch = (ctx as { sessionManager?: { getBranch?: () => unknown[]; getSessionId?: () => string } }).sessionManager;
			const entries = branch?.getBranch?.();
			if (Array.isArray(entries)) plan = replayPlan(entries as never);
			const sid = branch?.getSessionId?.();
			if (typeof sid === "string" && sid) sessionId = sid;
		} catch {
			// fresh session starts plan-less
		}
		if (planActive()) applyPlanTools(pi);
		else if (enabled) applyReadOnlyTools(pi);
		bindControlWatcher(ctx);
		// A control action may have landed while the process was down.
		consumeControlFile(sessionId, ctx);
	});

	// pi 0.84.4 names these before_switch/before_fork (upstream zz-read-only-mode
	// used post-hoc session_switch/session_fork from an older pi — divergence).
	pi.on("session_before_switch", async () => {
		if (planActive()) applyPlanTools(pi);
		else if (enabled) applyReadOnlyTools(pi);
	});

	pi.on("session_before_fork", async () => {
		if (planActive()) applyPlanTools(pi);
		else if (enabled) applyReadOnlyTools(pi);
	});
}
