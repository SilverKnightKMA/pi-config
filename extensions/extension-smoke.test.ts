import { describe, expect, test } from "bun:test";
import { join } from "node:path";

/**
 * Extension load smoke (v1.4.72) — the regression gate for the class the user
 * named on 2026-09-15: "changing pi extension code without thorough testing
 * causes pi to crash" (session 01a093d5). Upstream pi `process.exit(1)`s when an
 * extension fails to load; the daemon then retries and spawns a pi storm.
 *
 * Unit tests cover pure modules; nothing else in this suite ever executes
 * activate(). This test imports + activates EVERY extension in a child bun
 * process — exactly the code path pi runs at session start — and fails the
 * suite on any load/activation throw.
 *
 * It caught its first real bug on day one: extensions/web-fetch had imported
 * "typebox" (never declared, never installed) since v1.4.0 (2026-09-05).
 */
describe("extension load smoke (crash-class regression, #01a093d5)", () => {
	test("every extensions/*/index.ts imports and activate()s clean in a child process", async () => {
		const script = join(import.meta.dir, "..", "scripts", "smoke-extensions.mjs");
		const proc = Bun.spawnSync([process.execPath, script, join(import.meta.dir)], {
			cwd: join(import.meta.dir, ".."),
			timeout: 120_000,
			stdout: "pipe",
			stderr: "pipe",
		});
		const out = proc.stdout?.toString() ?? "";
		const tail = out.trim().split("\n").slice(-4).join("\n");
		expect(tail, `smoke output tail:\n${out.trim().split("\n").slice(-8).join("\n")}`).toContain("EXTENSIONS LOAD CLEAN");
		expect(tail).not.toMatch(/FAILED/);
	}, 150_000);
});
