import { describe, expect, test } from "bun:test";
import { appendFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { judgeSessionPath, appendJudgeRegistry } from "../index.ts";

describe("judgeSessionPath (v1.4.101)", () => {
	test("points into the dedicated --judge-- subdir", () => {
		const p = judgeSessionPath("/home/x/.pi/agent/sessions");
		expect(p).toContain("/--judge--/");
		expect(p.endsWith(".jsonl")).toBe(true);
	});

	test("filename keeps the <ts>_<uuid>.jsonl convention", () => {
		const at = new Date("2026-09-18T09:28:47.336Z");
		const p = judgeSessionPath("/sessions-root", at);
		const name = p.split("/").pop()!;
		// 2026-09-18T09-28-47-336Z_<uuid>.jsonl
		expect(name).toMatch(/^2026-09-18T09-28-47-336Z_[0-9a-f-]{36}\.jsonl$/);
	});
});

describe("appendJudgeRegistry (v1.4.101)", () => {
	test("appends one JSON line per call with exact keys", () => {
		const home = join(tmpdir(), `judge-registry-test-${Date.now()}`);
		rmSync(home, { recursive: true, force: true });
		mkdirSync(home, { recursive: true });
		appendJudgeRegistry(home, { ts: "2026-09-18T09:28:47Z", cwd: "/w", path: "/s/--judge--/a.jsonl" });
		appendJudgeRegistry(home, { ts: "2026-09-18T09:29:00Z", cwd: "/w", path: "/s/--judge--/b.jsonl" });
		const lines = readFileSync(join(home, "judge-sessions.jsonl"), "utf8").trim().split("\n");
		expect(lines.length).toBe(2);
		const first = JSON.parse(lines[0]);
		expect(first).toEqual({ ts: "2026-09-18T09:28:47Z", cwd: "/w", path: "/s/--judge--/a.jsonl" });
		rmSync(home, { recursive: true, force: true });
	});

	test("never throws when the target dir is unwritable", () => {
		// root path that cannot exist on any sane system
		expect(() => appendJudgeRegistry("/proc/definitely-not-here", { ts: "t", cwd: "c", path: "p" })).not.toThrow();
	});
});
