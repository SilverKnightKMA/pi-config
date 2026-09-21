/**
 * facts-core store — pure functions for the durable facts tier
 * (memory part 2 HYBRID, plan 2026-09-21, step P1a).
 *
 * One fact = one line:
 *   `[category][YYYY-MM-DD][priority] text (#id)`
 * with optional suffixes, in this fixed order:
 *   ` ttl=YYYY-MM-DD`                       (ONE-SHOT facts die on this date)
 *   ` tombstoned=YYYY-MM-DD reason=<text>`  (no hard delete — recovery span)
 *
 * categories (taxonomy borrowed from @pify/memory, MIT — idea, no code):
 *   identity | preference | convention | project | decision | ops
 * priorities: P1 (always inject) | P2 | P3 (contextual)
 *
 * Doctrine (learn/plan-memory-part2-2026-09-21.md):
 *  - Edit-in-place by id: a corrected fact REPLACES its line; never append
 *    a second line for the same id. Growth is bounded by lifecycle, not cap.
 *  - No hard delete: tombstone keeps the original text + dates so a wrong
 *    verdict is recoverable (same recovery-span doctrine as OM promotion).
 *  - The agent (model) never writes this file directly; writers are the
 *    deterministic regex trigger and the memory-curator, both gated.
 *  - Secret-bearing lines are rejected at parse and never injected.
 *
 * This module is PURE: no fs, no pi imports, no globals. fs wiring lives in
 * index.ts (P1b).
 */

// --- taxonomy -----------------------------------------------------------------

export const FACT_CATEGORIES = [
	"identity",
	"preference",
	"convention",
	"project",
	"decision",
	"ops",
] as const;
export type FactCategory = (typeof FACT_CATEGORIES)[number];

export const FACT_PRIORITIES = ["P1", "P2", "P3"] as const;
export type FactPriority = (typeof FACT_PRIORITIES)[number];

export interface Fact {
	id: string; // 6-hex, unique in file
	category: FactCategory;
	date: string; // origin date YYYY-MM-DD (kept on tombstone = recovery span)
	priority: FactPriority;
	text: string;
	ttl?: string; // YYYY-MM-DD — fact auto-tombstones when today >= ttl
	tombstoned?: string; // YYYY-MM-DD the tombstone was applied
	reason?: string; // why tombstoned (ttl-expired | superseded | contradicted | ... )
}

// --- secret detection (same fence as lessons-core; defense in depth) --------

const SECRET_PATTERNS: RegExp[] = [
	/sk-ant-[A-Za-z0-9_\-]{16,}/, // Anthropic
	/sk-proj-[A-Za-z0-9_\-]{16,}/, // OpenAI project key
	/ghp_[A-Za-z0-9]{20,}/, // GitHub PAT
	/gho_[A-Za-z0-9]{20,}/, // GitHub OAuth
	/github_pat_[A-Za-z0-9_]{20,}/, // GitHub fine-grained
	/AKIA[0-9A-Z]{16}/, // AWS access key id
	/xox[baprs]-[A-Za-z0-9\-]+/, // Slack tokens
	/-----BEGIN [A-Z ]*PRIVATE KEY-----/, // PEM private key
];

export function factContainsSecret(text: string): boolean {
	return SECRET_PATTERNS.some((re) => re.test(text));
}

// --- validation ----------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidFactDate(d: string): boolean {
	if (!DATE_RE.test(d)) return false;
	const t = Date.parse(`${d}T00:00:00Z`);
	if (Number.isNaN(t)) return false;
	return new Date(t).toISOString().slice(0, 10) === d;
}

// --- parse / serialize -----------------------------------------------------------

const LINE_RE = new RegExp(
	"^\\[(" + FACT_CATEGORIES.join("|") + ")\\]" +
		"\\[(\\d{4}-\\d{2}-\\d{2})\\]" +
		"\\[(P[123])\\] " +
		"(.+?) " +
		"\\(#([a-f0-9]{6})\\)" +
		"(?: ttl=(\\d{4}-\\d{2}-\\d{2}))?" +
		"(?: tombstoned=(\\d{4}-\\d{2}-\\d{2}) reason=(.+))?$",
);

export function parseFactLine(line: string): Fact | null {
	const m = LINE_RE.exec(line.trim());
	if (!m) return null;
	const fact: Fact = {
		category: m[1] as FactCategory,
		date: m[2],
		priority: m[3] as FactPriority,
		text: m[4].trim(),
		id: m[5],
	};
	if (m[6]) fact.ttl = m[6];
	if (m[7] && m[8] !== undefined) {
		fact.tombstoned = m[7];
		fact.reason = m[8].trim();
	}
	return fact;
}

