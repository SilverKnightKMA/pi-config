/**
 * GC of .runs/ artifacts (pi v1.2.7):
 *  - unlinkCommittedResult: result.json is deleted ONLY when every observation content is
 *    provably in the ledger fold — otherwise kept for the sweep.
 *  - sweepOldResults: age-based safety net for orphans (crash between commit and unlink)
 *    and pre-GC legacy files. cost.json is NEVER touched.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	runCostPath,
	runResultPath,
	runsDir,
	sweepOldResults,
	unlinkCommittedResult,
	writeObserverResult,
	writeWorkerCost,
} from "../src/spawn/runs.js";

const tmp = join(import.meta.dir, ".tmp-runs-gc");

function setup() {
	rmSync(tmp, { recursive: true, force: true });
	mkdirSync(runsDir(tmp), { recursive: true });
}

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("unlinkCommittedResult — verify-then-delete", () => {
	test("all contents in ledger → file deleted", () => {
		setup();
		writeObserverResult(runResultPath(tmp, "obs-1"), {
			observations: [
				{ timestamp: "2026-09-05 10:19", content: "alpha" },
				{ timestamp: "2026-09-05 10:20", content: "beta" },
			],
		});
		const ok = unlinkCommittedResult(tmp, "obs-1", new Set(["alpha", "beta"]));
		expect(ok).toBe(true);
	});

	test("one observation missing from ledger → file KEPT", () => {
		setup();
		writeObserverResult(runResultPath(tmp, "obs-2"), {
			observations: [
				{ timestamp: "2026-09-05 10:19", content: "alpha" },
				{ timestamp: "2026-09-05 10:20", content: "UNCOMMITTED" },
			],
		});
		const ok = unlinkCommittedResult(tmp, "obs-2", new Set(["alpha"]));
		expect(ok).toBe(false);
	});

	test("empty observations array → deleted (nothing to lose)", () => {
		setup();
		writeObserverResult(runResultPath(tmp, "obs-3"), { observations: [] });
		expect(unlinkCommittedResult(tmp, "obs-3", new Set())).toBe(true);
	});

	test("already-absent file → true (idempotent)", () => {
		setup();
		expect(unlinkCommittedResult(tmp, "obs-404", new Set())).toBe(true);
	});
});

describe("sweepOldResults — age-based safety net", () => {
	test("removes only result.json older than cutoff; keeps recent + cost.json", () => {
		setup();
		const old = runResultPath(tmp, "obs-old");
		const recent = runResultPath(tmp, "obs-recent");
		writeObserverResult(old, { observations: [{ timestamp: "2026-08-30 10:19", content: "legacy" }] });
		writeObserverResult(recent, { observations: [{ timestamp: "2026-09-05 10:19", content: "fresh" }] });
		writeWorkerCost(runCostPath(tmp, "obs-old"), { costUsd: 0.01, role: "observer" });

		const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
		utimesSync(old, tenDaysAgo, tenDaysAgo);

		const removed = sweepOldResults(tmp, 7);
		expect(removed).toBe(1);
		// old result gone, but its cost.json survives forever (durable cost truth)
		expect(existsSync(old)).toBe(false);
		expect(existsSync(runCostPath(tmp, "obs-old"))).toBe(true);
		expect(existsSync(recent)).toBe(true);
	});

	test("maxAgeDays <= 0 disables the sweep", () => {
		setup();
		const stale = runResultPath(tmp, "obs-stale");
		writeObserverResult(stale, { observations: [] });
		const far = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
		utimesSync(stale, far, far);
		expect(sweepOldResults(tmp, 0)).toBe(0);
		expect(existsSync(stale)).toBe(true);
	});

	test("missing .runs dir → 0, no throw", () => {
		setup();
		rmSync(runsDir(tmp), { recursive: true, force: true });
		expect(sweepOldResults(tmp, 7)).toBe(0);
	});
});
