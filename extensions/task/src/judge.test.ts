/**
 * Pure tests for the layer-2 judge module (v1.4.26).
 * Design contract: pify-pending-2026-09-07.md row 9 (settled 2026-09-09).
 */
import { describe, it, test } from "bun:test";
import assert from "node:assert/strict";

import {
	buildJudgePacket,
	parseJudgeVerdict,
	pickLogSlice,
	verdictConsequence,
	MAX_JUDGE_ROUNDS,
	type JudgeVerdict,
	type LogSliceEntry,
} from "./judge.ts";

const log = (cmd: string, output = ""): LogSliceEntry => ({ cmd, output });

// ── pickLogSlice ─────────────────────────────────────────────────────────

describe("judge: pickLogSlice", () => {
	test("relevant entries first, newest context fills the rest", () => {
		const entries = [log("ls"), log("gh pr view 139", "MERGED"), log("pwd"), log("cat f")];
		const slice = pickLogSlice(entries, [{ pattern: "gh pr view 139", status: "green" }], "");
		assert.equal(slice[0]!.cmd, "gh pr view 139");
		assert.equal(slice.length, entries.length);
	});

	test("evidence backtick claims pull their matching entries", () => {
		const slice = pickLogSlice([log("ls"), log("bun test", "3 pass")], [], "ran `bun test` — green");
		assert.equal(slice[0]!.cmd, "bun test");
	});

	test("cap respected, newest wins when nothing matches", () => {
		const entries = Array.from({ length: 30 }, (_, i) => log(`cmd-${i}`));
		const slice = pickLogSlice(entries, [], "", 5);
		assert.equal(slice.length, 5);
		assert.equal(slice[0]!.cmd, "cmd-29"); // newest first from the tail
	});
});

// ── buildJudgePacket ─────────────────────────────────────────────────────

