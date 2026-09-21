/**
 * Plan mode — daemon port of the valuable third of @pify/plan-mode@0.4.2
 * (eval 2026-09-09, brief pify-planmode-eval-2026-09-09.md), folded INTO
 * read-only-mode because plan mode IS read-only plus one blessed file.
 *
 * Ported (HIGH per the eval):
 *  - plan file .pi/plans/YYYY-MM-DD-<slug>.md, written ONLY through the
 *    write_plan tool (extension-owned fs — no write tool ever unblocked)
 *  - parseSteps: top-level numbered/bulleted lines only, ≤40 steps, ≤200 chars
 *  - plan_step_done(index, evidence) cursor after approval
 *  - full-snapshot persistence in the session ledger; replay on respawn
 *  - /plan list | open — the plan library
 * NOT ported (dead or unwanted in the daemon):
 *  - ui.select approve menu (TUI-only dead-end headless) → replaced by the
 *    user-only doors: /plan approve|revise|off + the plan-control file the
 *    panel writes. The MODEL can never approve: exit_plan_mode only submits.
 *  - ctrl+alt+p, --plan flag, setStatus badge, HTML export, ctx.newSession,
 *    the 3-tier bash confirm classifier (our plan mode blocks bash outright).
 *
 * Pure module — no pi imports, no fs. index.ts owns I/O.
 */

export const PLAN_STATE = "plan-state";
export const PLANS_DIR = ".pi/plans";
export const MAX_STEPS = 40;
export const MAX_STEP_CHARS = 200;
export const MAX_SLUG_CHARS = 40;

export type PlanMode = "inactive" | "active" | "awaiting" | "tracking" | "complete";

/** v1.4.70 (#47 doctrine — user rule 2026-09-15): plan/goal mode ENTRY is
 *  user-only. The model can never open plan mode itself; /plan on is a door
 *  only the user runs. Denials follow the #43 envelope: WHAT/WHY/door/NEXT. */
export type PlanToolGate =
	| { allowed: true }
	| { allowed: false; what: string; why: string; door: string; next: string };

export function planToolGate(mode: PlanMode, tool: string): PlanToolGate {
	if (tool === "enter_plan_mode") {
		return mode === "inactive"
			? {
					allowed: false,
					what: `tool "enter_plan_mode" is blocked`,
					why: "plan mode entry is user-only — the bot never opens the mode itself",
					door: "/plan on (user)",
					next: "present the plan outline in chat and ask the user to run /plan on; once the mode is active, write_plan becomes available",
				}
			: {
					allowed: false,
					what: `tool "enter_plan_mode" is blocked`,
					why: `plan mode is already ${mode} — entry happened through the user door`,
					door: "/plan on (user)",
					next: mode === "active" || mode === "awaiting" ? "use write_plan to draft, exit_plan_mode to submit for approval" : `the plan is ${mode}; /plan off (user) ends it`,
				};
	}
	if (tool === "write_plan") {
		if (mode === "active" || mode === "awaiting") return { allowed: true };
		return mode === "inactive"
			? {
					allowed: false,
					what: `tool "write_plan" is blocked`,
					why: "no plan mode is open — plan files are written only under a user-opened mode (this also prevents silent overwrite of plan files)",
					door: "/plan on (user)",
					next: "ask the user to run /plan on first, then draft with write_plan",
				}
			: {
					allowed: false,
					what: `tool "write_plan" is blocked`,
					why: `the plan is ${mode} — writing would overwrite a live/historical plan file`,
					door: "/plan off then /plan on (user)",
					next: "ask the user to end the current plan and open a new one before drafting",
				};
	}
	if (tool === "exit_plan_mode") {
		if (mode === "active" || mode === "awaiting") return { allowed: true };
		return {
			allowed: false,
			what: `tool "exit_plan_mode" is blocked`,
			why: `nothing to submit — the plan is ${mode}`,
			door: "—",
			next: mode === "tracking" ? "the plan is already approved and tracking — work the steps" : "no drafted plan awaits submission",
		};
	}
	if (tool === "plan_step_done") {
		if (mode === "tracking" || mode === "complete") return { allowed: true };
		return {
			allowed: false,
			what: `tool "plan_step_done" is blocked`,
			why: `the plan is ${mode} — steps only complete while tracking`,
			door: "/plan on → draft → approve (user)",
			next: "no active plan is tracking steps",
		};
	}
	return { allowed: true };
}

export interface PlanStep {
	index: number; // 1-based, stable per parse order
	text: string;
	done: boolean;
	evidence?: string;
	/** v1.4.77 (#86): optional real dependencies expressed as a trailing
	 *  "(after N[,M])" marker — backward refs only, never forced. The bridge
	 *  wires them to task blockedBy so the wake driver skips not-ready work. */
	dependsOn?: number[];
}

