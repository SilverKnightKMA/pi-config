/**
 * memory-curator core — P3 (#180, plan 2026-09-21).
 *
 * Concept credit: @fradser/pi-memory 0.2.8 (MIT, package NOT ported —
 * publicDir collides with the OM-owned tree; see upstream-registry row):
 * plan→validate→apply split (planner is READ-ONLY and returns a JSON plan;
 * engine code validates + applies), per-run receipts with content hashes,
 * staleness verdicts, usage-triggered one-shot worker with a pre-packed
 * bounded evidence ration.
 *
 * Deterministic gates only — no LLM inside the engine path.
 */

import { createHash } from "node:crypto";
import {
	buildFactLine,
	formatFact,
	isLiveFact,
	newFactId,
	parseFactLine,
	tombstoneFact,
	type Fact,
	type FactCategory,
} from "./store.ts";

// --- thresholds ----------------------------------------------------------------

export interface CuratorThresholds {
	enabled: boolean;
	minLines: number; // ≥N fact/lesson lines changed since last run
	minTokens: number; // ≥N tokens processed since last run
	minSessions: number; // ≥N sessions closed since last run
	floorDays: number; // at most N days without a run
	quotaPct: number; // ≤N% of live lines may be tombstoned per run
	maxProposals: number;
}

function clampIntEnv(v: string | undefined, min: number, max: number, dflt: number): number {
	const n = Number.parseInt(v ?? "", 10);
	if (Number.isNaN(n)) return dflt;
	return Math.min(max, Math.max(min, n));
}

export function curatorThresholds(env: NodeJS.ProcessEnv = process.env): CuratorThresholds {
	return {
		enabled: env.FACTS_CURATOR !== "0",
		minLines: clampIntEnv(env.FACTS_CURATOR_MIN_LINES, 1, 1000, 10),
		minTokens: clampIntEnv(env.FACTS_CURATOR_MIN_TOKENS, 1000, 100_000_000, 2_000_000),
		minSessions: clampIntEnv(env.FACTS_CURATOR_MIN_SESSIONS, 1, 1000, 15),
		floorDays: clampIntEnv(env.FACTS_CURATOR_FLOOR_DAYS, 1, 365, 30),
		quotaPct: clampIntEnv(env.FACTS_CURATOR_QUOTA_PCT, 1, 100, 20),
		maxProposals: clampIntEnv(env.FACTS_CURATOR_MAX_PROPOSALS, 0, 20, 5),
	};
}

// --- persisted counters -----------------------------------------------------------

export interface CuratorState {
	lastRunAt: string | null; // ISO
	/** Line-count baseline of facts.md + lessons.md at the last successful run. */
	factsBaseline: number;
	lessonsBaseline: number;
	tokensSinceRun: number;
	sessionsSinceRun: number;
	failingStreak: number;
	lastError: string | null;
}

export function initialCuratorState(now = new Date()): CuratorState {
	return {
		lastRunAt: now.toISOString(),
		factsBaseline: 0,
		lessonsBaseline: 0,
		tokensSinceRun: 0,
		sessionsSinceRun: 0,
		failingStreak: 0,
		lastError: null,
	};
}

export interface CuratorSnapshot {
	factLines: number; // current non-empty lines in facts.md
	lessonLines: number; // current non-empty lines in lessons.md
	tokensSinceRun: number; // persisted counter (already includes this session)
	sessionsSinceRun: number;
}

export type CuratorDecision =
	| { run: false; reason: "disabled" | "below-thresholds" }
	| { run: true; reason: "lines" | "tokens" | "sessions" | "floor" };

export function shouldRunCurator(
	state: CuratorState,
	snap: CuratorSnapshot,
	t: CuratorThresholds,
	now: Date = new Date(),
): CuratorDecision {
	if (!t.enabled) return { run: false, reason: "disabled" };
	const linesChanged = Math.abs(snap.factLines - state.factsBaseline) + Math.abs(snap.lessonLines - state.lessonsBaseline);
	if (linesChanged >= t.minLines) return { run: true, reason: "lines" };
	if (snap.tokensSinceRun >= t.minTokens) return { run: true, reason: "tokens" };
	if (snap.sessionsSinceRun >= t.minSessions) return { run: true, reason: "sessions" };
	if (state.lastRunAt) {
		const days = (now.getTime() - Date.parse(state.lastRunAt)) / 86_400_000;
		if (days >= t.floorDays) return { run: true, reason: "floor" };
	}
	return { run: false, reason: "below-thresholds" };
}

// --- plan schema + validation (fail-closed: one bad item refuses the WHOLE plan) --

export const VERDICTS = [
	"KEEP",
	"CONTRADICTED",
	"SUPERSEDED",
	"SUBSUMED",
	"DORMANT",
	"ONE-SHOT",
] as const;
export type Verdict = (typeof VERDICTS)[number];

export interface PlanVerdict {
	id: string;
	verdict: Verdict;
	evidence: string;
}

export interface PlanProposal {
	category: FactCategory;
	date: string;
	priority: string;
	text: string;
	source: string;
}

export interface CuratorPlan {
	verdicts: PlanVerdict[];
	proposals: PlanProposal[];
}

export type Validation =
	| { ok: true; plan: CuratorPlan }
	| { ok: false; errors: string[] };

/** Tolerant parse: the planner is told to print ONLY JSON; if it wraps the
 *  object in prose, take the outermost {...} span. */
export function extractJson(raw: string): unknown {
	const trimmed = raw.trim();
	try {
		return JSON.parse(trimmed);
	} catch {
		/* fall through to span extraction */
	}
	const first = trimmed.indexOf("{");
	const last = trimmed.lastIndexOf("}");
	if (first >= 0 && last > first) {
		try {
			return JSON.parse(trimmed.slice(first, last + 1));
		} catch {
			/* fall through */
		}
	}
	return null;
}

