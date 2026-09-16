/**
 * Pure state machine for the zombie-turn watchdog — no pi imports, fully testable.
 *
 * Model: a turn is ALIVE whenever ledger-worthy activity keeps happening
 * (message streaming, tool executions, prompt events). A turn is a suspected
 * ZOMBIE when it is marked active but has been idle for `stallMs` with no tool
 * in flight — that is the signature of a silently-dead request
 * (getpaseo/paseo#3845/#3847 family: completion wake lost, spinner runs forever,
 * no error banner). Long tools are NOT zombies: they legitimately stay quiet
 * for minutes, so they only get a soft notice after `toolStallMs`.
 */

export interface WatchdogConfig {
	/** Idle (no activity, no tool in flight) after which a turn is a suspected zombie. */
	stallMs: number;
	/** Idle while a tool is in flight after which we softly note it (long tools are normal). */
	toolStallMs: number;
	/** While a zombie persists, re-warn every this many ms. */
	reNotifyMs: number;
}

export const DEFAULT_CONFIG: WatchdogConfig = {
	stallMs: 120_000,
	toolStallMs: 600_000,
	reNotifyMs: 300_000,
};

export type SignalCode = "zombie" | "zombie-repeat" | "tool-stall";

export interface WatchdogSignal {
	code: SignalCode;
	idleMs: number;
	toolDepth: number;
}

export class TurnWatchdog {
	private cfg: WatchdogConfig;
	private turnActive = false;
	private lastActivityAt = 0;
	private toolDepth = 0;
	private zombieNotified = false;
	private toolStallNotified = false;
	private lastNotifyAt = 0;

	constructor(cfg: Partial<WatchdogConfig> = {}) {
		this.cfg = { ...DEFAULT_CONFIG, ...cfg };
	}

	get active(): boolean {
		return this.turnActive;
	}

	get toolsInFlight(): number {
		return this.toolDepth;
	}

	onTurnStart(at: number): void {
		this.turnActive = true;
		this.lastActivityAt = at;
		this.resetFlags();
	}

	onTurnEnd(at: number): void {
		this.turnActive = false;
		this.lastActivityAt = at;
		this.resetFlags();
	}

	/** Any streaming/prompt activity proves the turn is alive and clears suspicion. */
	onActivity(at: number): void {
		this.lastActivityAt = at;
		this.resetFlags();
	}

	onToolStart(at: number): void {
		this.toolDepth += 1;
		this.lastActivityAt = at;
		this.resetFlags();
	}

	onToolEnd(at: number): void {
		this.toolDepth = Math.max(0, this.toolDepth - 1);
		this.lastActivityAt = at;
		this.resetFlags();
	}

	private resetFlags(): void {
		this.zombieNotified = false;
		this.toolStallNotified = false;
		this.lastNotifyAt = 0;
	}

	/** Poll: returns a signal when something should be surfaced, else null. */
	tick(at: number): WatchdogSignal | null {
		if (!this.turnActive) return null;
		const idle = at - this.lastActivityAt;

		if (this.toolDepth > 0) {
			if (idle >= this.cfg.toolStallMs && !this.toolStallNotified) {
				this.toolStallNotified = true;
				this.lastNotifyAt = at;
				return { code: "tool-stall", idleMs: idle, toolDepth: this.toolDepth };
			}
			return null;
		}

		if (idle >= this.cfg.stallMs) {
			if (!this.zombieNotified) {
				this.zombieNotified = true;
				this.lastNotifyAt = at;
				return { code: "zombie", idleMs: idle, toolDepth: 0 };
			}
			if (at - this.lastNotifyAt >= this.cfg.reNotifyMs) {
				this.lastNotifyAt = at;
				return { code: "zombie-repeat", idleMs: idle, toolDepth: 0 };
			}
		}
		return null;
	}
}

// ---------------------------------------------------------------------------
// Settle-watch (v2, 2026-09-01): detects daemon-side settle-loss (shape B2).
//
// The in-process watchdog above cannot see B2: the turn completes cleanly
// inside the pi process (message_end + turn_end fire, ledger persisted), but
// the daemon never receives the completion wake and keeps reporting "running"
// — spinner spins forever. Verified live twice on 2026-09-01 (23:26 my own
// agent cf76ad71; 23:49 chat agent a0e1eec5, 4 minutes, watchdog v1 silent).
// Settle-watch crosses the boundary: after in-process turn_end it polls the
// daemon's view of OUR agent. Still busy on two consecutive checks while we
// know we finished → B2 zombie.
// ---------------------------------------------------------------------------

