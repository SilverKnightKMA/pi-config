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

export type PlanMode = "inactive" | "active" | "awaiting" | "tracking";

export interface PlanStep {
	index: number; // 1-based, stable per parse order
	text: string;
	done: boolean;
	evidence?: string;
}

export interface PlanState {
	mode: PlanMode;
	planFile?: string;
	steps: PlanStep[];
	thinkingBefore?: string;
	submittedAt?: string;
}

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
 * plan-mode's parseSteps caps verbatim (40 × 200).
 */
export function parseSteps(markdown: string): PlanStep[] {
	const steps: PlanStep[] = [];
	for (const rawLine of markdown.split("\n")) {
		const line = rawLine.trimEnd();
		const m = /^(\s*)(?:\d+[.)]|[-*+])\s+(.*)$/.exec(line);
		if (!m) continue;
		if (m[1].length > 0) continue; // indented → nested detail, not a step
		const text = m[2].trim().slice(0, MAX_STEP_CHARS);
		if (!text) continue;
		steps.push({ index: steps.length + 1, text, done: false });
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
			if (state.mode === "inactive") {
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
	if (typeof mode !== "string" || !["inactive", "active", "awaiting", "tracking"].includes(mode)) return null;
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
		steps,
		...(typeof raw.thinkingBefore === "string" ? { thinkingBefore: raw.thinkingBefore } : {}),
		...(typeof raw.submittedAt === "string" ? { submittedAt: raw.submittedAt } : {}),
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
