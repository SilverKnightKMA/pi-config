/**
 * Unattended-mode detection + interactive ban (#103, v1.4.90).
 *
 * Doctrine (user-approved 2026-09-16, "A + lifecycle"): from activation to
 * self-dissolution a goal/plan session runs wake-driven WITHOUT a human at
 * the keyboard — interactive tools (ask_user_question, quiz) would hang it
 * indefinitely (research brief learn/interactive-ban-research-2026-09-16.md:
 * 121 interactive calls during goal/plan runs, worst observed stall 50.3
 * minutes). This module is the single source of truth for that window:
 *
 *  - goalWakeActive / planWakeActive — the WAKE window (moved from
 *    subagent-types v1.4.51/69; auto-ping single-waker uses these; quiescent
 *    plans have disarmed their wake loop and are exempt).
 *  - unattendedWindow — the BAN window (broader): ANY running goal (any
 *    session) and plans in tracking mode INCLUDING quiescent ones — the plan
 *    door is still open, so the session is unattended until /plan off or
 *    auto-close. Draft/awaiting plan modes are interactive drafting with the
 *    user PRESENT — asking questions then is legitimate and stays allowed.
 *
 * Escape hatches (user-owned, never model-owned): the user pauses the goal
 * (/goal pause) or closes the plan (/plan off); INTERACTIVE_BAN=0 disables
 * the ban outright (test/break-glass env, like PLAN_TASK_BRIDGE=0). Decisions
 * that arise mid-run go through the decision-pair (task awaitsDecision:true
 * parks an [AWAITING-USER-DECISION] stage for the user) — never a workaround.
 *
 * Pure filesystem reads only — deterministic, model-free, no pi imports.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** v1.4.51: is any goal run currently running (reads the goal-state dir —
 *  file bridge, no goal ext import). Auto-ping yields to goal wake. */
export function goalWakeActive(dir?: string): boolean {
	const d = dir ?? join(process.env.HOME ?? homedir(), ".pi", "agent", "goal-state");
	try {
		for (const f of readdirSync(d)) {
			if (!f.endsWith(".json")) continue;
			try {
				const st = JSON.parse(readFileSync(join(d, f), "utf8")) as { status?: unknown };
				if (st?.status === "running") return true;
			} catch {
				// junk file — skip
			}
		}
	} catch {
		// no dir — no goal
	}
	return false;
}

/** v1.4.69 (#61 Phase C): is any bridged plan still waking (mode tracking +
 *  planId + steps remaining — reads the plan ext's status projections).
 *  Auto-ping yields to the plan continuation loop too (single-waker priority:
 *  goal > plan > task). */
export function planWakeActive(dir?: string): boolean {
	const d = dir ?? join(process.env.HOME ?? homedir(), ".pi", "agent", "plan-control");
	try {
		for (const f of readdirSync(d)) {
			if (!f.endsWith(".status.json")) continue;
			try {
				const st = JSON.parse(readFileSync(join(d, f), "utf8")) as { mode?: unknown; planId?: unknown; stepsDone?: unknown; stepsTotal?: unknown; quiescent?: unknown };
				if (st?.mode !== "tracking" || typeof st?.planId !== "string" || !st.planId.startsWith("p-")) continue;
				// v1.4.77 (#80): quiescent plans (only parked/blocked steps) have
				// disarmed their wake loop — the task auto-ping owns the cadence
				// instead, else a reopen would have NO waker at all.
				if (st?.quiescent === true) continue;
				const done = typeof st?.stepsDone === "number" ? (st.stepsDone as number) : 0;
				const total = typeof st?.stepsTotal === "number" ? (st.stepsTotal as number) : 0;
				if (total > 0 && done < total) return true;
			} catch {
				// junk file — skip
			}
		}
	} catch {
		// no dir — no plan
	}
	return false;
}

export interface UnattendedWindow {
	active: boolean;
	kind: "goal" | "plan" | null;
}

/** The interactive-ban window (#103). Broader than the wake window: a
 *  quiescent tracking plan still leaves the session unattended (door open,
 *  steps parked — the user answers on return). Directory overrides keep
 *  tests hermetic; INTERACTIVE_BAN=0 disables (#103 break-glass env). */
export function unattendedWindow(goalDir?: string, planDir?: string): UnattendedWindow {
	if (process.env.INTERACTIVE_BAN === "0") return { active: false, kind: null };
	const g = goalDir ?? process.env.UNATTENDED_GOAL_DIR ?? join(process.env.HOME ?? homedir(), ".pi", "agent", "goal-state");
	if (goalWakeActive(g)) return { active: true, kind: "goal" };
	const p = planDir ?? process.env.UNATTENDED_PLAN_DIR ?? join(process.env.HOME ?? homedir(), ".pi", "agent", "plan-control");
	try {
		for (const f of readdirSync(p)) {
			if (!f.endsWith(".status.json")) continue;
			try {
				const st = JSON.parse(readFileSync(join(p, f), "utf8")) as { mode?: unknown; planId?: unknown };
				if (st?.mode === "tracking" && typeof st?.planId === "string" && st.planId.startsWith("p-")) {
					return { active: true, kind: "plan" };
				}
			} catch {
				// junk file — skip
			}
		}
	} catch {
		// no dir — no plan
	}
	return { active: false, kind: null };
}

/** #43-style denial envelope for the refused interactive call. Shared by
 *  ask_user_question and quiz so the model reads one consistent contract. */
export function interactiveBanText(tool: string, kind: "goal" | "plan"): string {
	const which = kind === "goal" ? "a goal is running" : "a plan session is tracking steps";
	return [
		`${tool} refused — unattended mode (#103).`,
		"",
		`WHAT: this session is running a goal/plan continuation (${which}); the user is not at the keyboard and this call would hang the session indefinitely.`,
		"WHY: goal/plan runs are wake-driven, self-terminating cycles (done / deferred / budget exhausted); between activation and dissolution the session must stay non-interactive (2026-09-16 research: worst observed stall 50.3 min).",
		"NEXT: record the decision instead — task_create the decision task with awaitsDecision:true so the paired [AWAITING-USER-DECISION] stage parks it for the user to answer on return; continue with work that does not depend on the answer. If the human is present and a live question is truly required, the USER pauses the goal (/goal pause) or closes the plan (/plan off) — never work around the ban yourself.",
	].join("\n");
}
