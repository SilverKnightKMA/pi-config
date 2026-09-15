/**
 * Ported from pifydev/task @ 0.3.0 (MIT, https://github.com/pifydev/task),
 * snapshot 2026-09-07. Upstream design synthesis: CC-style tools/widget/nudges
 * (@tintinweb/pi-tasks), dependency graph + ready-set (eleqtrizit/pi-tasks),
 * evidence-gated completion (nczz/pi-tasks).
 *
 * Port adaptations for this repo (Paseo daemon + pi-config):
 * - import scope "typebox" -> "@sinclair/typebox" (house dependency)
 * - entry lives at extensions/task/index.ts with src/ beside it, so upstream
 *   "../src/x.ts" imports become "./src/x.ts"; nothing else changed
 * - widget + /tasks notify are hasUI-guarded upstream and stay TUI-only;
 *   in the Paseo daemon both no-op — the tools, evidence gate, nudges
 *   (transient <system-reminder> via the context hook) and session ledger
 *   persistence are the daemon-relevant surface
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, renameSync, watch, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
	TASK_STATE,
	createTask,
	newlyReady,
	readyTasks,
	replayBranch,
	updateTask,
	fieldChanges,
	openBlockers,
	type UpdatePatch,
} from "./src/graph.ts";
import { buildCompletionSweep, buildNudge, classifyTurn, completionSignature, shouldNudge } from "./src/nudge.ts";
import { buildWidgetLines } from "./src/widget.ts";
import { buildTaskStatus, taskStatusPath, writeTaskStatus } from "./src/status-file.ts";
import {
	auditCompletion,
	checkEvidenceCommands,
	parseVerify,
	redGreenCheck,
	summarizeAudit,
	type RunLogEntry,
	type VerifySpec,
} from "./src/verify.ts";
import {
	buildJudgePacket,
	MAX_JUDGE_ROUNDS,
	parseJudgeVerdict,
	pickLogSlice,
	verdictConsequence,
	type JudgeProbeView,
} from "./src/judge.ts";
import { ackPayload, applyControlAction, controlFilePath, parseControlPayload } from "./src/control.ts";
import { EMPTY_STATE, DESC_AMEND_MAX, type TaskProposal, type TaskState, type TaskStatus } from "./src/types.ts";
import { activeGoal, anyGoalRunning, goalIdActive, planContinuationActive, tryConsumeLease } from "./src/goal-bridge.ts";
import { decide, nextStreak, TASK_BUDGET, continuationOwnedByHigherKind } from "../_shared/continuation-driver.ts";
import { ackPlanBridge, applyPlanBridge, planBridgePath, readPlanBridge } from "./src/plan-bridge.ts";

type UiContext = ExtensionContext;

// ── Layer-2 judge runner ─────────────────────────────────────────────
// Independent LLM verification (design: pify-pending row 9, settled
// 2026-09-09). Judge model MUST be a different family than the worker's
// GLM — default fci/deepseek-v4-flash; override: env TASK_JUDGE_MODEL, then
// settings taskJudgeModel (workspace .pi/settings.json > ~/.pi/agent).
const DEFAULT_JUDGE_MODEL = "cli-openai/fci/deepseek-v4-flash";
const JUDGE_TIMEOUT_MS = 60_000;

function readSettingsKey(cwd: string, key: string): string | null {
	const candidates = [`${cwd}/.pi/settings.json`, `${process.env.HOME || ""}/.pi/agent/settings.json`];
	for (const p of candidates) {
		try {
			const raw = JSON.parse(readFileSync(p, "utf8"));
			if (raw && typeof raw === "object" && typeof (raw as Record<string, unknown>)[key] === "string") {
				return (raw as Record<string, string>)[key];
			}
		} catch {
			// absent/unparsable — next candidate
		}
	}
	return null;
}

function resolveJudgeModel(cwd: string): string {
	const env = process.env.TASK_JUDGE_MODEL;
	if (env && env.trim()) return env.trim();
	return readSettingsKey(cwd, "taskJudgeModel") ?? DEFAULT_JUDGE_MODEL;
}

/** Same entry-point trick the OM workers use: run pi through the real entry
 *  file when resolvable, else plain `pi` on PATH. */
function resolvePiBinary(): { command: string; baseArgs: string[] } {
	const entry = process.argv[1];
	if (entry) {
		try {
			const realEntry = realpathSync(entry);
			if (/\.(?:mjs|cjs|js)$/i.test(realEntry)) {
				return { command: process.execPath, baseArgs: [realEntry] };
			}
		} catch {
			// fall through
		}
	}
	return { command: "pi", baseArgs: [] };
}

/** Test seam: overrides the subprocess judge (pure wiring tests inject a stub). */
let judgeRunnerOverride: ((packet: string) => Promise<string | null>) | null = null;
export function _setJudgeRunnerForTests(fn: ((packet: string) => Promise<string | null>) | null): void {
	judgeRunnerOverride = fn;
}

/** Spawn a headless, tool-less, extension-less pi on the judge model with the
 *  packet as the one prompt. Resolves stdout, or null on any failure/timeout
 *  (the tool layer treats null as judge-unavailable → fail-closed refusal). */
