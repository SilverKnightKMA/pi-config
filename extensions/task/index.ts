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
		}),
		async execute(
			_id,
			params: { subject: string; description?: string; blockedBy?: number[] },
			_signal,
			_onUpdate,
			ctx,
		) {
			turnsSinceTaskTool = 0;
			const result = createTask(
				state,
				params.subject,
				params.description ?? "",
				params.blockedBy ?? [],
				Date.now(),
			);
			if (result.error) throw new Error(result.error);
			commit(ctx as UiContext, result.state);
			const warn = result.warnings.length > 0 ? `\nWarnings: ${result.warnings.join(" ")}` : "";
			return {
				content: [{ type: "text", text: `Created #${result.task!.id}: ${result.task!.subject}${warn}` }],
				details: { id: result.task!.id, warnings: result.warnings },
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
		}),
		async execute(
			_id,
			params: { id: number; status?: TaskStatus; subject?: string; description?: string; blockedBy?: number[]; evidence?: string },
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

			const result = updateTask(state, params.id, patch, Date.now());
			if (result.error) throw new Error(result.error);
			const unblocked = newlyReady(state, result.state);
			commit(ctx as UiContext, result.state);
			const warn = result.warnings.length > 0 ? `\nWarnings: ${result.warnings.join(" ")}` : "";
			const ready =
				unblocked.length > 0
					? `\nNow ready (no open blockers, safe to parallelize): ${unblocked.map((t) => `#${t.id} ${t.subject}`).join(", ")}`
					: "";
			return {
				content: [{ type: "text", text: `#${result.task!.id} → ${result.task!.status}${warn}${ready}` }],
				details: {
					id: result.task!.id,
					status: result.task!.status,
					warnings: result.warnings,
					ready: unblocked.map((t) => t.id),
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
			return { content: [{ type: "text", text: snapshot() }], details: { count: state.tasks.length } };
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
		projectStatus();
		renderWidget(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		state = replayBranch(ctx.sessionManager.getBranch() as never);
		projectStatus();
		renderWidget(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setWidget("task", undefined);
	});

	pi.registerCommand("tasks", {
		description: "Show the session task list (statuses, blockers, ready set)",
		handler: async (_args, ctx) => {
			if (ctx.hasUI) ctx.ui.notify(snapshot(), "info");
		},
	});
}
