/**
 * goal engine (#37, v1.4.51 — wake-loop hoàn chỉnh).
 * Phiên làm việc không giám sát: anchor + 20 epoch tự đánh thức + lease mặc định.
 *
 * Bất biến vòng lặp (chốt thiết kế 2026-09-14):
 *  - goal-done CƠ KHÍ: code đọc board projection, model không tự kết luận xong.
 *  - Membership động qua cửa: snapshot start ∪ task stamp goalId (task sinh
 *    trong goal LÀ thành viên) — nhưng admission không hoàn lại epoch.
 *  - Completed một chiều trong goal: reopen bị chặn ở task ext (escape: tạo
 *    task mới có stamp).
 *  - Spinning-detect: 2 epoch liền 0 task hoàn thành → wrap-up sớm.
 *  - Single-waker: khi goal running, auto-ping của subagent-types bị suppress
 *    (subagent-types đọc goal-state file trước khi ping).
 *
 * File bridge (single-writer #44): goal engine là người ghi duy nhất của
 * ~/.pi/agent/goal-state/<sessionId>.json; task ext + subagent-types ĐỌC
 * (task ext còn ghi lease dùng qua tryConsumeLease — lease do user cấp mặc định ở goal start).
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type BoardTaskLike,
	type GoalState,
	backoffSec,
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
	wrapUpReport,
} from "./src/goal-state.js";

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
		// best-effort; /goal status sẽ thấy state cũ
	}
}

/** Board projection của task ext (đọc-only, shape ổn định). */
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

