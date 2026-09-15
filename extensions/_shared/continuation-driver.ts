/**
 * continuation-driver (v1.4.69 #61/#47 Phase C) — shared pure decision core
 * for the per-kind wake loops (goal / plan / task).
 *
 * Doctrine (user-approved 2026-09-14, task #61): ONE continuation driver,
 * wake-conditions parameterized per kind, budgets counted PER-KIND (never
 * pooled), one turn serves every active kind, anti-spin shared floor.
 *
 * This module is PURE: no timers, no IO — each extension keeps its own
 * counters in its own state (goal-state / plan ledger / task ledger) and
 * calls `decide()`. Wakes themselves stay per-extension (sendUserMessage
 * followUp), preserving the single-waker rule: goal > plan > task; lower
 * kinds yield (subagent-types auto-ping yields to goal+plan via
 * continuationActive()).
 *
 * Parameters (user table, 2026-09-14):
 *  - goal: budget 20 epochs (ladder 5→80s) — unchanged from v1.4.51.
 *  - plan: budget ~12 rounds, co theo remaining steps (max(6, min(12, 2*open))).
 *  - task: budget 10 rounds per open-episode (signature reset when the
 *    in_progress set changes).
 *  - anti-spin: NO_PROGRESS_STOP consecutive wakes with zero progress →
 *    wrap up early (goal keeps its stricter spinning=2 pre-check).
 */
export const KINDS = ["goal", "plan", "task"] as const;
export type Kind = (typeof KINDS)[number];

/** Shared anti-spin floor: 3 wakes with no progress → stop. */
export const NO_PROGRESS_STOP = 3;

/** Shared backoff ladder (seconds) — same shape goal has used since v1.4.51. */
export const BACKOFF_LADDER = [5, 10, 20, 40, 80] as const;

export const GOAL_BUDGET = 20;
export const TASK_BUDGET = 10;
export const PLAN_BUDGET_MAX = 12;
export const PLAN_BUDGET_MIN = 6;

/** Plan budget shrinks with remaining steps: max(6, min(12, 2*open)). */
export function planBudget(openSteps: number): number {
	return Math.max(PLAN_BUDGET_MIN, Math.min(PLAN_BUDGET_MAX, 2 * openSteps));
}

/** Ladder delay for the given consumed-round count (clamped, 1-indexed). */
export function ladderDelaySec(rounds: number): number {
	const i = Math.max(0, Math.min(BACKOFF_LADDER.length - 1, Math.max(0, rounds - 1)));
	return BACKOFF_LADDER[i];
}

export interface KindFacts {
	kind: Kind;
	/** Wake-eligible work exists (goal running, plan bridged with open steps, task in_progress). */
	active: boolean;
	/** Open items — drives the message text and plan-budget shrink. */
	openWork: number;
	/** Rounds consumed so far (persisted per-kind by the owning extension). */
	rounds: number;
	/** Kind budget (goal 20, plan planBudget(open), task 10). */
	budget: number;
	/** Consecutive wakes with zero progress (progressSignature unchanged). */
	noProgressStreak: number;
}

export type ContinuationDecision =
	| { action: "none"; reason: string }
	| { action: "wrapup"; reason: string }
	| { action: "wake"; delaySec: number; reason: string };

/** Pure wake decision shared by every kind. */
export function decide(f: KindFacts): ContinuationDecision {
	if (!f.active) return { action: "none", reason: `${f.kind}: no wake-eligible work` };
	if (f.rounds >= f.budget) {
		return { action: "wrapup", reason: `${f.kind}: budget exhausted (${f.rounds}/${f.budget})` };
	}
	if (f.noProgressStreak >= NO_PROGRESS_STOP) {
		return { action: "wrapup", reason: `${f.kind}: ${f.noProgressStreak} consecutive wakes with no progress` };
	}
	return {
		action: "wake",
		delaySec: ladderDelaySec(f.rounds + 1),
		reason: `${f.kind}: wake round ${f.rounds + 1}/${f.budget}, ${f.openWork} open`,
	};
}

/** Progress bookkeeping: returns the next streak given a signature delta. */
export function nextStreak(prevStreak: number, prevSignature: string, currentSignature: string): number {
	return prevSignature === currentSignature ? prevStreak + 1 : 0;
}

/** True when ANY higher-priority continuation owns main's wake cadence
 *  (goal running, or a bridged plan with open steps) — lower kinds + the
 *  subagent-types auto-ping yield to it. Pure over the given facts. */
export function continuationOwnedByHigherKind(
	goalRunning: boolean,
	planBridgedWithOpenSteps: boolean,
): boolean {
	return goalRunning || planBridgedWithOpenSteps;
}
