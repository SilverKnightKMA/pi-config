/**
 * goal — #37, design locked 2026-09-13 (7 pieces + default lease).
 * Pure module: no pi import, no fs, no network. index.ts does the I/O.
 *
 * Philosophy: a goal = an UNSUPERVISED work session (overnight, 20 self-wake epochs).
 * Everything the model decides on its own has hard limits (epoch cap, 1-use lease)
 * and all of it surfaces in the next morning's wrap-up for the user to inspect.
 */

export const GOAL_EPOCH_MAX = 20;
/** Backoff ladder (seconds) between epochs — ramps up patiently, cap 80s. */
export const GOAL_BACKOFF_LADDER = [5, 10, 20, 40, 80] as const;

export type GoalStatus = "draft" | "running" | "paused" | "done" | "stopped";

export interface LeaseUse {
	at: string;
	taskId?: string;
	note: string;
}

/** Lease (user locked in 13/09): granted by DEFAULT at start; usable at most once;
 *  the model cannot grant it itself; it dies when the goal ends; every use lands in the log + wrap-up. */
export interface GoalLease {
	granted: boolean;
	used: number;
	log: LeaseUse[];
}

/** Scope proposal table for the init phase (draft) — the model drafts it, the user approves. */
export interface GoalProposal {
	/** Anchor describing the DESTINATION AS AN OUTCOME (not a task list). */
	anchor: string;
	/** Task ids proposed INTO scope (empty = every currently open task). */
	includeIds: number[];
	/** Task ids proposed to DROP (only valid when includeIds is empty). */
	excludeIds: number[];
	/** Reason for each choice (shown in the chat table + approval card). */
	rationale: string;
	proposedAt: string;
}

/** A consumed epoch: accounting of task-member creation/completion (guards against self-feeding). */
export interface EpochRec {
	n: number;
	at: string;
	created: number;
	completed: number;
}

