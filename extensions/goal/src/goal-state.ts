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

export type GoalStatus = "draft" | "running" | "paused" | "done" | "stopped";

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

/** Bảng đề xuất scope cho pha init (draft) — model soạn, user duyệt. */
export interface GoalProposal {
	/** Anchor tả ĐÍCH BẰNG KẾT QUẢ (không phải danh sách task). */
	anchor: string;
	/** Task id đề xuất VÀO scope (rỗng = mọi task đang mở). */
	includeIds: number[];
	/** Task id đề xuất BỎ (chỉ hợp lệ khi includeIds rỗng). */
	excludeIds: number[];
	/** Lý do từng lựa chọn (hiện trong bảng chat + card duyệt). */
	rationale: string;
	proposedAt: string;
}

/** Một epoch đã tiêu: kế toán tạo/hoàn thành task-member (chống self-feeding). */
export interface EpochRec {
	n: number;
	at: string;
	created: number;
	completed: number;
}

export interface GoalState {
	v: 1;
	sessionId: string;
	/** Id định danh goal run (g-<sid8>-<ts36>) — task stamp tham chiếu về đây. */
	goalId: string;
	anchor: string;
	status: GoalStatus;
	/** DRAFT (#v1.4.52): bảng đề xuất scope chờ user duyệt trên panel.
	 *  Model chỉ ghi được qua tool goal_propose — KHÔNG tự start được. */
	proposal?: GoalProposal;
	/** Số epoch tự đánh thức đã tiêu. */
	epoch: number;
	lease: GoalLease;
	/** Snapshot id các task mở lúc start (membership = snapshot ∪ stamped goalId). */
	memberIds: number[];
	/** Kế toán từng epoch (cap GOAL_EPOCH_MAX). */
	epochs: EpochRec[];
	/** Bộ đếm board lần settle gần nhất (chuẩn để tính delta tạo/xong). */
	board: { members: number; completed: number };
	createdAt: string;
	updatedAt: string;
	/** Epoch tiếp theo dự kiến đánh thức (ISO) — driver ghi, chỉ để hiển thị. */
	wakeAt?: string;
}

export type LeaseResult = { ok: true; state: GoalState } | { ok: false; reason: string };

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

export function makeGoalId(sessionId: string, now: string): string {
	const sid8 = sessionId.replace(/-/g, "").slice(0, 8);
	const ts = Date.parse(now);
	return `g-${sid8}-${Number.isFinite(ts) ? ts : Date.now()}`;
}

export function startGoal(
	sessionId: string,
	anchor: string,
	now: string,
	opts: { lease?: boolean; memberIds?: number[]; status?: "draft" | "running" } = {},
): GoalState {
	return {
		v: 1,
		sessionId,
		goalId: makeGoalId(sessionId, now),
		anchor: anchor.slice(0, 2000),
		status: opts.status ?? "draft",
		epoch: 0,
		lease: { granted: opts.lease !== false, used: 0, log: [] },
		memberIds: (opts.memberIds ?? []).slice(0, 500),
		epochs: [],
		board: { members: (opts.memberIds ?? []).length, completed: 0 },
		createdAt: now,
		updatedAt: now,
	};
}

/** Model ghi bảng đề xuất (chỉ hợp lệ khi draft). Pure validation + return state mới. */
export function setProposal(state: GoalState, p: GoalProposal, now: string): GoalState {
	const trimmed: GoalProposal = {
		anchor: p.anchor.trim().slice(0, 2000),
		includeIds: p.includeIds.filter((x, i) => Number.isInteger(x) && x > 0 && p.includeIds.indexOf(x) === i).slice(0, 500),
		excludeIds: p.excludeIds.filter((x, i) => Number.isInteger(x) && x > 0 && p.excludeIds.indexOf(x) === i).slice(0, 500),
		rationale: p.rationale.trim().slice(0, 4000),
		proposedAt: now,
	};
	return { ...state, status: "draft", proposal: trimmed, updatedAt: now };
}

/** User bấm ✓ duyệt: draft → running, membership KHÓA theo bảng đã duyệt.
 *  openIds là snapshot task mở tại lúc confirm (nếu includeIds rỗng = mọi task mở trừ exclude). */
export function confirmGoal(state: GoalState, openIds: number[], now: string): GoalState {
	const p = state.proposal;
	const memberIds = p && p.includeIds.length > 0
		? p.includeIds.filter((id) => openIds.includes(id))
		: openIds.filter((id) => !(p?.excludeIds ?? []).includes(id));
	return {
		...state,
		status: "running",
		anchor: p?.anchor?.trim() || state.anchor,
		memberIds: memberIds.slice(0, 500),
		board: { members: memberIds.length, completed: 0 },
		epoch: 0,
		epochs: [],
		proposal: undefined,
		updatedAt: now,
	};
}

