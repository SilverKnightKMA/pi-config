import { describe, expect, test } from "bun:test";
import { bashLongRunVerdict } from "./match.ts";

describe("bash-long-run-guard — silent-abort risk class (v1.4.71)", () => {
	test("test suites / installs / big sleeps / polling loops foreground → blocked with recipe", () => {
		for (const cmd of [
			"bun test",
			"cd /repo && bun test plan.test.ts",
			"npm test",
			"yarn test",
			"bun install",
			"npm ci",
			"sleep 14",
			"sleep 30",
			"for i in 1 2 3; do gh pr view 198; sleep 20; done",
			"while true; do sleep 5; done",
			"seq 1 10 | while read i; do sleep 2; done",
			"gh pr view 199 --json x; sleep 25",
		]) {
			const v = bashLongRunVerdict(cmd);
			expect(v.background).toBe(true);
			expect(v.reason).toBeTruthy();
			expect(v.recipe).toContain("setsid nohup");
			expect(v.recipe).toContain("/tmp/blk-");
		}
	});

	test("quick interactive commands pass — the everyday workflow never gets blocked", () => {
		for (const cmd of [
			"grep -n foo bar.ts",
			"sleep 1",
			"sleep 2",
			"git push origin main",
			"git pull",
			"node scripts/managed-pi-extensions.mjs init",
			"gh pr merge 198 --squash --delete-branch",
			"tail -5 /tmp/v1468-full.log",
			"ls -t ~/.omp/logs",
			"df -h /",
		]) {
			expect(bashLongRunVerdict(cmd).background).toBe(false);
		}
	});

	test("already backgrounded (setsid/nohup + /tmp log) → pass — the launcher itself is safe", () => {
		expect(bashLongRunVerdict("L=/tmp/x.log; setsid nohup bash -c 'bun test' >$L 2>&1 & sleep 1; tail -5 $L").background).toBe(false);
		expect(bashLongRunVerdict("rm -f /tmp/f.log && setsid nohup bash -c 'bun test > /tmp/f.log 2>&1; echo EXIT:$? >> /tmp/f.log' >/dev/null 2>&1 & sleep 1; echo started").background).toBe(false);
	});

	test("BASH_LONG_RUN_GUARD=0 escape restores raw behavior", () => {
		expect(bashLongRunVerdict("bun test", { BASH_LONG_RUN_GUARD: "0" }).background).toBe(false);
		expect(bashLongRunVerdict("sleep 99", { BASH_LONG_RUN_GUARD: "0" }).background).toBe(false);
	});

	test("recipe survives single quotes in the command", () => {
		const v = bashLongRunVerdict("bun test 'plan file.test.ts'");
		if (v.background) expect(v.recipe).toContain("'\\''");
	});

	test("empty command passes", () => {
		expect(bashLongRunVerdict("").background).toBe(false);
	});
});