export interface PlanState {
	mode: PlanMode;
	planFile?: string;
	/** v1.4.68 (#47 Phase B): stamped at approve when the task bridge is on —
	 *  step-tasks carry it back so the plan derives progress from the board. */
	planId?: string;
	/** v1.4.69 (#61 Phase C): continuation counters for the plan wake loop —
	 *  rounds consumed, consecutive no-progress wakes, board signature, and the
	 *  scheduled wake time (restart-back-up). Persisted via the plan ledger. */
	wakeRounds?: number;
	wakeNoProgress?: number;
	wakeSignature?: string;
	wakeAt?: string;
	/** v1.4.77 (#80): true while the plan loop is QUIESCENT — unresolved steps
	 *  remain but NONE is wake-eligible (all parked / dependency-blocked).
	 *  Consumes no budget; cleared (with a FRESH wake episode) the moment a
	 *  step becomes actionable again. */
	wakeQuiescent?: boolean;
	steps: PlanStep[];
	thinkingBefore?: string;
	submittedAt?: string;
	/** v1.4.60 (#62): auto-close — set when the last step completes. */
	completedAt?: string;
}

/** v1.4.67 (#47 Phase A): 12KB cap for the awaiting-card plan text. */
export const PLAN_TEXT_MAX_CHARS = 12_000;

export function emptyPlan(): PlanState {
	return { mode: "inactive", steps: [] };
}

/** Slug from the first `# ` heading (fallback "plan"), kebab-ish and short. */
export function slugFromPlan(markdown: string): string {
	const heading = markdown
		.split("\n")
		.map((l) => l.trim())
		.find((l) => l.startsWith("# "));
	const base = (heading ?? "plan")
		.replace(/^#\s+/, "")
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/đ/g, "d")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, MAX_SLUG_CHARS)
		.replace(/-+$/g, "");
	return base || "plan";
}

/** Next free plan file path given existing files (collision → -2, -3, …). */
export function planFilePath(existing: readonly string[], slug: string, date = new Date()): string {
	const stamp = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
	const ext = ".md";
	const taken = new Set(existing.map((f) => f.split(/[\\/]/).pop() ?? ""));
	const first = `${stamp}-${slug}${ext}`;
	if (!taken.has(first)) return first;
	for (let n = 2; n < 50; n++) {
		const candidate = `${stamp}-${slug}-${n}${ext}`;
		if (!taken.has(candidate)) return candidate;
	}
	return `${stamp}-${slug}-${Date.now().toString(36)}${ext}`;
}

/**
 * Steps = TOP-LEVEL list items only (no indentation), numbered or bulleted.
 * Nested items and non-list lines are plan prose, not steps. Ports
 * plan-mode's parseSteps caps verbatim (40 x 200).
 */
export function parseSteps(markdown: string): PlanStep[] {
	const steps: PlanStep[] = [];
	// #86: optional trailing "(after N[,M])" — real dependencies, never forced.
	const AFTER_RE = /\s*\(after\s+([\d][\d\s,]*)\)\s*$/i;
	for (const rawLine of markdown.split("\n")) {
		const line = rawLine.trimEnd();
		const m = /^(\s*)(?:\d+[.)]|[-*+])\s+(.*)$/.exec(line);
		if (!m) continue;
		if (m[1].length > 0) continue; // indented → nested detail, not a step
		let text = m[2].trim();
		let dependsOn: number[] | undefined;
		const am = AFTER_RE.exec(text);
		if (am) {
			// Backward refs only (n ≤ steps.length, i.e. < own index): self/dup/
			// forward/out-of-range drop silently — cycle-proof by construction.
			const refs = [...new Set(am[1].split(",").map((x) => parseInt(x.trim(), 10)).filter((n) => Number.isInteger(n)))]
				.filter((n) => n >= 1 && n <= steps.length)
				.sort((a, b) => a - b);
			if (refs.length > 0) dependsOn = refs;
			text = text.slice(0, am.index).trim();
		}
		const clipped = text.slice(0, MAX_STEP_CHARS);
		if (!clipped) continue;
		steps.push({ index: steps.length + 1, text: clipped, done: false, ...(dependsOn ? { dependsOn } : {}) });
		if (steps.length >= MAX_STEPS) break;
	}
	return steps;
}