/** User bấm ↺ sửa lại: về draft, xóa bảng cũ (model đề xuất lại). */
export function reviseGoal(state: GoalState, now: string): GoalState {
	return { ...state, status: "draft", proposal: undefined, updatedAt: now };
}

/** Task-board record tối thiểu để goal nhìn từ ngoài (đọc projection, không import task ext). */
export interface BoardTaskLike {
	id: number;
	status: string;
	goalId?: string;
}

/** Membership: snapshot ∪ task stamp goalId này (task sinh trong goal LÀ thành viên). */
export function memberTasks(state: GoalState, tasks: BoardTaskLike[]): BoardTaskLike[] {
	const snap = new Set(state.memberIds);
	return tasks.filter((t) => snap.has(t.id) || t.goalId === state.goalId);
}

/** Goal-done cơ khí: KHÔNG còn member nào mở (pending/in_progress/parked đều là mở). */
export function goalDone(state: GoalState, tasks: BoardTaskLike[]): boolean {
	const open = memberTasks(state, tasks).filter((t) => t.status !== "completed" && t.status !== "cancelled");
	return open.length === 0;
}

/** Kế toán epoch từ delta board; trả state mới đã push record (cap GOAL_EPOCH_MAX). */
export function recordEpoch(state: GoalState, n: number, at: string, created: number, completed: number): GoalState {
	const rec: EpochRec = { n, at, created: Math.max(0, created), completed: Math.max(0, completed) };
	return { ...state, epochs: [...state.epochs, rec].slice(-GOAL_EPOCH_MAX) };
}

/** Spinning: ≥2 epoch liền mà 0 task hoàn thành (tạo task mới KHÔNG tính tiến độ). */
export function spinning(state: GoalState): boolean {
	const es = state.epochs;
	return es.length >= 2 && es[es.length - 1].completed === 0 && es[es.length - 2].completed === 0;
}

export function sanitizeGoalState(raw: unknown): GoalState | null {
	if (!isRecord(raw)) return null;
	if (raw.v !== 1 || typeof raw.sessionId !== "string" || !raw.sessionId) return null;
	if (typeof raw.anchor !== "string" || !raw.anchor) return null;
	const status = raw.status;
	if (typeof status !== "string" || !["draft", "running", "paused", "done", "stopped"].includes(status)) return null;
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
	const memberIds = Array.isArray(raw.memberIds)
		? raw.memberIds.filter((x): x is number => typeof x === "number").slice(0, 500)
		: [];
	const epochs = Array.isArray(raw.epochs)
		? raw.epochs.filter(
				(e): e is EpochRec =>
					isRecord(e) && typeof e.n === "number" && typeof e.at === "string" &&
					typeof e.created === "number" && typeof e.completed === "number",
			).slice(0, GOAL_EPOCH_MAX)
		: [];
	const boardRaw = isRecord(raw.board) ? raw.board : {};
	return {
		v: 1,
		sessionId: raw.sessionId,
		goalId: typeof raw.goalId === "string" && raw.goalId.startsWith("g-") ? raw.goalId : makeGoalId(raw.sessionId, typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString()),
		anchor: raw.anchor,
		status: status as GoalStatus,
		epoch: Math.min(epoch, GOAL_EPOCH_MAX),
		lease: {
			granted: leaseRaw.granted !== false,
			used: typeof leaseRaw.used === "number" && leaseRaw.used > 0 ? 1 : 0,
			log: log.slice(-8),
		},
		memberIds,
		epochs,
		board: {
			members: typeof boardRaw.members === "number" ? boardRaw.members : memberIds.length,
			completed: typeof boardRaw.completed === "number" ? boardRaw.completed : 0,
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
	const created = state.epochs.reduce((s, e) => s + e.created, 0);
	const done = state.epochs.reduce((s, e) => s + e.completed, 0);
	const tail = state.epochs.slice(-5).map((e) => `  ep${e.n}: +${e.created} tạo / ${e.completed} xong`).join("\n");
	return [
		`GOAL wrap-up — ${state.status}`,
		`anchor: ${state.anchor}`,
		`epoch: ${state.epoch}/${GOAL_EPOCH_MAX} · task: ${created} tạo / ${done} xong / ${state.board.members} member`,
		...(state.memberIds.length > 0 ? [`snapshot: #${state.memberIds.slice(0, 30).join(" #")}${state.memberIds.length > 30 ? " …" : ""}`] : []),
		...(tail ? [tail] : []),
		leaseLine,
		...(uses ? [uses] : []),
	].join("\n");
}