export function activate(pi: ExtensionAPI): void {
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
			content: `${wrapUpReport(done)}\nlý do kết thúc: ${why}`,
			display: true,
		});
	}

	/** Đánh giá sau mỗi lượt: xong / giò chỗ / hết ngân sách / lên lịch epoch mới. */
	function settle(pi2: ExtensionAPI): void {
		const st = sessionId ? readGoal(sessionId) : null;
		if (!st || st.status !== "running") return;
		const now = new Date().toISOString();
		const board = readBoard(sessionId);
		const members = memberTasks(st, board);
		const completed = members.filter((t) => t.status === "completed" || t.status === "cancelled").length;

		if (goalDone(st, board)) {
			wrapUp(pi2, st, "goal-done cơ khí: không còn task-member nào mở");
			return;
		}
		if (spinning(st)) {
			wrapUp(pi2, st, "spinning: 2 epoch liên tiếp không task nào hoàn thành");
			return;
		}
		if (st.epoch >= 20) {
			wrapUp(pi2, st, "hết ngân sách epoch (20/20)");
			return;
		}
		clearWake();
		const waitMs = backoffSec(st.epoch) * 1000;
		const withBoard: GoalState = { ...st, board: { members: members.length, completed }, wakeAt: new Date(Date.now() + waitMs).toISOString(), updatedAt: now };
		writeGoal(withBoard);
		wakeTimer = setTimeout(() => {
			wakeTimer = null;
			const cur = sessionId ? readGoal(sessionId) : null;
			if (!cur || cur.status !== "running") return;
			// epoch tiêu khi wake THẬT; kế toán delta board so với lần settle trước
			const b = readBoard(sessionId);
			const mem = memberTasks(cur, b);
			const doneNow = mem.filter((t) => t.status === "completed" || t.status === "cancelled").length;
			const consumed = nextEpoch(cur, new Date().toISOString());
			const accounted = recordEpoch(consumed, consumed.epoch, consumed.updatedAt, Math.max(0, mem.length - cur.board.members), Math.max(0, doneNow - cur.board.completed));
			writeGoal(accounted);
			const open = openIds(mem);
			const nextId = open[0];
			const nextTxt = nextId !== undefined ? `bắt đầu #${nextId}` : "kiểm tra lại board";
			pi2.sendUserMessage(
				`[goal wake ${accounted.epoch}/20] anchor: ${accounted.anchor.slice(0, 160)}\nmở ${open.length} task-member · lease ${accounted.lease.used}/1 · ${nextTxt} — làm tiếp; không reopen task completed (tạo task mới nếu phát sinh việc); xong thì dừng tự nhiên (goal sẽ tự kết thúc).`,
				{ deliverAs: "followUp" },
			);
		}, waitMs);
	}

	pi.on("session_start", (_event, ctx) => {
		const header = ctx.sessionManager.getHeader?.() as { parentSession?: string } | undefined;
		sessionId = !header?.parentSession ? ((ctx.sessionManager.getSessionId?.() as string | undefined) ?? "") : "";
		if (!sessionId) return;
		const st = readGoal(sessionId);
		if (!st || st.status !== "running") return;
		say(pi, `[goal] resumed — epoch ${st.epoch}/20, lease ${st.lease.used}/1, member ${st.memberIds.length}+stamped (anchor: ${st.anchor.slice(0, 120)})`);
		// mảnh 6 restart-back-up: nếu wakeAt đã quá khứ thì đánh thức lại sớm
		const past = st.wakeAt ? Date.parse(st.wakeAt) < Date.now() : true;
		setTimeout(() => settle(pi), past ? 5_000 : Math.max(1_000, Math.min(60_000, (st.wakeAt ? Date.parse(st.wakeAt) - Date.now() : 5_000))));
	});

	pi.on("input", () => clearWake());

	pi.on("agent_settled", () => {
		// để thoát event loop: hẹn 2s rồi đánh giá (turn thật vừa kết thúc)
		setTimeout(() => settle(pi), 2_000);
	});

	pi.registerCommand("goal", {
		description: "Quản lý goal (phiên không giám sát): start <anchor> | status | pause | resume | stop",
		handler: async (args, ctx) => {
			const argv = args.trim().split(/\s+/).filter(Boolean);
			const sub = argv[0]?.toLowerCase();
			if (!sessionId) sessionId = ((ctx.sessionManager.getSessionId?.() as string | undefined) ?? "");
			if (!sessionId) {
				ctx.ui.notify("goal: không xác định được session (subagent?)", "error");
				return;
			}

			if (sub === "start") {
				const anchor = args.trim().slice("start".length).trim();
				if (!anchor) {
					ctx.ui.notify("/goal start <anchor text> — mô tả đích đến của phiên đêm", "warning");
					return;
				}
				const existing = readGoal(sessionId);
				if (existing && (existing.status === "running" || existing.status === "paused")) {
					ctx.ui.notify(`goal đang chạy (epoch ${existing.epoch}/20) — /goal stop trước khi start mới`, "warning");
					return;
				}
				const snapshot = openIds(readBoard(sessionId));
				const st = startGoal(sessionId, anchor, new Date().toISOString(), { memberIds: snapshot });
				writeGoal(st);
				say(pi, [
					`[goal] BẮT ĐẦU — anchor: ${st.anchor}`,
					`goalId ${st.goalId} · snapshot ${snapshot.length} task mở · epoch 0/20 · lease ĐÃ CẤP mặc định (1 lần)`,
					"task tạo từ giờ tự thuộc goal (stamp); goal tự kết thúc khi board sạch — sáng soi wrap-up.",
				].join("\n"));
				return;
			}

			const st = readGoal(sessionId);
			if (!st) {
				ctx.ui.notify("chưa có goal trong session này — /goal start <anchor>", "warning");
				return;
			}
			const now = new Date().toISOString();

			if (sub === "status") {
				const board = readBoard(sessionId);
				const open = openIds(memberTasks(st, board));
				say(pi, [`[goal] ${st.status} — epoch ${st.epoch}/20 · goalId ${st.goalId}`, `anchor: ${st.anchor}`, `mở ${open.length}: ${open.length ? `#${open.slice(0, 10).join(" #")}${open.length > 10 ? " …" : ""}` : "—"}`, st.lease.granted ? `lease: ${st.lease.used}/1 đã dùng` : "lease: không được cấp"].join("\n"));
			} else if (sub === "pause") {
				clearWake();
				writeGoal(pauseGoal(st, now));
				say(pi, "[goal] TẠM DỪNG — không tự đánh thức cho tới /goal resume");
			} else if (sub === "resume") {
				writeGoal(resumeGoal(st, now));
				say(pi, "[goal] TIẾP TỤC");
				setTimeout(() => settle(pi), 2_000);
			} else if (sub === "stop") {
				wrapUp(pi, st, "user gọi /goal stop");
			} else if (sub === "lease-use") {
				const note = args.trim().slice("lease-use".length).trim() || "(không ghi chú)";
				const r = useLease(st, note, now);
				if (r.ok) {
					writeGoal(r.state);
					say(pi, `[goal] LEASE ĐÃ DÙNG (1/1) — ${note}\nSáng sẽ thấy trong wrap-up.`);
				} else {
					ctx.ui.notify(`lease từ chối: ${r.reason}`, "error");
				}
			} else {
				ctx.ui.notify("sub: start <anchor> | status | pause | resume | stop | lease-use <note>", "warning");
			}
		},
	});
}
