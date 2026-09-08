/**
 * Verify layer 0+1 for the task extension (pi-config, 2026-09-09).
 *
 * Design (user-settled, see learn/pify-pending-2026-09-07.md "Row 9"):
 * - Layer 0: task_create may declare a verify spec {lane, probes, strict}.
 *   Probes are MATCHERS over the session's recorded bash tool calls — the
 *   extension NEVER executes probe commands (no injection surface; a green
 *   probe means the worker really ran the command through its normal bash
 *   pipeline). Red-green at define: a probe that already matches the run log
 *   cannot discriminate done/not-done and is rejected.
 * - Layer 1: task_update status=completed audits each probe against the run
 *   log. green = cmd ran + expect found · red = cmd never ran (worker-fault)
 *   · amber = cmd ran but expect mismatched (possible wrong spec — the real
 *   observed output is surfaced so the worker can self-correct or amend the
 *   probe; full adjudication is layer 2, not built yet).
 *
 * Pure module: no pi imports, no fs, no clock — fully unit-testable.
 */

import { isRecord } from "./types.ts";

export type VerifyLane = "state" | "judgment";

export interface Probe {
	/** Substring that must appear in a bash command the worker really ran. */
	pattern: string;
	/** Optional substring expected in that command's real output. */
	expect?: string;
}

export interface VerifySpec {
	lane: VerifyLane;
	probes: Probe[];
	/** Escalation flag — honored by layer 2 (not built); recorded now. */
	strict: boolean;
}

export const MAX_PROBES = 8;

export interface RunLogEntry {
	tool: string;
	cmd: string;
	output: string;
	ts: number;
}

export type ProbeStatus = "green" | "amber" | "red";

export interface ProbeResult {
	pattern: string;
	expect?: string;
	status: ProbeStatus;
	/** Real observed output excerpt (amber/green only). */
	observed?: string;
}

export type AuditVerdict = "pass" | "fail" | "spec-fault";

export interface AuditOutcome {
	verdict: AuditVerdict;
	results: ProbeResult[];
}

export interface TaskAudit {
	at: number;
	verdict: AuditVerdict | "pass-judgment";
	summary: string;
}

// ── parse (layer 0) ─────────────────────────────────────────────────────

export function parseVerify(
	raw: unknown,
): { spec: VerifySpec | null; error: string | null; notes: string[] } {
	const notes: string[] = [];
	if (!isRecord(raw)) return { spec: null, error: "verify must be an object {lane, probes, strict}", notes };

	let lane: VerifyLane = "judgment";
	if (raw.lane !== undefined) {
		if (raw.lane !== "state" && raw.lane !== "judgment") {
			return { spec: null, error: `verify.lane must be "state" or "judgment"`, notes };
		}
		lane = raw.lane;
	}

	let probes: Probe[] = [];
	if (raw.probes !== undefined) {
		if (!Array.isArray(raw.probes)) return { spec: null, error: "verify.probes must be an array", notes };
		if (raw.probes.length > MAX_PROBES) {
			return { spec: null, error: `verify.probes: max ${MAX_PROBES} probes`, notes };
		}
		for (const p of raw.probes) {
			if (!isRecord(p) || typeof p.pattern !== "string" || p.pattern.trim().length < 3) {
				return { spec: null, error: "each probe needs a pattern (string, ≥3 chars)", notes };
			}
			if (p.expect !== undefined && typeof p.expect !== "string") {
				return { spec: null, error: "probe.expect must be a string", notes };
			}
			probes.push(p.expect === undefined ? { pattern: p.pattern } : { pattern: p.pattern, expect: p.expect });
		}
	}

	// Structural floor: declaring probes forces the state lane — a task with
	// checkable commands cannot downgrade itself to judgment.
	if (probes.length > 0 && lane === "judgment") {
		lane = "state";
		notes.push("probes declared → lane forced to state");
	}

	let strict = false;
	if (raw.strict !== undefined) {
		if (typeof raw.strict !== "boolean") return { spec: null, error: "verify.strict must be boolean", notes };
		strict = raw.strict;
	}

	return { spec: { lane, probes, strict }, error: null, notes };
}

// ── matching ────────────────────────────────────────────────────────────

function matchEntry(probe: Probe, runLog: RunLogEntry[]): RunLogEntry | null {
	let best: RunLogEntry | null = null;
	for (const entry of runLog) {
		if (!entry.cmd.includes(probe.pattern)) continue;
		if (best === null || entry.ts >= best.ts) best = entry;
	}
	return best;
}

