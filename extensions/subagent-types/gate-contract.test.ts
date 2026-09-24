/**
 * gate-contract.test.ts — honest outcomes port (#294 P5, @pify/swarm 0.12.1).
 *
 * The headline regression each suite guards:
 *  - exit 0 without the expected evidence is result_missing, NEVER a pass;
 *  - a gate that could not run is no_attestation, never a failure of the work;
 *  - a blocked declaration forbids a repair pass; a read-only agent gets none.
 */

import { describe, expect, test } from "bun:test";
import {
	canWrite,
	contractProblems,
	deriveOutcome,
	evaluateGate,
	gateVerification,
	outcomeLine,
	parseDeclaredOutcome,
	repairAllowed,
	stripDeclaration,
} from "./gate-contract.ts";
import { researchReportDigest, validateResearchReport } from "./research-report.ts";

describe("parseDeclaredOutcome", () => {
	test("absent or unparseable means no claim, never a failure", () => {
		expect(parseDeclaredOutcome(undefined)).toBeUndefined();
		expect(parseDeclaredOutcome("")).toBeUndefined();
		expect(parseDeclaredOutcome("## Summary\nall good, nothing to see")).toBeUndefined();
	});
	test("parses a trailing declaration, case-insensitive", () => {
		expect(parseDeclaredOutcome("did the thing\nOUTCOME: Blocked")).toBe("blocked");
		expect(parseDeclaredOutcome("outcome: succeeded")).toBe("succeeded");
	});
	test("last declaration wins when the report revises itself", () => {
		expect(parseDeclaredOutcome("OUTCOME: succeeded\n...on reflection\nOUTCOME: failed")).toBe("failed");
	});
});

describe("stripDeclaration", () => {
	test("removes the declaration line and normalizes whitespace", () => {
		expect(stripDeclaration("body one\n\nOUTCOME: blocked\n\nbody two")).toBe("body one\n\nbody two");
	});
});

describe("gateVerification + deriveOutcome precedence", () => {
	test("gate outcome → verification translation", () => {
		expect(gateVerification("success")).toBe("passed");
		expect(gateVerification("failure")).toBe("failed");
		expect(gateVerification("timeout")).toBe("failed");
		expect(gateVerification("result_missing")).toBe("inconclusive");
		expect(gateVerification("no_attestation")).toBe("inconclusive");
	});
	test("a session that did not finish cannot have succeeded", () => {
		expect(deriveOutcome({ status: "error", declared: "succeeded", verification: "passed" })).toBe("failed");
		expect(deriveOutcome({ status: "aborted" })).toBe("failed");
	});
	test("a failed gate outranks any claim", () => {
		expect(deriveOutcome({ status: "done", declared: "succeeded", verification: "failed" })).toBe("failed");
	});
	test("an inconclusive gate leaves the claim alone — not evidence against it", () => {
		expect(deriveOutcome({ status: "done", declared: "blocked", verification: "inconclusive" })).toBe("blocked");
	});
	test("claim respected when no gate or a passing gate", () => {
		expect(deriveOutcome({ status: "done", declared: "blocked", verification: "not-requested" })).toBe("blocked");
		expect(deriveOutcome({ status: "done", declared: "blocked", verification: "passed" })).toBe("blocked");
	});
	test("defaults to succeeded when done with nothing more said", () => {
		expect(deriveOutcome({ status: "done" })).toBe("succeeded");
	});
	test("outcomeLine names both facts", () => {
		expect(outcomeLine("succeeded", "not-requested")).toBe(
			"[outcome] succeeded — no gate was requested, so this is the agent's own account",
		);
		expect(outcomeLine("failed", "failed")).toBe("[outcome] failed — a gate ran and failed");
		expect(outcomeLine("succeeded", "inconclusive")).toBe(
			"[outcome] succeeded — a gate ran but proved nothing either way",
		);
	});
});

