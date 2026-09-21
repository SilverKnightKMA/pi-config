import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";

import {
	emptyRollup,
	foldIntoRollup,
	readCostGcStamp,
	readRunsRollup,
	rollupPath,
	runsCostTtlDays,
	sumRunCosts,
	sweepRunsCost,
	writeWorkerCost,
	runCostPath,
} from "../src/spawn/runs.js";

const DAY = 24 * 60 * 60 * 1000;

function tmpRoot(): string {
	return mkdtempSync(join(tmpdir(), "om-runs-gc-"));
}

describe("#32 .runs cost GC — rollup keeps sums identical", () => {
	it("foldIntoRollup splits by role and counts files", () => {
		let r = emptyRollup();
		r = foldIntoRollup(r, { costUsd: 0.001, role: "observer" }, "2026-09-16T00:00:00Z");
		r = foldIntoRollup(r, { costUsd: 0.08, role: "consolidator" }, "2026-09-16T00:00:00Z");
		r = foldIntoRollup(r, { costUsd: 0.002 }, "2026-09-16T00:00:01Z"); // legacy no-role
		expect(r.total).toEqual({ costUsd: 0.083, runs: 3 });
		expect(r.observer).toEqual({ costUsd: 0.001, runs: 1 });
		expect(r.consolidator).toEqual({ costUsd: 0.08, runs: 1 });
		expect(r.files).toBe(3);
		expect(r.rolledUpAt).toBe("2026-09-16T00:00:01Z");
	});

	it("sweep folds old files into rollup; sumRunCosts totals are IDENTICAL before/after", () => {
		const root = tmpRoot();
		try {
			const now = Date.now();
			// 2 old (9 days) + 1 fresh
			writeWorkerCost(runCostPath(root, "obs-1"), { costUsd: 0.0012, role: "observer" });
			writeWorkerCost(runCostPath(root, "cons-1"), { costUsd: 0.09, role: "consolidator" });
			writeWorkerCost(runCostPath(root, "obs-2"), { costUsd: 0.0013, role: "observer" });
			utimesSync(runCostPath(root, "obs-1"), new Date(now - 9 * DAY), new Date(now - 9 * DAY));
			utimesSync(runCostPath(root, "cons-1"), new Date(now - 9 * DAY), new Date(now - 9 * DAY));

			const before = sumRunCosts(root);
			const gc = sweepRunsCost(root, 7, now);
			const after = sumRunCosts(root);

			expect(gc.files).toBe(2);
			expect(gc.bytes).toBeGreaterThan(0); // #100: bytes reclaimed by the fold
			expect(after.total.costUsd).toBeCloseTo(before.total.costUsd, 10);
			expect(after.total.runs).toBe(before.total.runs);
			expect(after.observer.costUsd).toBeCloseTo(before.observer.costUsd, 10);
			expect(after.consolidator.costUsd).toBeCloseTo(before.consolidator.costUsd, 10);
			// rollup persisted with the folded numbers
			const rollup = JSON.parse(readFileSync(rollupPath(root), "utf8")) as { files: number; total: { runs: number } };
			expect(rollup.files).toBe(2);
			expect(rollup.total.runs).toBe(2);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("ttl<=0 disables the sweep; missing dir is a no-op", () => {
		const root = tmpRoot();
		try {
			const now = Date.now();
			writeWorkerCost(runCostPath(root, "obs-1"), { costUsd: 0.001, role: "observer" });
			utimesSync(runCostPath(root, "obs-1"), new Date(now - 30 * DAY), new Date(now - 30 * DAY));
			expect(sweepRunsCost(root, 0, now)).toEqual({ files: 0, bytes: 0 });
			expect(sweepRunsCost("", 7, now)).toEqual({ files: 0, bytes: 0 });
			const missing = join(root, "nope");
			expect(sweepRunsCost(missing, 7, now)).toEqual({ files: 0, bytes: 0 });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("malformed old cost files are deleted without folding (rollup stays clean)", () => {
		const root = tmpRoot();
		try {
			const now = Date.now();
			const bad = runCostPath(root, "obs-bad");
			mkdirSync(join(root, ".runs"), { recursive: true });
			writeFileSync(bad, "{not json");
			utimesSync(bad, new Date(now - 9 * DAY), new Date(now - 9 * DAY));
			const gc = sweepRunsCost(root, 7, now);
			expect(gc.files).toBe(0);
			expect(gc.bytes).toBe(0);
			expect(sumRunCosts(root).total.runs).toBe(0);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rollup roundtrips through sumRunCosts after a restart-shaped reload", () => {
		const root = tmpRoot();
		try {
			const now = Date.now();
			writeWorkerCost(runCostPath(root, "cons-1"), { costUsd: 0.5, role: "consolidator" });
			utimesSync(runCostPath(root, "cons-1"), new Date(now - 9 * DAY), new Date(now - 9 * DAY));
			sweepRunsCost(root, 7, now);
			// a NEW run lands after the GC
			writeWorkerCost(runCostPath(root, "cons-2"), { costUsd: 0.2, role: "consolidator" });
			const totals = sumRunCosts(root);
			expect(totals.consolidator).toEqual({ costUsd: 0.7, runs: 2 });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("#100 readers: readRunsRollup / readCostGcStamp / runsCostTtlDays", () => {
		const root = tmpRoot();
		try {
			// no rollup yet
			expect(readRunsRollup(root)).toBeNull();
			expect(readCostGcStamp(root)).toBe("");
			// fold one file, stamp the sweep
			const now = Date.now();
			writeWorkerCost(runCostPath(root, "obs-9"), { costUsd: 0.01, role: "observer" });
			utimesSync(runCostPath(root, "obs-9"), new Date(now - 9 * DAY), new Date(now - 9 * DAY));
			expect(sweepRunsCost(root, 7, now).files).toBe(1);
			const rollup = readRunsRollup(root);
			expect(rollup?.files).toBe(1);
			expect(rollup?.observer.runs).toBe(1);
			mkdirSync(join(root, ".runs"), { recursive: true });
			writeFileSync(join(root, ".runs", ".cost-gc-stamp"), "2026-09-21");
			expect(readCostGcStamp(root)).toBe("2026-09-21");
			// ttl reader follows env at call time
			process.env.OM_RUNS_COST_TTL_DAYS = "14";
			try {
				expect(runsCostTtlDays()).toBe(14);
			} finally {
				delete process.env.OM_RUNS_COST_TTL_DAYS;
			}
			expect(runsCostTtlDays()).toBe(0);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
