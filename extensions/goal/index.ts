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
	// projection cho plugin card (goal-status/<sid>.json) — plugin chỉ đọc, không ghi
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
		// projection là best-effort
	}
}

/** Control bridge (user-only door): panel button ghi goal-control/<sid>.json */
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
		if (!st) return;
		if (st.status === "draft") {
			// restart-back-up cho PHA INIT: session chết giữa init → đánh thức làm nốt bảng
			if (!st.proposal) {
				say(pi, `[goal] draft chưa có bảng đề xuất — model làm nốt init (đọc board → đề xuất scope + anchor → goal_propose)`);
				pi.sendUserMessage(`[goal-init] tiếp tục init goal (anchor thô: ${st.anchor.slice(0, 200)}): đề xuất scope + anchor đích rồi gọi goal_propose.`, { deliverAs: "followUp" });
			} else {
				say(pi, `[goal] draft có bảng chờ duyệt — user duyệt ở panel hoặc /goal confirm.`);
			}
			return;
		}
		if (st.status !== "running") return;
		say(pi, `[goal] resumed — epoch ${st.epoch}/20, lease ${st.lease.used}/1, member ${st.memberIds.length}+stamped (anchor: ${st.anchor.slice(0, 120)})`);
		// mảnh 6 restart-back-up: nếu wakeAt đã quá khứ thì đánh thức lại sớm
		const past = st.wakeAt ? Date.parse(st.wakeAt) < Date.now() : true;
		setTimeout(() => settle(pi), past ? 5_000 : Math.max(1_000, Math.min(60_000, (st.wakeAt ? Date.parse(st.wakeAt) - Date.now() : 5_000))));
	});

	// Control bridge (user-only door): nút panel ghi goal-control/<sid>.json.
	// Watch dir + 150ms debounce + self-ack dedupe — pattern snip v1.4.6.
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
				// v1.4.52: start mở màn INIT (draft) — goal chưa chạy, chưa tiêu epoch.
				// Model làm bảng đề xuất scope; user duyệt trên panel/slách rồi mới running.
				const existingAny = readGoal(sessionId);
				const st = startGoal(sessionId, anchor, new Date().toISOString(), { lease: existingAny?.lease.granted !== false });
				writeGoal(st);
				pi.sendUserMessage(
					`[goal-init] user mở goal (yêu cầu: ${anchor.slice(0, 300)}). Việc của model ngay bây giờ: (1) đọc board qua task_list; (2) đề xuất scope — task nào VÀO (lý do), task nào BỎ (lý do); (3) viết anchor tả ĐÍCH BẰNG KẾT QUẢ (không phải danh sách task); (4) trình bảng ngắn trong chat; (5) gọi goal_propose với anchor + includeIds/excludeIds + rationale. Goal chỉ chạy sau khi user duyệt bảng — KHÔNG tự start, không tiêu epoch lúc init. Nếu board rỗng/đề xuất chưa rõ: hỏi user trong chat.`,
					{ deliverAs: "followUp" },
				);
				return;
			}

			const st = readGoal(sessionId);
			if (!st) {
				ctx.ui.notify("chưa có goal trong session này — /goal start <anchor>", "warning");
				return;
			}
			const now = new Date().toISOString();

			if (sub === "status") {
				if (st.status === "draft") {
					say(pi, st.proposal
						? [`[goal] DRAFT — chờ user duyệt bảng (nút panel hoặc /goal confirm)`, `anchor đề xuất: ${st.proposal.anchor}`, `vào: ${st.proposal.includeIds.length ? `#${st.proposal.includeIds.join(" #")}` : "mọi task mở"}${st.proposal.excludeIds.length ? ` · bỏ: #${st.proposal.excludeIds.join(" #")}` : ""}`].join("\n")
						: "[goal] DRAFT — model chưa đề xuất bảng; chờ init hoặc nhắc model gọi goal_propose");
				} else {
					const board = readBoard(sessionId);
					const open = openIds(memberTasks(st, board));
					say(pi, [`[goal] ${st.status} — epoch ${st.epoch}/20 · goalId ${st.goalId}`, `anchor: ${st.anchor}`, `mở ${open.length}: ${open.length ? `#${open.slice(0, 10).join(" #")}${open.length > 10 ? " …" : ""}` : "—"}`, st.lease.granted ? `lease: ${st.lease.used}/1 đã dùng` : "lease: không được cấp"].join("\n"));
				}
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
			} else if (sub === "confirm") {
				// user-typed fallback của nút ✓ duyệt trên panel
				if (st.status !== "draft" || !st.proposal) {
					ctx.ui.notify("goal chưa có bảng đề xuất để duyệt (draft chưa có proposal)", "warning");
					return;
				}
				const now2 = new Date().toISOString();
				writeGoal(confirmGoal(st, openIds(readBoard(sessionId)), now2));
				say(pi, "[goal] ĐÃ DUYỆT — membership khóa theo bảng, epoch budget + wake-loop bắt đầu.");
				setTimeout(() => settle(pi), 2_000);
			} else if (sub === "revise") {
				writeGoal(reviseGoal(st, new Date().toISOString()));
				say(pi, "[goal] SỬA LẠI — model sẽ đề xuất bảng mới (draft, chưa chạy).");
			} else if (sub === "cancel") {
				if (st.status === "draft") {
					clearWake();
					writeGoal(stopGoal(st, new Date().toISOString()));
					say(pi, "[goal] ĐÃ HỦY draft.");
				} else {
					ctx.ui.notify("goal đang chạy — dùng /goal stop (có wrap-up)", "warning");
				}
			} else {
				ctx.ui.notify("sub: start <anchor> | confirm | revise | cancel | status | pause | resume | stop | lease-use <note>", "warning");
			}
		},
	});

	// tool duy nhất của model trong pha init: ghi bảng đề xuất (không chạy được gì)
	pi.registerTool({
		name: "goal_propose",
		label: "Goal init — đề xuất scope",
		description: "Goal init: ghi bảng đề xuất scope chờ user duyệt. Chỉ hợp lệ khi goal đang draft (user vừa /goal start). anchor tả ĐÍCH BẰNG KẾT QUẢ, KHÔNG phải danh sách task.",
		parameters: Type.Object({
			anchor: Type.String({ description: "Đích đến tả bằng kết quả, ví dụ 'task về X hoàn thành + test pass'" }),
			includeIds: Type.Array(Type.Number(), { default: [], description: "Task id đề xuất VÀO scope — để [] nếu mọi task mở (dùng excludeIds)" }),
			excludeIds: Type.Array(Type.Number(), { default: [] }),
			rationale: Type.String({ description: "Lý do vào/bỏ từng task — hiện trong bảng chat + card duyệt" }),
		}),
		async execute(_id, params: { anchor: string; includeIds?: number[]; excludeIds?: number[]; rationale: string }, _signal, _onUpdate, _ctx) {
			if (!sessionId) throw new Error("goal: không xác định được session");
			const st = readGoal(sessionId);
			if (!st) throw new Error("goal: chưa có goal nào (user gõ /goal start <yêu cầu> trước)");
			if (st.status !== "draft") throw new Error(`goal đang ${st.status} — chỉ ghi bảng khi draft`);
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
					`Đã ghi bảng đề xuất (draft chờ duyệt):`,
					`anchor: ${p.anchor}`,
					`vào: ${p.includeIds.length ? `#${p.includeIds.join(" #")}` : "mọi task mở"}${p.excludeIds.length ? ` · bỏ: #${p.excludeIds.join(" #")}` : ""}`,
					`User duyệt ở bảng goal trên panel (nút ✓) hoặc gõ /goal confirm — goal CHƯA chạy.`,
				].join("\n") }],
				details: {},
			};
		},
	});

	// watch goal-control dir — confirm/revise/cancel từ nút panel
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
							say(pi, "[goal] ĐÃ DUYỆT (panel) — membership khóa, wake-loop bắt đầu.");
							lastAckAt = new Date().toISOString();
							ackControl(sessionId, { action: "confirm", sentAt: raw.sentAt, ackAt: lastAckAt });
							setTimeout(() => settle(pi), 2_000);
						}
					} else if (raw.action === "revise") {
						const st = readGoal(sessionId);
						if (st && st.status === "draft") {
							writeGoal(reviseGoal(st, new Date().toISOString()));
							say(pi, "[goal] SỬA LẠI (panel) — model đề xuất bảng mới.");
							lastAckAt = new Date().toISOString();
							ackControl(sessionId, { action: "revise", sentAt: raw.sentAt, ackAt: lastAckAt });
							pi.sendUserMessage("[goal-init] user bấm 'sửa lại' — đề xuất bảng scope mới (anchor + vào/bỏ + lý do) rồi gọi goal_propose.", { deliverAs: "followUp" });
						}
					} else if (raw.action === "cancel") {
						const st = readGoal(sessionId);
						if (st && st.status === "draft") {
							clearWake();
							writeGoal(stopGoal(st, new Date().toISOString()));
							say(pi, "[goal] ĐÃ HỦY draft (panel).");
							lastAckAt = new Date().toISOString();
							ackControl(sessionId, { action: "cancel", sentAt: raw.sentAt, ackAt: lastAckAt });
						}
					}
				} catch {
					// chưa có file / rác — bỏ qua
				}
			}, 150);
		});
	} catch {
		// không tạo được dir control — nút panel không hoạt động, slash vẫn chạy
	}
}
