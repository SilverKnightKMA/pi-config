import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTimelineSink } from "./timeline-message.ts";
import { appendOmStatusEvent, omStatusPath, writeOmStatusSnapshot, type OmStatusFile, type PiSnapshotSource } from "./status-file.ts";
import { runCostPath, writeWorkerCost } from "../spawn/runs.ts";
import type { Runtime } from "../runtime.ts";

/**
 * v2 emission contract (2026-09-04): with a runtime attached the sink must NOT
 * call sendMessage (custom messages enter the model context — that's the bug
 * this fixes) and must write the workspace status file instead. The legacy
 * in-chat emission survives only behind OM_TIMELINE_EMISSION=message.
 */

function stubRuntime(root: string): Runtime {
	return {
		memoryRoot: join(root, ".memory", "sess-1"),
		enabled: true,
		config: {
			consolidateAtPoolTokens: 60000,
			poolTargetTokens: 8000,
			chunkTokens: 9000,
			observerConcurrency: 2,
			compactAtContextTokens: 150000,
		},
		observersInFlight: new Map(),
		consolidatorInFlight: false,
		lastWorkerError: undefined,
	} as unknown as Runtime;
}

describe("om timeline sink v2 — file, not messages", () => {
	test("sink with runtime: no sendMessage, writes om-status.json", async () => {
		const dir = mkdtempSync(join(tmpdir(), "omv2-"));
		const rt = stubRuntime(dir);
		let sent = 0;
		const fake = { sendMessage: () => { sent++; } };
		const sink = makeTimelineSink(fake as never, { runtime: rt });
		sink.notify("om: observer done: 5 observations from ~1.0k tok");
		await new Promise((r) => setTimeout(r, 80)); // coalesce tick + async write
		expect(sent).toBe(0);
		const statusPath = omStatusPath(rt)!;
		expect(statusPath.endsWith(join(".memory", "sess-1", "om-status.json"))).toBe(true);
		expect(existsSync(statusPath)).toBe(true);
		const file = JSON.parse(readFileSync(statusPath, "utf8")) as OmStatusFile;
		expect(file.schema).toBe(1);
		expect(file.events.at(-1)?.text).toContain("observer done: 5 observations");
		expect(file.lines[0]).toContain("om status");
		expect(file.workspace).toBe(dir);
	});

	test("appendOmStatusEvent: ring capped at 24, newest last", async () => {
		const dir = mkdtempSync(join(tmpdir(), "omv2ring-"));
		const rt = stubRuntime(dir);
		for (let i = 0; i < 30; i++) await appendOmStatusEvent(rt, `event ${i}`);
		const file = JSON.parse(readFileSync(omStatusPath(rt)!, "utf8")) as OmStatusFile;
		expect(file.events).toHaveLength(24);
		expect(file.events[0]?.text).toBe("event 6");
		expect(file.events.at(-1)?.text).toBe("event 29");
	});

	test("v2.1: session cost from getEntries + real context — no more $0.0000 / context ?", async () => {
		const dir = mkdtempSync(join(tmpdir(), "omv2ctx-"));
		const rt = stubRuntime(dir);
		// empty branch (fresh respawn/compact) but full ledger: cost entries $1.5 + $2.5, 2 runs
		const costEntry = (usd: number) => ({
			type: "custom",
			customType: "om.cost",
			data: { costUsd: usd, role: "observer" },
		});
		const pi: PiSnapshotSource = {
			sessionManager: { getBranch: () => [], getEntries: () => [costEntry(1.5), costEntry(2.5)] },
			getContextUsage: () => ({ tokens: 60000 }),
		};
		await appendOmStatusEvent(rt, "om: observer done", pi);
		const file = JSON.parse(readFileSync(omStatusPath(rt)!, "utf8")) as OmStatusFile;
		const ctxLine = file.lines.find((l) => l.trim().startsWith("context:"))!;
		expect(ctxLine).toContain("60,000");
		expect(ctxLine).not.toContain("?");
		const sessionLine = file.lines.find((l) => l.trim().startsWith("session:"))!;
		expect(sessionLine).toContain("4.0000");
		expect(sessionLine).toContain("(2 runs)");
		expect(file.summary?.sessionCostUsd).toBe(4);
		expect(file.summary?.sessionRuns).toBe(2);
		expect(file.summary?.contextTokens).toBe(60000);
		expect(file.summary?.verdict).toBe("healthy");
	});

	test("v2.2: file lives under .memory/<sessionId>/ — two sessions never stomp each other", async () => {
		const dir = mkdtempSync(join(tmpdir(), "omv2sess-"));
		const rtA = stubRuntime(dir);
		const rtB = { ...rtA, memoryRoot: join(dir, ".memory", "sess-2") } as Runtime;
		await appendOmStatusEvent(rtA, "from-a");
		await appendOmStatusEvent(rtB, "from-b");
		const fileA = JSON.parse(readFileSync(omStatusPath(rtA)!, "utf8")) as OmStatusFile;
		const fileB = JSON.parse(readFileSync(omStatusPath(rtB)!, "utf8")) as OmStatusFile;
		expect(fileA.sessionId).toBe("sess-1");
		expect(fileB.sessionId).toBe("sess-2");
		expect(fileA.events.at(-1)?.text).toBe("from-a"); // b does not overwrite a
		expect(fileB.events.at(-1)?.text).toBe("from-b");
	});

	test("v2.1: writeOmStatusSnapshot refresh between events — ring unchanged, new lines", async () => {
		const dir = mkdtempSync(join(tmpdir(), "omv2snap-"));
		const rt = stubRuntime(dir);
		await appendOmStatusEvent(rt, "event-a");
		const before = JSON.parse(readFileSync(omStatusPath(rt)!, "utf8")) as OmStatusFile;
		await new Promise((r) => setTimeout(r, 30));
		const pi: PiSnapshotSource = { getContextUsage: () => ({ tokens: 42000 }) };
		await writeOmStatusSnapshot(rt, pi);
		const after = JSON.parse(readFileSync(omStatusPath(rt)!, "utf8")) as OmStatusFile;
		expect(after.events).toHaveLength(before.events.length); // no event appended
		expect(after.generatedAt).not.toBe(before.generatedAt); // but snapshot is new
		expect(after.lines.some((l) => l.includes("42,000"))).toBe(true);
	});

	test("escape hatch: OM_TIMELINE_EMISSION=message keeps the old channel", async () => {
		const dir = mkdtempSync(join(tmpdir(), "omv2leg-"));
		const rt = stubRuntime(dir);
		process.env.OM_TIMELINE_EMISSION = "message";
		try {
			let sent = 0;
			const fake = { sendMessage: () => { sent++; } };
			const sink = makeTimelineSink(fake as never, { runtime: rt });
			sink.notify("om: observer done");
			await new Promise((r) => setTimeout(r, 80));
			expect(sent).toBe(1);
		} finally {
			delete process.env.OM_TIMELINE_EMISSION;
		}
	});
});

