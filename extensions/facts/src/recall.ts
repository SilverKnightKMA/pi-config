/**
 * facts_recall — PULL recall backend (memory part 2, step P1c / #176).
 *
 * Pure keyword search over parsed facts — the grep-grade backend. The docs
 * record the agreed swap threshold (plan 2026-09-21): move to FTS5/BM25 when
 * facts.md exceeds ~100KB OR false-hit noise grows; grep stays right until
 * then (deterministic, zero deps, swappable behind this module's signature).
 *
 * Two-stage matching, both deterministic:
 *  PASS 1  all-keywords (AND): a fact matches when its text contains EVERY
 *          keyword (case-insensitive substring).
 *  PASS 2  any-keyword (OR), only when PASS 1 finds nothing: facts ranked by
 *          total keyword occurrences, capped.
 */

import { FACT_CATEGORIES, type Fact, type FactCategory, formatFact, isLiveFact } from "./store.ts";

export interface RecallQuery {
	query: string;
	category?: string;
	includeTombstoned?: boolean;
}

export interface RecallHit {
	fact: Fact;
	score: number;
	matchedAll: boolean;
}

export interface RecallReport {
	hits: RecallHit[];
	mode: "all-keywords" | "any-keyword" | "empty-query" | "unknown-category";
	scanned: number; // facts considered after category/liveness filters
	live: number;
	tombstoned: number;
	note?: string;
}

export const RECALL_MAX_HITS = 30;

function keywordScore(textLower: string, kws: string[]): { total: number; matched: number } {
	let total = 0;
	let matched = 0;
	for (const k of kws) {
		const c = textLower.split(k).length - 1;
		if (c > 0) {
			matched++;
			total += c;
		}
	}
	return { total, matched };
}

export function recallFacts(facts: Fact[], q: RecallQuery): RecallReport {
	const live = facts.filter(isLiveFact).length;
	const tombstoned = facts.length - live;

	if (!q.query.trim()) {
		return { hits: [], mode: "empty-query", scanned: 0, live, tombstoned, note: "query is empty" };
	}
	if (q.category && !FACT_CATEGORIES.includes(q.category as FactCategory)) {
		return {
			hits: [],
			mode: "unknown-category",
			scanned: 0,
			live,
			tombstoned,
			note: `unknown category '${q.category}' — expected one of ${FACT_CATEGORIES.join("|")}`,
		};
	}

	const pool = facts.filter(
		(f) =>
			(q.includeTombstoned || isLiveFact(f)) && (!q.category || f.category === (q.category as FactCategory)),
	);
	const kws = q.query
		.trim()
		.split(/\s+/)
		.map((k) => k.toLowerCase())
		.filter(Boolean);

	// PASS 1 — every keyword must match.
	let hits: RecallHit[] = [];
	for (const f of pool) {
		const { total, matched } = keywordScore(f.text.toLowerCase(), kws);
		if (matched === kws.length && matched > 0) hits.push({ fact: f, score: total, matchedAll: true });
	}
	let mode: RecallReport["mode"] = "all-keywords";

	// PASS 2 — OR fallback only when AND found nothing.
	if (hits.length === 0) {
		for (const f of pool) {
			const { total, matched } = keywordScore(f.text.toLowerCase(), kws);
			if (matched > 0) hits.push({ fact: f, score: total, matchedAll: false });
		}
		if (hits.length > 0) mode = "any-keyword";
	}

	hits = hits
		.sort((a, b) => b.score - a.score || (a.fact.date < b.fact.date ? 1 : a.fact.date > b.fact.date ? -1 : 0))
		.slice(0, RECALL_MAX_HITS);

	return { hits, mode, scanned: pool.length, live, tombstoned };
}

/** Render the tool result text (agent-facing). */
export function renderRecallReport(r: RecallReport): string {
	const head = `facts_recall: ${r.hits.length} hit(s), mode=${r.mode}, scanned=${r.scanned} (live=${r.live} tombstoned=${r.tombstoned})`;
	if (r.note) return `${head}\n${r.note}`;
	if (r.hits.length === 0) {
		return `${head}\nno matching fact — the durable tier may not cover this topic yet`;
	}
	const lines = r.hits.map((h) => {
		const flag = h.fact.tombstoned ? `[dead:${h.fact.reason ?? "?"}]` : "[live]";
		return `${flag} ${formatFact(h.fact)}${h.matchedAll ? "" : " (partial match)"}`;
	});
	return [head, ...lines].join("\n");
}
