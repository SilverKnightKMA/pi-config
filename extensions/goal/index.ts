/**
 * goal engine (#37, v1.4.50 — core + commands; wake-loop next).
 * Phiên làm việc không giám sát: anchor + 20 epoch tự đánh thức + lease mặc định.
 *
 * v1.4.50 scope: pure transitions (src/goal-state.ts) + state file
 * ~/.pi/agent/goal-state/<sessionId>.json + /goal start|stop|pause|status +
 * restart-back-up (session_start đọc lại). Continuation driver (agent_settled
 * wake), auto-ping single-waker merge, task doneCheck lease path và
 * zombie-watchdog goal-wait: v1.4.51.
 *
 * Single-writer (#44): namespace này chỉ goal engine ghi; task/subagent-types
 * ĐỌC để biết goal đang chạy (shouldAutoPing suppress, lease available).
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type GoalState,
	type LeaseResult,
	resumeGoal,
	sanitizeGoalState,
	startGoal,
	stopGoal,
	pauseGoal,
	useLease,
	wrapUpReport,
} from "./src/goal-state.js";

function goalDir(): string {
	return join(process.env.HOME ?? homedir(), ".pi", "agent", "goal-state");
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
		// best-effort: /goal commands báo lỗi read lại qua status
	}
}

export function activate(pi: ExtensionAPI): void {
	let sessionId = "";

	pi.on("session_start", (_event, ctx) => {
		const parent = (ctx.sessionManager.getHeader?.() as { parentSession?: string } | undefined)?.parentSession;
		sessionId = !parent ? ((ctx.sessionManager.getSessionId?.() as string | undefined) ?? "") : "";
		// mảnh 6 — restart-back-up: goal sống qua respawn
		const st = sessionId ? readGoal(sessionId) : null;
		if (st && st.status === "running") {
			pi.sendMessage({ customType: "goal-status", content: `[goal] resumed — epoch ${st.epoch}/20, lease ${st.lease.used}/1 (anchor: ${st.anchor.slice(0, 120)})`, display: true });
		}
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
				const st = startGoal(sessionId, anchor, new Date().toISOString());
				writeGoal(st);
				pi.sendMessage({
					customType: "goal-status",
					content: [
						`[goal] BẮT ĐẦU — anchor: ${st.anchor}`,
						`epoch 0/20 · lease: ĐÃ CẤP mặc định (dùng tối đa 1 lần, sáng soi wrap-up)`,
					].join("\n"),
					display: true,
				});
				return;
			}

			const st = readGoal(sessionId);
			if (!st) {
				ctx.ui.notify("chưa có goal trong session này — /goal start <anchor>", "warning");
				return;
			}
			const now = new Date().toISOString();

			if (sub === "status") {
				pi.sendMessage({
					customType: "goal-status",
					content: [`[goal] ${st.status} — epoch ${st.epoch}/20`, `anchor: ${st.anchor}`, st.lease.granted ? `lease: ${st.lease.used}/1 đã dùng` : "lease: không được cấp"].join("\n"),
					display: true,
				});
			} else if (sub === "pause") {
				writeGoal(pauseGoal(st, now));
				pi.sendMessage({ customType: "goal-status", content: "[goal] TẠM DỪNG — không tự đánh thức cho tới /goal resume", display: true });
			} else if (sub === "resume") {
				writeGoal(resumeGoal(st, now));
				pi.sendMessage({ customType: "goal-status", content: "[goal] TIẾP TỤC", display: true });
			} else if (sub === "stop") {
				writeGoal(stopGoal(st, now));
				pi.sendMessage({ customType: "goal-status", content: `[goal] KẾT THÚC\n${wrapUpReport(st)}`, display: true });
			} else if (sub === "lease-use") {
				// đường model-side sẽ nối vào task doneCheck ở v1.4.51; tạm user-kích hoạt thử
				const note = args.trim().slice("lease-use".length).trim() || "(không ghi chú)";
				const r: LeaseResult = useLease(st, note, now);
				if (r.ok) {
					writeGoal(r.state);
					pi.sendMessage({ customType: "goal-status", content: `[goal] LEASE ĐÃ DÙNG (1/1) — ${note}\nSáng sẽ thấy trong wrap-up.`, display: true });
				} else {
					ctx.ui.notify(`lease từ chối: ${r.reason}`, "error");
				}
			} else {
				ctx.ui.notify("sub: start <anchor> | status | pause | resume | stop | lease-use <note>", "warning");
			}
		},
	});
}