describe("evaluateGate", () => {
	test("THE HOLE THIS CLOSES: exit 0 without the expected evidence is result_missing, not a pass", () => {
		const v = evaluateGate({ command: "bun test", expect: "\\d+ pass" }, { status: 0, output: "no tests found" });
		expect(v.ok).toBe(false);
		expect(v.outcome).toBe("result_missing");
	});
	test("exit 0 with the evidence is a pass", () => {
		const v = evaluateGate({ command: "bun test", expect: "\\d+ pass" }, { status: 0, output: "3 pass, 0 fail" });
		expect(v.ok).toBe(true);
		expect(v.outcome).toBe("success");
	});
	test("failure pattern beats a zero exit", () => {
		const v = evaluateGate(
			{ command: "make", failure: "FATAL" },
			{ status: 0, output: "done (FATAL ignored)" },
		);
		expect(v.ok).toBe(false);
		expect(v.outcome).toBe("failure");
	});
	test("non-zero exit is a failure", () => {
		expect(evaluateGate({ command: "x" }, { status: 2, output: "" }).outcome).toBe("failure");
	});
	test("timeout is a real verdict", () => {
		const v = evaluateGate({ command: "x", timeoutMs: 1000 }, { status: null, signal: "SIGKILL", output: "", timedOut: true });
		expect(v.outcome).toBe("timeout");
		expect(v.ok).toBe(false);
	});
	test("spawn error attests nothing — not a failure of the work", () => {
		const v = evaluateGate({ command: "typo-cmd" }, { status: null, output: "", spawnError: "ENOENT" });
		expect(v.outcome).toBe("no_attestation");
		expect(v.ok).toBe(false);
	});
	test("no exit status and no signal attests nothing", () => {
		expect(evaluateGate({ command: "x" }, { status: null, output: "" }).outcome).toBe("no_attestation");
	});
	test("bare exit 0 with no expect pattern is a plain pass", () => {
		const v = evaluateGate({ command: "true" }, { status: 0, output: "" });
		expect(v.ok).toBe(true);
		expect(v.outcome).toBe("success");
	});
});

describe("contractProblems", () => {
	test("catches empty command, invalid regex, non-positive timeout", () => {
		expect(contractProblems({ command: "" })).toEqual(["gate has no command"]);
		expect(contractProblems({ command: "x", expect: "([" })).toContain("gate expect is not a valid regular expression");
		expect(contractProblems({ command: "x", timeoutMs: 0 })).toContain("gate timeoutMs must be positive");
		expect(contractProblems({ command: "x", expect: "ok" })).toEqual([]);
	});
});

describe("repair policy", () => {
	test("a read-only agent cannot repair — the pass buys nothing", () => {
		expect(canWrite(["read", "grep", "glob"])).toBe(false);
		expect(repairAllowed(["read", "grep"], "OUTCOME: failed")).toBe(false);
	});
	test("a writing agent may repair unless it declared blocked", () => {
		expect(repairAllowed(["edit", "bash"], "OUTCOME: failed")).toBe(true);
		expect(repairAllowed(["edit", "bash"], "OUTCOME: blocked")).toBe(false);
		expect(repairAllowed(["edit", "bash"], "plain report")).toBe(true);
	});
});

describe("research_report digest integration (#294 P5)", () => {
	const report = "## Summary\n" + "x".repeat(500) + "\n\nOUTCOME: blocked";
	test("validate stats carry the declared outcome", () => {
		const v = validateResearchReport({ report, token: "TOK-1" });
		// token missing → not ok, but stats still computed
		expect(v.stats.declared).toBe("blocked");
	});
	test("digest leads with the [outcome] line, strips the raw declaration, keeps token first", () => {
		const d = researchReportDigest("TOK-1\n\n## Summary\n" + "y".repeat(500) + "\n\nOUTCOME: blocked", "TOK-1");
		const lines = d.split("\n");
		expect(lines[0]).toBe("TOK-1");
		expect(lines[2]).toBe("[outcome] blocked — no gate was requested, so this is the agent's own account");
		expect(d).not.toContain("OUTCOME: blocked"); // stripped from body
	});
	test("digest without a declaration is unchanged in shape", () => {
		const d = researchReportDigest("## Summary\n" + "z".repeat(500), "TOK-2");
		expect(d.startsWith("TOK-2")).toBe(true);
		expect(d).not.toContain("[outcome]");
	});
});
