import { describe, expect, test } from "bun:test";
import { validateResearchReport, researchReportDigest, REPORT_MIN_CHARS, REPORT_MAX_CHARS } from "./research-report.ts";

function goodReport(token?: string): string {
	const head = token ? `${token}\n\n` : "";
	return `${head}## Summary
Direct answer in two sentences covering the sweep result and the deltas.

## Findings
1. **pi-watchdog-supervisor 0.1.1** — real npm package, tarball ships full TS source; license unknown (red flag). [Source](https://www.npmjs.com/package/pi-watchdog-supervisor)
2. **pi-swarm-supervisor 0.2.0** — MIT, active; stuck-heuristics worth borrowing. [Source](https://github.com/gvkhosla/pi-swarm-supervisor)

## Sources
- Kept: npm registry sweep (verified against registry API)
- Dropped: github.laiyagushi.com mirror (untrusted domain)

## Gaps
Codex CLI watchdog patterns not swept — next pass.`;
}

describe("research_report validation (#51)", () => {
	test("accepts a well-formed report", () => {
		const v = validateResearchReport({ report: goodReport(), token: undefined });
		expect(v.ok).toBe(true);
		expect(v.problems).toEqual([]);
		expect(v.stats.sections >= 2).toBe(true);
		expect(v.stats.chars >= REPORT_MIN_CHARS).toBe(true);
	});

	test("rejects a too-short report with an envelope problem", () => {
		const v = validateResearchReport({ report: "## Summary\nshort", token: undefined });
		expect(v.ok).toBe(false);
		expect(v.problems.some((p) => p.includes("minimum"))).toBe(true);
	});

	test("rejects a report above the ceiling", () => {
		const padded = goodReport() + "\n" + "x".repeat(REPORT_MAX_CHARS);
		const v = validateResearchReport({ report: padded, token: undefined });
		expect(v.ok).toBe(false);
		expect(v.problems.some((p) => p.includes("ceiling"))).toBe(true);
	});

	test("rejects a missing ## Summary section", () => {
		const noSummary = goodReport().replace("## Summary", "## TL;DR");
		const v = validateResearchReport({ report: noSummary, token: undefined });
		expect(v.ok).toBe(false);
		expect(v.problems.some((p) => p.includes("## Summary"))).toBe(true);
	});

	test("token declared but absent from the report is rejected", () => {
		const v = validateResearchReport({ report: goodReport(), token: "LANDSCAPE-WATCHDOG" });
		expect(v.ok).toBe(false);
		expect(v.problems.some((p) => p.includes("LANDSCAPE-WATCHDOG") && p.includes("FIRST line"))).toBe(true);
	});

	test("token present in the report verifies", () => {
		const v = validateResearchReport({ report: goodReport("LANDSCAPE-WATCHDOG"), token: "LANDSCAPE-WATCHDOG" });
		expect(v.ok).toBe(true);
		expect(v.stats.tokenVerified).toBe(true);
	});
});

describe("researchReportDigest (#51)", () => {
	test("prepends the token when the report does not lead with it", () => {
		const d = researchReportDigest(goodReport(), "LANDSCAPE-WATCHDOG");
		expect(d.startsWith("LANDSCAPE-WATCHDOG\n")).toBe(true);
		expect(d).toContain("## Summary");
	});

	test("leaves the report untouched when the first line already carries the token", () => {
		const r = goodReport("LANDSCAPE-WATCHDOG");
		const d = researchReportDigest(r, "LANDSCAPE-WATCHDOG");
		expect(d.startsWith("LANDSCAPE-WATCHDOG\n")).toBe(true);
		expect(d).toBe(r);
	});

	test("no token — report passes through trimmed", () => {
		const d = researchReportDigest(`  ${goodReport()}  `, undefined);
		expect(d).toBe(goodReport());
	});
});