export function parseFactsFile(content: string): Fact[] {
	const out: Fact[] = [];
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		const f = parseFactLine(line);
		// Malformed lines and secret-bearing lines never enter the model.
		if (f && !factContainsSecret(f.text)) out.push(f);
	}
	return out;
}

export function formatFact(f: Fact): string {
	let s = `[${f.category}][${f.date}][${f.priority}] ${f.text} (#${f.id})`;
	if (f.ttl) s += ` ttl=${f.ttl}`;
	if (f.tombstoned) s += ` tombstoned=${f.tombstoned} reason=${f.reason ?? ""}`;
	return s;
}

export function serializeFacts(facts: Fact[]): string {
	return facts.map(formatFact).join("\n");
}

/** Build a fact for writing. Returns null when it must NOT be written:
 *  bad date/category/priority, empty text, text with a newline or secret. */
export function buildFactLine(input: {
	category: string;
	date: string;
	priority: string;
	text: string;
	id?: string;
	ttl?: string;
}): string | null {
	if (!FACT_CATEGORIES.includes(input.category as FactCategory)) return null;
	if (!FACT_PRIORITIES.includes(input.priority as FactPriority)) return null;
	if (!isValidFactDate(input.date)) return null;
	if (input.ttl && !isValidFactDate(input.ttl)) return null;
	const text = input.text.trim();
	if (!text || text.includes("\n") || factContainsSecret(text)) return null;
	const id = input.id ?? newFactId();
	if (!/^[a-f0-9]{6}$/.test(id)) return null;
	return formatFact({
		id,
		category: input.category as FactCategory,
		date: input.date,
		priority: input.priority as FactPriority,
		text,
		ttl: input.ttl,
	});
}

// --- ids -------------------------------------------------------------------------

/** 6 hex chars from crypto — deterministic source injected for tests. */
function hex6(rand: () => number): string {
	const HEX = "0123456789abcdef";
	let s = "";
	for (let i = 0; i < 6; i++) s += HEX[Math.floor(rand() * 16)];
	return s;
}

export function newFactId(existing: ReadonlySet<string> = new Set(), rand: () => number = Math.random): string {
	for (let i = 0; i < 64; i++) {
		const id = hex6(rand);
		if (!existing.has(id)) return id;
	}
	throw new Error("newFactId: could not find a free id after 64 draws");
}

// --- edit-in-place (never append a second line for the same id) -------------------

export interface FactPatch {
	category?: FactCategory;
	priority?: FactPriority;
	date?: string;
	text?: string;
	ttl?: string;
}

/** Apply a patch to the fact with `id`. Returns changed=false when the id is
 *  unknown, the patch is empty, or the patched line would be invalid — in
 *  every failed case the input array is returned untouched (fail-closed). */
export function updateFactInPlace(
	facts: Fact[],
	id: string,
	patch: FactPatch,
): { facts: Fact[]; changed: boolean } {
	const idx = facts.findIndex((f) => f.id === id);
	if (idx < 0) return { facts, changed: false };
	const old = facts[idx];
	if (old.tombstoned) return { facts, changed: false }; // tombstones are terminal; un-tombstone is user-only
	const next: Fact = {
		...old,
		...(patch.category ? { category: patch.category } : {}),
		...(patch.priority ? { priority: patch.priority } : {}),
		...(patch.date ? { date: patch.date } : {}),
		...(patch.text !== undefined ? { text: patch.text } : {}),
		...(patch.ttl !== undefined ? { ttl: patch.ttl } : {}),
	};
	const hasChange =
		(patch.category !== undefined && patch.category !== old.category) ||
		(patch.priority !== undefined && patch.priority !== old.priority) ||
		(patch.date !== undefined && patch.date !== old.date) ||
		(patch.text !== undefined && patch.text !== old.text) ||
		(patch.ttl !== undefined && patch.ttl !== old.ttl);
	if (!hasChange) return { facts, changed: false };
	const serialized = buildFactLine({ ...next, id: next.id });
	if (!serialized) return { facts, changed: false };
	const out = facts.slice();
	out[idx] = parseFactLine(serialized)!; // round-trip = what lands on disk
	return { facts: out, changed: true };
}

// --- lifecycle --------------------------------------------------------------------

/** Tombstone a fact. No hard delete — the line keeps text + origin date. */
export function tombstoneFact(f: Fact, today: string, reason: string): Fact {
	return { ...f, tombstoned: today, reason };
}

/** ONE-SHOT death: facts whose ttl has arrived (today >= ttl) get tombstoned.
 *  Idempotent: already-tombstoned / no-ttl facts are returned unchanged. */
