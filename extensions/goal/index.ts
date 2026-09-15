/**
 * goal engine (#37, v1.4.51 — complete wake-loop).
 * Unsupervised work session: anchor + 20 self-wake epochs + default lease.
 *
 * Loop invariants (design lock 2026-09-14):
 *  - Mechanical goal-done: code reads the board projection; the model never
 *    concludes done on its own.
 *  - Membership is dynamic through a door: start snapshot ∪ tasks stamped
 *    goalId (tasks born inside the goal ARE members) — but admission never
 *    refunds an epoch.
 *  - Completed is one-way inside a goal: reopen is blocked at the task ext
 *    (escape hatch: create a new stamped task).
 *  - Spinning-detect: 2 consecutive epochs with 0 tasks completed → early wrap-up.
 *  - Single-waker: while a goal is running, subagent-types' auto-ping is
 *    suppressed (subagent-types reads the goal-state file before pinging).
 *
 * File bridge (single-writer #44): the goal engine is the sole writer of
 * ~/.pi/agent/goal-state/<sessionId>.json; task ext + subagent-types READ
 * (the task ext also records lease use via tryConsumeLease — the lease is granted by default at goal start).
 */

import { mkdirSync, readFileSync, renameSync, watch, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type BoardTaskLike,
	type GoalState,
	type GoalProposal,
	backoffSec,
	confirmGoal,
	setProposal,
	reviseGoal,
	creditProgress,
	goalDone,
	memberTasks,
	nextEpoch,
	recordEpoch,
	resumeGoal,
	sanitizeGoalState,
	spinning,
	startGoal,
	stopGoal,
	pauseGoal,
	useLease,
	wakeAccount,
	wrapUpReport,
} from "./src/goal-state.js";
import { decide as continuationDecide, GOAL_BUDGET } from "../_shared/continuation-driver.ts";

function home(): string {
	return process.env.HOME ?? homedir();
}

function goalDir(): string {
	return join(home(), ".pi", "agent", "goal-state");
}

function goalPath(sessionId: string): string {
	return join(goalDir(), `${sessionId}.json`);
}

function readGoal(sessionId: string): GoalState | null {
	try {
		return sanitizeGoalState(JSON.parse(readFileSync(goalPath(sessionId), "utf8")));
	} catch {
		return null;
	}
}

function writeGoal(state: GoalState): void {
	const file = goalPath(state.sessionId);
	try {
		mkdirSync(dirname(file), { recursive: true });
		const tmp = `${file}.tmp-${process.pid}`;
		writeFileSync(tmp, JSON.stringify(state), "utf8");
		renameSync(tmp, file);
	} catch {
		// best-effort; /goal status will see the old state
	}
	// projection for the plugin card (goal-status/<sid>.json) — plugin only reads, never writes
	try {
		const dir = join(home(), ".pi", "agent", "goal-status");
		mkdirSync(dir, { recursive: true });
		const p = join(dir, `${state.sessionId}.json`);
		const tmp = `${p}.tmp-${process.pid}`;
		writeFileSync(tmp, JSON.stringify({
			v: 1,
			sessionId: state.sessionId,
			goalId: state.goalId,
			status: state.status,
			anchor: state.proposal?.anchor ?? state.anchor,
			awaiting: state.status === "draft" && state.proposal ? "confirm" : null,
			proposal: state.proposal
				? { includeIds: state.proposal.includeIds, excludeIds: state.proposal.excludeIds, rationale: state.proposal.rationale, proposedAt: state.proposal.proposedAt }
				: undefined,
			epoch: state.epoch,
			members: state.memberIds.length,
			lease: { granted: state.lease.granted, used: state.lease.used },
			updatedAt: state.updatedAt,
		}), "utf8");
		renameSync(tmp, p);
	} catch {
		// projection is best-effort
	}
}

/** Control bridge (user-only door): panel buttons write goal-control/<sid>.json */
function controlPath(sessionId: string): string {
	return join(home(), ".pi", "agent", "goal-control", `${sessionId}.json`);
}

function ackControl(sessionId: string, payload: Record<string, unknown>): void {
	try {
		writeFileSync(controlPath(sessionId), JSON.stringify({ ...payload, ackAt: new Date().toISOString() }), "utf8");
	} catch {
		// ack best-effort
	}
}