export interface SettleConfig {
	/** Delay after turn_end before the first daemon check. */
	firstCheckMs: number;
	/** Delay of the second (confirming) check. */
	secondCheckMs: number;
}

export const DEFAULT_SETTLE_CONFIG: SettleConfig = {
	firstCheckMs: 20_000,
	secondCheckMs: 45_000,
};

export class SettleWatch {
	private cfg: SettleConfig;
	private turnEndedAt: number | null = null;
	private firstBusyAt: number | null = null;
	private reported = false;

	constructor(cfg: Partial<SettleConfig> = {}) {
		this.cfg = { ...DEFAULT_SETTLE_CONFIG, ...cfg };
	}

	get watching(): boolean {
		return this.turnEndedAt !== null && !this.reported;
	}

	/** A new turn starting legitimately cancels the watch (daemon running is correct then). */
	onTurnStart(): void {
		this.turnEndedAt = null;
		this.reset();
	}

	onTurnEnd(at: number): void {
		this.reset();
		this.turnEndedAt = at;
	}

	/** Should the caller poll the daemon right now? Returns delay hints. */
	dueCheck(at: number): "first" | "second" | null {
		if (this.turnEndedAt === null || this.reported) return null;
		const since = at - this.turnEndedAt;
		if (this.firstBusyAt === null) {
			return since >= this.cfg.firstCheckMs && since < this.cfg.secondCheckMs ? "first" : null;
		}
		return since >= this.cfg.secondCheckMs ? "second" : null;
	}

	/** Feed one daemon status observation (busy = daemon says running/initializing). */
	onPoll(at: number, busy: boolean): "b2-settle-lost" | null {
		if (this.turnEndedAt === null || this.reported) return null;
		if (this.dueCheck(at) === null) return null;
		if (busy) {
			if (this.firstBusyAt === null) {
				this.firstBusyAt = at; // suspicious, wait for the confirming check
				return null;
			}
			this.reported = true;
			return "b2-settle-lost"; // busy on BOTH checks while we are done in-process
		}
		this.reset(); // daemon settled: all good
		return null;
	}

	private reset(): void {
		this.firstBusyAt = null;
		this.reported = false;
	}
}

// ---------------------------------------------------------------------------
// v1.4.92 (#107) — 4-port from the 2026-09-16 watchdog landscape brief:
//  A. TerminationLedger  — @mporenta/pi-claude-code (MIT): terminationReason
//     taxonomy + idempotent completion funnel + run ledger with recovered:true
//  B. LoopDetector       — Cline loop-detection.ts (Apache-2.0): canonical
//     tool-call signature (sorted keys, IGNORED_PARAMS stripped) + 2-tier
//     soft=3 warn / hard=5 escalate
//  C. isSyntheticMessage — opencode-auto-continue: watchdog's own messages
//     must never feed the watchdog (anti-watchdog-of-watchdog)
//  D. evidenceFor        — codex-task-watchdog: absence-only evidence is NOT
//     confirmed failure and does not license an interrupt until re-confirmed
// ---------------------------------------------------------------------------

/** A. Termination reasons — every watched turn converges to exactly ONE. */
export type TerminationReason = "completed" | "stall-stopped" | "stopped-error" | "shutdown" | "crash-recovered";

export interface RunRecord {
	turnId: string;
	sessionFile?: string;
	startedAt: string;
	endedAt?: string;
	reason?: TerminationReason;
	/** Set when the extension reloads and finds this turn was never finalized. */
	recovered?: boolean;
	detections: string[];
}

