/**
 * goal — #37, thiết kế chốt 2026-09-13 (7 mảnh + lease mặc định).
 * Pure module: không pi import, không fs, không network. index.ts làm I/O.
 *
 * Triết lý: goal = phiên làm việc KHÔNG giám sát (đêm, 20 epoch tự đánh thức).
 * Mọi thứ model tự quyết đều có giới hạn cứng (epoch cap, lease 1 lần) và
 * đều lộ ra wrap-up sáng hôm sau cho user soi.
 */

export const GOAL_EPOCH_MAX = 20;
/** Backoff ladder (giây) giữa các epoch — kiên nhẫn tăng dần, cap 80s. */
export const GOAL_BACKOFF_LADDER = [5, 10, 20, 40, 80] as const;

export type GoalStatus = "running" | "paused" | "done" | "stopped";

export interface LeaseUse {
	at: string;
	taskId?: string;
	note: string;
}

/** Lease (user chốt 13/09): MẶC ĐẶN granted khi start; dùng tối đa 1 lần;
 *  model không tự cấp; chết khi goal kết thúc; mọi lần dùng vào log + wrap-up. */
export interface GoalLease {
	granted: boolean;
	used: number;
	log: LeaseUse[];
}

export interface GoalState {
	v: 1;
	sessionId: string;
	anchor: string;
	status: GoalStatus;
	/** Số epoch tự đánh thức đã tiêu. */
	epoch: number;
	lease: GoalLease;
	createdAt: string;
	updatedAt: string;
	/** Epoch tiếp theo dự kiến đánh thức (ISO) — driver ghi, chỉ để hiển thị. */
	wakeAt?: string;
}

export type LeaseResult = { ok: true; state: GoalState } | { ok: false; reason: string };

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

export function startGoal(
	sessionId: string,
	anchor: string,
	now: string,
	opts: { lease?: boolean } = {},
): GoalState {
	return {
		v: 1,
		sessionId,
		anchor: anchor.slice(0, 2000),
		status: "running",
		epoch: 0,
		lease: { granted: opts.lease !== false, used: 0, log: [] },
		createdAt: now,
		updatedAt: now,
	};
}

export function sanitizeGoalState(raw: unknown): GoalState | null {
	if (!isRecord(raw)) return null;
	if (raw.v !== 1 || typeof raw.sessionId !== "string" || !raw.sessionId) return null;
	if (typeof raw.anchor !== "string" || !raw.anchor) return null;
	const status = raw.status;
	if (typeof status !== "string" || !["running", "paused", "done", "stopped"].includes(status)) return null;
	const epoch = typeof raw.epoch === "number" && raw.epoch >= 0 ? Math.floor(raw.epoch) : 0;
	const leaseRaw = isRecord(raw.lease) ? raw.lease : {};
	const log: LeaseUse[] = [];
	if (Array.isArray(leaseRaw.log)) {
		for (const e of leaseRaw.log) {
			if (isRecord(e) && typeof e.at === "string" && typeof e.note === "string") {
				log.push({ at: e.at, ...(typeof e.taskId === "string" ? { taskId: e.taskId } : {}), note: e.note });
			}
		}
	}
	return {
		v: 1,
		sessionId: raw.sessionId,
		anchor: raw.anchor,
		status: status as GoalStatus,
		epoch: Math.min(epoch, GOAL_EPOCH_MAX),
		lease: {
			granted: leaseRaw.granted !== false,
			used: typeof leaseRaw.used === "number" && leaseRaw.used > 0 ? 1 : 0,
			log: log.slice(-8),
		},
		createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
		updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
		...(typeof raw.wakeAt === "string" ? { wakeAt: raw.wakeAt } : {}),
	};
}

/** Driver gọi trước khi đánh thức: còn chạy mới wake. */
export function shouldWake(state: GoalState): boolean {
	return state.status === "running";
}

/** Tiêu 1 epoch sau khi đã đánh thức. Chạm cap → done (epoch cạn). */
export function nextEpoch(state: GoalState, now: string): GoalState {
	const epoch = state.epoch + 1;
	return { ...state, epoch, status: epoch >= GOAL_EPOCH_MAX ? "done" : state.status, updatedAt: now };
}

/** Backoff sau epoch thứ n (0-based) — giây, cap cuối thang. */
export function backoffSec(epoch: number): number {
	const i = Math.max(0, Math.min(epoch, GOAL_BACKOFF_LADDER.length - 1));
	return GOAL_BACKOFF_LADDER[i];
}

export function pauseGoal(state: GoalState, now: string): GoalState {
	return { ...state, status: "paused", updatedAt: now };
}

export function resumeGoal(state: GoalState, now: string): GoalState {
	return state.status === "paused" ? { ...state, status: "running", updatedAt: now } : state;
}

export function stopGoal(state: GoalState, now: string): GoalState {
	return { ...state, status: "stopped", updatedAt: now };
}

/** Dùng lease — đường appeal duy nhất cho phiên không giám sát.
 *  Chỉ 1 lần/goal, chỉ khi còn granted, chỉ khi goal chưa kết thúc. */
export function useLease(state: GoalState, note: string, now: string, taskId?: string): LeaseResult {
	if (!state.lease.granted) return { ok: false, reason: "lease không được cấp cho goal này" };
	if (state.lease.used >= 1) return { ok: false, reason: "lease đã dùng 1/1 lần — chặn như plan-strict" };
	if (state.status === "done" || state.status === "stopped") {
		return { ok: false, reason: `goal đã ${state.status} — lease chết theo goal` };
	}
	const entry: LeaseUse = { at: now, ...(taskId ? { taskId } : {}), note: note.slice(0, 400) };
	return {
		ok: true,
		state: { ...state, lease: { ...state.lease, used: 1, log: [...state.lease.log, entry] }, updatedAt: now },
	};
}

/** Báo cáo sáng hôm sau — lease LUÔN lộ, phong bì có bị xé là thấy ngay. */
export function wrapUpReport(state: GoalState): string {
	const leaseLine =
		state.lease.used === 0
			? `lease: CHƯA DÙNG${state.lease.granted ? "" : " (không được cấp)"}`
			: `lease: ĐÃ DÙNG ${state.lease.used}/1 lần`;
	const uses = state.lease.log.map((l) => `  • ${l.at}${l.taskId ? ` task ${l.taskId}` : ""} — ${l.note}`).join("\n");
	return [
		`GOAL wrap-up — ${state.status}`,
		`anchor: ${state.anchor}`,
		`epoch: ${state.epoch}/${GOAL_EPOCH_MAX}`,
		leaseLine,
		...(uses ? [uses] : []),
	].join("\n");
}
