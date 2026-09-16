/**
 * O4 (#105) telemetry heartbeat tests — pure core + file roundtrip.
 * Hermetic: all file I/O goes through a mkdtempSync dir (PI_TELEMETRY_DIR is
 * NOT consulted by these helpers; paths are passed explicitly).
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildPayload,
	classifyPressure,
	effectivePercent,
	isPidAlive,
	isStale,
	sweepInstances,
	type InstancePayload,
} from "./heartbeat.js";
import { instanceFile, readInstance, telemetryDir, writeInstance } from "./index.js";

const state = { pid: 4242, sessionId: "sess-o4", startedAt: "2026-09-16T00:00:00Z", turnIndex: 3 };
const usage = { tokens: 90_000, contextWindow: 100_000, percent: 90 };

describe("telemetry heartbeat core (O4 #105)", () => {
	test("classifyPressure: ok < 85, near >= 85, close >= 95, null = ok", () => {
		expect(classifyPressure(10)).toBe("ok");
		expect(classifyPressure(84.9)).toBe("ok");
		expect(classifyPressure(85)).toBe("near");
		expect(classifyPressure(94.9)).toBe("near");
		expect(classifyPressure(95)).toBe("close");
		expect(classifyPressure(100)).toBe("close");
		expect(classifyPressure(null)).toBe("ok");
	});

	test("effectivePercent: derives from tokens/window when percent is null", () => {
		expect(effectivePercent(null)).toBeNull();
		expect(effectivePercent({ tokens: null, contextWindow: 1000, percent: null })).toBeNull();
		expect(effectivePercent({ tokens: 50_000, contextWindow: 100_000, percent: null })).toBe(50);
		expect(effectivePercent({ tokens: 50_000, contextWindow: 100_000, percent: 51.2 })).toBe(51.2);
	});

	test("buildPayload: full snapshot, working, near pressure", () => {
		const now = new Date("2026-09-16T12:00:00Z");
		const p = buildPayload(state, "working", usage, now);
		expect(p).toEqual({
			v: 1,
			pid: 4242,
			sessionId: "sess-o4",
			startedAt: "2026-09-16T00:00:00Z",
			updatedAt: "2026-09-16T12:00:00.000Z",
			activity: "working",
			turnIndex: 3,
			context: { tokens: 90_000, contextWindow: 100_000, percent: 90 },
			pressure: "near",
		} satisfies InstancePayload);
	});

	test("buildPayload: compaction case — usage null tolerated, pressure ok", () => {
		const p = buildPayload(state, "working", { tokens: null, contextWindow: 100_000, percent: null });
		expect(p.context?.tokens).toBeNull();
		expect(p.pressure).toBe("ok");
	});

	test("isStale: 119s fresh, 121s stale (default 120s), unparseable = stale", () => {
		const now = new Date("2026-09-16T12:00:00Z");
		const fresh = buildPayload(state, "working", usage, new Date(now.getTime() - 119_000));
		const stale = buildPayload(state, "working", usage, new Date(now.getTime() - 121_000));
		expect(isStale(fresh, now)).toBe(false);
		expect(isStale(stale, now)).toBe(true);
		const bogus = { ...stale, updatedAt: "not-a-date" };
		expect(isStale(bogus as InstancePayload, now)).toBe(true);
	});

	test("isPidAlive: own pid yes, garbage no", () => {
		expect(isPidAlive(process.pid)).toBe(true);
		expect(isPidAlive(-1)).toBe(false);
		expect(isPidAlive(0.5)).toBe(false);
		expect(isPidAlive(999_999_999)).toBe(false);
	});

	test("sweepInstances: deletes stale+dead and shutdown; keeps fresh and stale+alive", () => {
		const now = new Date("2026-09-16T12:00:00Z");
		const mk = (pid: number, ageMs: number, activity: InstancePayload["activity"] = "working") =>
			buildPayload({ pid, sessionId: null, startedAt: "2026-09-16T00:00:00Z", turnIndex: null }, activity, null, new Date(now.getTime() - ageMs));
		const files = [
			{ name: "1.json", payload: mk(999_999_991, 10_000) }, // fresh — keep
			{ name: "2.json", payload: mk(999_999_992, 300_000) }, // stale + dead pid — delete
			{ name: "3.json", payload: mk(process.pid, 300_000) }, // stale but ALIVE — keep
			{ name: "4.json", payload: mk(999_999_994, 10_000, "shutdown") }, // shutdown but fresh — keep
			{ name: "5.json", payload: mk(999_999_995, 300_000, "shutdown") }, // shutdown + stale — delete
			{ name: "6.json", payload: null }, // corrupt — delete
		];
		const report = sweepInstances(files, now, 120_000);
		expect(report.scanned).toBe(6);
		expect(report.deleted.sort()).toEqual(["2.json", "5.json", "6.json"]);
	});
});

describe("telemetry instance file I/O (O4 #105)", () => {
	test("atomic write + read roundtrip in temp dir", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-telemetry-"));
		const file = instanceFile(4242, dir);
		expect(file).toBe(join(dir, "4242.json"));
		writeInstance(buildPayload(state, "working", usage), file);
		const back = readInstance(file);
		expect(back?.pid).toBe(4242);
		expect(back?.activity).toBe("working");
		expect(back?.pressure).toBe("near");
		// no tmp litter after rename
		expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
	});

	test("readInstance: missing/corrupt file → null, never throws", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-telemetry-"));
		expect(readInstance(join(dir, "nope.json"))).toBeNull();
		writeFileSync(join(dir, "corrupt.json"), "{not json", "utf8");
		expect(readInstance(join(dir, "corrupt.json"))).toBeNull();
	});

	test("consumer contract: a torn write is impossible (tmp never equals final name)", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-telemetry-"));
		const file = instanceFile(777, dir);
		writeInstance(buildPayload(state, "waiting_input", null), file);
		const raw = readFileSync(file, "utf8");
		expect(() => JSON.parse(raw)).not.toThrow(); // final file is always whole JSON
		expect(existsSync(`${file}.tmp`)).toBe(false);
	});

	test("telemetryDir: PI_TELEMETRY_DIR override beats default path", () => {
		const saved = process.env.PI_TELEMETRY_DIR;
		try {
			process.env.PI_TELEMETRY_DIR = "/tmp/o4-override";
			expect(telemetryDir()).toBe("/tmp/o4-override");
		} finally {
			if (saved === undefined) delete process.env.PI_TELEMETRY_DIR;
			else process.env.PI_TELEMETRY_DIR = saved;
		}
	});
});
