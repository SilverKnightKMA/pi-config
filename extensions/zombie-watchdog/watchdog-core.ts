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
