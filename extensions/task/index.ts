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

import {
	TASK_STATE,
	createTask,
	newlyReady,
	readyTasks,
	replayBranch,
	updateTask,
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
import { EMPTY_STATE, type TaskState, type TaskStatus } from "./src/types.ts";

type UiContext = ExtensionContext;

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

	/** Layer-1 run log: bash tool calls this session really executed (ring, cap
	 * 200). The extension NEVER executes probe commands — it matches declared
	 * probes against what the worker ran through its normal bash pipeline, so
	 * a green probe is proof the command really ran, with no injection surface. */
	let runLog: RunLogEntry[] = [];
	const runLogByCall = new Map<string, RunLogEntry>();
	const BASH_TOOLS = new Set(["bash", "safe_bash"]);

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
		const e = event as { toolCallId?: string; toolName?: string; args?: { command?: unknown } };
		if (!e.toolCallId || !BASH_TOOLS.has(e.toolName ?? "")) return;
		if (typeof e.args?.command !== "string") return;
		const entry: RunLogEntry = { tool: e.toolName ?? "", cmd: e.args.command, output: "", ts: Date.now() };
		runLogByCall.set(e.toolCallId, entry);
		runLog.push(entry);
		if (runLog.length > 200) runLog = runLog.slice(-200);
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
	const detailsTasks = (s: TaskState) =>
		s.tasks.map((t) => ({ id: t.id, subject: t.subject, status: t.status }));

	pi.registerTool({
		name: "task_create",
		label: "Create task",
		description:
			"Add a task to the session task list. Use for multi-step work so progress is visible and " +
			"survives compaction. blockedBy lists ids of tasks that must complete first (cycles and " +
			"dangling ids are dropped with warnings). Create tasks BEFORE starting the work they describe.",
		parameters: Type.Object({
			subject: Type.String({ description: "Short imperative subject" }),
			description: Type.Optional(Type.String()),
			blockedBy: Type.Optional(Type.Array(Type.Number())),
			verify: Type.Optional(
				Type.Object({
					lane: Type.Optional(
						Type.Union([Type.Literal("state"), Type.Literal("judgment")], {
							description: "state = có lệnh/file tự kiểm được; judgment = chỉ phán được",
						}),
					),
					probes: Type.Optional(
						Type.Array(
							Type.Object({
								pattern: Type.String({
									description: "Chuỗi phải xuất hiện trong lệnh bash worker THẬT SỰ chạy",
								}),
								expect: Type.Optional(
									Type.String({ description: "Chuỗi phải có trong output thật của lệnh đó" }),
								),
							}),
							{ description: "Red-green: mỗi probe phải ĐỎ lúc tạo (chưa khớp sổ ghi lệnh)" },
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
							`[verify] probe không hợp lệ lúc tạo:\n${rg.reasons.join("\n")}\nHãy khai probe mà việc CHƯA làm thì nó ĐỎ (fail-to-pass), ví dụ lệnh kiểm sẽ chạy lúc xong việc.`,
						);
					}
				}
			}
			const result = createTask(
				state,
				params.subject,
				params.description ?? "",
				params.blockedBy ?? [],
				Date.now(),
				verifySpec,
			);
			if (result.error) throw new Error(result.error);
			commit(ctx as UiContext, result.state);
			const warn = result.warnings.length > 0 ? `\nWarnings: ${result.warnings.join(" ")}` : "";
			const verifyNote = verifySpec
				? `\nVerify: lane=${verifySpec.lane}${verifySpec.probes.length > 0 ? `, ${verifySpec.probes.length} probe` : ""}${verifySpec.strict ? ", STRICT" : ""} — layer-1 audit sẽ chạy lúc khai completed (probe phải xanh trong sổ ghi lệnh).`
				: "";
			return {
				content: [{ type: "text", text: `Created #${result.task!.id}: ${result.task!.subject}${warn}${verifyNote}` }],
				details: { id: result.task!.id, warnings: result.warnings, tasks: detailsTasks(result.state) },
			};
		},
	});

	pi.registerTool({
		name: "task_update",
		label: "Update task",
		description:
			"Update a task. Set status=in_progress when starting (blocked tasks refuse), status=completed " +
			"when done — completion REQUIRES evidence: what you verified (command output, test results, " +
			"file state). Never mark completed merely because you wrote code. status=cancelled prunes a " +
			"task that no longer applies.",
		parameters: Type.Object({
			id: Type.Number(),
			status: Type.Optional(
				Type.Union(
					[
						Type.Literal("pending"),
						Type.Literal("in_progress"),
						Type.Literal("completed"),
						Type.Literal("cancelled"),
					],
					{ description: "Task status" },
				),
			),
			subject: Type.Optional(Type.String()),
			description: Type.Optional(Type.String()),
			blockedBy: Type.Optional(Type.Array(Type.Number())),
			evidence: Type.Optional(Type.String({ description: "Required when completing" })),
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
			},
			_signal,
			_onUpdate,
			ctx,
		) {
			turnsSinceTaskTool = 0;
			const patch: UpdatePatch = {};
			if (params.status !== undefined) patch.status = params.status;
			if (params.subject !== undefined) patch.subject = params.subject;
			if (params.description !== undefined) patch.description = params.description;
			if (params.blockedBy !== undefined) patch.blockedBy = params.blockedBy;
			if (params.evidence !== undefined) patch.evidence = params.evidence;

			// Verify-spec amendment: escape hatch khi probe khai sai (chứ không
			// phải để hạ mức kiểm). Tối đa 2 lần, mỗi lần đếm và ghi vào projection.
			if (params.verify !== undefined) {
				const existingTask = state.tasks.find((t) => t.id === params.id);
				const count = existingTask?.verifyAmendments ?? 0;
				if (count >= 2) {
					throw new Error(
						`[verify] spec của #${params.id} đã amend ${count} lần — chờ user hoặc layer-2 phân xử, không amend thêm.`,
					);
				}
				const parsed = parseVerify(params.verify);
				if (parsed.error || !parsed.spec) throw new Error(`[verify] ${parsed.error}`);
				patch.verify = parsed.spec;
			}

			// Layer-1 completion audit: state-lane task phải mọi probe XANH trong
			// sổ ghi lệnh; judgment-lane chỉ đối chiếu advisory. Audit gắn vào task
			// để projection/panel thấy.
			if (params.status === "completed") {
				const task = state.tasks.find((t) => t.id === params.id);
				const spec = patch.verify ?? task?.verify;
				if (spec && spec.lane === "state" && spec.probes.length > 0) {
					const audit = auditCompletion(spec, runLog);
					if (audit.verdict !== "pass") {
						throw new Error(
							`[verify] #${params.id} CHƯA qua kiểm chứng layer-1:\n${summarizeAudit(audit)}\nLàm xong việc rồi chạy lệnh kiểm (qua bash thật, để sổ ghi có bằng chứng) rồi khai completed lại; nếu probe khai sai thì amend verify (tối đa 2 lần).`,
						);
					}
					patch.audit = { at: Date.now(), verdict: "pass", summary: summarizeAudit(audit) };
				} else if (spec && spec.lane === "judgment") {
					const claims = checkEvidenceCommands(patch.evidence ?? task?.evidence ?? "", runLog);
					const unfound = claims.filter((c) => !c.found);
					const note =
						claims.length === 0
							? "lane=judgment — evidence không có lệnh backtick nào để đối chiếu (layer-2 sẽ phán sau)"
							: unfound.length > 0
								? `lane=judgment — cảnh báo: ${unfound.map((c) => `"${c.claim}"`).join(", ")} không thấy trong sổ ghi lệnh (layer-2 sẽ phán)`
								: "lane=judgment — mọi lệnh evidence đều có trong sổ ghi";
					patch.audit = { at: Date.now(), verdict: "pass-judgment", summary: note };
				}
			}

			const result = updateTask(state, params.id, patch, Date.now());
			if (result.error) throw new Error(result.error);
			const unblocked = newlyReady(state, result.state);
			commit(ctx as UiContext, result.state);
			const warn = result.warnings.length > 0 ? `\nWarnings: ${result.warnings.join(" ")}` : "";
			const auditNote =
				params.status === "completed" && result.task!.audit
					? `\nAudit: ${result.task!.audit.summary.replace(/\n/g, "; ")}`
					: "";
			const strictNote =
				params.status === "completed" && result.task!.verify?.strict
					? "\n(STRICT task — layer-2 verifier chưa build; hiện completion dựa trên layer-1 audit)"
					: "";
			const ready =
				unblocked.length > 0
					? `\nNow ready (no open blockers, safe to parallelize): ${unblocked.map((t) => `#${t.id} ${t.subject}`).join(", ")}`
					: "";
			return {
				content: [{ type: "text", text: `#${result.task!.id} → ${result.task!.status}${warn}${auditNote}${strictNote}${ready}` }],
				details: {
					id: result.task!.id,
					status: result.task!.status,
					warnings: result.warnings,
					ready: unblocked.map((t) => t.id),
					tasks: detailsTasks(result.state),
				},
			};
		},
	});

	pi.registerTool({
		name: "task_list",
		label: "List tasks",
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
		projectStatus();
		renderWidget(ctx);
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
