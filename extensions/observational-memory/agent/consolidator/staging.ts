/**
 * v1.4.56 staging: the consolidator model never touches topic files directly. It submits
 * dated sections and a whole-file JOURNEY; this module is the pure engine core (no pi API):
 * target jail, section sanitizing, front-matter maintenance, and the JOURNEY budget gate that
 * replaces the v1.4.54 post-hoc `enforceJourneyCap` (rejected writes leave the old file intact —
 * no mechanical data loss).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "../../src/memory/paths.js";

export type StagedSection = { target: string; section: string; summary?: string };
export type ApplyOutcome = {
	applied: { target: string; created: boolean }[];
	rejected: { target: string; reason: string }[];
};

export const SECTION_CHAR_CAP = 8_000;
const SLUG_RE = /^[a-z0-9][a-z0-9-]*\.md$/;
const FORBIDDEN_TARGETS = new Set(["index.md", "journey.md"]);
const FM_UPDATED_RE = /^updated:.*$/m;
const FM_SUMMARY_RE = /^summary:.*$/m;
const SUMMARY_CHAR_CAP = 140;

/** Jail: root-level kebab-case slug only. No separators, no reserved names, one flat level. */
export function normalizeTarget(raw: string): string | undefined {
	const t = raw.trim().toLowerCase();
	if (t.includes("/") || t.includes("\\") || t.includes("..")) return undefined;
	if (!SLUG_RE.test(t)) return undefined;
	if (FORBIDDEN_TARGETS.has(t)) return undefined;
	return t;
}

/** Section sanitizer: trims, strips a leading front-matter block if the model adds one,
 * rejects empty or over-cap sections. No silent truncation — the model resubmits tighter. */
export function sanitizeSection(section: string): { ok: true; text: string } | { ok: false; reason: string } {
	let s = (section ?? "").trim();
	if (!s) return { ok: false, reason: "empty section" };
	if (s.startsWith("---")) {
		s = s.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
		if (!s) return { ok: false, reason: "section was only a front-matter block" };
	}
	if (s.length > SECTION_CHAR_CAP) {
		return { ok: false, reason: `section is ${s.length} chars > cap ${SECTION_CHAR_CAP}; split or tighten it` };
	}
	return { ok: true, text: s };
}

/** One-line index summary; capped (with ellipsis), whitespace-collapsed; empty → undefined. */
export function sanitizeSummary(raw: string | undefined): string | undefined {
	const s = (raw ?? "").trim().replace(/\s+/g, " ");
	if (!s) return undefined;
	return s.length > SUMMARY_CHAR_CAP ? `${s.slice(0, SUMMARY_CHAR_CAP - 1)}…` : s;
}

/** Replace the FIRST line matching `re` (multiline, non-global) with `line`. */
function replaceFirstLine(content: string, re: RegExp, line: string): string {
	const m = re.exec(content);
	if (!m) return content;
	return content.slice(0, m.index) + line + content.slice(m.index + m[0].length);
}

export function buildFrontMatter(o: { id: string; title: string; summary: string; updated: string }): string {
	return `---\nid: ${o.id}\ntitle: ${o.title}\nsummary: ${o.summary}\nupdated: ${o.updated}\n---\n`;
}

export function deriveTitle(id: string): string {
	return id
		.split("-")
		.map((w) => (w.length > 0 ? w[0].toUpperCase() + w.slice(1) : w))
		.join(" ");
}

function firstLine(text: string): string {
	const line = text.split("\n").find((l) => l.trim().length > 0) ?? "";
	return line.replace(/^#+\s*/, "").trim();
}

/**
 * Apply a batch of staged sections: append each to its topic file under an engine-written
 * heading (`## <at> (batch <batchId>)`); bump `updated:`; replace `summary:` when supplied;
 * create brand-new files with engine-built front-matter. Sequential per item; a rejected item
 * never blocks the others. Existing files without front-matter are rejected (the engine does
 * not append blind into files it cannot index).
 */
export function applyStagedSections(
	root: string,
	batchId: string,
	at: string,
	sections: StagedSection[],
): ApplyOutcome {
	const out: ApplyOutcome = { applied: [], rejected: [] };
	for (const item of sections ?? []) {
		const target = normalizeTarget(String(item.target ?? ""));
		if (!target) {
			out.rejected.push({
				target: String(item.target ?? ""),
				reason: "target must be a root-level <slug>.md (no paths; INDEX/JOURNEY reserved)",
			});
			continue;
		}
		const section = sanitizeSection(String(item.section ?? ""));
		if (!section.ok) {
			out.rejected.push({ target, reason: section.reason });
			continue;
		}
		const summary = sanitizeSummary(item.summary);
		const path = join(root, target);
		const heading = `## ${at} (batch ${batchId})`;
		if (existsSync(path)) {
			let current: string;
			try {
				current = readFileSync(path, "utf-8");
			} catch {
				out.rejected.push({ target, reason: "existing file unreadable" });
				continue;
			}
			if (!current.startsWith("---")) {
				out.rejected.push({ target, reason: "existing file has no front-matter; engine will not append blind" });
				continue;
			}
			let next = `${current.replace(/\s+$/, "")}\n\n${heading}\n${section.text}\n`;
			next = replaceFirstLine(next, FM_UPDATED_RE, `updated: ${at}`);
			if (summary) next = replaceFirstLine(next, FM_SUMMARY_RE, `summary: ${summary}`);
			atomicWrite(path, next);
			out.applied.push({ target, created: false });
		} else {
			const id = target.replace(/\.md$/, "");
			const fmSummary = summary ?? sanitizeSummary(firstLine(section.text)) ?? `${deriveTitle(id)} topic`;
			atomicWrite(
				path,
				`${buildFrontMatter({ id, title: deriveTitle(id), summary: fmSummary, updated: at })}\n${heading}\n${section.text}\n`,
			);
			out.applied.push({ target, created: true });
		}
	}
	return out;
}

// ---- JOURNEY budget gate (v1.4.56; replaces the v1.4.54 post-run mechanical cap) ----

export function countWords(text: string): number {
	return text.split(/\s+/).filter(Boolean).length;
}

/** Words ≈ tokens x 3/4; floor 50 guards against absurdly small budgets.
 * v1.4.62: drop the 1.25 tolerance (port-side) — upstream pi-observational-memory
 * guides ~750 words per 1,000 tok, no padding. The gate now matches prompt + display. */
export function journeyWordBudget(targetTokens: number, tolerance = 1): number {
	return Math.max(50, Math.round((targetTokens * 3 * tolerance) / 4));
}

export function checkJourneyBudget(
	content: string,
	targetTokens: number,
	tolerance = 1,
): { ok: boolean; words: number; budget: number; overBy: number } {
	const budget = journeyWordBudget(targetTokens, tolerance);
	const words = countWords(content);
	return { ok: words <= budget, words, budget, overBy: words > budget ? words - budget : 0 };
}