describe("judge: buildJudgePacket", () => {
	test("packet carries task, probes, evidence and a numbered log", () => {
		const packet = buildJudgePacket(
			{ subject: "bump pin", doneCheck: "manifest pinned + PR merged", evidence: "`gh pr merge` xong", lane: "state", probes: [{ pattern: "gh pr view", expect: "MERGED", status: "amber", observed: "OPEN" }] },
			[log("gh pr view 140", "state OPEN")],
		);
		assert.match(packet, /subject: bump pin/);
		assert.match(packet, /done-check: manifest pinned/);
		assert.match(packet, /\[amber\] pattern="gh pr view"/);
		assert.match(packet, /observed="OPEN"/);
		assert.match(packet, /## LOG \(1 lines/);
		assert.match(packet, /\[0\] cmd: gh pr view 140/);
		assert.match(packet, /fabricated ids invalidate/);
	});
});

// ── parseJudgeVerdict ────────────────────────────────────────────────────

describe("judge: parseJudgeVerdict", () => {
	test("parses a clean JSON verdict", () => {
		const v = parseJudgeVerdict('{"verdict":"pass","confidence":"high","reason":"log shows merged","cited_log_ids":[0,1]}', 2);
		assert.equal(v?.verdict, "pass");
		assert.deepEqual(v?.cited_log_ids, [0, 1]);
	});

	test("extracts JSON from prose around it", () => {
		const v = parseJudgeVerdict('Sure!\n\n{"verdict":"fail","confidence":"medium","reason":"no evidence","cited_log_ids":[]}\nDone.', 0);
		assert.equal(v?.verdict, "fail");
	});

	test("out-of-range citations invalidate the verdict → insufficient/low", () => {
		const v = parseJudgeVerdict('{"verdict":"pass","confidence":"high","reason":"x","cited_log_ids":[7]}', 2);
		assert.equal(v?.verdict, "insufficient_evidence");
		assert.equal(v?.confidence, "low");
	});

	test("garbage / missing object → null", () => {
		assert.equal(parseJudgeVerdict("no verdict here", 2), null);
		assert.equal(parseJudgeVerdict('{"verdict":"maybe"}', 2), null);
	});

	test("unbalanced braces → null", () => {
		assert.equal(parseJudgeVerdict('{"verdict":"pass","confidence":"high"', 1), null);
	});
});

// ── verdictConsequence ───────────────────────────────────────────────────

const verdict = (v: Partial<JudgeVerdict>): JudgeVerdict => ({
	verdict: "pass",
	confidence: "high",
	reason: "r",
	cited_log_ids: [],
	...v,
});

describe("judge: verdictConsequence", () => {
	test("pass completes and resets the streak", () => {
		const c = verdictConsequence(verdict({}), { failStreak: 1, judgeRounds: 1 });
		assert.equal(c.action, "complete");
		assert.equal(c.failStreak, 0);
		assert.equal(c.judgeRounds, 2);
	});

	test("null verdict (judge unavailable) → fail-closed refusal, no round spent", () => {
		const c = verdictConsequence(null, { failStreak: 1, judgeRounds: 2 });
		assert.equal(c.action, "refuse-unavailable");
		assert.equal(c.judgeRounds, 2);
		assert.match(c.message, /fail-closed/);
	});

	test("first high-conf fail → refused, streak 1, no demote", () => {
		const c = verdictConsequence(verdict({ verdict: "fail", confidence: "high" }), { failStreak: 0, judgeRounds: 0 });
		assert.equal(c.action, "fail-streak");
		assert.equal(c.failStreak, 1);
	});

	test("second consecutive high-conf fail → demote, streak resets", () => {
		const c = verdictConsequence(verdict({ verdict: "fail", confidence: "high" }), { failStreak: 1, judgeRounds: 1 });
		assert.equal(c.action, "demote");
		assert.equal(c.failStreak, 0);
		assert.match(c.message, /demote/);
	});

	test("low-conf fail → ask for evidence, no demotion, streak resets", () => {
		const c = verdictConsequence(verdict({ verdict: "fail", confidence: "low" }), { failStreak: 1, judgeRounds: 0 });
		assert.equal(c.action, "need-evidence");
		assert.equal(c.failStreak, 0);
		assert.match(c.message, /không demote/);
	});

	test("insufficient evidence → ask for evidence", () => {
		const c = verdictConsequence(verdict({ verdict: "insufficient_evidence", confidence: "medium" }), { failStreak: 0, judgeRounds: 0 });
		assert.equal(c.action, "need-evidence");
	});

	test("round cap: 3rd non-pass round parks instead of judging again", () => {
		const c = verdictConsequence(verdict({ verdict: "insufficient_evidence" }), { failStreak: 0, judgeRounds: MAX_JUDGE_ROUNDS - 1 });
		assert.equal(c.action, "park-cap");
		assert.equal(c.judgeRounds, MAX_JUDGE_ROUNDS);
	});

	test("pass on the 3rd round still completes (cap only funnels non-pass)", () => {
		const c = verdictConsequence(verdict({}), { failStreak: 0, judgeRounds: MAX_JUDGE_ROUNDS - 1 });
		assert.equal(c.action, "complete");
	});
});

// ── v1.4.38: packet phải đưa judge cả tờ đề cũ ─────────────────────────
describe("judge: buildJudgePacket — doneCheck amendments (v1.4.38)", () => {
	it("renders the amendment trail so the judge sees rewrites", () => {
		const packet = buildJudgePacket(
			{
				subject: "s",
				doneCheck: "chạy echo ok là xong",
				evidence: "e",
				lane: "judgment",
				descHistory: [
					{ at: 1, by: "agent", from: "deploy production + curl 200", to: "chạy echo ok là xong" },
				],
			},
			[],
		);
		assert.ok(packet.includes("## DONE-CHECK AMENDMENTS"));
		assert.ok(packet.includes("deploy production + curl 200"));
		assert.ok(packet.includes("chạy echo ok là xong"));
		assert.ok(packet.includes("1 time(s), 1 by the worker"));
	});

	it("no section when the sheet was never rewritten", () => {
		const packet = buildJudgePacket({ subject: "s", doneCheck: "d", evidence: "e", lane: "judgment" }, []);
		assert.ok(!packet.includes("DONE-CHECK AMENDMENTS"));
	});

	it("user-authored rewrites are counted separately from worker rewrites", () => {
		const packet = buildJudgePacket(
			{
				subject: "s",
				doneCheck: "d",
				evidence: "e",
				lane: "judgment",
				descHistory: [
					{ at: 1, by: "agent", from: "a", to: "b" },
					{ at: 2, by: "user", from: "b", to: "c" },
				],
			},
			[],
		);
		assert.ok(packet.includes("2 time(s), 1 by the worker"));
		assert.ok(packet.includes("- (user)"));
	});
});