/** Board projection of the task ext (read-only, stable shape). */
function readBoard(sessionId: string): BoardTaskLike[] {
	try {
		const raw = JSON.parse(readFileSync(join(home(), ".pi", "agent", "task-status", `${sessionId}.json`), "utf8"));
		const tasks = raw?.tasks;
		if (!Array.isArray(tasks)) return [];
		return tasks
			.filter((t: unknown): t is { id: number; status: string; goalId?: string } =>
				typeof t === "object" && t !== null && typeof (t as { id?: unknown }).id === "number" && typeof (t as { status?: unknown }).status === "string")
			.map((t) => ({ id: t.id, status: t.status, ...(typeof t.goalId === "string" ? { goalId: t.goalId } : {}) }));
	} catch {
		return [];
	}
}

function openIds(tasks: BoardTaskLike[]): number[] {
	return tasks.filter((t) => t.status !== "completed" && t.status !== "cancelled").map((t) => t.id);
}

function say(pi: ExtensionAPI, content: string): void {
	pi.sendMessage({ customType: "goal-status", content, display: true });
}

export default function activate(pi: ExtensionAPI): void {
	let sessionId = "";
	let wakeTimer: ReturnType<typeof setTimeout> | null = null;

	function clearWake(): void {
		if (wakeTimer) {
			clearTimeout(wakeTimer);
			wakeTimer = null;
		}
	}

	function wrapUp(pi2: ExtensionAPI, st: GoalState, why: string): void {
		clearWake();
		const done = stopGoal(st, new Date().toISOString());
		writeGoal(done);
		pi2.sendMessage({
			customType: "goal-status",
			content: `${wrapUpReport(done)}\nend reason: ${why}`,
			display: true,
		});
	}

	/** Evaluate after each turn: done / spinning / out of budget / schedule the next epoch. */
	function settle(pi2: ExtensionAPI): void {
		const st = sessionId ? readGoal(sessionId) : null;
		if (!st || st.status !== "running") return;
		const now = new Date().toISOString();
		const board = readBoard(sessionId);
		const members = memberTasks(st, board);
		const completed = members.filter((t) => t.status === "completed" || t.status === "cancelled").length;
		// #89: credit fresh completions FIRST — mid-turn progress must be visible to
		// spinning() or long-running goals false-stop (board.completed stays display-only).
		const creditedSt = creditProgress(st, completed);

		if (goalDone(creditedSt, board)) {
			wrapUp(pi2, creditedSt, "mechanical goal-done: no open task-members left");
			return;
		}
		if (spinning(creditedSt)) {
			wrapUp(pi2, st, "spinning: 2 consecutive epochs with no task completed");
			return;
		}
		// v1.4.69 (#61 Phase C): budget decision now routes through the shared
		// continuation driver (goal keeps its stricter spinning=2 pre-check above;
		// no-progress tracking stays goal-local via epochs, so the driver sees 0).
		const wd = continuationDecide({ kind: "goal", active: true, openWork: openIds(members).length, rounds: st.epoch, budget: GOAL_BUDGET, noProgressStreak: 0 });
		if (wd.action === "wrapup") {
			wrapUp(pi2, st, st.epoch >= GOAL_BUDGET ? "epoch budget exhausted (20/20)" : wd.reason);
			return;
		}
		clearWake();
		const waitMs = backoffSec(st.epoch) * 1000;
		const withBoard: GoalState = { ...creditedSt, board: { members: members.length, completed }, wakeAt: new Date(Date.now() + waitMs).toISOString(), updatedAt: now };
		writeGoal(withBoard);
		wakeTimer = setTimeout(() => {
			wakeTimer = null;
			const cur = sessionId ? readGoal(sessionId) : null;
			if (!cur || cur.status !== "running") return;
			// epoch consumed on REAL wake; #89 wakeAccount credits last-instant completions
			// then flushes ALL pending credit into the consumed epoch's record
			const b = readBoard(sessionId);
			const mem = memberTasks(cur, b);
			const doneNow = mem.filter((t) => t.status === "completed" || t.status === "cancelled").length;
			const accounted = wakeAccount(cur, doneNow, mem.length - cur.board.members, new Date().toISOString());
			writeGoal(accounted);
			const open = openIds(mem);
			const nextId = open[0];
			const nextTxt = nextId !== undefined ? `start #${nextId}` : "re-check the board";
			pi2.sendUserMessage(
				`[goal wake ${accounted.epoch}/20] anchor: ${accounted.anchor.slice(0, 160)}\n${open.length} open task-members · lease ${accounted.lease.used}/1 · ${nextTxt} — keep going; do not reopen completed tasks (create a new task if more work comes up); when done, stop naturally (the goal will conclude itself).`,
				{ deliverAs: "followUp" },
			);
		}, waitMs);
	}

	pi.on("session_start", (_event, ctx) => {
		const header = ctx.sessionManager.getHeader?.() as { parentSession?: string } | undefined;
		sessionId = !header?.parentSession ? ((ctx.sessionManager.getSessionId?.() as string | undefined) ?? "") : "";
		if (!sessionId) return;
		const st = readGoal(sessionId);
		if (!st) return;
		if (st.status === "draft") {
			// restart-back-up for the INIT phase: session died mid-init → wake up to finish the table
			if (!st.proposal) {
				say(pi, `[goal] draft has no proposal table yet — model finishes init (read board → propose scope + anchor → goal_propose)`);
				pi.sendUserMessage(`[goal-init] continue goal init (raw anchor: ${st.anchor.slice(0, 200)}): propose scope + target anchor, then call goal_propose.`, { deliverAs: "followUp" });
			} else {
				say(pi, `[goal] draft has a table awaiting approval — user approves on the panel or via /goal confirm.`);
			}
			return;
		}
		if (st.status !== "running") return;
		say(pi, `[goal] resumed — epoch ${st.epoch}/20, lease ${st.lease.used}/1, members ${st.memberIds.length} + stamped (anchor: ${st.anchor.slice(0, 120)})`);
		// piece 6 restart-back-up: if wakeAt is already in the past, wake again soon
		const past = st.wakeAt ? Date.parse(st.wakeAt) < Date.now() : true;
		setTimeout(() => settle(pi), past ? 5_000 : Math.max(1_000, Math.min(60_000, (st.wakeAt ? Date.parse(st.wakeAt) - Date.now() : 5_000))));
	});

	// Control bridge (user-only door): panel buttons write goal-control/<sid>.json.
	// Watch dir + 150ms debounce + self-ack dedupe — pattern snip v1.4.6.
	pi.on("input", () => clearWake());

	pi.on("agent_settled", () => {
		// to let the event loop exit: wait 2s then evaluate (a real turn just ended)
		setTimeout(() => settle(pi), 2_000);
	});

	pi.registerCommand("goal", {
		description: "Manage goals (unsupervised sessions): start <anchor> | status | pause | resume | stop",
		handler: async (args, ctx) => {
			const argv = args.trim().split(/\s+/).filter(Boolean);
			const sub = argv[0]?.toLowerCase();
			if (!sessionId) sessionId = ((ctx.sessionManager.getSessionId?.() as string | undefined) ?? "");
			if (!sessionId) {
				ctx.ui.notify("goal: could not determine session (subagent?)", "error");
				return;
			}

			if (sub === "start") {
				const anchor = args.trim().slice("start".length).trim();
				if (!anchor) {
					ctx.ui.notify("/goal start <anchor text> — describe the destination of the overnight session", "warning");
					return;
				}
				const existing = readGoal(sessionId);
				if (existing && (existing.status === "running" || existing.status === "paused")) {
					ctx.ui.notify(`goal already running (epoch ${existing.epoch}/20) — /goal stop before starting a new one`, "warning");
					return;
				}
				// v1.4.52: start opens the INIT phase (draft) — the goal is not running yet, no epoch consumed.
				// The model builds the scope proposal table; it goes running only after the user approves on the panel/slash.
				const existingAny = readGoal(sessionId);
				const st = startGoal(sessionId, anchor, new Date().toISOString(), { lease: existingAny?.lease.granted !== false });
				writeGoal(st);
				pi.sendUserMessage(
					`[goal-init] user opened a goal (request: ${anchor.slice(0, 300)}). The model's job right now: (1) read the board via task_list; (2) propose scope — which tasks go IN (reason), which are dropped (reason); (3) write an anchor describing the DESTINATION AS AN OUTCOME (not a task list); (4) present a short table in chat; (5) call goal_propose with anchor + includeIds/excludeIds + rationale. The goal only runs after the user approves the table — do NOT self-start, and consume no epochs during init. If the board is empty or the proposal is unclear: ask the user in chat.`,
					{ deliverAs: "followUp" },
				);
				return;
			}

			const st = readGoal(sessionId);
			if (!st) {
				ctx.ui.notify("no goal in this session yet — /goal start <anchor>", "warning");
				return;
			}
			const now = new Date().toISOString();

			if (sub === "status") {
				if (st.status === "draft") {
					say(pi, st.proposal
						? [`[goal] DRAFT — awaiting user approval of the table (panel button or /goal confirm)`, `proposed anchor: ${st.proposal.anchor}`, `in: ${st.proposal.includeIds.length ? `#${st.proposal.includeIds.join(" #")}` : "all open tasks"}${st.proposal.excludeIds.length ? ` · out: #${st.proposal.excludeIds.join(" #")}` : ""}`].join("\n")
						: "[goal] DRAFT — model has not proposed a table yet; await init or remind the model to call goal_propose");
				} else {
					const board = readBoard(sessionId);
					const open = openIds(memberTasks(st, board));
					say(pi, [`[goal] ${st.status} — epoch ${st.epoch}/20 · goalId ${st.goalId}`, `anchor: ${st.anchor}`, `${open.length} open: ${open.length ? `#${open.slice(0, 10).join(" #")}${open.length > 10 ? " …" : ""}` : "—"}`, st.lease.granted ? `lease: ${st.lease.used}/1 used` : "lease: not granted"].join("\n"));
				}
			} else if (sub === "pause") {
				clearWake();
				writeGoal(pauseGoal(st, now));
				say(pi, "[goal] PAUSED — no self-waking until /goal resume");
			} else if (sub === "resume") {
				writeGoal(resumeGoal(st, now));
				say(pi, "[goal] RESUMED");
				setTimeout(() => settle(pi), 2_000);
			} else if (sub === "stop") {
				wrapUp(pi, st, "user called /goal stop");
			} else if (sub === "lease-use") {
				const note = args.trim().slice("lease-use".length).trim() || "(no note)";
				const r = useLease(st, note, now);
				if (r.ok) {
					writeGoal(r.state);
					say(pi, `[goal] LEASE USED (1/1) — ${note}\nIt will show up in the morning wrap-up.`);
				} else {
					ctx.ui.notify(`lease denied: ${r.reason}`, "error");
				}
			} else if (sub === "confirm") {
				// user-typed fallback for the ✓ approve button on the panel
				if (st.status !== "draft" || !st.proposal) {
					ctx.ui.notify("goal has no proposal table to approve (draft without a proposal)", "warning");
					return;
				}
				const now2 = new Date().toISOString();
				writeGoal(confirmGoal(st, openIds(readBoard(sessionId)), now2));
				say(pi, "[goal] APPROVED — membership locked to the table, epoch budget + wake-loop begin.");
				setTimeout(() => settle(pi), 2_000);
			} else if (sub === "revise") {
				writeGoal(reviseGoal(st, new Date().toISOString()));
				say(pi, "[goal] REVISED — the model will propose a new table (draft, not running).");
			} else if (sub === "cancel") {
				if (st.status === "draft") {
					clearWake();
					writeGoal(stopGoal(st, new Date().toISOString()));
					say(pi, "[goal] DRAFT CANCELED.");
				} else {
					ctx.ui.notify("goal is running — use /goal stop (includes wrap-up)", "warning");
				}
			} else {
				ctx.ui.notify("sub: start <anchor> | confirm | revise | cancel | status | pause | resume | stop | lease-use <note>", "warning");
			}
		},
	});

	// the model's only tool in the init phase: write the proposal table (cannot run anything)
	pi.registerTool({
		name: "goal_propose",
		label: "Goal init — propose scope",
		description: "Goal init: record the scope proposal table awaiting user approval. Only valid while the goal is in draft (user just ran /goal start). The anchor describes the DESTINATION AS AN OUTCOME, NOT a task list.",
		parameters: Type.Object({
			anchor: Type.String({ description: "Destination described as an outcome, e.g. 'tasks about X completed + tests pass'" }),
			includeIds: Type.Array(Type.Number(), { default: [], description: "Task ids proposed INTO scope — use [] for all open tasks (use excludeIds instead)" }),
			excludeIds: Type.Array(Type.Number(), { default: [] }),
			rationale: Type.String({ description: "Reason for including/dropping each task — shown in the chat table + approval card" }),
		}),
		async execute(_id, params: { anchor: string; includeIds?: number[]; excludeIds?: number[]; rationale: string }, _signal, _onUpdate, _ctx) {
			if (!sessionId) throw new Error("goal: could not determine session");
			const st = readGoal(sessionId);
			if (!st) throw new Error("goal: no goal yet (user types /goal start <request> first)");
			if (st.status !== "draft") throw new Error(`goal is ${st.status} — the table can only be written while in draft`);
			const p: GoalProposal = {
				anchor: params.anchor ?? "",
				includeIds: Array.isArray(params.includeIds) ? params.includeIds.map(Number) : [],
				excludeIds: Array.isArray(params.excludeIds) ? params.excludeIds.map(Number) : [],
				rationale: params.rationale ?? "",
				proposedAt: new Date().toISOString(),
			};
			writeGoal(setProposal(st, p, p.proposedAt));
			return {
				content: [{ type: "text", text: [
					`Proposal table recorded (draft awaiting approval):`,
					`anchor: ${p.anchor}`,
					`in: ${p.includeIds.length ? `#${p.includeIds.join(" #")}` : "all open tasks"}${p.excludeIds.length ? ` · out: #${p.excludeIds.join(" #")}` : ""}`,
					`User approves via the goal table on the panel (✓ button) or by typing /goal confirm — the goal is NOT running yet.`,
				].join("\n") }],
				details: {},
			};
		},
	});

	// watch goal-control dir — confirm/revise/cancel from panel buttons
	try {
		mkdirSync(dirname(controlPath("x")), { recursive: true });
		let debounce: ReturnType<typeof setTimeout> | null = null;
		let lastAckAt = "";
		watch(join(home(), ".pi", "agent", "goal-control"), () => {
			if (debounce) clearTimeout(debounce);
			debounce = setTimeout(() => {
				debounce = null;
				if (!sessionId) return;
				try {
					const raw = JSON.parse(readFileSync(controlPath(sessionId), "utf8")) as { action?: string; ackAt?: string; sentAt?: string };
					if (raw.ackAt && raw.ackAt === lastAckAt) return; // self-ack dedupe
					if (raw.action === "confirm") {
						const st = readGoal(sessionId);
						if (st && st.status === "draft" && st.proposal) {
							writeGoal(confirmGoal(st, openIds(readBoard(sessionId)), new Date().toISOString()));
							say(pi, "[goal] APPROVED (panel) — membership locked, wake-loop begins.");
							lastAckAt = new Date().toISOString();
							ackControl(sessionId, { action: "confirm", sentAt: raw.sentAt, ackAt: lastAckAt });
							setTimeout(() => settle(pi), 2_000);
						}
					} else if (raw.action === "revise") {
						const st = readGoal(sessionId);
						if (st && st.status === "draft") {
							writeGoal(reviseGoal(st, new Date().toISOString()));
							say(pi, "[goal] REVISED (panel) — the model will propose a new table.");
							lastAckAt = new Date().toISOString();
							ackControl(sessionId, { action: "revise", sentAt: raw.sentAt, ackAt: lastAckAt });
							pi.sendUserMessage("[goal-init] user clicked 'revise' — propose a new scope table (anchor + in/out + reasons), then call goal_propose.", { deliverAs: "followUp" });
						}
					} else if (raw.action === "cancel") {
						const st = readGoal(sessionId);
						if (st && st.status === "draft") {
							clearWake();
							writeGoal(stopGoal(st, new Date().toISOString()));
							say(pi, "[goal] DRAFT CANCELED (panel).");
							lastAckAt = new Date().toISOString();
							ackControl(sessionId, { action: "cancel", sentAt: raw.sentAt, ackAt: lastAckAt });
						}
					}
				} catch {
					// no file yet / junk — skip
				}
			}, 150);
		});
	} catch {
		// could not create the control dir — panel buttons won't work, slash still runs
	}
}