/** Apply a step-done marker; returns the updated open-step list or an error. */
export function markStepDone(state: PlanState, index: number, evidence?: string): { ok: true; open: number; total: number } | { ok: false; error: string } {
	const step = state.steps.find((s) => s.index === index);
	if (!step) {
		const open = state.steps.filter((s) => !s.done).map((s) => s.index).join(", ");
		return { ok: false, error: `No step #${index}. Open steps: ${open || "(none)"}.` };
	}
	if (step.done) return { ok: true, open: openCount(state), total: state.steps.length };
	step.done = true;
	step.evidence = evidence?.trim().slice(0, 300) || step.evidence;
	return { ok: true, open: openCount(state), total: state.steps.length };
}

export function openCount(state: PlanState): number {
	return state.steps.filter((s) => !s.done).length;
}

/** One-line-per-status text for /plan status and tool results. */
export function planStatusText(state: PlanState): string {
	const parts: string[] = [];
	parts.push(`Plan mode: ${state.mode}`);
	if (state.planFile) parts.push(`File: ${state.planFile}`);
	if (state.steps.length > 0) {
		const done = state.steps.length - openCount(state);
		parts.push(`Steps: ${done}/${state.steps.length} done`);
		for (const s of state.steps) {
			parts.push(`${s.done ? "✓" : "·"} #${s.index} ${s.text}`);
		}
	}
	if (state.mode === "complete") {
		parts.push(`COMPLETE ${state.completedAt ?? ""} — plan closed automatically (all steps done). /plan off clears it; the plan file stays in the library.`);
	}
	if (state.mode === "awaiting") parts.push("Waiting for the USER: /plan approve (implement) · /plan revise (keep editing) · /plan off (discard). The model cannot approve its own plan.");
	return parts.join("\n");
}

// ── Control-file bridge (user-only doors; the panel writes this file) ────

export const PLAN_CONTROL_DIR = "plan-control";

export type PlanControlAction = "on" | "approve" | "revise" | "off";

export interface PlanControlPayload {
	v: 1;
	action: PlanControlAction;
	sentAt: string;
	ackAt?: string;
}

export function parseControlPayload(raw: unknown): PlanControlPayload | null {
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as Record<string, unknown>;
	if (r.v !== 1) return null;
	if (typeof r.action !== "string" || !["on", "approve", "revise", "off"].includes(r.action)) return null;
	if (typeof r.sentAt !== "string") return null;
	return { v: 1, action: r.action as PlanControlAction, sentAt: r.sentAt };
}

/** Transition rules — the approve direction is USER-ONLY by construction. */
export function applyControlAction(state: PlanState, action: PlanControlAction, now = new Date().toISOString()): { state: PlanState; note: string } {
	switch (action) {
		case "on":
			if (state.mode === "inactive" || state.mode === "complete") {
				return { state: { ...state, mode: "active" }, note: "Plan mode ON — model writes the plan via write_plan." };
			}
			return { state, note: `Plan mode already ${state.mode}.` };
		case "approve":
			if (state.mode !== "awaiting") {
				return { state, note: `Nothing to approve (mode=${state.mode}); the model must call exit_plan_mode first.` };
			}
			return { state: { ...state, mode: "tracking", submittedAt: now }, note: "Approved — tools restored; implementation starts on the approval message." };
		case "revise":
			if (state.mode !== "awaiting") return { state, note: `Nothing to revise (mode=${state.mode}).` };
			return { state: { ...state, mode: "active" }, note: "Back to planning — the model keeps editing the plan." };
		case "off":
			if (state.mode === "inactive") return { state, note: "Plan mode already off." };
			return { state: { ...state, mode: "inactive", steps: [] }, note: "Plan mode OFF — plan file kept in the library; tracking cleared." };
	}
}

// ── Ledger replay (full snapshots, last wins — compaction-safe) ──────────

