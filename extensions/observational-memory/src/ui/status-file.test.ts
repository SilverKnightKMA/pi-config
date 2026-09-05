import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTimelineSink } from "./timeline-message.ts";
import { appendOmStatusEvent, omStatusPath, type OmStatusFile } from "./status-file.ts";
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
	test("sink với runtime: không sendMessage, ghi om-status.json", async () => {
		const dir = mkdtempSync(join(tmpdir(), "omv2-"));
		const rt = stubRuntime(dir);
		let sent = 0;
		const fake = { sendMessage: () => { sent++; } };
		const sink = makeTimelineSink(fake as never, { runtime: rt });
		sink.notify("om: observer done: 5 observations from ~1.0k tok");
		await new Promise((r) => setTimeout(r, 80)); // coalesce tick + async write
		expect(sent).toBe(0);
		const statusPath = omStatusPath(rt)!;
		expect(statusPath.endsWith(join(".memory", "om-status.json"))).toBe(true);
		expect(existsSync(statusPath)).toBe(true);
		const file = JSON.parse(readFileSync(statusPath, "utf8")) as OmStatusFile;
		expect(file.schema).toBe(1);
		expect(file.events.at(-1)?.text).toContain("observer done: 5 observations");
		expect(file.lines[0]).toContain("om status");
		expect(file.workspace).toBe(dir);
	});

	test("appendOmStatusEvent: ring giới hạn 24, thứ tự mới nhất cuối", async () => {
		const dir = mkdtempSync(join(tmpdir(), "omv2ring-"));
		const rt = stubRuntime(dir);
		for (let i = 0; i < 30; i++) await appendOmStatusEvent(rt, `event ${i}`);
		const file = JSON.parse(readFileSync(omStatusPath(rt)!, "utf8")) as OmStatusFile;
		expect(file.events).toHaveLength(24);
		expect(file.events[0]?.text).toBe("event 6");
		expect(file.events.at(-1)?.text).toBe("event 29");
	});

	test("escape hatch: OM_TIMELINE_EMISSION=message giữ kênh cũ", async () => {
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
