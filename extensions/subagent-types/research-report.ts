/**
 * research_report (#51) — a verified submission path for read-only researchers.
 *
 * Problem it replaces: tasks that need a durable artifact used to instruct the
 * child to "write the brief via bash", which pushed read-only researchers into
 * safe_bash heredoc workarounds (the exact anti-pattern the user banned — teach
 * the native tool, never a workaround). The report IS the artifact: the child
 * submits it through this tool, the engine validates the shape, and the full
 * text travels to the main over the existing message channel — the pool's
 * expect-gate then reads the completion token from the channel report, the
 * same string the tool verified locally. Failures return a denial envelope
 * (#43): WHAT / WHY / NEXT — never a workaround.
 *
 * Pure validation is split out so tests never need a live channel.
 */

import { outcomeLine, parseDeclaredOutcome, stripDeclaration } from "./gate-contract.ts";

export interface ResearchReportInput {
	report: string;
	/** Optional completion token the task demanded (e.g. LANDSCAPE-WATCHDOG). */
	token?: string;
}

export interface ResearchReportVerdict {
	ok: boolean;
	/** Denial-envelope problems — empty when ok. */
	problems: string[];
	/** stats.declared: the child's own OUTCOME: line, if any (claim, not evidence — #294 P5). */
	stats: { chars: number; sections: number; tokenVerified: boolean; declared?: string };
}

export const REPORT_MIN_CHARS = 400;
export const REPORT_MAX_CHARS = 20000;

/** Validate a research report submission. Pure, deterministic. */
export function validateResearchReport(input: ResearchReportInput): ResearchReportVerdict {
	const text = (input.report ?? "").trim();
	const problems: string[] = [];
	const token = (input.token ?? "").trim();

	if (text.length < REPORT_MIN_CHARS) {
		problems.push(
			`Report is ${text.length} chars — below the ${REPORT_MIN_CHARS}-char minimum. A research brief needs Summary + Findings + Sources + Gaps with real content.`,
		);
	}
	if (text.length > REPORT_MAX_CHARS) {
		problems.push(
			`Report is ${text.length} chars — above the ${REPORT_MAX_CHARS}-char ceiling. Cut to the essential findings; the main agent keeps every word you send.`,
		);
	}
	if (!/^##\s+Summary\b/m.test(text)) {
		problems.push('Missing "## Summary" section — the template requires it as the first section.');
	}
	const sections = (text.match(/^##\s+\S/gm) ?? []).length;
	if (sections < 2) {
		problems.push(
			`Only ${sections} "## " section header(s) found — a brief needs at least 2 (Summary + one more, e.g. Findings).`,
		);
	}
	let tokenVerified = false;
	if (token) {
		if (!text.includes(token)) {
			problems.push(
				`Completion token "${token}" is declared but does not appear verbatim in the report. Put it on the FIRST line of the report.`,
			);
		} else {
			tokenVerified = true;
		}
	}
	const declared = parseDeclaredOutcome(text);
	return { ok: problems.length === 0, problems, stats: { chars: text.length, sections, tokenVerified, declared } };
}

/** Build the digest the channel carries to the main: token line + full report.
 *
 * #294 P5 (honest outcome): when the child ended with an OUTCOME: declaration,
 * the digest leads with the machine-readable [outcome] line and the raw
 * declaration is stripped from the body — the main reads the settled fact
 * without prose-hunting, and the claim is named as a claim.
 */
export function researchReportDigest(text: string, token?: string): string {
	const tok = (token ?? "").trim();
	const declared = parseDeclaredOutcome(text);
	const body = declared ? stripDeclaration(text) : text.trim();
	const note = declared ? outcomeLine(declared, "not-requested") : "";
	const outcomeNote = note ? `${note}\n\n` : "";
	if (tok) {
		const firstBodyLine = body.split("\n", 1)[0] ?? "";
		if (firstBodyLine.includes(tok)) {
			// token already leads the body — inject the outcome note right after it
			const rest = body.slice(firstBodyLine.length).replace(/^\n+/, "");
			return `${firstBodyLine}\n\n${outcomeNote}${rest}`;
		}
		return `${tok}\n\n${outcomeNote}${body}`;
	}
	return `${outcomeNote}${body}`;
}
