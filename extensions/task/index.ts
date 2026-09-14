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
import { activeGoal, goalIdActive, tryConsumeLease } from "./src/goal-bridge.ts";

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

	/** Layer-1 run log: bash tool calls this session really executed (ring, cap
	 * 200). The extension NEVER executes probe commands — it matches declared
	 * probes against what the worker ran through its normal bash pipeline, so
	 * a green probe is proof the command really ran, with no injection surface. */
	let runLog: RunLogEntry[] = [];
	const runLogByCall = new Map<string, RunLogEntry>();
	const BASH_TOOLS = new Set(["bash", "safe_bash"]);

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
			// v1.4.53: vòng kín — báo ngược về model để làm tiếp, không phải dò
			if (payload.action === "proposal-decide") {
				pi.sendUserMessage(
					`[task-proposal] #${payload.id} ${payload.decision === "apply" ? "user ĐÃ DUYỆT" : "user TỪ CHỐI"} đề xuất sửa đề${payload.note ? ` (ghi chú: ${payload.note})` : ""}. ${payload.decision === "apply" ? "Đề mới đã áp dụng — làm tiếp theo đề mới." : "Đề giữ nguyên — tiếp tục theo đề cũ hoặc hỏi user làm rõ."}`,
					{ deliverAs: "followUp" },
				);
			}
		}
		ackControlFile(payload);
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
				t.judgeRounds ? `judge-rounds:${t.judgeRounds}` : "",
				t.failStreak ? `fail-streak:${t.failStreak}` : "",
				t.status === "parked" ? `parked:${(t.appealReason ?? "chờ user").slice(0, 60)}` : "",
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
			// v1.4.51 goal membership: task tạo khi goal active → stamp goalId
			// (membership = snapshot ∪ stamped; goal-done check cơ khí theo tập này).
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
				? `\nVerify: lane=${verifySpec.lane}${verifySpec.probes.length > 0 ? `, ${verifySpec.probes.length} probe` : ""}${verifySpec.strict ? ", STRICT" : ""} — layer-1 audit sẽ chạy lúc khai completed (probe phải xanh trong sổ ghi lệnh).`
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
			amendReason: Type.Optional(Type.String({ description: "v1.4.53: lý do đề xuất sửa đề (hiện trong bảng duyệt) — ghi rõ khi bị chặn" })),
			appeal: Type.Optional(
				Type.String({
					escription: "Worker phản đối phán quyết verify/judge → PARK chờ user; nêu lý do cụ thể",
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
			// v1.4.51 no-reopen-in-goal: completed là một chiều trong goal — dao động
			// (xong → mở lại → làm lại) tiêu epoch vô nghĩa. Escape hợp lệ: TẠO task
			// mới có stamp (mảnh việc thật), không phải reopen (#43 envelope).
			if (params.status !== undefined) {
				const cur = state.tasks.find((t) => t.id === params.id);
				if (cur && cur.status === "completed" && params.status !== "completed" && cur.goalId && goalIdActive(cur.goalId)) {
					throw new Error(
						`[task] #${params.id} thuộc goal ${cur.goalId} (đang chạy) — completed là một chiều trong goal. Việc phát sinh: tạo task mới (tự được stamp vào goal), không reopen.`,
					);
				}
				patch.status = params.status;
			}
			if (params.subject !== undefined) patch.subject = params.subject;
			if (params.description !== undefined) patch.description = params.description;
			if (params.blockedBy !== undefined) patch.blockedBy = params.blockedBy;
			if (params.evidence !== undefined) patch.evidence = params.evidence;

			// PARK là một chiều với model (v1.4.28): được đưa VÀO park (appeal/cap)
			// nhưng không tự ra khỏi — worker tự un-park = bypass toàn bộ phán quyết
			// (user report 2026-09-09). Cửa ra duy nhất: nút panel (user) → control
			// file → consumeControlFile ở trên. Cancel task đang chờ user cũng chặn
			// (hủy = giấu tranh chấp).
			const existingForLock = state.tasks.find((t) => t.id === params.id);
			if (existingForLock?.status === "parked" && params.status !== undefined && params.status !== "parked") {
				throw new Error(
					`[task] #${params.id} đang PARKED (dừng chờ user) — model không tự mở lại/hủy được. User bấm "mở lại" trên task panel (control-file bridge), hoặc user nói trực tiếp trong chat.`,
				);
			}

			// v1.4.38 doneCheck guard — học sinh được đổi đề nhưng không được đổi kín:
			// mọi sửa description của model được ghi trail (descHistory: tờ cũ → tờ mới,
			// updateTask qua descAmend), cap DESC_AMEND_MAX lần; task strict cấm hẳn.
			// Cửa còn lại khi hết hạn mức: user (control-file action 'amend' trên panel,
			// cùng pattern unpark/strict/reopen). Lý do sống: judge chỉ thấy tờ đề
			// HIỆN TẠI — agent giữ quyền đổi đề = điều khiển phán quyết (task #13 lesson).
			if (params.description !== undefined) {
				const t = state.tasks.find((t) => t.id === params.id);
				if (t && params.description.trim() !== t.description) {
					// v1.4.53 proposal channel: amend bị chặn KHÔNG còn là đường chết.
					// (1) còn quota → sửa như thường; (2) goal lease chưa dùng → lease;
					// (3) còn lại → GHI ĐỀ XUẤT chờ user duyệt trên panel (strict cũng
					// được đề xuất — đề xuất = hỏi user, không phải tự sửa).
					const recordProposal = (blockedWhy: string): string => {
						const to = (params.description ?? "").trim().slice(0, 2000);
						const dup = (t.proposals ?? []).find((p) => p.status === "pending" && p.to === to);
						if (dup) return `đề xuất ${dup.id} đã đang chờ duyệt (nội dung trùng) — không ghi thêm`;
						const p: TaskProposal = {
							id: `p${Date.now().toString(36)}`,
							at: Date.now(),
							from: t.description.slice(0, 2000),
							to,
							reason: (params.amendReason ?? "").slice(0, 1000) || blockedWhy,
							status: "pending",
						};
						patch.proposals = [...(t.proposals ?? []), p].slice(-4);
						return `đã ghi đề xuất ${p.id} — user duyệt ở bảng đề xuất trên task panel (✓/✗); đề CHƯA đổi`;
					};
					if (t.verify?.strict === true) {
						const note = recordProposal("strict — chỉ user được sửa đề");
						return {
							content: [{ type: "text", text: `[task] #${params.id} ${note}. Lý do chặn: strict — doneCheck do user giữ. Sau khi user duyệt, engine sẽ áp + báo lại.` }],
							details: {},
						};
					}
					const used = t.descAmendments ?? 0;
					if (used >= DESC_AMEND_MAX) {
						// v1.4.51 goal lease: appeal đúng 1 lần/goal khi goal đang chạy.
						const lease = statusSessionId
							? tryConsumeLease(statusSessionId, `#${params.id} descAmend ${used}/${DESC_AMEND_MAX} — appeal qua goal lease`)
							: { ok: false as const, reason: "không có goal đang chạy" };
						if (!lease.ok) {
							const note = recordProposal(`cap ${used}/${DESC_AMEND_MAX} — ${lease.reason}`);
							return {
								content: [{ type: "text", text: `[task] #${params.id} ${note}. Lý do chặn: doneCheck đã bị model sửa ${used}/${DESC_AMEND_MAX} lần (judge chỉ thấy đề hiện tại). Goal lease: ${lease.reason}.` }],
								details: {},
							};
						}
						patch.descAmend = { by: "goal-lease" };
					} else {
						patch.descAmend = { by: "agent" };
					}
				}
			}

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
				// strict v2 (user chốt 03:38): nâng strict ai cũng được, HẠ chỉ user —
				// amendment không được dùng để tắt strict của task đang có
				if (existingTask?.verify?.strict === true && parsed.spec.strict !== true) {
					parsed.spec.strict = true;
				}
				patch.verify = parsed.spec;
			}

			// Completion verification (design: pify-pending row 9, settled
			// 2026-09-09). appeal bất kỳ lúc nào → PARK chờ user (escape valve cho
			// mọi ngõ cụt, kể cả judge fail-closed). Ngược lại khi completed:
			// - layer 1 ($0, deterministic): state-lane yêu mọi probe XANH; ĐỎ = lỗi
			//   worker (từ chối, không cần judge); VÀNG = spec-fault → judge phân xử
			// - layer 2 (judge, model khác họ GLM): judgment-lane luôn chạy; state-lane
			//   chạy khi VÀNG hoặc strict. Hệ quả theo verdictConsequence: demote sau
			//   2 fail-conf-cao liên tiếp, conf thấp → xin thêm evidence, PARK khi đủ
			//   3 vòng, judge chết → từ chối (fail-closed, không đổi state).
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
							`[verify] #${params.id} CHƯA qua kiểm chứng layer-1:\n${summarizeAudit(audit)}\nLàm xong việc rồi chạy lệnh kiểm (qua bash thật, để sổ ghi có bằng chứng) rồi khai completed lại; nếu probe khai sai thì amend verify (tối đa 2 lần).`,
						);
					}
					if (audit.verdict === "pass" && !spec.strict) {
						patch.audit = { at: Date.now(), verdict: "pass", summary: summarizeAudit(audit) };
					} else {
						// VÀNG (spec-fault) hoặc strict-green → layer-2 phán
						judgeNeeded = true;
					}
				} else if (spec) {
					// lane=judgment (hoặc state không probe — floor ép thành judgment)
					judgeNeeded = true;
				}

				if (judgeNeeded) {
					const roundsUsed = task?.judgeRounds ?? 0;
					if (roundsUsed >= MAX_JUDGE_ROUNDS) {
						// đủ vòng phán rồi — park ngay, không tốn thêm judge call
						patch.status = "parked";
						patch.appealReason = `judge cap: đã ${roundsUsed} vòng phán chưa hoàn thành`;
					} else {
						const logSlice = pickLogSlice(
							runLog.map((e) => ({ cmd: e.cmd, output: e.output })),
							probeViews ?? [],
							evidence,
						);
						// v1.4.38: nếu task_update này CŨNG đổi đề, judge phải thấy cả tờ cũ
						// + lần đổi đang bay (updateTask sẽ ghi trail thật ngay sau đó)
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
							// fail-closed: không đổi state, không tốn vòng
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
							patch.status = task?.status ?? "pending"; // không hoàn thành — giữ nguyên trạng thái
							patch.audit = { at: Date.now(), verdict: "judge-insufficient", summary: conseq.message };
						} else {
							// fail-streak: refused, chưa demote — giữ trạng thái, đếm streak
							patch.status = task?.status ?? "pending";
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
					? `\nPARKED (dừng chờ user): ${result.task!.appealReason ?? "—"} — chỉ USER mở lại được: nút "mở lại (user)" trên panel task (ghi file ~/.pi/agent/task-control/<sessionId>.json) hoặc nói trực tiếp trong chat. Model không thể tự mở.`
					: "";
			const strictNote =
				params.status === "completed" && result.task!.verify?.strict
					? "\n(STRICT task — layer-2 judge đã phán theo audit ở trên)"
					: "";
			// #59 (user 2026-09-14): completion bị GIỮ phải tự phô bày — gate nào giữ,
			// vòng judge thứ mấy, và NEXT hợp lệ. Envelope chuẩn #43: thiếu dòng này
			// model chỉ thấy "→ pending" và khai lại mò vài lần.
			const heldNote =
				params.status === "completed" && result.task!.status !== "completed" && result.task!.status !== "parked"
					? `\n⏸ Completion HELD — #${result.task!.id} CHƯA hoàn thành (vòng judge ${result.task!.judgeRounds ?? 0}/${MAX_JUDGE_ROUNDS}). ` +
					  `Đừng khai lại y nguyên: bỏ phiếu lại cũng bị giữ. ` +
					  `NEXT: (1) làm đúng việc gate yêu cầu — chạy lệnh probe THẬT qua bash (sổ ghi lệnh bắt bằng chứng) / bổ sung evidence cụ thể: lệnh + output + file, rồi khai completed lại; ` +
					  `(2) probe khai sai → amend verify (task_update verify=..., ≤2 lần); ` +
					  `(3) tranh chấp phán quyết → appeal="lý do cụ thể" → PARK chờ user.`
					: "";
			// #45: field-level CHANGES block (self-explaining harness, same family
			// as the #43 denial envelope) — model sees it, panel card rides it.
			const fields = fieldChanges(prevTask, result.task!);
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
					{ type: "text", text: `#${result.task!.id} → ${result.task!.status}${heldNote}${warn}${auditNote}${parkedNote}${strictNote}${ready}${changesNote}` },
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

		// v1.4.28 control bridge: user-only actions (unpark / strict) từ Paseo
		// panel. Chỉ main chat watch (giống snip) — worker session không có file.
		const parent = (ctx.sessionManager.getHeader?.() as { parentSession?: string } | undefined)?.parentSession;
		controlSessionId = !parent && statusSessionId ? statusSessionId : "";
		lastControlSentAt = undefined;
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
