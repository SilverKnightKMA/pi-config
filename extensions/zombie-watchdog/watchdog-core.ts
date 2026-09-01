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
