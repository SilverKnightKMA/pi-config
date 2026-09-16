/**
 * safe-bash wrapper tests — #108 shadow telemetry + git-aware warning.
 * Pure pieces only (writeShadowLine with a temp path, appendGitAwareWarning
 * with injected porcelain): the pi registration is smoke-covered elsewhere.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendGitAwareWarning, writeShadowLine } from "../safe-bash.ts";
import { checkBash } from "../safe-bash-rules.ts";
import type { BashDenial } from "../safe-bash-rules.ts";

const HOME = "/home/tester";

function denialOf(cmd: string): BashDenial {
	const d = checkBash(cmd, { home: HOME });
	if (!d) throw new Error(`expected denial for ${cmd}`);
	return d;
}

describe("shadow telemetry (#108, pi-verdict)", () => {
	test("allow and deny lines land in the shadow log", () => {
		const dir = mkdtempSync(join(tmpdir(), "sb-shadow-"));
		const p = join(dir, "shadow.jsonl");
		try {
			writeShadowLine({ ts: "t1", role: "worker", verdict: "allow", command: "ls -la", cwd: "/w" }, p);
			writeShadowLine({ ts: "t2", role: "worker", verdict: "deny", rule: "rm-root", what: "recursive/forced rm", command: "rm -rf /", cwd: "/w" }, p);
			const lines = readFileSync(p, "utf8").trim().split("\n").map((l) => JSON.parse(l));
			expect(lines).toHaveLength(2);
			expect(lines[0]).toMatchObject({ verdict: "allow", role: "worker" });
			expect(lines[1]).toMatchObject({ verdict: "deny", rule: "rm-root" });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("telemetry failure never throws (best-effort by contract)", () => {
		expect(() => writeShadowLine({ ts: "t", verdict: "allow", command: "x", cwd: "/w" }, "/nonexistent-dir/deep/shadow.jsonl")).not.toThrow();
		expect(existsSync("/nonexistent-dir")).toBe(false);
	});
});

describe("git-aware destructive warning (#108, @spences10)", () => {
	test("destructive deny + dirty porcelain → GIT-AWARE line appended", () => {
		const d = denialOf("rm -rf /home/tester/project");
		const out = appendGitAwareWarning("BASE ENVELOPE", d, " M src/a.ts\n?? new.txt\n");
		expect(out.startsWith("BASE ENVELOPE")).toBe(true);
		expect(out).toContain("GIT-AWARE");
		expect(out).toContain("2 uncommitted changes");
		expect(out).toContain(" M src/a.ts");
	});

	test("clean porcelain → no warning line", () => {
		const d = denialOf("rm -rf /home/tester/project");
		expect(appendGitAwareWarning("BASE", d, "")).toBe("BASE");
	});

	test("not a repo / probe failed (null) → no warning line", () => {
		const d = denialOf("rm -rf /home/tester/project");
		expect(appendGitAwareWarning("BASE", d, null)).toBe("BASE");
	});

	test("non-destructive denies never get the warning", () => {
		const d = denialOf("sudo id");
		expect(appendGitAwareWarning("BASE", d, " M dirty.txt\n")).toBe("BASE");
	});

	test("one dirty file reads singular", () => {
		const d = denialOf("dd if=/dev/zero of=/dev/sda");
		expect(appendGitAwareWarning("B", d, "?? x\n")).toContain("1 uncommitted change");
	});
});
