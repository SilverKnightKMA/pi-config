/**
 * task ⇄ plan file-bridge (v1.4.68 #47 Phase B).
 * The task ext does NOT import the plan ext — the plan engine writes a
 * bridge request into ~/.pi/agent/plan-bridge/<sessionId>.json when the user
 * APPROVES a plan (status "tracking") or drops it (status "off"); this ext
 * consumes it:
 *  - "tracking": one step-task per plan step, strict + judgment-verified —
 *    registration and verification reuse the TASK machinery (evidence →
 *    probes → judge → held). Idempotent by planId+stepIndex.
 *  - "off": still-open step-tasks of that plan are cancelled.
 * Pure readers/sanitizers pinned by plan-bridge.test.ts; the wiring lives in
 * index.ts (same shape as the goal-lease consume in goal-bridge.ts).
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createTask, updateTask } from "./graph.ts";
import type { TaskState } from "./types.ts";

export interface PlanBridgeStep {
	index: number;
	text: string;
	/** v1.4.77 (#86): optional backward step-index refs from an "(after N)"
	 *  marker — wired to task blockedBy below. Never forced. */
	dependsOn?: number[];
}

export interface PlanBridgePayload {
	v: 1;
	sessionId: string;
	/** `p-<sessionId>-<base36>` — matches the plan state stamp (graph.ts sanitize pins the prefix). */
	planId: string;
	status: "tracking" | "off";
	planFile?: string;
	steps: PlanBridgeStep[];
	consumedAt?: string;
}

function home(): string {
	return process.env.HOME ?? homedir();
}

export function planBridgePath(sessionId: string): string {
	return join(home(), ".pi", "agent", "plan-bridge", `${sessionId}.json`);
}

export function sanitizePlanBridge(raw: unknown): PlanBridgePayload | null {
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as Record<string, unknown>;
	if (r.v !== 1) return null;
	if (typeof r.sessionId !== "string" || !r.sessionId) return null;
	if (typeof r.planId !== "string" || !r.planId.startsWith("p-")) return null;
	if (r.status !== "tracking" && r.status !== "off") return null;
	const steps: PlanBridgeStep[] = [];
	if (Array.isArray(r.steps)) {
		for (const s of r.steps.slice(0, 40)) {
			if (typeof s !== "object" || s === null) continue;
			const step = s as Record<string, unknown>;
			if (typeof step.index !== "number" || !Number.isInteger(step.index) || step.index < 1) continue;
			if (typeof step.text !== "string" || !step.text.trim()) continue;
			const stepIndex = step.index; // TS: typeof-narrowing doesn't survive closures
			// #86: backward refs only (< own index); self/dup/forward drop silently.
			let dependsOn: number[] | undefined;
			if (Array.isArray(step.dependsOn)) {
				const refs = [...new Set(step.dependsOn.filter((n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 1 && n < stepIndex))].sort((a, b) => a - b);
				if (refs.length > 0) dependsOn = refs;
			}
			steps.push({ index: step.index, text: step.text.slice(0, 200), ...(dependsOn ? { dependsOn } : {}) });
		}
	}
	if (r.status === "tracking" && steps.length === 0) return null;
	return {
		v: 1,
		sessionId: r.sessionId,
		planId: r.planId,
		status: r.status,
		...(typeof r.planFile === "string" && r.planFile ? { planFile: r.planFile } : {}),
		steps,
		...(typeof r.consumedAt === "string" ? { consumedAt: r.consumedAt } : {}),
	};
}

export function readPlanBridge(sessionId: string): PlanBridgePayload | null {
	try {
		return sanitizePlanBridge(JSON.parse(readFileSync(planBridgePath(sessionId), "utf8")));
	} catch {
		return null;
	}
}

/** Ack: stamp consumedAt so the watcher never double-consumes (mirror control-file ackAt). */
export function ackPlanBridge(payload: PlanBridgePayload): void {
	try {
		const file = planBridgePath(payload.sessionId);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, JSON.stringify({ ...payload, consumedAt: new Date().toISOString() }, null, 2));
	} catch {
		// ack is best-effort — consume is idempotent anyway (planId+stepIndex)
	}
}

/** Pure consume: tracking → one strict judgment step-task per missing step
 *  (idempotent by planId+stepIndex); off → cancel still-open step-tasks.
 *  Pinned by plan-bridge.test.ts — index.ts only wires file IO around it. */
export function applyPlanBridge(state: TaskState, payload: PlanBridgePayload, now: number): TaskState {
	let next = state;
	if (payload.status === "tracking") {
		const total = payload.steps.length;
	const existing = new Set(
			next.tasks
				.filter((t: { planId?: string; stepIndex?: number }) => t.planId === payload.planId && typeof t.stepIndex === "number")
				.map((t: { stepIndex?: number }) => t.stepIndex),
		);
		for (const step of payload.steps) {
			if (existing.has(step.index)) continue;
			const result = createTask(
				next,
				`[plan ${step.index}/${total}] ${step.text}`,
				`Plan step ${step.index}/${total}${payload.planFile ? ` of ${payload.planFile}` : ""}. Complete via task_update with real evidence — the judge verifies every completion; the plan auto-closes only when every step-task is verified-complete.`,
				[],
				now,
				{ lane: "judgment", probes: [], strict: true },
				undefined,
				payload.planId,
				step.index,
			);
			if (!result.error) next = result.state;
		}
		// #86: wire optional dependencies — step index → task id → blockedBy.
		// Idempotent (re-consume re-derives the same edges); cycles impossible
		// because sanitize keeps backward refs only.
		const idByIndex = new Map<number, number>();
		for (const t of next.tasks) {
			if (t.planId === payload.planId && typeof t.stepIndex === "number") idByIndex.set(t.stepIndex, t.id);
		}
		for (const step of payload.steps) {
			if (!step.dependsOn || step.dependsOn.length === 0) continue;
			const id = idByIndex.get(step.index);
			if (typeof id !== "number") continue;
			const blockedBy = [...new Set(step.dependsOn.map((n) => idByIndex.get(n)).filter((b): b is number => typeof b === "number"))];
			if (blockedBy.length === 0) continue;
			const t = next.tasks.find((x) => x.id === id);
			if (t && JSON.stringify(t.blockedBy ?? []) === JSON.stringify(blockedBy)) continue;
			const result = updateTask(next, id, { blockedBy }, now);
			if (!result.error) next = result.state;
		}
	} else {
		for (const t of next.tasks) {
			if (t.planId !== payload.planId) continue;
			if (t.status === "completed" || t.status === "cancelled") continue;
			const result = updateTask(next, t.id, { status: "cancelled" }, now);
			if (!result.error) next = result.state;
		}
	}
	return next;
}
