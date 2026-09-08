/**
 * Pure tests for the verify layer 0+1 module (probe matching over the run
 * log, red-green at define, completion audit, evidence cross-check).
 */
import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
	auditCompletion,
	checkEvidenceCommands,
	parseVerify,
	redGreenCheck,
	sanitizeVerify,
	summarizeAudit,
	type RunLogEntry,
} from "./verify.ts";

function entry(cmd: string, output = "", ts = 1): RunLogEntry {
	return { tool: "bash", cmd, output, ts };
}

describe("parseVerify (layer 0)", () => {
	test("no probes defaults to judgment lane", () => {
		const { spec, error, notes } = parseVerify({});
		assert.equal(error, null);
		assert.deepEqual(spec, { lane: "judgment", probes: [], strict: false });
		assert.equal(notes.length, 0);
	});

	test("declared probes force the state lane (structural floor)", () => {
		const { spec, notes } = parseVerify({ lane: "judgment", probes: [{ pattern: "gh pr view" }] });
		assert.equal(spec!.lane, "state");
		assert.ok(notes.some((n) => n.includes("forced to state")));
	});

	test("rejects bad lane, short pattern, bad expect, probe overflow", () => {
		assert.ok(parseVerify({ lane: "mixed" }).error);
		assert.ok(parseVerify({ probes: [{ pattern: "ab" }] }).error);
		assert.ok(parseVerify({ probes: [{ pattern: "ok-cmd", expect: 5 }] }).error);
		assert.ok(parseVerify({ probes: Array.from({ length: 9 }, () => ({ pattern: "cmd-x" })) }).error);
	});

	test("strict must be boolean", () => {
		assert.ok(parseVerify({ strict: "yes" }).error);
		assert.equal(parseVerify({ strict: true }).spec!.strict, true);
	});
});

describe("sanitizeVerify (replay)", () => {
	test("round-trips a valid spec", () => {
		const spec = parseVerify({ lane: "state", probes: [{ pattern: "bun test", expect: "pass" }], strict: true }).spec!;
		assert.deepEqual(sanitizeVerify(JSON.parse(JSON.stringify(spec))), spec);
	});

	test("drops judgment-with-probes and junk", () => {
		assert.equal(sanitizeVerify({ lane: "judgment", probes: [{ pattern: "cmd-x" }] }), undefined);
		assert.equal(sanitizeVerify("nope"), undefined);
		assert.equal(sanitizeVerify({ lane: "state", probes: [{ pattern: "" }] }), undefined);
	});
});

describe("redGreenCheck (define time)", () => {
	test("already-green probe is rejected — cannot discriminate", () => {
		const spec = parseVerify({ probes: [{ pattern: "gh pr view 139", expect: "MERGED" }] }).spec!;
		const rg = redGreenCheck(spec, [entry("gh pr view 139", "state MERGED")]);
		assert.equal(rg.ok, false);
		assert.ok(rg.reasons[0]!.includes("không phân biệt"));
	});

	test("amber (ran, expect mismatched) still discriminates → accepted", () => {
		const spec = parseVerify({ probes: [{ pattern: "gh pr view 139", expect: "MERGED" }] }).spec!;
		assert.equal(redGreenCheck(spec, [entry("gh pr view 139", "state OPEN")]).ok, true);
	});

	test("never-ran probe is red → accepted", () => {
		const spec = parseVerify({ probes: [{ pattern: "bun test" }] }).spec!;
		assert.equal(redGreenCheck(spec, []).ok, true);
	});
});

describe("auditCompletion (layer 1)", () => {
	test("no probes → pass", () => {
		assert.equal(auditCompletion({ lane: "judgment", probes: [], strict: false }, []).verdict, "pass");
	});

	test("all green → pass; latest entry wins", () => {
		const spec = parseVerify({ probes: [{ pattern: "gh pr view 139", expect: "MERGED" }] }).spec!;
		const audit = auditCompletion(spec, [
			entry("gh pr view 139", "state OPEN", 1),
			entry("gh pr view 139", "state MERGED", 2),
		]);
		assert.equal(audit.verdict, "pass");
		assert.equal(audit.results[0]!.status, "green");
	});

	test("never ran → fail (worker-fault)", () => {
		const spec = parseVerify({ probes: [{ pattern: "bun test" }] }).spec!;
		const audit = auditCompletion(spec, [entry("npm install")]);
		assert.equal(audit.verdict, "fail");
		assert.equal(audit.results[0]!.status, "red");
		assert.match(summarizeAudit(audit), /CHƯA THẤY/);
	});

	test("ran but expect mismatched → spec-fault with observed output", () => {
		const spec = parseVerify({ probes: [{ pattern: "gh pr view 139", expect: "MERGED" }] }).spec!;
		const audit = auditCompletion(spec, [entry("gh pr view 139", "state OPEN")]);
		assert.equal(audit.verdict, "spec-fault");
		assert.equal(audit.results[0]!.status, "amber");
		assert.ok(audit.results[0]!.observed!.includes("OPEN"));
		assert.match(summarizeAudit(audit), /KHÔNG chứa/);
	});

	test("expect-less probe is green when the command ran", () => {
		const spec = parseVerify({ probes: [{ pattern: "git push" }] }).spec!;
		assert.equal(auditCompletion(spec, [entry("git push origin main", "done")]).verdict, "pass");
	});
});

describe("checkEvidenceCommands (judgment lane, advisory)", () => {
	test("matches backticked claims against run-log cmds both directions", () => {
		const claims = checkEvidenceCommands("ran `bun test` then `gh pr merge`, see `fluff words here`", [
			entry("bun test 2>&1", "ok"),
			entry("gh pr merge 139 --squash", "ok"),
		]);
		assert.deepEqual(
			claims.map((c) => c.found),
			[true, true, false],
		);
	});

	test("ignores short fragments and duplicate claims", () => {
		const claims = checkEvidenceCommands("`ab` `bun test` `bun test`", [entry("bun test", "ok")]);
		assert.equal(claims.length, 1);
		assert.equal(claims[0]!.found, true);
	});
});