function runJudge(packet: string, cwd: string): Promise<string | null> {
	if (judgeRunnerOverride) return judgeRunnerOverride(packet);
	return new Promise((resolve) => {
		let settled = false;
		const done = (v: string | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(v);
		};
		const pi = resolvePiBinary();
		const argv = [
			...pi.baseArgs,
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-context-files",
			"--no-builtin-tools",
			"--model",
			resolveJudgeModel(cwd),
			"-p",
			packet,
		];
		const proc = spawn(pi.command, argv, {
			cwd,
			// stdin MUST be closed: `pi -p` reads stdin when it is an open pipe
			// and hangs forever waiting for EOF (observed live 2026-09-09 — judge
			// “unavailable” with 0 bytes of output, while the same argv from a
			// closed-stdin shell returned in ~2s). stdio ignore = no stdin.
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		const timer = setTimeout(() => {
			proc.kill("SIGKILL");
			done(null);
		}, JUDGE_TIMEOUT_MS);
		proc.stdout?.on("data", (d: Buffer) => {
			if (out.length < 100_000) out += d.toString("utf8");
		});
		proc.on("error", () => done(null));
		proc.on("close", (code) => done(code === 0 && out.trim() ? out : null));
	});
}

export default function taskExtension(pi: ExtensionAPI) {
	let state: TaskState = EMPTY_STATE;
	let turnsSinceTaskTool = 0;
	/** Which completed list has already had its sweep, so it fires once. */
	let sweptSignature: string | null = null;
	let lastTurnTextOnly = false;
	let lastUiCtx: UiContext | null = null;
	/** Session whose status projection we write (set at session_start). */
	let statusSessionId = "";
	/** Serializes projection writes: session_start's empty write and the next
	 * commit's write race on rename; last-rename-wins could leave a STALE
	 * (older) snapshot on disk if writes land out of call order. */
	let statusWriteQueue: Promise<void> = Promise.resolve();

	/** Layer-1 run log: bash calls + WRITE-TOOL calls (write/edit — v1.4.76:
	 * files created via the write tool were invisible to the judge, which held
	 * completions on "no command shows file creation") this session really
	 * executed (ring, cap 200). The extension NEVER executes probe commands —
	 * it matches declared probes against what the worker ran through its
	 * normal tool pipeline, so a green probe is proof the command really ran,
	 * with no injection surface. */
	let runLog: RunLogEntry[] = [];
	const runLogByCall = new Map<string, RunLogEntry>();
	const BASH_TOOLS = new Set(["bash", "safe_bash"]);
	const WRITE_TOOLS = new Set(["write", "edit"]);
	function pushRunEntry(toolCallId: string, entry: RunLogEntry): void {
		runLogByCall.set(toolCallId, entry);
		runLog.push(entry);
		if (runLog.length > 200) runLog = runLog.slice(-200);
	}

	/** Session whose control file this process watches (set at session_start). */
	let controlSessionId = "";
	/** sentAt of the last control payload applied (self-write ack dedupe). */
	let lastControlSentAt: string | undefined;
	let controlDebounce: ReturnType<typeof setTimeout> | undefined;

	/** Ack the applied control payload so the panel can confirm the engine is live. */
	function ackControlFile(payload: ReturnType<typeof parseControlPayload>): void {
		if (!controlSessionId || !payload) return;
		try {
			const file = controlFilePath(controlSessionId);
			mkdirSync(dirname(file), { recursive: true });
			const tmp = `${file}.tmp-${process.pid}`;
			writeFileSync(tmp, ackPayload(payload, new Date().toISOString()), "utf8");
			renameSync(tmp, file);
		} catch {
			// best-effort ack
		}
	}

	/** v1.4.69 (#61 Phase C): task continuation — wake when in_progress work
	 *  remains at settle (budget 10 per episode, anti-spin 3, ladder 5→80s).
	 *  Yields while goal/plan own main's wake cadence (single-waker priority). */
	let taskWakeTimer: ReturnType<typeof setTimeout> | null = null;

	function clearTaskWake(): void {
		if (taskWakeTimer) {
			clearTimeout(taskWakeTimer);
			taskWakeTimer = null;
		}
	}

	function taskSettle(): void {
		clearTaskWake();
		if (!controlSessionId) return;
		if (continuationOwnedByHigherKind(anyGoalRunning(), planContinuationActive(controlSessionId))) return;
		const open = state.tasks.filter((t) => t.status === "in_progress");
		if (open.length === 0) {
			if (state.wake) {
				state = { ...state, wake: undefined };
				pi.appendEntry(TASK_STATE, state);
			}
			return;
		}
		const sig = open.map((t) => `${t.id}:${t.status}:${t.updatedAt}`).join(",");
		const prev = state.wake && state.wake.signature === sig ? state.wake : { rounds: 0, noProgress: 0, signature: sig };
		const d = decide({ kind: "task", active: true, openWork: open.length, rounds: prev.rounds, budget: TASK_BUDGET, noProgressStreak: prev.noProgress });
		if (d.action !== "wake") {
			try {
				pi.sendMessage({
					customType: "task-wake",
					content: `[task] continuation wrapped up — ${d.reason}. #${open.map((t) => t.id).join(" #")} still in_progress; the user decides next (park with a reason or keep going manually).`,
					display: true,
				});
			} catch {
				// display best effort
			}
			return;
		}
		taskWakeTimer = setTimeout(() => {
			taskWakeTimer = null;
			if (!controlSessionId) return;
			if (continuationOwnedByHigherKind(anyGoalRunning(), planContinuationActive(controlSessionId))) return;
			const nowOpen = state.tasks.filter((t) => t.status === "in_progress");
			if (nowOpen.length === 0) return;
			const nowSig = nowOpen.map((t) => `${t.id}:${t.status}:${t.updatedAt}`).join(",");
			const next = { rounds: (state.wake && state.wake.signature === nowSig ? state.wake.rounds : 0) + 1, noProgress: nextStreak(state.wake && state.wake.signature === nowSig ? state.wake.noProgress : 0, state.wake?.signature ?? "", nowSig), signature: nowSig };
			state = { ...state, wake: next };
			pi.appendEntry(TASK_STATE, state);
			projectStatus();
			pi.sendUserMessage(
				`[task wake ${next.rounds}/${TASK_BUDGET}] #${nowOpen.map((t) => t.id).join(" #")} still in_progress — continue with task_update (real evidence; the judge gates completion) or park with a reason if genuinely blocked. Do not re-declare completed without evidence.`,
				{ deliverAs: "followUp" },
			);
			taskSettle();
		}, d.delaySec * 1000);
	}

	/** Apply a plugin/user action from the control file (watch callback). */
	function consumeControlFile(): void {
		if (!controlSessionId) return;
		let payload: ReturnType<typeof parseControlPayload> = null;
		try {
			payload = parseControlPayload(readFileSync(controlFilePath(controlSessionId), "utf8"));
		} catch {
			return; // unreadable — nothing to apply
		}
		if (!payload) return;
		if (payload.sentAt && payload.sentAt === lastControlSentAt) return; // our own ack echo
		lastControlSentAt = payload.sentAt ?? `no-sentAt-${Date.now()}`;
		const result = applyControlAction(state, payload, Date.now());
		if (result.applied) {
			// engine-side commit: no ctx here, projection + widget refresh via stored ctx
			state = result.state;
			pi.appendEntry(TASK_STATE, state);
			projectStatus();
			renderWidget();
			// v1.4.53: closed loop — report back to the model so it can continue, no polling
			if (payload.action === "proposal-decide") {
				pi.sendUserMessage(
					`[task-proposal] #${payload.id} ${payload.decision === "apply" ? "user APPROVED" : "user REJECTED"} the done-check amendment proposal${payload.note ? ` (note: ${payload.note})` : ""}. ${payload.decision === "apply" ? "New brief applied — continue with the new brief." : "Brief unchanged — continue under the old brief or ask the user to clarify."}`,
					{ deliverAs: "followUp" },
				);
			}
		}
		ackControlFile(payload);
	}

	/** v1.4.68 #47 Phase B: consume a plan-bridge request written by the plan
	 *  engine when the USER approves (tracking → one strict judgment-verified
	 *  step-task per step) or drops (off → cancel still-open step-tasks) a plan.
	 *  Idempotent by planId+stepIndex — a missed ack never duplicates tasks. */
	function consumePlanBridge(): void {
		if (!controlSessionId) return;
		const payload = readPlanBridge(controlSessionId);
		if (!payload || payload.consumedAt) return;
		const next = applyPlanBridge(state, payload, Date.now());
		if (next !== state) {
			state = next;
			pi.appendEntry(TASK_STATE, next);
			projectStatus();
			renderWidget();
		}
		ackPlanBridge(payload);
	}

	function extractOutput(result: unknown): string {
		const r = result as { content?: Array<{ type?: string; text?: unknown }> } | null;
		if (r && Array.isArray(r.content)) {
			const text = r.content
				.map((b) => (typeof b?.text === "string" ? b.text : ""))
				.join("\n")
				.trim();
			if (text) return text.slice(0, 2000);
		}
		if (typeof result === "string") return result.slice(0, 2000);
		try {
			return JSON.stringify(result).slice(0, 2000);
		} catch {
			return "";
		}
	}

	pi.on("tool_execution_start", (event) => {
		const e = event as { toolCallId?: string; toolName?: string; args?: { command?: unknown; path?: unknown; content?: unknown; edits?: unknown } };
		if (!e.toolCallId) return;
		if (BASH_TOOLS.has(e.toolName ?? "")) {
			if (typeof e.args?.command !== "string") return;
			pushRunEntry(e.toolCallId, { tool: e.toolName ?? "", cmd: e.args.command, output: "", ts: Date.now() });
			return;
		}
		if (WRITE_TOOLS.has(e.toolName ?? "")) {
			const p = typeof e.args?.path === "string" ? e.args.path : "?";
			const cmd =
				e.toolName === "write"
					? `write ${p} (${typeof e.args?.content === "string" ? Buffer.byteLength(e.args.content, "utf8") : "?"} bytes)`
					: `edit ${p} (${Array.isArray(e.args?.edits) ? e.args.edits.length : "?"} block(s))`;
			pushRunEntry(e.toolCallId, { tool: e.toolName ?? "", cmd, output: "", ts: Date.now() });
		}
	});

	pi.on("tool_execution_end", (event) => {
		const e = event as { toolCallId?: string; result?: unknown };
		const id = e.toolCallId;
		if (!id) return;
		const entry = runLogByCall.get(id);
		if (!entry) return;
		entry.output = extractOutput(e.result);
		runLogByCall.delete(id);
	});

	/** Read-only file projection (~/.pi/agent/task-status/<sessionId>.json):
	 * ledger stays single-writer truth; the file is for audit + Paseo panels.
	 * Fire-and-forget — projection failure never breaks the tools. */
	function projectStatus(): void {
		if (!statusSessionId) return;
		statusWriteQueue = statusWriteQueue
			.then(() => writeTaskStatus(taskStatusPath(statusSessionId), buildTaskStatus(state, statusSessionId)))
			.catch((err) => console.warn(`[task] status projection failed: ${err instanceof Error ? err.message : String(err)}`));
	}

	function commit(ctx: UiContext, next: TaskState): void {
		state = next;
		pi.appendEntry(TASK_STATE, next);
		projectStatus();
		renderWidget(ctx);
	}

	function renderWidget(ctx: UiContext | null = lastUiCtx): void {
		if (!ctx || !ctx.hasUI) return;
		lastUiCtx = ctx;
		const active = state.tasks.filter((t) => t.status !== "cancelled");
		if (active.length === 0) {
			ctx.ui.setWidget("task", undefined);
			return;
		}
		ctx.ui.setWidget(
			"task",
			(_tui: unknown, theme: { fg(c: string, s: string): string; bold(s: string): string }) =>
				new Text(buildWidgetLines(state, theme).join("\n"), 0, 0),
			{ placement: "aboveEditor" },
		);
	}

	function snapshot(): string {
		if (state.tasks.length === 0) return "No tasks.";
		const index = new Map(state.tasks.map((t) => [t.id, t]));
		const lines = state.tasks.map((t) => {
			const blockers = openBlockers(t, index);
			const flags = [
				t.status,
				blockers.length > 0 ? `blocked by ${blockers.map((b) => `#${b}`).join(",")}` : "",
				t.evidence ? "evidence recorded" : "",
				t.verify ? `verify:${t.verify.lane}${t.verify.probes.length > 0 ? `(${t.verify.probes.length})` : ""}${t.verify.strict ? "+strict" : ""}` : "",
				t.audit ? `audit:${t.audit.verdict}` : "",
				t.judgeRounds ? `judge-rounds:${t.judgeRounds}` : "",
				t.failStreak ? `fail-streak:${t.failStreak}` : "",
				t.status === "parked" ? `parked:${(t.appealReason ?? "awaiting user").slice(0, 60)}` : "",
				t.status === "held" ? `HELD judge ${t.judgeRounds ?? 1}/3 — needs real evidence, do not re-declare verbatim` : "",
			]
				.filter(Boolean)
				.join(" · ");
			return `#${t.id} [${flags}] ${t.subject}${t.description ? ` — ${t.description}` : ""}`;
		});
		const ready = readyTasks(state);
		if (ready.length > 0) {
			lines.push(`Ready to start: ${ready.map((t) => `#${t.id}`).join(", ")}`);
		}
		return lines.join("\n");
	}

	// ── Tools ────────────────────────────────────────────────────────────

	// details.tasks rides every tool result (model-invisible metadata) so the
	// Paseo task plugin's timeline transformer can render a snapshot card.
	// details.changes (create/update only) is the compact prev→next diff the
	// in-flow card shows by default; the full snapshot stays available but is
	// collapsed behind the card's expander (user request 2026-09-09).
	const detailsTasks = (s: TaskState) =>
		s.tasks.map((t) => ({ id: t.id, subject: t.subject, status: t.status }));
	const changeFor = (id: number, from: string | null, to: string) => {
		const t = state.tasks.find((x) => x.id === id);
		return t ? [{ id, subject: t.subject, from, to }] : [];
	};

	pi.registerTool({
		name: "task_create",
		label: "Create task",
		promptSnippet: "Track a task, with dependencies on other tasks",
		description:
			"Add a task to the session task list. Use for multi-step work so progress is visible and " +
			"survives compaction. blockedBy lists ids of tasks that must complete first (cycles and " +
			"dangling ids are dropped with warnings). Create tasks BEFORE starting the work they describe. " +
			"Tasks are OPTIONAL — never create one just to be allowed to work: chat, explanations, " +
			"quick reads and 1-2 step jobs need no task; a junk task is fake evidence.",
		parameters: Type.Object({
			subject: Type.String({ description: "Short imperative subject" }),
			description: Type.Optional(Type.String()),
			blockedBy: Type.Optional(Type.Array(Type.Number())),
			verify: Type.Optional(
				Type.Object({
					lane: Type.Optional(
						Type.Union([Type.Literal("state"), Type.Literal("judgment")], {
							description: "state = self-checkable via commands/files; judgment = only judgeable",
						}),
					),
					probes: Type.Optional(
						Type.Array(
							Type.Object({
								pattern: Type.String({
									description: "Substring that must appear in a bash command the worker ACTUALLY runs",
								}),
								expect: Type.Optional(
									Type.String({ description: "Substring that must appear in that command's real output" }),
								),
							}),
							{ description: "Red-green: each probe must be RED at create (not yet matched in the run log)" },
						),
					),
					strict: Type.Optional(Type.Boolean()),
				}),
			),
		}),
		async execute(
			_id,
			params: { subject: string; description?: string; blockedBy?: number[]; verify?: unknown },
			_signal,
			_onUpdate,
			ctx,
		) {
			turnsSinceTaskTool = 0;
			let verifySpec: VerifySpec | undefined;
			if (params.verify !== undefined) {
				const parsed = parseVerify(params.verify);
				if (parsed.error || !parsed.spec) throw new Error(`[verify] ${parsed.error}`);
				verifySpec = parsed.spec;
				if (verifySpec.probes.length > 0) {
					const rg = redGreenCheck(verifySpec, runLog);
					if (!rg.ok) {
						throw new Error(
							`[verify] invalid probe at create:\n${rg.reasons.join("\n")}\nDeclare a probe that is RED while the work is NOT done (fail-to-pass), e.g. the check command you will run when the work is finished.`,
						);
					}
				}
			}
			// v1.4.51 goal membership: a task created while a goal is active → stamp goalId
			// (membership = snapshot ∪ stamped; the goal-done check is mechanical over this set).
			const goal = statusSessionId ? activeGoal(statusSessionId) : null;
			const result = createTask(
				state,
				params.subject,
				params.description ?? "",
				params.blockedBy ?? [],
				Date.now(),
				verifySpec,
				goal?.goalId,
			);
			if (result.error) throw new Error(result.error);
			commit(ctx as UiContext, result.state);
			const warn = result.warnings.length > 0 ? `\nWarnings: ${result.warnings.join(" ")}` : "";
			const verifyNote = verifySpec
				? `\nVerify: lane=${verifySpec.lane}${verifySpec.probes.length > 0 ? `, ${verifySpec.probes.length} probe` : ""}${verifySpec.strict ? ", STRICT" : ""} — layer-1 audit runs when you declare completed (probes must be green in the run log).`
				: "";
			return {
				content: [{ type: "text", text: `Created #${result.task!.id}: ${result.task!.subject}${warn}${verifyNote}` }],
				details: {
					id: result.task!.id,
					warnings: result.warnings,
					tasks: detailsTasks(result.state),
					changes: changeFor(result.task!.id, null, result.task!.status),
				},
			};
		},
	});

	pi.registerTool({
		name: "task_update",
		label: "Update task",
		promptSnippet: "Change a task's state; completing one requires stating the evidence",
		description:
			"Update a task. Set status=in_progress when starting (blocked tasks refuse), status=completed " +
			"when done — completion REQUIRES evidence and passes the verify gates (layer-1 probe audit + " +
			"layer-2 LLM judge for judgment-lane/strict/spec-fault tasks; a different model family judges " +
			"by done-check intent, may demote after 2 high-conf fails, ask for more evidence, or park at 3 rounds). " +
			"Never mark completed merely because you wrote code. appeal=\"reason\" parks a task you dispute for the " +
			"user; status=parked/cancelled prune/pause a task.",
		parameters: Type.Object({
			id: Type.Number(),
			status: Type.Optional(
				Type.Union(
					[
						Type.Literal("pending"),
						Type.Literal("in_progress"),
						Type.Literal("completed"),
						Type.Literal("cancelled"),
						Type.Literal("parked"),
					],
					{ description: "Task status" },
				),
			),
			subject: Type.Optional(Type.String()),
			description: Type.Optional(Type.String()),
			blockedBy: Type.Optional(Type.Array(Type.Number())),
			evidence: Type.Optional(Type.String({ description: "Required when completing" })),
			amendReason: Type.Optional(Type.String({ description: "v1.4.53: reason for the done-check amendment proposal (shown in the approval panel) — state it clearly when blocked" })),
			appeal: Type.Optional(
				Type.String({
					escription: "Worker disputes the verify/judge verdict → PARK awaiting the user; state a specific reason",
				}),
			),
			verify: Type.Optional(
				Type.Object({
					lane: Type.Optional(Type.Union([Type.Literal("state"), Type.Literal("judgment")])),
					probes: Type.Optional(
						Type.Array(
							Type.Object({
								pattern: Type.String(),
								expect: Type.Optional(Type.String()),
							}),
						),
					),
					strict: Type.Optional(Type.Boolean()),
				}),
			),
		}),
		async execute(
			_id,
			params: {
				id: number;
				status?: TaskStatus;
				subject?: string;
				description?: string;
				blockedBy?: number[];
				evidence?: string;
				verify?: unknown;
				appeal?: string;
				amendReason?: string;
			},
			_signal,
			_onUpdate,
			ctx,
		) {
			turnsSinceTaskTool = 0;
			const patch: UpdatePatch = {};
			// v1.4.51 no-reopen-in-goal: completed is one-way inside a goal — flip-flopping
			// (done → reopened → redone) burns meaningless epochs. The valid escape: CREATE a
			// new stamped task (real work), not a reopen (#43 envelope).
			if (params.status !== undefined) {
				const cur = state.tasks.find((t) => t.id === params.id);
				if (cur && cur.status === "completed" && params.status !== "completed" && cur.goalId && goalIdActive(cur.goalId)) {
					throw new Error(
						`[task] #${params.id} belongs to goal ${cur.goalId} (running) — completed is one-way inside a goal. Follow-up work: create a new task (auto-stamped into the goal), do not reopen.`,
					);
				}
				patch.status = params.status;
			}
			if (params.subject !== undefined) patch.subject = params.subject;
			if (params.description !== undefined) patch.description = params.description;
			if (params.blockedBy !== undefined) patch.blockedBy = params.blockedBy;
			if (params.evidence !== undefined) patch.evidence = params.evidence;

			// PARK is one-way for the model (v1.4.28): the model may put a task INTO park
			// (appeal/cap) but never take it out — a worker un-parking itself bypasses the
			// entire verdict (user report 2026-09-09). The only way out: the panel button
			// (user) → control file → consumeControlFile above. Cancelling a task awaiting
			// the user is blocked too (cancelling = hiding the dispute).
			const existingForLock = state.tasks.find((t) => t.id === params.id);
			if (existingForLock?.status === "parked" && params.status !== undefined && params.status !== "parked") {
				throw new Error(
					`[task] #${params.id} is PARKED (stopped, awaiting the user) — the model cannot un-park or cancel it itself. The user clicks "reopen" on the task panel (control-file bridge), or says so directly in chat.`,
				);
			}

			// v1.4.38 doneCheck guard — the agent may rephrase the brief but not swap it
			// out: every model edit to description is trailed (descHistory: old sheet →
			// new sheet, updateTask via descAmend), capped at DESC_AMEND_MAX; strict tasks
			// forbid it outright. The remaining door once the budget is gone: the user
			// (control-file action 'amend' on the panel, same pattern as
			// unpark/strict/reopen). Why it lives: the judge only sees the CURRENT sheet —
			// an agent free to rewrite the brief controls the verdict (task #13 lesson).
			if (params.description !== undefined) {
				const t = state.tasks.find((t) => t.id === params.id);
				if (t && params.description.trim() !== t.description) {
					// v1.4.53 proposal channel: a blocked amend is NO LONGER a dead end.
					// (1) quota left → edit as usual; (2) unused goal lease → lease;
					// (3) otherwise → RECORD A PROPOSAL awaiting user approval on the panel
					// (strict tasks may propose too — a proposal = asking the user, not self-editing).
					const recordProposal = (blockedWhy: string): string => {
						const to = (params.description ?? "").trim().slice(0, 2000);
						const dup = (t.proposals ?? []).find((p) => p.status === "pending" && p.to === to);
						if (dup) return `proposal ${dup.id} is already pending approval (identical content) — not recording another`;
						const p: TaskProposal = {
							id: `p${Date.now().toString(36)}`,
							at: Date.now(),
							from: t.description.slice(0, 2000),
							to,
							reason: (params.amendReason ?? "").slice(0, 1000) || blockedWhy,
							status: "pending",
						};
						patch.proposals = [...(t.proposals ?? []), p].slice(-4);
						return `recorded proposal ${p.id} — the user decides in the proposals panel on the task panel (✓/✗); brief NOT changed yet`;
					};
					if (t.verify?.strict === true) {
						const note = recordProposal("strict — only the user may edit the brief");
						return {
							content: [{ type: "text", text: `[task] #${params.id} ${note}. Block reason: strict — the doneCheck is user-controlled. Once the user approves, the engine will apply it and report back.` }],
							details: {},
						};
					}
					const used = t.descAmendments ?? 0;
					if (used >= DESC_AMEND_MAX) {
						// v1.4.51 goal lease: appeal exactly once per goal while the goal is running.
						const lease = statusSessionId
							? tryConsumeLease(statusSessionId, `#${params.id} descAmend ${used}/${DESC_AMEND_MAX} — appeal via goal lease`)
							: { ok: false as const, reason: "no goal running" };
						if (!lease.ok) {
							const note = recordProposal(`cap ${used}/${DESC_AMEND_MAX} — ${lease.reason}`);
							return {
								content: [{ type: "text", text: `[task] #${params.id} ${note}. Block reason: the doneCheck was already amended by the model ${used}/${DESC_AMEND_MAX} times (the judge only sees the current brief). Goal lease: ${lease.reason}.` }],
								details: {},
							};
						}
						patch.descAmend = { by: "goal-lease" };
					} else {
						patch.descAmend = { by: "agent" };
					}
				}
			}

			// Verify-spec amendment: an escape hatch for wrongly declared probes (NOT a
			// way to lower the bar). Max 2 times, each counted and written to the projection.
			if (params.verify !== undefined) {
				const existingTask = state.tasks.find((t) => t.id === params.id);
				const count = existingTask?.verifyAmendments ?? 0;
				if (count >= 2) {
					throw new Error(
						`[verify] spec of #${params.id} already amended ${count} times — wait for the user or layer-2 adjudication; no further amendments.`,
					);
				}
				const parsed = parseVerify(params.verify);
				if (parsed.error || !parsed.spec) throw new Error(`[verify] ${parsed.error}`);
				// strict v2 (user settled 03:38): anyone may RAISE strict, LOWERING is user-only —
				// an amendment may not turn off strict on an existing task
				if (existingTask?.verify?.strict === true && parsed.spec.strict !== true) {
					parsed.spec.strict = true;
				}
				patch.verify = parsed.spec;
			}

			// Completion verification (design: pify-pending row 9, settled
			// 2026-09-09). appeal at any time → PARK awaiting the user (escape valve
			// for every dead end, including judge fail-closed). Otherwise on completed:
			// - layer 1 ($0, deterministic): state-lane requires every probe GREEN;
			//   RED = worker fault (refuse, no judge needed); AMBER = spec-fault → judge adjudicates
			// - layer 2 (judge, a model from a different family than GLM): judgment-lane
			//   always runs; state-lane runs on AMBER or strict. Consequences per
			//   verdictConsequence: demote after 2 consecutive high-conf fails, low conf
			//   → ask for more evidence, PARK at 3 rounds, judge dead → refuse
			//   (fail-closed, no state change).
			if (params.appeal !== undefined) {
				patch.status = "parked";
				patch.appealReason = params.appeal.trim().slice(0, 500);
				patch.failStreak = 0;
			} else if (params.status === "completed") {
				const task = state.tasks.find((t) => t.id === params.id);
				const spec = patch.verify ?? task?.verify;
				const evidence = patch.evidence ?? task?.evidence ?? "";
				let judgeNeeded = false;
				let probeViews: JudgeProbeView[] | undefined;
				if (spec && spec.lane === "state" && spec.probes.length > 0) {
					const audit = auditCompletion(spec, runLog);
					probeViews = audit.results.map((r) => ({
						pattern: r.pattern,
						expect: r.expect,
						status: r.status,
						observed: r.observed,
					}));
					if (audit.verdict === "fail") {
						throw new Error(
							`[verify] #${params.id} has NOT passed layer-1 verification:\n${summarizeAudit(audit)}\nFinish the work, then run the check command (through real bash, so the run log holds the evidence), then declare completed again; if the probe was declared wrong, amend verify (max 2 times).`,
						);
					}
					if (audit.verdict === "pass" && !spec.strict) {
						patch.audit = { at: Date.now(), verdict: "pass", summary: summarizeAudit(audit) };
					} else {
						// AMBER (spec-fault) or strict-green → layer-2 rules
						judgeNeeded = true;
					}
				} else if (spec) {
					// lane=judgment (or state with no probes — the floor forces judgment)
					judgeNeeded = true;
				}

				if (judgeNeeded) {
					const roundsUsed = task?.judgeRounds ?? 0;
					if (roundsUsed >= MAX_JUDGE_ROUNDS) {
						// rounds exhausted — park immediately, no more judge calls
						patch.status = "parked";
						patch.appealReason = `judge cap: ${roundsUsed} judge rounds without completion`;
					} else {
						const mapped = runLog.map((e) => ({ cmd: e.cmd, output: e.output, ts: e.ts }));
						const logSlice = pickLogSlice(mapped, probeViews ?? [], evidence);
						// v1.4.38: if this task_update ALSO rewrites the brief, the judge must see the
						// old sheet + the in-flight rewrite too (updateTask records the real trail right after)
						let judgeDescHistory = task?.descHistory;
						if (
							task &&
							patch.description !== undefined &&
							patch.description.trim() !== task.description
						) {
							judgeDescHistory = [
								...(task.descHistory ?? []),
								{
									at: Date.now(),
									by: "agent" as const,
									from: task.description.slice(0, 400),
									to: patch.description.trim().slice(0, 400),
								},
							];
						}
						const packet = buildJudgePacket(
							{
								subject: patch.subject ?? task?.subject ?? "",
								doneCheck: patch.description ?? task?.description ?? "",
								evidence,
								lane: spec?.lane ?? "judgment",
								probes: probeViews,
								descHistory: judgeDescHistory,
								fullLog: mapped,
							},
							logSlice,
						);
						const cwd = ((ctx as { cwd?: string }).cwd ?? process.cwd()) as string;
						const raw = await runJudge(packet, cwd);
						const verdict = raw !== null ? parseJudgeVerdict(raw, logSlice.length) : null;
						const conseq = verdictConsequence(verdict, {
							failStreak: task?.failStreak ?? 0,
							judgeRounds: roundsUsed,
						});
						if (conseq.action === "refuse-unavailable") {
							// fail-closed: no state change, no round spent
							throw new Error(conseq.message);
						}
						patch.judgeRounds = conseq.judgeRounds;
						patch.failStreak = conseq.failStreak;
						if (conseq.action === "complete") {
							patch.audit = { at: Date.now(), verdict: "judge-pass", summary: conseq.message };
						} else if (conseq.action === "demote") {
							patch.status = "in_progress";
							patch.audit = { at: Date.now(), verdict: "judge-fail", summary: conseq.message };
						} else if (conseq.action === "park-cap") {
							patch.status = "parked";
							patch.appealReason = conseq.message.slice(0, 500);
							patch.audit = { at: Date.now(), verdict: "judge-insufficient", summary: conseq.message };
						} else if (conseq.action === "need-evidence") {
							// v1.4.65 #64: judge holds the completion → status HELD (instead of leaving it
							// as-is) — task_list + nudge now clearly say "declared, held, needs real evidence".
							patch.status = "held";
							patch.audit = { at: Date.now(), verdict: "judge-insufficient", summary: conseq.message };
						} else {
							// fail-streak: refused, no demote yet — v1.4.65 #64: also HELD
							patch.status = "held";
							patch.audit = { at: Date.now(), verdict: "judge-fail", summary: conseq.message };
						}
					}
				}
			}

			const prevTask = state.tasks.find((t) => t.id === params.id);
			const prevStatus = prevTask?.status ?? null;
			const result = updateTask(state, params.id, patch, Date.now());
			if (result.error) throw new Error(result.error);
			const unblocked = newlyReady(state, result.state);
			commit(ctx as UiContext, result.state);
			const warn = result.warnings.length > 0 ? `\nWarnings: ${result.warnings.join(" ")}` : "";
			const auditNote = result.task!.audit ? `\nAudit: ${result.task!.audit.summary.replace(/\n/g, "; ")}` : "";
			const parkedNote =
				result.task!.status === "parked"
					? `\nPARKED (stopped, awaiting the user): ${result.task!.appealReason ?? "—"} — only the USER can reopen: the "reopen (user)" button on the task panel (writes file ~/.pi/agent/task-control/<sessionId>.json) or say so directly in chat. The model cannot reopen it itself.`
					: "";
			const strictNote =
				params.status === "completed" && result.task!.verify?.strict
					? "\n(STRICT task — layer-2 judge ruled per the audit above)"
					: "";
			// #59 (user 2026-09-14): a HELD completion must expose itself — which gate
			// holds it, which judge round, and the valid NEXT. Standard #43 envelope:
			// without this line the model only sees "→ pending" and blindly re-declares a few times.
			const heldNote =
				params.status === "completed" && result.task!.status !== "completed" && result.task!.status !== "parked"
					? `\n⏸ Completion HELD — #${result.task!.id} is NOT complete (judge round ${result.task!.judgeRounds ?? 0}/${MAX_JUDGE_ROUNDS}). ` +
					  `Do not re-declare verbatim: re-voting gets held too. ` +
					  `NEXT: (1) do what the gate actually requires — run the REAL probe command via bash (the run log captures the evidence) / add concrete evidence: command + output + file, then declare completed again; ` +
					  `(2) probe declared wrong → amend verify (task_update verify=..., ≤2 times); ` +
					  `(3) dispute the verdict → appeal="specific reason" → PARK for the user.`
					: "";
			// #45: field-level CHANGES block (self-explaining harness, same family
			// as the #43 denial envelope) — model sees it, panel card rides it.
			const fields = fieldChanges(prevTask, result.task!);
			// v1.4.64 (#64): with status unchanged, "#N → pending" reads like a no-op/bounce
			// (user sees the card, the model reads the tool result post-compaction) — say clearly WHAT changed.
			const sameStatus = prevStatus !== null && prevStatus === result.task!.status;
			const statusNote =
				sameStatus && fields.length > 0
					? ` — status unchanged; changed: ${fields.slice(0, 2).map((f) => f.field).join(", ")}`
					: "";
			const changesNote =
				fields.length > 0
					? `\nCHANGES:\n${fields.map((f) => `  ${f.field}: ${f.from ? `${f.from} → ` : ""}${f.to}`).join("\n")}`
					: "";
			const ready =
				unblocked.length > 0
					? `\nNow ready (no open blockers, safe to parallelize): ${unblocked.map((t) => `#${t.id} ${t.subject}`).join(", ")}`
					: "";
			return {
				content: [
					{ type: "text", text: `#${result.task!.id} → ${result.task!.status}${statusNote}${heldNote}${warn}${auditNote}${parkedNote}${strictNote}${ready}${changesNote}` },
				],
					details: {
					id: result.task!.id,
					status: result.task!.status,
					warnings: result.warnings,
					ready: unblocked.map((t) => t.id),
					tasks: detailsTasks(result.state),
					changes: changeFor(result.task!.id, prevStatus, result.task!.status),
					// #45: field-level diff — "pending => pending" said nothing about
					// WHAT changed (user 2026-09-13). Panel card renders these lines.
					fields: fieldChanges(prevTask, result.task!),
				},
			};
		},
	});

	pi.registerTool({
		name: "task_list",
		label: "List tasks",
		promptSnippet: "The task list, with what is ready to start",
		description:
			"The current task list with statuses, open blockers, and which tasks are ready to start " +
			"(no open blockers) — ready tasks are safe to parallelize.",
		parameters: Type.Object({}),
		async execute() {
			turnsSinceTaskTool = 0;
			return { content: [{ type: "text", text: snapshot() }], details: { count: state.tasks.length, tasks: detailsTasks(state) } };
		},
	});

	// ── Nudges: transient context-hook injection (never persisted) ───────

	pi.on("context", async (event) => {
		// A finished list gets one sweep; an unfinished one gets the stale-list
		// nudge. Both are transient — decided per request, never persisted.
		const signature = completionSignature(state);
		const sweep = signature !== null && signature !== sweptSignature;
		if (sweep) sweptSignature = signature;
		else if (signature === null) sweptSignature = null;

		const text = sweep
			? buildCompletionSweep(state)
			: shouldNudge({ state, turnsSinceTaskTool, lastTurnTextOnly })
				? buildNudge(state)
				: null;
		if (text === null) return undefined;

		const messages = [
			...event.messages,
			{
				role: "user",
				content: [{ type: "text", text }],
				timestamp: Date.now(),
			} as never,
		];
		return { messages };
	});

	pi.on("agent_end", async (event) => {
		const messages = (event as { messages?: unknown[] }).messages ?? [];
		const { usedTaskTool, anyToolCall } = classifyTurn(messages);
		lastTurnTextOnly = !anyToolCall;
		turnsSinceTaskTool = usedTaskTool ? 0 : turnsSinceTaskTool + 1;
	});

	// ── Lifecycle & command ──────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		state = replayBranch(ctx.sessionManager.getBranch() as never);
		statusSessionId = (ctx.sessionManager.getSessionId?.() as string | undefined) ?? "";
		turnsSinceTaskTool = 0;
		lastTurnTextOnly = false;
		runLog = [];
		runLogByCall.clear();

		// v1.4.28 control bridge: user-only actions (unpark / strict) from the Paseo
		// panel. Only the main chat watches (like snip) — worker sessions have no file.
		const parent = (ctx.sessionManager.getHeader?.() as { parentSession?: string } | undefined)?.parentSession;
		controlSessionId = !parent && statusSessionId ? statusSessionId : "";
		lastControlSentAt = undefined;
		// v1.4.68 #47 Phase B: the plan engine writes plan-bridge/<sid>.json on
		// approve/off — consume at startup (restart case) and watch for live ones.
		if (controlSessionId) {
			try {
				mkdirSync(dirname(planBridgePath(controlSessionId)), { recursive: true });
			} catch {
				// best effort
			}
			try {
				let planBridgeDebounce: ReturnType<typeof setTimeout> | undefined;
				const planBridgeWatcher = watch(dirname(planBridgePath(controlSessionId)), (event, filename) => {
					if (!filename || !filename.endsWith(`${controlSessionId}.json`)) return;
					if (planBridgeDebounce) clearTimeout(planBridgeDebounce);
					planBridgeDebounce = setTimeout(() => {
						planBridgeDebounce = undefined;
						consumePlanBridge();
					}, 150);
				});
				planBridgeWatcher.on("error", () => {
					// best-effort — tools never depend on the watcher
				});
			} catch {
				// no plan-bridge dir → no bridge
			}
			consumePlanBridge();
		}
		if (controlSessionId) {
			try {
				mkdirSync(dirname(controlFilePath(controlSessionId)), { recursive: true });
			const watcher = watch(dirname(controlFilePath(controlSessionId)), (event, filename) => {
					if (!filename || !filename.endsWith(`${controlSessionId}.json`)) return;
					if (controlDebounce) clearTimeout(controlDebounce);
					controlDebounce = setTimeout(() => {
						controlDebounce = undefined;
						consumeControlFile();
					}, 150);
				});
				watcher.on("error", () => {
					// best-effort — tools never depend on the watcher
				});
			} catch {
				// no control dir → no bridge; tools unaffected
			}
		}

		projectStatus();
		renderWidget(ctx);
		// v1.4.69 (#61 Phase C): restart-back-up — resume the task wake loop if
		// in_progress work remains and no higher kind owns the cadence.
		setTimeout(() => taskSettle(), 3_000);
	});

	pi.on("input", () => clearTaskWake());

	pi.on("agent_settled", () => {
		// v1.4.69 (#61 Phase C): in_progress work at settle → continuation wake
		// (2s grace — mirrors goal; a higher kind owning cadence cancels inside).
		setTimeout(() => taskSettle(), 2_000);
	});

	pi.on("session_tree", async (_event, ctx) => {
		state = replayBranch(ctx.sessionManager.getBranch() as never);
		projectStatus();
		renderWidget(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		// flush pending projection writes before the process exits — otherwise a
		// fast exit between writeFile and rename orphans the tmp file (observed
		// live 2026-09-08 during daemon-restart churn).
		await statusWriteQueue;
		if (ctx.hasUI) ctx.ui.setWidget("task", undefined);
	});

	pi.registerCommand("tasks", {
		description: "Show the session task list (statuses, blockers, ready set)",
		handler: async (_args, ctx) => {
			if (ctx.hasUI) ctx.ui.notify(snapshot(), "info");
		},
	});
}