export interface BranchEntryLike {
	type?: string;
	customType?: string;
	data?: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

export function sanitizePlanState(raw: unknown): PlanState | null {
	if (!isRecord(raw)) return null;
	const mode = raw.mode;
	if (typeof mode !== "string" || !["inactive", "active", "awaiting", "tracking", "complete"].includes(mode)) return null;
	const steps: PlanStep[] = [];
	if (Array.isArray(raw.steps)) {
		for (const s of raw.steps.slice(0, MAX_STEPS)) {
			if (!isRecord(s) || typeof s.index !== "number" || typeof s.text !== "string") continue;
			steps.push({
				index: s.index,
				text: s.text.slice(0, MAX_STEP_CHARS),
				done: s.done === true,
				...(typeof s.evidence === "string" ? { evidence: s.evidence.slice(0, 300) } : {}),
			});
		}
	}
	return {
		mode: mode as PlanMode,
		...(typeof raw.planFile === "string" && raw.planFile ? { planFile: raw.planFile } : {}),
		...(typeof raw.planId === "string" && raw.planId.startsWith("p-") ? { planId: raw.planId } : {}),
		...(typeof raw.wakeRounds === "number" && raw.wakeRounds >= 0 ? { wakeRounds: Math.min(99, Math.floor(raw.wakeRounds)) } : {}),
		...(typeof raw.wakeNoProgress === "number" && raw.wakeNoProgress >= 0 ? { wakeNoProgress: Math.min(99, Math.floor(raw.wakeNoProgress)) } : {}),
		...(typeof raw.wakeSignature === "string" ? { wakeSignature: raw.wakeSignature.slice(0, 500) } : {}),
		...(typeof raw.wakeAt === "string" ? { wakeAt: raw.wakeAt } : {}),
		steps,
		...(typeof raw.thinkingBefore === "string" ? { thinkingBefore: raw.thinkingBefore } : {}),
		...(typeof raw.submittedAt === "string" ? { submittedAt: raw.submittedAt } : {}),
		...(typeof raw.completedAt === "string" ? { completedAt: raw.completedAt } : {}),
	};
}

export function replayPlan(entries: readonly BranchEntryLike[]): PlanState {
	let state = emptyPlan();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== PLAN_STATE) continue;
		const next = sanitizePlanState(entry.data);
		if (next) state = next;
	}
	return state;
}

/**
 * v1.4.67 (#47 Phase A): drift repair — the projection used to be written
 * only on plan EVENTS, so a plan finished under an older engine froze in
 * `tracking` forever (e.g. 11/11 done, never auto-closed). Reconcile runs at
 * load points (session_start, control-file consumption):
 *  - tracking with every step done → flip `complete` + completedAt (the
 *    appendEntry in persistPlan makes this durable across restarts);
 *  - tracking/complete with an EMPTY step list → re-derive steps from the
 *    plan file on disk (state always kept them; this covers very old or
 *    hand-mangled ledgers). Re-derived steps start `done:false`, so a
 *    finished-but-empty plan stays honest: it shows 0/N until re-marked.
 * Pure + idempotent: a second call changes nothing.
 */
export function reconcilePlan(state: PlanState, planFileText: string | null, now = new Date().toISOString()): { state: PlanState; changed: boolean } {
	let next: PlanState = state;
	let changed = false;
	if ((next.mode === "tracking" || next.mode === "complete") && next.steps.length === 0 && planFileText) {
		const steps = parseSteps(planFileText);
		if (steps.length > 0) {
			next = { ...next, steps };
			changed = true;
		}
	}
	if (next.mode === "tracking" && next.steps.length > 0 && next.steps.every((s) => s.done)) {
		next = { ...next, mode: "complete", completedAt: next.completedAt ?? now };
		changed = true;
	}
	return { state: next, changed };
}

// ── v1.4.68 #47 Phase B: task bridge (approve → step-tasks; off → cancel) ──

/** v1.4.77 (#80): wake-eligible subset of the UNRESOLVED steps — parked is
 *  never actionable (user-only reopen), a pending step blocked by ANY open
 *  task (parked blocker or not) is not ready either, while in_progress/held
 *  stay actionable (the agent can act on judge feedback). Pinning this as a
 *  pure helper was tonight's lesson: the 2026-09-15 incident nudge-targeted
 *  parked tasks 4x because "unresolved" and "actionable" were one set. */
export function actionableSteps(open: readonly BoardStepTaskLike[]): BoardStepTaskLike[] {
	const openIds = new Set(open.map((t) => t.id));
	return open.filter((t) => {
		if (t.status === "parked") return false;
		if (t.status === "pending") return !(t.blockedBy ?? []).some((b) => openIds.has(b));
		return true;
	});
}

/** Board task shape the plan derives from (task-status projection, stable subset). */
export interface BoardStepTaskLike {
	id: number;
	status: string;
	planId?: string;
	stepIndex?: number;
	/** v1.4.77 (#80): read from the projection to compute dependency-ready
	 *  pending work (a parked/open blocker keeps its dependents not-ready). */
	blockedBy?: number[];
}

/** Bridge request the task ext consumes (~/.pi/agent/plan-bridge/<sessionId>.json). */
export function planBridgePayload(
	state: PlanState,
	sessionId: string,
	status: "tracking" | "off",
): { v: 1; sessionId: string; planId: string; status: "tracking" | "off"; planFile?: string; steps: { index: number; text: string; dependsOn?: number[] }[] } | null {
	if (!state.planId) return null;
	return {
		v: 1,
		sessionId,
		planId: state.planId,
		status,
		...(state.planFile ? { planFile: state.planFile } : {}),
		steps:
			status === "tracking"
				? state.steps.map((s) => ({ index: s.index, text: s.text, ...(s.dependsOn && s.dependsOn.length > 0 ? { dependsOn: s.dependsOn } : {}) }))
				: [],
	};
}