function statusOf(probe: Probe, entry: RunLogEntry | null): ProbeResult {
	if (entry === null) return { pattern: probe.pattern, expect: probe.expect, status: "red" };
	if (probe.expect === undefined) {
		return { pattern: probe.pattern, expect: probe.expect, status: "green", observed: excerpt(entry.output) };
	}
	if (entry.output.includes(probe.expect)) {
		return { pattern: probe.pattern, expect: probe.expect, status: "green", observed: excerpt(entry.output) };
	}
	return {
		pattern: probe.pattern,
		expect: probe.expect,
		status: "amber",
		observed: excerpt(entry.output),
	};
}

function excerpt(output: string): string {
	const text = output.trim();
	if (text.length <= 240) return text;
	return `${text.slice(0, 240)}…`;
}

// ── layer 0: red-green at define ────────────────────────────────────────

/**
 * A probe is valid at define time only if it is NOT already green: work has
 * not happened yet, so a matching command+expect in the run log means the
 * probe cannot discriminate done/not-done (fail-to-pass structure, à la
 * SWE-bench). Amber (ran, expect mismatched) still discriminates → accepted.
 */
export function redGreenCheck(
	spec: VerifySpec,
	runLog: RunLogEntry[],
): { ok: boolean; reasons: string[] } {
	const reasons: string[] = [];
	for (const probe of spec.probes) {
		const entry = matchEntry(probe, runLog);
		if (entry === null) continue;
		if (probe.expect === undefined || entry.output.includes(probe.expect)) {
			reasons.push(
				`probe "${probe.pattern}"${probe.expect ? ` expect "${probe.expect}"` : ""} đã XANH ngay lúc tạo — không phân biệt được xong/chưa xong`,
			);
		}
	}
	return { ok: reasons.length === 0, reasons };
}

// ── layer 1: completion audit ───────────────────────────────────────────

export function auditCompletion(spec: VerifySpec, runLog: RunLogEntry[]): AuditOutcome {
	if (spec.probes.length === 0) return { verdict: "pass", results: [] };
	const results = spec.probes.map((probe) => statusOf(probe, matchEntry(probe, runLog)));
	if (results.some((r) => r.status === "red")) return { verdict: "fail", results };
	if (results.some((r) => r.status === "amber")) return { verdict: "spec-fault", results };
	return { verdict: "pass", results };
}

export function summarizeAudit(audit: AuditOutcome): string {
	const lines = audit.results.map((r) => {
		if (r.status === "green") return `✓ "${r.pattern}" ran${r.expect ? `, output chứa "${r.expect}"` : ""}`;
		if (r.status === "red") return `✗ "${r.pattern}" — CHƯA THẤY lệnh này trong sổ ghi session. Hãy chạy nó (qua bash thật) rồi khai xong lại.`;
		return `⚠ "${r.pattern}" đã chạy nhưng output KHÔNG chứa "${r.expect}". Thực tế: ${r.observed ?? ""} — hoặc việc chưa đạt, hoặc probe khai sai (amend verify, tối đa 2 lần).`;
	});
	return lines.join("\n");
}

// ── judgment lane: evidence ↔ run-log cross-check (advisory) ────────────

export interface EvidenceClaim {
	claim: string;
	found: boolean;
}

/**
 * Extract backticked command-ish snippets from the evidence string and check
 * each against the run log. Advisory in v1 (layer 2 adjudicates later):
 * unfound claims ride along as warnings, they do not block completion of
 * judgment-lane tasks.
 */
export function checkEvidenceCommands(evidence: string, runLog: RunLogEntry[]): EvidenceClaim[] {
	const claims: string[] = [];
	const re = /`([^`\n]{4,120})`/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(evidence)) !== null) claims.push(m[1].trim());
	const seen = new Set<string>();
	const out: EvidenceClaim[] = [];
	for (const claim of claims) {
		if (seen.has(claim)) continue;
		seen.add(claim);
		const found = runLog.some((e) => e.cmd.includes(claim) || claim.includes(e.cmd));
		out.push({ claim, found });
	}
	return out;
}

/** Rebuild a verify spec from an untrusted snapshot (session replay). Returns
 * undefined for anything that does not satisfy the layer-0 invariants,
 * including the structural floor (probes ⇒ state lane). */
export function sanitizeVerify(raw: unknown): VerifySpec | undefined {
	if (!isRecord(raw)) return undefined;
	const lane = raw.lane === "state" || raw.lane === "judgment" ? raw.lane : undefined;
	if (lane === undefined) return undefined;
	if (!Array.isArray(raw.probes)) return undefined;
	const probes: Probe[] = [];
	for (const p of raw.probes) {
		if (!isRecord(p) || typeof p.pattern !== "string" || p.pattern.length < 3) return undefined;
		probes.push(
			p.expect === undefined || typeof p.expect !== "string"
				? { pattern: p.pattern }
				: { pattern: p.pattern, expect: p.expect },
		);
	}
	if (probes.length > 0 && lane === "judgment") return undefined;
	if (probes.length > MAX_PROBES) return undefined;
	return { lane, probes, strict: raw.strict === true };
}