describe("om status v2.5 — durable cost from .runs (restart-safe)", () => {
	test("session cost/runs come from cost files when the ledger is empty (after restart)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "omv2runs-"));
		const rt = stubRuntime(dir);
		mkdirSync(join(rt.memoryRoot, ".runs"), { recursive: true });
		writeWorkerCost(runCostPath(rt.memoryRoot, "obs-a"), { costUsd: 0.001, role: "observer" });
		writeWorkerCost(runCostPath(rt.memoryRoot, "obs-b"), { costUsd: 0.002, role: "observer" });
		writeWorkerCost(runCostPath(rt.memoryRoot, "obs-c"), { costUsd: 0.0009, role: "consolidator" });
		writeWorkerCost(runCostPath(rt.memoryRoot, "obs-old"), { costUsd: 0.0003 }); // pre-tag file

		// ledger fully empty — exactly the fresh-process state after a restart
		const pi: PiSnapshotSource = { sessionManager: { getBranch: () => [], getEntries: () => [] } };
		await writeOmStatusSnapshot(rt, pi);
		const file = JSON.parse(readFileSync(omStatusPath(rt)!, "utf8")) as OmStatusFile;
		expect(file.summary?.sessionRuns).toBe(4);
		expect(Math.abs((file.summary?.sessionCostUsd ?? 0) - 0.0042)).toBeLessThan(1e-9);
		// the session line in lines also carries durable numbers
		expect(file.lines.some((l) => l.includes("session: $0.0042 (4 runs)"))).toBe(true);
		// role split from the tag in the file (untagged legacy files only add to total)
		expect(file.lines.some((l) => l.includes("observer") && l.includes("$0.0030 (2 runs)"))).toBe(true);
		expect(file.lines.some((l) => l.includes("consolidator") && l.includes("$0.0009 (1 runs)"))).toBe(true);
	});

	test("no cost files → fall back to the ledger as before", async () => {
		const dir = mkdtempSync(join(tmpdir(), "omv2nof-"));
		const rt = stubRuntime(dir); // no .runs created
		const pi: PiSnapshotSource = { sessionManager: { getBranch: () => [], getEntries: () => [] } };
		await writeOmStatusSnapshot(rt, pi);
		const file = JSON.parse(readFileSync(omStatusPath(rt)!, "utf8")) as OmStatusFile;
		expect(file.summary?.sessionRuns).toBe(0);
		expect(file.summary?.sessionCostUsd).toBe(0);
	});
});