/** Derive step done-ness from the task board (bridge plans only — planId set).
 *  done is MONOTONIC: a step completed via a verified task stays done even if
 *  the board later hides it; without this, a torn projection read would
 *  regress visible progress. Pure; `changed` drives the appendEntry persist. */
export function deriveFromTasks(state: PlanState, board: readonly BoardStepTaskLike[]): { state: PlanState; changed: boolean } {
	if (!state.planId) return { state, changed: false };
	const mine = board.filter((t) => t.planId === state.planId && typeof t.stepIndex === "number");
	let changed = false;
	const steps = state.steps.map((s) => {
		const t = mine.find((x) => x.stepIndex === s.index);
		if (!t) return s;
		if (s.done || t.status !== "completed") return s;
		changed = true;
		return { ...s, done: true };
	});
	return { state: changed ? { ...state, steps } : state, changed };
}

// ── #22: status projection the task panel reads ────────────────────────

/** Payload of `<sessionId>.status.json` — the plugin panel renders plan
 *  state + the USER-ONLY approve/revise buttons from this file. Pure shape
 *  helper so tests pin the contract without touching a real HOME. */
export interface PlanStatusPayload {
	v: 1;
	sessionId: string;
	mode: PlanState["mode"];
	stepsDone: number;
	stepsTotal: number;
	/** v1.4.62 (#62): the full step list — the panel renders it as a checklist like task rows. */
	steps: { index: number; text: string; done: boolean; taskRef?: { id: number; status: string } }[];
	/** v1.4.60 (#62): what the plan is doing RIGHT NOW — first open step. */
	currentStep: { index: number; text: string } | null;
	/** v1.4.67 (#47 Phase A): full plan content so the USER can read and
	 *  approve ON the card — only sent in `awaiting` mode to keep tracking
	 *  payloads small. Capped at PLAN_TEXT_MAX_CHARS. */
	planText?: string;
	planFile: string | null;
	submittedAt: string | null;
	completedAt: string | null;
	/** v1.4.77 (#80): true while the plan loop is QUIESCENT (unresolved steps
	 *  remain but none is wake-eligible — parked/blocked). planWakeActive()
	 *  treats such plans as inactive so the task auto-ping owns the cadence
	 *  again (single-waker priority; tonight's reopen would otherwise have NO
	 *  waker at all). */
	quiescent?: boolean;
	/** v1.4.86 (#85): continuation-budget projection — the plan card renders
	 *  "budget 7/10 · streak 2/3 · 5 open (2 parked)" like the goal card. */
	wakeRounds: number;
	wakeNoProgress: number;
	openSteps: number;
	parkedSteps: number;
	updatedAt: string;
}

export function planStatusPayload(
	state: PlanState,
	sessionId: string,
	now = new Date().toISOString(),
	planText?: string,
	board?: readonly BoardStepTaskLike[],
): PlanStatusPayload {
	const open = state.steps.find((s) => !s.done);
	const mine = state.planId && board ? board.filter((t) => t.planId === state.planId && typeof t.stepIndex === "number") : [];
	return {
		v: 1,
		sessionId,
		mode: state.mode,
		stepsDone: state.steps.filter((s) => s.done).length,
		stepsTotal: state.steps.length,
		// v1.4.86 (#85): wake-budget projection so the panel card can render
		// "budget 7/10 · streak 2/3 · 5 open (2 parked)" like the goal card's epochs.
		wakeRounds: state.wakeRounds ?? 0,
		wakeNoProgress: state.wakeNoProgress ?? 0,
		openSteps: mine.filter((t) => t.status !== "completed" && t.status !== "cancelled").length,
		parkedSteps: mine.filter((t) => t.status === "parked").length,
		steps: state.steps.map((s) => {
			const t = mine.find((x) => x.stepIndex === s.index);
			return { index: s.index, text: s.text, done: s.done, ...(t ? { taskRef: { id: t.id, status: t.status } } : {}) };
		}),
		currentStep: open ? { index: open.index, text: open.text } : null,
		...(state.mode === "awaiting" && planText ? { planText: planText.slice(0, PLAN_TEXT_MAX_CHARS) } : {}),
		planFile: state.planFile ?? null,
		submittedAt: state.submittedAt ?? null,
		completedAt: state.completedAt ?? null,
		...(state.wakeQuiescent ? { quiescent: true } : {}),
		updatedAt: now,
	};
}
