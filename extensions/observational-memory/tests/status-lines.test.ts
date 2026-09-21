import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildStatusLines } from "../src/commands/status.js";
import { DEFAULTS } from "../src/config.js";
import { OM_COST, type Entry } from "../src/ledger/index.js";

function fakeRuntime(overrides: Record<string, unknown> = {}) {
	return {
		config: { ...DEFAULTS },
		observersInFlight: new Map(),
		consolidatorInFlight: false,
		lastWorkerError: null,
		memoryRoot: mkdtempSync(join(tmpdir(), "om-status-")),
		...overrides,
	} as never;
}

function costEntry(costUsd: number, role: "observer" | "consolidator"): Entry {
	return { type: "custom", customType: OM_COST, data: { costUsd, role, runId: "r" } } as unknown as Entry;
}

describe("buildStatusLines", () => {
	it("renders a healthy verdict with per-role cost split", () => {
		const runtime = fakeRuntime();
		const branch = [costEntry(0.1, "observer"), costEntry(0.1, "observer"), costEntry(0.05, "consolidator")];
		const text = buildStatusLines(runtime, branch, 100_000).join("\n");

		expect(text).toContain("✓ healthy");
		expect(text).toContain("observer      $0.2000 (2 runs)");
		expect(text).toContain("consolidator  $0.0500 (1 runs)");
		expect(text).toContain("session: $0.2500 (3 runs)");
		expect(text).toContain("topics (durable)");
		expect(text).toContain("(67%)");
	});

	it("#100: Storage & GC section surfaces rollup totals, TTL config and last sweep day", () => {
		const root = mkdtempSync(join(tmpdir(), "om-gcline-"));
		mkdirSync(join(root, ".runs"), { recursive: true });
		writeFileSync(
			join(root, ".runs", "rollup.json"),
			JSON.stringify({ v: 1, total: { costUsd: 1.25, runs: 9 }, observer: { costUsd: 0.25, runs: 8 }, consolidator: { costUsd: 1.0, runs: 1 }, files: 9, rolledUpAt: "2026-09-18T05:00:00Z" }),
		);
		writeFileSync(join(root, ".runs", ".cost-gc-stamp"), "2026-09-18");
		const runtime = fakeRuntime({ memoryRoot: root });
		process.env.OM_RUNS_COST_TTL_DAYS = "7";
		try {
			const text = buildStatusLines(runtime, [], null).join("\n");
			expect(text).toContain("Storage & GC");
			expect(text).toContain("9 cost file(s) folded");
			expect(text).toContain("$1.2500 preserved");
			expect(text).toContain("last 2026-09-18");
			expect(text).toContain("cost GC: TTL 7d");
			expect(text).toContain("last sweep 2026-09-18");
		} finally {
			delete process.env.OM_RUNS_COST_TTL_DAYS;
		}
		// TTL off by default — the line says so instead of hiding
		const off = buildStatusLines(runtime, [], null).join("\n");
		expect(off).toContain("cost GC: TTL 0d (off)");
		expect(off).toContain("last sweep 2026-09-18");
		rmSync(root, { recursive: true, force: true });
	});

	it("warns when the last worker errored", () => {
		const runtime = fakeRuntime({ lastWorkerError: "boom" });
		const lines = buildStatusLines(runtime, [], null);
		expect(lines[0]).toContain("⚠");
		expect(lines.join("\n")).toContain("last error: boom");
	});

	it("shows working verdict while an observer is in flight", () => {
		const runtime = fakeRuntime({ observersInFlight: new Map([["r1", {}]]) });
		const lines = buildStatusLines(runtime, [], null);
		expect(lines[0]).toContain("⏳ working");
		expect(lines[0]).toContain("1/4 observers");
	});

	it("renders ? when context usage is unknown", () => {
		const lines = buildStatusLines(fakeRuntime(), [], null);
		expect(lines.join("\n")).toContain("context: ?");
	});
});