export interface GoalState {
	v: 1;
	sessionId: string;
	/** Goal run identifier (g-<sid8>-<ts36>) — task stamps reference back here. */
	goalId: string;
	anchor: string;
	status: GoalStatus;
	/** DRAFT (#v1.4.52): scope proposal table awaiting user approval on the panel.
	 *  The model can only write it via the goal_propose tool — it CANNOT self-start. */
	proposal?: GoalProposal;
	/** Self-wake epochs consumed so far. */
	epoch: number;
	lease: GoalLease;
	/** Snapshot of open task ids at start (membership = snapshot ∪ stamped goalId). */
	memberIds: number[];
	/** Per-epoch accounting (cap GOAL_EPOCH_MAX). */
	epochs: EpochRec[];
	/** Board counters at the last settle (live display counts). */
	board: { members: number; completed: number };
	/** #89: member completions already credited to an epoch record. board.completed
	 *  is a LIVE count (panel display), NOT a credit baseline — using it as the delta
	 *  base made settle() absorb every mid-turn completion, so wakes recorded 0 done
	 *  and long-running goals false-stopped as spinning. */
	credited?: number;
	/** #89: completions not yet attached to an epoch record (credited during the
	 *  current epoch; flushed into the next consumed epoch record by the wake). */
	pendingCompleted?: number;
	createdAt: string;
	updatedAt: string;
	/** Next expected wake (ISO) — written by the driver, display only. */
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

/** The model records the proposal table (only valid while in draft). Pure validation + returns the new state. */
export function setProposal(state: GoalState, p: GoalProposal, now: string): GoalState {
	const trimmed: GoalProposal = {
		anchor: p.anchor.trim().slice(0, 2000),
		includeIds: p.includeIds.filter((x, i) => Number.isInteger(x) && x > 0 && p.includeIds.indexOf(x) === i).slice(0, 500),
		excludeIds: p.excludeIds.filter((x, i) => Number.isInteger(x) && x > 0 && p.excludeIds.indexOf(x) === i).slice(0, 500),
		rationale: p.rationale.trim().slice(0, 4000),
		// #88: never emit an undefined proposedAt (JSON roundtrip would drop the key
		// and sanitize would then reject the whole table) — fall back to the caller's
		// copy, then wall-clock.
		proposedAt: now || p.proposedAt || new Date().toISOString(),
	};
	return { ...state, status: "draft", proposal: trimmed, updatedAt: now };
}

/** User clicks ✓ approve: draft → running, membership LOCKED to the approved table.
 *  openIds is the snapshot of open tasks at confirm time (if includeIds is empty = every open task except excludes). */
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

/** User clicks ↺ revise: back to draft, the old table is cleared (the model re-proposes). */
export function reviseGoal(state: GoalState, now: string): GoalState {
	return { ...state, status: "draft", proposal: undefined, updatedAt: now };
}

/** Minimal task-board record so the goal can see in from outside (reads the projection, does not import the task ext). */
export interface BoardTaskLike {
	id: number;
	status: string;
	goalId?: string;
}

/** Membership: snapshot ∪ tasks stamped with this goalId (tasks born inside the goal ARE members). */
export function memberTasks(state: GoalState, tasks: BoardTaskLike[]): BoardTaskLike[] {
	const snap = new Set(state.memberIds);
	return tasks.filter((t) => snap.has(t.id) || t.goalId === state.goalId);
}

/** Mechanical goal-done: NO open members left (pending/in_progress/parked all count as open). */
export function goalDone(state: GoalState, tasks: BoardTaskLike[]): boolean {
	const open = memberTasks(state, tasks).filter((t) => t.status !== "completed" && t.status !== "cancelled");
	return open.length === 0;
}

/** Epoch accounting from the board delta; returns the new state with the record pushed (cap GOAL_EPOCH_MAX). */
export function recordEpoch(state: GoalState, n: number, at: string, created: number, completed: number): GoalState {
	const rec: EpochRec = { n, at, created: Math.max(0, created), completed: Math.max(0, completed) };
	return { ...state, epochs: [...state.epochs, rec].slice(-GOAL_EPOCH_MAX) };
}

/** Spinning: ≥2 consecutive epochs with 0 tasks completed (creating new tasks does NOT count
 *  as progress). #89: fresh completions credited during the CURRENT epoch sit in
 *  pendingCompleted — if any exist the goal is making progress RIGHT NOW, never stop. */
export function spinning(state: GoalState): boolean {
	const es = state.epochs;
	if ((state.pendingCompleted ?? 0) > 0) return false;
	return es.length >= 2 && es[es.length - 1].completed === 0 && es[es.length - 2].completed === 0;
}

/** #89: Credit freshly-observed member completions (live count vs credited).
 *  Returns a new state with credited/pendingCompleted advanced — call from settle()
 *  AFTER each turn and from the wake BEFORE consuming the next epoch. */
export function creditProgress(state: GoalState, completedNow: number): GoalState {
	const credited = state.credited ?? 0;
	if (completedNow <= credited) return state;
	const delta = completedNow - credited;
	return { ...state, credited: completedNow, pendingCompleted: (state.pendingCompleted ?? 0) + delta };
}

/** #89: Wake-side accounting — credit any last-instant completions, then consume the
 *  next epoch and flush ALL pending completions into its record (they happened during
 *  the epoch that just closed). */
export function wakeAccount(
	state: GoalState,
	completedNow: number,
	createdDelta: number,
	at: string,
): GoalState {
	const creditedState = creditProgress(state, completedNow);
	const consumed = nextEpoch(creditedState, at);
	return recordEpoch(
		{ ...consumed, pendingCompleted: 0 },
		consumed.epoch,
		consumed.updatedAt,
		Math.max(0, createdDelta),
		creditedState.pendingCompleted ?? 0,
	);
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
	// #88 (2026-09-16): the proposal table MUST survive the disk→RAM roundtrip.
	// sanitize used to rebuild the object without `proposal`, so every readGoal()
	// dropped the table while goal-state/<sid>.json still had it on disk —
	// /goal confirm then failed with "draft without a proposal" (user-approved
	// goal stuck in draft), and session_start restart-back-up nagged [goal-init]
	// continue even after the model had proposed. Malformed proposals still drop.
	const proposalRaw = isRecord(raw.proposal) ? raw.proposal : null;
	const proposal: GoalProposal | undefined =
		proposalRaw &&
		typeof proposalRaw.anchor === "string" && proposalRaw.anchor &&
		Array.isArray(proposalRaw.includeIds) && proposalRaw.includeIds.every((x) => typeof x === "number") &&
		Array.isArray(proposalRaw.excludeIds) && proposalRaw.excludeIds.every((x) => typeof x === "number") &&
		typeof proposalRaw.rationale === "string" &&
		typeof proposalRaw.proposedAt === "string"
			? {
				anchor: proposalRaw.anchor,
				includeIds: proposalRaw.includeIds as number[],
				excludeIds: proposalRaw.excludeIds as number[],
				rationale: proposalRaw.rationale,
				proposedAt: proposalRaw.proposedAt,
			}
			: undefined;
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
		...(typeof raw.credited === "number" && raw.credited >= 0 ? { credited: raw.credited } : {}),
		...(typeof raw.pendingCompleted === "number" && raw.pendingCompleted >= 0 ? { pendingCompleted: raw.pendingCompleted } : {}),
		createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
		updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
		...(typeof raw.wakeAt === "string" ? { wakeAt: raw.wakeAt } : {}),
		...(proposal ? { proposal } : {}),
	};
}