export function expireTtlFacts(facts: Fact[], today: string): { facts: Fact[]; expired: string[] } {
	const expired: string[] = [];
	const out = facts.map((f) => {
		if (f.tombstoned || !f.ttl) return f;
		if (today >= f.ttl) {
			expired.push(f.id);
			return tombstoneFact(f, today, "ttl-expired");
		}
		return f;
	});
	return { facts: out, expired };
}

export function isLiveFact(f: Fact): boolean {
	return !f.tombstoned;
}

// --- keyword match (used by the P2 regex trigger to find the line to edit) --------

/** Case-insensitive substring/word overlap score. Returns live facts whose
 *  text matches EVERY keyword, best score first (score = total occurrences). */
export function matchFactsByKeywords(
	facts: Fact[],
	keywords: string[],
	opts: { includeTombstoned?: boolean } = {},
): Array<{ fact: Fact; score: number }> {
	const kws = keywords.map((k) => k.trim().toLowerCase()).filter(Boolean);
	if (!kws.length) return [];
	const scored: Array<{ fact: Fact; score: number }> = [];
	for (const f of facts) {
		if (!opts.includeTombstoned && f.tombstoned) continue;
		const low = f.text.toLowerCase();
		let score = 0;
		let all = true;
		for (const k of kws) {
			const count = low.split(k).length - 1;
			if (count === 0) {
				all = false;
				break;
			}
			score += count;
		}
		if (all) scored.push({ fact: f, score });
	}
	scored.sort((a, b) => b.score - a.score || (a.fact.date < b.fact.date ? 1 : -1));
	return scored;
}

// --- config + paths (P1b) -----------------------------------------------------------

import { join } from "node:path";

export interface FactsInjectConfig {
	inject: boolean;
	maxLines: number;
	maxChars: number;
}

function clampIntEnv(v: string | undefined, min: number, max: number, dflt: number): number {
	const n = Number.parseInt(v ?? "", 10);
	if (Number.isNaN(n)) return dflt;
	return Math.min(max, Math.max(min, n));
}

export function factsInjectConfig(env: NodeJS.ProcessEnv = process.env): FactsInjectConfig {
	return {
		inject: env.FACTS_INJECT !== "0",
		maxLines: clampIntEnv(env.FACTS_MAX_LINES, 1, 50, 20),
		maxChars: clampIntEnv(env.FACTS_MAX_CHARS, 256, 4096, 2048),
	};
}

/** Default file location: ~/.pi/agent/facts.md — same HOME-aware placement as
 *  lessons.md (NOT under .memory/, NOT under ~/.pi/agent/memory/ so it can
 *  never collide with @pify/memory if upstream is installed some day). */
export function factsFilePath(env: NodeJS.ProcessEnv = process.env, home = process.env.HOME ?? ""): string {
	return env.FACTS_FILE && env.FACTS_FILE.trim() ? env.FACTS_FILE : join(home, ".pi", "agent", "facts.md");
}

export function todayIso(now: () => Date = () => new Date()): string {
	return now().toISOString().slice(0, 10);
}

// --- PUSH injection selection --------------------------------------------------------

const PRIORITY_ORDER: Record<FactPriority, number> = { P1: 0, P2: 1, P3: 2 };

/** Select live facts for the injected block: P1 first, then P2, then P3;
 *  within a tier, newest origin date first. Cut by BOTH line and char budget
 *  (the rendered line must fit, so selection counts serialized length).
 *  `today` (recommended at inject time): a fact whose ttl has arrived is NOT
 *  injected even before its tombstone is physically written (injector is
 *  read-only; the write belongs to the curator/trigger). */
export function selectFactsForInject(
	facts: Fact[],
	budget: { maxLines: number; maxChars: number },
	today?: string,
): Fact[] {
	const live = facts.filter((f) => isLiveFact(f) && (!today || !f.ttl || today < f.ttl));
	const sorted = live.slice().sort((a, b) => {
		const p = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
		if (p !== 0) return p;
		return a.date < b.date ? 1 : a.date > b.date ? -1 : 0;
	});
	const out: Fact[] = [];
	let chars = 0;
	for (const f of sorted) {
		if (out.length >= budget.maxLines) break;
		const len = formatFact(f).length + 1; // +1 newline
		if (chars + len > budget.maxChars) continue; // try a shorter one from the same tier
		out.push(f);
		chars += len;
	}
	return out;
}

/** Render the PUSH block injected at session_start / after compaction. */
export function renderFactsBlock(facts: Fact[]): string {
	if (!facts.length) return "";
	const lines = facts.map((f) => `[${f.category}] ${f.text} (#${f.id})`);
	return ["Facts (durable user/project memory — treat as standing instructions):", ...lines].join("\n");
}
