import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	appendPending,
	buildAutoPing,
	buildBatchText,
	claimPending,
	joinMsFromEnv,
	readPending,
	windowDelayMs,
	type PendingPing,
} from "../auto-report-join.ts";

function tmpBase(): string {
	return mkdtempSync(join(tmpdir(), "arj-"));
}

function ping(over: Partial<PendingPing> = {}): PendingPing {
	return { agentId: "agent-1", role: "scout", title: "look", ts: new Date().toISOString(), ...over };
}

describe("joinMsFromEnv", () => {
	test("undefined → default 10s", () => {
		expect(joinMsFromEnv(undefined)).toBe(10_000);
	});
	test('"0" disables → 0', () => {
		expect(joinMsFromEnv("0")).toBe(0);
	});
	test("numeric string parses", () => {
		expect(joinMsFromEnv("2500")).toBe(2_500);
	});
	test("garbage falls back to default (never silently off)", () => {
		expect(joinMsFromEnv("soon")).toBe(10_000);
	});
	test("negative clamps to 0", () => {
		expect(joinMsFromEnv("-5")).toBe(0);
	});
});

describe("pending window on disk", () => {
	test("append + read roundtrip; torn tail dropped", () => {
		const base = tmpBase();
		try {
			appendPending("mainA", ping({ agentId: "a1" }), base);
			appendPending("mainA", ping({ agentId: "a2", role: "researcher" }), base);
			// simulate a torn tail (crash mid-write)
			const file = join(base, "auto-report-join", "mainA", "pending.jsonl");
			appendFileSync(file, '{"agentId":"a3","role":"scout","ts":"20', "utf-8");
			const got = readPending("mainA", base);
			expect(got.length).toBe(2);
			expect(got.map((p) => p.agentId).sort()).toEqual(["a1", "a2"]);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
	test("claim returns all and dedupes by agentId (newest wins); second claim → null", () => {
		const base = tmpBase();
		try {
			appendPending("mainB", ping({ agentId: "a1", title: "old" }), base);
			appendPending("mainB", ping({ agentId: "a2" }), base);
			appendPending("mainB", ping({ agentId: "a1", title: "new" }), base);
			const claimed = claimPending("mainB", base);
			expect(claimed).not.toBeNull();
			expect(claimed!.length).toBe(2);
			const a1 = claimed!.find((p) => p.agentId === "a1");
			expect(a1!.title).toBe("new");
			expect(claimPending("mainB", base)).toBeNull();
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
	test("claim on empty window → null", () => {
		const base = tmpBase();
		try {
			expect(claimPending("mainC", base)).toBeNull();
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
});

describe("windowDelayMs", () => {
	const now = Date.parse("2026-09-17T12:00:00Z");
	test("fresh first line → ~joinMs remaining", () => {
		const d = windowDelayMs([ping({ ts: "2026-09-17T11:59:55Z" })], 10_000, now);
		expect(d).toBe(5_000);
	});
	test("expired window → 0 (flush now)", () => {
		const d = windowDelayMs([ping({ ts: "2026-09-17T11:59:40Z" })], 10_000, now);
		expect(d).toBe(0);
	});
	test("window anchored at FIRST line even with a later sibling", () => {
		const d = windowDelayMs([ping({ ts: "2026-09-17T11:59:57Z" }), ping({ ts: "2026-09-17T11:59:59Z" })], 10_000, now);
		expect(d).toBe(7_000);
	});
	test("empty pending → 0", () => {
		expect(windowDelayMs([], 10_000, now)).toBe(0);
	});
});

describe("buildBatchText", () => {
	test("single child → EXACTLY the legacy buildAutoPing text (zero model-visible change)", () => {
		const one = ping({ agentId: "agent-9", role: "scout", title: "look" });
		expect(buildBatchText([one])).toBe(buildAutoPing("scout", "agent-9", "look"));
	});
	test("N≥2 → one combined notice with [auto-report] prefix + pull hint", () => {
		const text = buildBatchText([
			ping({ agentId: "a1", role: "scout", title: "look" }),
			ping({ agentId: "a2", role: "researcher", title: undefined }),
			ping({ agentId: "a3", role: "worker" }),
		]);
		expect(text.startsWith("[auto-report] ")).toBe(true);
		expect(text).toContain("3 subagents finished");
		expect(text).toContain('scout "look" (a1)');
		expect(text).toContain("researcher (a2)");
		expect(text).toContain("paseo_activity(agentId)");
	});
});
