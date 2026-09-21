/** memory-curator runner tests — P3 (#180). Uses a FAKE planner spawn (never
 *  spawns a real pi child). */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCuratorOnce, accrueCounters, readCuratorState, factsRunsDir } from "./curator-run.ts";
import type { PlannerSpawn } from "./curator-run.ts";
import { curatorThresholds, initialCuratorState } from "./curator-core.ts";

let tmp: string;
let env: NodeJS.ProcessEnv;

function seedStore(lines: string[]): void {
	writeFileSync(env.FACTS_FILE!, lines.join("\n") + "\n");
}

const okSpawn = (stdout: string): PlannerSpawn => async () => ({ code: 0, stdout, stderr: "" });
const failSpawn: PlannerSpawn = async () => ({ code: 1, stdout: "", stderr: "boom" });

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "curator-test-"));
	env = {
		HOME: tmp,
		FACTS_FILE: join(tmp, "facts.md"),
		FACTS_RUNS_DIR: join(tmp, "runs"),
		FACTS_CURATOR_BACKOFF_MS: "0", // tests never wait on retry backoff
	};
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe("runCuratorOnce", () => {
	test("below thresholds → no run, no receipt", async () => {
		seedStore(["[ops][2026-09-01][P1] one fact (#aaaa01)"]);
		const out = await runCuratorOnce({ env, home: tmp, plannerSpawn: okSpawn("{}") });
		expect(out).toEqual({ ran: false, reason: "below-thresholds" });
	});

	test("threshold crossed → planner plan validated + applied atomically + receipt + counters reset", async () => {
		seedStore([
			"[convention][2026-09-01][P1] test runner: bun (#aaa001)",
			"[ops][2026-09-01][P3] port 34091 (#aaa003)",
		]);
		// cross the lines threshold via state baseline 0 → 2 changed lines with minLines=1
		const out = await runCuratorOnce({
			env: { ...env, FACTS_CURATOR_MIN_LINES: "1" },
			home: tmp,
			plannerSpawn: okSpawn(
				JSON.stringify({
					verdicts: [{ id: "aaa001", verdict: "SUPERSEDED", evidence: "runner switched to npm" }],
					proposals: [
						{ category: "ops", date: "2026-09-21", priority: "P2", text: "curator ran E2E", source: "test" },
					],
				}),
			),
		});
		expect(out).toMatchObject({ ran: true, outcome: "ok" });
		const after = readFileSync(env.FACTS_FILE!, "utf8");
		expect(after).toContain("curator:superseded");
		expect(after).toContain("curator ran E2E");
		const st = readCuratorState(env, tmp);
		expect(st.failingStreak).toBe(0);
		expect(st.tokensSinceRun).toBe(0);
		// receipt file with pre/post hashes
		if (!("receiptFile" in out)) throw new Error("expected a receiptFile");
		const receipt = JSON.parse(readFileSync((out as { receiptFile: string }).receiptFile, "utf8"));
		expect(receipt.outcome).toBe("ok");
		expect(receipt.preHash).not.toBe(receipt.postHash);
		expect(receipt.appliedVerdicts).toBe(1);
	});

	test("garbage plan → whole plan refused (fail-closed), store untouched, streak++", async () => {
		seedStore(["[convention][2026-09-01][P1] test runner: bun (#aaa001)"]);
		const before = readFileSync(env.FACTS_FILE!, "utf8");
		const out = await runCuratorOnce({
			env: { ...env, FACTS_CURATOR_MIN_LINES: "1" },
			home: tmp,
			plannerSpawn: okSpawn("I think everything is fine!"),
		});
		expect(out).toMatchObject({ ran: true, outcome: "refused" });
		expect(readFileSync(env.FACTS_FILE!, "utf8")).toBe(before);
		expect(readCuratorState(env, tmp).failingStreak).toBe(1);
	});

	test("planner crash → retry once then error receipt; debt stays crossed (counters kept)", async () => {
		seedStore(["[convention][2026-09-01][P1] test runner: bun (#aaa001)"]);
		// seed counters so the debt path matters
		writeCuratorStateRaw();
		const out = await runCuratorOnce({
			env: { ...env, FACTS_CURATOR_MIN_LINES: "1" },
			home: tmp,
			plannerSpawn: failSpawn,
			force: true,
		});
		expect(out).toMatchObject({ ran: true, outcome: "error" });
		const st = readCuratorState(env, tmp);
		expect(st.failingStreak).toBe(1);
		expect(st.tokensSinceRun).toBe(12345); // kept — next successful run heals
	});

	test("second attempt success after first failure (retry within the run)", async () => {
		seedStore(["[convention][2026-09-01][P1] test runner: bun (#aaa001)"]);
		let calls = 0;
		const flaky: PlannerSpawn = async () => {
			calls++;
			return calls === 1
				? { code: 1, stdout: "", stderr: "transient" }
				: { code: 0, stdout: JSON.stringify({ verdicts: [], proposals: [] }), stderr: "" };
		};
		const out = await runCuratorOnce({ env: { ...env, FACTS_CURATOR_MIN_LINES: "1" }, home: tmp, plannerSpawn: flaky });
		expect(out).toMatchObject({ ran: true, outcome: "ok" });
		expect(calls).toBe(2);
	});

	test("no facts store → ran:false", async () => {
		const out = await runCuratorOnce({ env, home: tmp, plannerSpawn: okSpawn("{}"), force: true });
		expect(out).toMatchObject({ ran: false, reason: "no facts store yet" });
	});
});

function writeCuratorStateRaw(): void {
	mkdirSync(factsRunsDir(env, tmp), { recursive: true });
	const st = { ...initialCuratorState(), tokensSinceRun: 12345, sessionsSinceRun: 40 };
	writeFileSync(join(factsRunsDir(env, tmp), "curator-state.json"), JSON.stringify(st));
}

describe("accrueCounters", () => {
	test("tokens + sessions accumulate across calls", () => {
		seedStore(["[ops][2026-09-01][P1] x (#aaaa01)"]);
		accrueCounters(env, tmp, 5000);
		accrueCounters(env, tmp, 3000);
		const st = readCuratorState(env, tmp);
		expect(st.tokensSinceRun).toBe(8000);
		expect(st.sessionsSinceRun).toBe(2);
	});
});

describe("curatorThresholds integration with env", () => {
	test("FACTS_CURATOR=0 disables", async () => {
		seedStore(["[ops][2026-09-01][P1] x (#aaaa01)"]);
		const out = await runCuratorOnce({
			env: { ...env, FACTS_CURATOR: "0", FACTS_CURATOR_MIN_LINES: "1" },
			home: tmp,
			plannerSpawn: okSpawn("{}"),
		});
		expect(out).toEqual({ ran: false, reason: "disabled" });
		expect(curatorThresholds({ FACTS_CURATOR: "0" }).enabled).toBe(false);
	});
});