export function validatePlan(raw: string, facts: Fact[], t: CuratorThresholds): Validation {
	const errors: string[] = [];
	const parsed = extractJson(raw);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { ok: false, errors: ["plan is not a JSON object"] };
	}
	const obj = parsed as Record<string, unknown>;
	if (!Array.isArray(obj.verdicts)) return { ok: false, errors: ["plan.verdicts must be an array"] };
	if (obj.proposals !== undefined && !Array.isArray(obj.proposals)) {
		return { ok: false, errors: ["plan.proposals must be an array when present"] };
	}

	const live = facts.filter(isLiveFact);
	const seenIds = new Set<string>();
	const verdicts: PlanVerdict[] = [];
	let mutating = 0;

	for (const [i, v] of (obj.verdicts as unknown[]).entries()) {
		if (!v || typeof v !== "object") {
			errors.push(`verdicts[${i}]: not an object`);
			continue;
		}
		const r = v as Record<string, unknown>;
		const id = typeof r.id === "string" ? r.id : "";
		const verdict = typeof r.verdict === "string" ? r.verdict : "";
		const evidence = typeof r.evidence === "string" ? r.evidence.trim() : "";
		if (!/^[a-f0-9]{6}$/.test(id)) errors.push(`verdicts[${i}]: id '${id}' is not a 6-hex fact id`);
		if (seenIds.has(id)) errors.push(`verdicts[${i}]: duplicate id '${id}'`);
		seenIds.add(id);
		if (!VERDICTS.includes(verdict as Verdict)) errors.push(`verdicts[${i}]: verdict '${verdict}' not in ${VERDICTS.join("|")}`);
		if (!evidence) errors.push(`verdicts[${i}]: evidence is required (every action must cite its ground)`);
		const target = facts.find((f) => f.id === id);
		if (!target) errors.push(`verdicts[${i}]: id '${id}' does not exist in the store`);
		else if (target.tombstoned) errors.push(`verdicts[${i}]: id '${id}' is already tombstoned`);
		if (verdict !== "KEEP") mutating++;
		verdicts.push({ id, verdict: verdict as Verdict, evidence });
	}

	// Quota: mutating verdicts (≠KEEP) may touch at most quotaPct% of live lines.
	const quota = Math.max(1, Math.floor((live.length * t.quotaPct) / 100));
	if (mutating > quota) {
		errors.push(`quota exceeded: ${mutating} mutating verdicts > ${quota} allowed (${t.quotaPct}% of ${live.length} live lines)`);
	}

	const proposals: PlanProposal[] = [];
	if (Array.isArray(obj.proposals)) {
		for (const [i, p] of (obj.proposals as unknown[]).entries()) {
			if (!p || typeof p !== "object") {
				errors.push(`proposals[${i}]: not an object`);
				continue;
			}
			const r = p as Record<string, unknown>;
			const line = buildFactLine({
				category: String(r.category ?? ""),
				date: String(r.date ?? ""),
				priority: String(r.priority ?? ""),
				text: String(r.text ?? ""),
			});
			if (!line) errors.push(`proposals[${i}]: invalid fact line (category/date/priority/text rejected)`);
			if (typeof r.source !== "string" || !r.source.trim()) errors.push(`proposals[${i}]: source is required`);
			proposals.push({
				category: r.category as FactCategory,
				date: String(r.date ?? ""),
				priority: String(r.priority ?? ""),
				text: String(r.text ?? ""),
				source: String(r.source ?? ""),
			});
		}
		if (obj.proposals.length > t.maxProposals) {
			errors.push(`proposals: ${obj.proposals.length} > ${t.maxProposals} allowed per run`);
		}
	}

	if (errors.length > 0) return { ok: false, errors };
	return { ok: true, plan: { verdicts, proposals } };
}

// --- apply -----------------------------------------------------------------------

export interface ApplyResult {
	facts: Fact[];
	tombstoned: number;
	proposalsAdded: number;
}

export function applyPlan(facts: Fact[], plan: CuratorPlan, today: string): ApplyResult {
	let tombstoned = 0;
	let out = facts.map((f) => {
		const v = plan.verdicts.find((x) => x.id === f.id);
		if (!v || v.verdict === "KEEP" || f.tombstoned) return f;
		tombstoned++;
		return tombstoneFact(f, today, `curator:${v.verdict.toLowerCase()}`);
	});
	let proposalsAdded = 0;
	const taken = new Set(out.map((f) => f.id));
	for (const p of plan.proposals) {
		const line = buildFactLine({ ...p, id: newFactId(taken) });
		if (!line) continue;
		const f = parseFactLine(line);
		if (f) {
			out = [...out, f];
			taken.add(f.id);
			proposalsAdded++;
		}
	}
	return { facts: out, tombstoned, proposalsAdded };
}

// --- receipts ----------------------------------------------------------------------

export function sha256Content(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

export interface CuratorReceipt {
	ts: string;
	trigger: string;
	outcome: "ok" | "refused" | "error";
	appliedVerdicts: number;
	proposalsAdded: number;
	preHash: string;
	postHash: string;
	packBytes: number;
	planEcho?: CuratorPlan;
	errors?: string[];
}

export function buildReceipt(partial: Omit<CuratorReceipt, "ts"> & { ts?: string }): CuratorReceipt {
	return { ts: partial.ts ?? new Date().toISOString(), ...partial };
}

/** Render one facts line for receipts/logs (already-serialized form). */
export function factLine(f: Fact): string {
	return formatFact(f);
}
