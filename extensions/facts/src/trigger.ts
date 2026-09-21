/**
 * facts trigger — P2 regex correction-detector (memory part 2, #179).
 *
 * Concept credit: pi-hermes-memory 0.9.8 correction-detector (MIT) —
 * deterministic 2-pass regex on the user's own typed words, $0 model calls,
 * engine-side hook. The VI pattern set, the replace-structure route, and the
 * store-grounded keyword matching are ours (docs/upstream-registry.md).
 *
 * PASS 1 (strong): the sentence must contain a correction marker
 *   VI: thôi / từ giờ / từ nay / đừng / ngừng / không dùng / đã bảo / sai rồi /
 *       nhầm rồi / bỏ ... đi
 *   EN: actually / don't / wrong / stop using / no longer / from now on
 * PASS 2 (negative): reject uncertain shapes — questions, hedges
 *   ("hình như", "có phải", "why", "what if", trailing "?").
 *
 * Two matching routes, both grounded in the STORE (the old topic must already
 * be a live fact — the trigger only corrects what exists, never invents):
 *   ROUTE A (replace structure): "X thay cho Y" / "X instead of Y" → old
 *          keywords come from Y only (the thing being replaced).
 *   ROUTE B (bare strong marker): keywords = sentence tokens minus pattern
 *          words; needs ≥2 distinct keyword hits on one live fact.
 * Fail-silent on no target (tier-5 curator catches the rest later).
 *
 * Dry-run doctrine (plan 2026-09-21): log-only for the first 2 weeks;
 * FACTS_TRIGGER_APPLY=1 enables writes. FACTS_TRIGGER=0 disables everything.
 */

import type { Fact } from "./store.ts";

export const TRIGGER_STRONG: RegExp[] = [
	// VI patterns are plain substrings: JS \b word boundaries only work for
	// ASCII [A-Za-z0-9_] — "đừng"/"thôi" at a string edge would never match
	// with \b. False positives stay cheap here: PASS 2 + store-grounding gate
	// the fire anyway.
	/thôi/i,
	/từ\s+giờ/i,
	/từ\s+nay/i,
	/đừng/i,
	/ngừng/i,
	/không\s+dùng/i,
	/đã\s+bảo/i,
	/sai\s+rồi/i,
	/nhầm\s+rồi/i,
	/bỏ\s+.+\s+đi/i,
	/\bactually\b/i,
	/\bdon'?t\b/i,
	/\bwrong\b/i,
	/\bstop\s+using\b/i,
	/\bno\s+longer\b/i,
	/\bfrom\s+now\s+on\b/i,
];

const TRIGGER_NEGATIVE: RegExp[] = [
	/\?\s*$/,
	/hình\s+như/i,
	/có\s+phải/i,
	/phải\s+không/i,
	/tại\s+sao/i,
	/\bwhy\b/i,
	/\bwhat\s+if\b/i,
	/mình\s+thấy\s+có\s+vẻ/i, // hedge — uncertain, not a correction
	/là\s+sao/i,
];

/** Replace-structure route: "<new> thay cho <old>" family. */
const REPLACE_RE =
	/(.+?)\s+(?:thay\s+cho|thay\s+vì|thay\s+thế\s+cho|thay\s+chỗ|thay|instead\s+of|rather\s+than)\s+(.+)/i;

/** Pattern + filler words stripped before keyword extraction. */
const STOPWORDS = new Set<string>(
	[
		// VI pattern words + fillers
		"thôi", "từ", "giờ", "nay", "đừng", "ngừng", "không", "dùng", "nữa", "đã", "báo", "sai",
		"rồi", "nhầm", "bỏ", "đi", "nhé", "nhá", "nha", "ém", "em", "mình", "cậu", "bạn", "cái",
		"này", "kia", "và", "hoặc", "nhưng", "mà", "của", "với", "cho", "trong", "ngoài", "là",
		"có", "được", "vào", "lên", "ra", "tại", "vì", "thế", "khi", "nếu", "thì",
		// EN pattern words + fillers
		"actually", "dont", "don", "do", "not", "wrong", "stop", "using", "no", "longer", "from",
		"now", "on", "instead", "of", "rather", "than", "please", "the", "a", "an", "to", "for",
		"with", "and", "or", "but", "is", "are", "was", "were", "be", "been", "use", "it", "this",
		"that", "we", "you", "i",
	].map((w) => w.toLowerCase()),
);

export interface CorrectionDetection {
	sentence: string;
	pattern: string;
	route: "replace-structure" | "bare-strong";
	/** Keywords describing the OLD topic (store-grounded match input). */
	oldKeywords: string[];
}

function splitSentences(text: string): string[] {
	return text
		.split(/\n+/)
		.flatMap((line) => line.split(/(?<=[.!?])\s+/))
		.map((s) => s.trim())
		.filter(Boolean);
}

export function tokenize(sentence: string): string[] {
	return Array.from(
		new Set(
			sentence
				.toLowerCase()
				.replace(/[.,!?;:"'`()[\]{}]+/g, " ")
				.split(/\s+/)
				.filter((t) => t.length >= 2 && !STOPWORDS.has(t)),
		),
	);
}

/** PASS 1 + PASS 2 over the whole message. First surviving sentence wins. */
export function detectCorrection(text: string): CorrectionDetection | null {
	for (const sentence of splitSentences(text)) {
		const strong = TRIGGER_STRONG.find((re) => re.test(sentence));
		if (!strong) continue;
		if (TRIGGER_NEGATIVE.some((re) => re.test(sentence))) continue; // uncertain — fail-silent
		const rep = REPLACE_RE.exec(sentence);
		if (rep) {
			const oldKeywords = tokenize(rep[2]);
			if (oldKeywords.length >= 1) {
				return { sentence, pattern: strong.source, route: "replace-structure", oldKeywords };
			}
		}
		const kws = tokenize(sentence);
		if (kws.length >= 2) {
			return { sentence, pattern: strong.source, route: "bare-strong", oldKeywords: kws };
		}
	}
	return null;
}

export interface TriggerMatch {
	fact: Fact;
	score: number;
}

/** Best live fact matching the old-topic keywords. ROUTE A needs ≥1 hit,
 *  ROUTE B needs ≥2 distinct hits (it has no structural anchor). */
export function matchOldFact(facts: Fact[], d: CorrectionDetection): TriggerMatch | null {
	const min = d.route === "replace-structure" ? 1 : 2;
	let best: TriggerMatch | null = null;
	for (const f of facts) {
		if (f.tombstoned) continue;
		const low = f.text.toLowerCase();
		const score = d.oldKeywords.reduce((n, k) => n + (low.includes(k) ? 1 : 0), 0);
		if (score >= min && (!best || score > best.score)) best = { fact: f, score };
	}
	return best;
}

export interface TriggerOutcome {
	status: "no-fire" | "fired-no-target" | "fired-target";
	detection?: CorrectionDetection;
	target?: Fact;
	/** The new fact text (the corrected sentence itself). */
	newText?: string;
}

/** Pure decision: detect + ground. Applying is the engine's job (atomic write). */
export function evaluateTrigger(text: string, facts: Fact[]): TriggerOutcome {
	const d = detectCorrection(text);
	if (!d) return { status: "no-fire" };
	const m = matchOldFact(facts, d);
	if (!m) return { status: "fired-no-target", detection: d };
	return { status: "fired-target", detection: d, target: m.fact, newText: d.sentence.trim() };
}