/** Deterministic canonical stringify: recursively sorted keys. */
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`);
		return `{${entries.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

/**
 * B. Cline-style signature: tool name + canonical args with volatile params
 * stripped. `task_progress`-style metadata changes every update even when the
 * user-visible args are identical — sorting + stripping makes repeated calls
 * with cosmetic differences compare equal (Cline IGNORED_PARAMS).
 */
export const IGNORED_TOOL_PARAMS = new Set(["task_progress", "onUpdate", "on_update", "progress", "_seq", "requestId"]);

export function toolCallSignature(toolName: string, args: unknown): string {
	const filtered: Record<string, unknown> = {};
	if (args && typeof args === "object" && !Array.isArray(args)) {
		for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
			if (!IGNORED_TOOL_PARAMS.has(k)) filtered[k] = v;
		}
	}
	return `${toolName}(${canonical(filtered)})`;
}

export interface LoopConfig {
	/** Identical consecutive tool calls after which we softly warn (model may still self-correct; ui-only by default). */
	soft: number;
	/** Identical consecutive tool calls after which we escalate to the zombie class (auto-stop eligible). */
	hard: number;
}

export const DEFAULT_LOOP_CONFIG: LoopConfig = { soft: 3, hard: 5 };

export interface LoopTier {
	tier: "soft" | "hard" | null;
	count: number;
	signature: string;
}

/** Consecutive-identical tool-call detector (Cline semantics: any different
 *  signature or turn boundary resets the count). */
export class LoopDetector {
	private cfg: LoopConfig;
	private last: string | null = null;
	private count = 0;

	constructor(cfg: Partial<LoopConfig> = {}) {
		this.cfg = { ...DEFAULT_LOOP_CONFIG, ...cfg };
	}

	onToolStart(toolName: string, args: unknown): LoopTier {
		const signature = toolCallSignature(toolName, args);
		if (signature === this.last) {
			this.count += 1;
		} else {
			this.last = signature;
			this.count = 1;
		}
		// Tiers fire AT the crossing (Cline: warn at 3, escalate at 5) — not on
		// every subsequent identical call.
		const tier = this.count === this.cfg.hard ? "hard" : this.count === this.cfg.soft ? "soft" : null;
		return { tier, count: this.count, signature };
	}

	onTurnBoundary(): void {
		this.last = null;
		this.count = 0;
	}
}

/** C. Synthetic flag: messages emitted by this watchdog carry customType
 *  "zw-*"; their message events must not reset the zombie clock — a kick that
 *  resets the clock would mask the very stall it answered (anti-self-count,
 *  opencode-auto-continue architecture). */
export function isSyntheticMessage(message: unknown): boolean {
	const ct = (message as { customType?: unknown } | null | undefined)?.customType;
	return typeof ct === "string" && ct.startsWith("zw-");
}

/** D. codex-task-watchdog principle: classify the evidence class of a
 *  detection. ABSENCE-only (quiet) is not proof of death; POSITIVE
 *  contradiction (daemon busy while in-process ended — B2) is. An interrupt
 *  (STOP) is licensed only when safeToInterrupt. */
export interface Evidence {
	confirmedFailure: boolean;
	safeToInterrupt: boolean;
	note: string;
}

export function evidenceFor(code: string, opts: { repeated?: boolean; absenceGuard?: boolean } = {}): Evidence {
	const guard = opts.absenceGuard !== false; // ZW_ABSENCE_GUARD=0 restores v1 immediacy
	switch (code) {
		case "b2-settle-lost":
			return {
				confirmedFailure: true,
				safeToInterrupt: true,
				note: "positive contradiction: daemon busy on both checks while the turn ended in-process (verified 2026-09-01)",
			};
		case "loop-hard":
			return {
				confirmedFailure: true,
				safeToInterrupt: true,
				note: "positive evidence: identical canonical tool call observed hard-threshold times consecutively",
			};
		case "zombie":
			if (!guard) return { confirmedFailure: false, safeToInterrupt: true, note: "absence guard disabled (ZW_ABSENCE_GUARD=0)" };
			return {
				confirmedFailure: false,
				safeToInterrupt: false,
				note: "absence-only: no activity for stallMs proves nothing — watching for repeat before STOP",
			};
		case "zombie-repeat":
			if (!guard) return { confirmedFailure: false, safeToInterrupt: true, note: "absence guard disabled (ZW_ABSENCE_GUARD=0)" };
			return {
				confirmedFailure: false,
				safeToInterrupt: true,
				note: "repeat absence after reNotifyMs — second silent window licenses STOP",
			};
		default:
			return { confirmedFailure: false, safeToInterrupt: false, note: "not an interrupt class" };
	}
}