/** Driver calls before waking: only wake while still running. */
export function shouldWake(state: GoalState): boolean {
	return state.status === "running";
}

/** Consume 1 epoch after waking. Hitting the cap → done (epochs exhausted). */
export function nextEpoch(state: GoalState, now: string): GoalState {
	const epoch = state.epoch + 1;
	return { ...state, epoch, status: epoch >= GOAL_EPOCH_MAX ? "done" : state.status, updatedAt: now };
}

/** Backoff after epoch n (0-based) — seconds, capped at the end of the ladder. */
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

/** Use the lease — the only appeal path for an unsupervised session.
 *  Once per goal, only while still granted, only while the goal has not ended. */
export function useLease(state: GoalState, note: string, now: string, taskId?: string): LeaseResult {
	if (!state.lease.granted) return { ok: false, reason: "lease not granted for this goal" };
	if (state.lease.used >= 1) return { ok: false, reason: "lease already used 1/1 times — blocked like plan-strict" };
	if (state.status === "done" || state.status === "stopped") {
		return { ok: false, reason: `goal already ${state.status} — the lease dies with the goal` };
	}
	const entry: LeaseUse = { at: now, ...(taskId ? { taskId } : {}), note: note.slice(0, 400) };
	return {
		ok: true,
		state: { ...state, lease: { ...state.lease, used: 1, log: [...state.lease.log, entry] }, updatedAt: now },
	};
}

/** Next-morning report — the lease ALWAYS surfaces; tear open the envelope and it is right there. */
export function wrapUpReport(state: GoalState): string {
	const leaseLine =
		state.lease.used === 0
			? `lease: NOT USED YET${state.lease.granted ? "" : " (not granted)"}`
			: `lease: USED ${state.lease.used}/1 times`;
	const uses = state.lease.log.map((l) => `  • ${l.at}${l.taskId ? ` task ${l.taskId}` : ""} — ${l.note}`).join("\n");
	const created = state.epochs.reduce((s, e) => s + e.created, 0);
	const done = state.epochs.reduce((s, e) => s + e.completed, 0);
	const tail = state.epochs.slice(-5).map((e) => `  ep${e.n}: +${e.created} created / ${e.completed} done`).join("\n");
	return [
		`GOAL wrap-up — ${state.status}`,
		`anchor: ${state.anchor}`,
		`epoch: ${state.epoch}/${GOAL_EPOCH_MAX} · tasks: ${created} created / ${done} done / ${state.board.members} members`,
		...(state.memberIds.length > 0 ? [`snapshot: #${state.memberIds.slice(0, 30).join(" #")}${state.memberIds.length > 30 ? " …" : ""}`] : []),
		...(tail ? [tail] : []),
		leaseLine,
		...(uses ? [uses] : []),
	].join("\n");
}
