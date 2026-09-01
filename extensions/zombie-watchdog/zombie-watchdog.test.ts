import { describe, expect, it } from "bun:test";
import { TurnWatchdog } from "./watchdog-core.js";
import { readDetections, wire } from "./index.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("TurnWatchdog core", () => {
	it("healthy streaming never signals", () => {
		const wd = new TurnWatchdog();
		wd.onTurnStart(0);
		for (let t = 0; t <= 600_000; t += 5_000) {
			wd.onActivity(t); // stream updates every 5s
			expect(wd.tick(t + 1_000)).toBeNull();
		}
	});

	it("signals zombie after stallMs idle with no tool in flight", () => {
		const wd = new TurnWatchdog({ stallMs: 120_000 });
		wd.onTurnStart(0);
		wd.onActivity(1_000);
		expect(wd.tick(60_000)).toBeNull(); // below threshold
		const sig = wd.tick(121_000);
		expect(sig?.code).toBe("zombie");
		expect(sig?.idleMs).toBe(120_000);
	});

	it("re-warns on reNotifyMs cadence while the zombie persists", () => {
		const wd = new TurnWatchdog({ stallMs: 120_000, reNotifyMs: 300_000 });
		wd.onTurnStart(0);
		wd.onActivity(1_000);
		expect(wd.tick(121_000)?.code).toBe("zombie");
		expect(wd.tick(130_000)).toBeNull(); // no spam in between
		expect(wd.tick(421_000)?.code).toBe("zombie-repeat");
		expect(wd.tick(721_000)?.code).toBe("zombie-repeat");
	});

	it("recovery clears suspicion and the repeat cadence", () => {
		const wd = new TurnWatchdog({ stallMs: 120_000, reNotifyMs: 300_000 });
		wd.onTurnStart(0);
		wd.onActivity(1_000);
		expect(wd.tick(121_000)?.code).toBe("zombie");
		wd.onActivity(150_000); // recovered: stream came back
		expect(wd.tick(200_000)).toBeNull();
		expect(wd.tick(271_000)?.code).toBe("zombie"); // fresh grace period
	});

	it("a tool in flight is NOT a zombie (voz-style 5-minute crawls)", () => {
		const wd = new TurnWatchdog({ stallMs: 120_000, toolStallMs: 600_000 });
		wd.onTurnStart(0);
		wd.onToolStart(1_000);
		expect(wd.tick(300_000)).toBeNull(); // 5 min quiet tool: fine
		expect(wd.tick(601_000)?.code).toBe("tool-stall"); // 10 min: soft note, once
		expect(wd.tick(650_000)).toBeNull();
	});

	it("after the tool ends, zombie detection resumes", () => {
		const wd = new TurnWatchdog({ stallMs: 120_000, toolStallMs: 600_000 });
		wd.onTurnStart(0);
		wd.onToolStart(1_000);
		wd.onToolEnd(400_000);
		expect(wd.tick(450_000)).toBeNull();
		expect(wd.tick(521_000)?.code).toBe("zombie");
	});

	it("turn_end clears everything", () => {
		const wd = new TurnWatchdog({ stallMs: 120_000 });
		wd.onTurnStart(0);
		wd.onActivity(1_000);
		wd.onTurnEnd(10_000);
		expect(wd.tick(10_000_000)).toBeNull();
		expect(wd.active).toBe(false);
	});

	it("nested tools tracked by depth", () => {
		const wd = new TurnWatchdog({ stallMs: 120_000 });
		wd.onTurnStart(0);
		wd.onToolStart(1);
		wd.onToolStart(2);
		wd.onToolEnd(3);
		expect(wd.toolsInFlight).toBe(1);
		wd.onToolEnd(4);
		expect(wd.toolsInFlight).toBe(0);
	});
});

describe("zombie-watchdog wiring", () => {
	it("wires events, logs detections, notifies via ui, and /zw reads them back", () => {
		const dir = mkdtempSync(join(tmpdir(), "zw-"));
		const logPath = join(dir, "log.jsonl");
		let fakeNow = 1_000_000;
		const handlers = new Map<string, (e?: unknown, ctx?: unknown) => void>();
		const commands: string[] = [];
		const ui = {
			notes: [] as string[],
			statuses: new Map<string, string | undefined>(),
			notify(msg: string, _kind?: string) {
				this.notes.push(msg);
			},
			setStatus(key: string, text: string | undefined) {
				this.statuses.set(key, text);
			},
		};
		const pi = {
			on(ev: string, h: any) {
				handlers.set(ev, h as never);
			},
			registerCommand(name: string) {
				commands.push(name);
			},
		} as never;

		const tick = wire(pi, { now: () => fakeNow, logPath });
		try {
			handlers.get("session_start")!(undefined, { hasUI: true, ui, sessionFile: "/tmp/s.jsonl" });
			handlers.get("turn_start")!();
			handlers.get("message_start")!();
			// 130s of silence → zombie
			fakeNow += 130_000;
			const sig = tick();
			expect(sig?.code).toBe("zombie");
			expect(ui.notes.length).toBe(1);
			expect(ui.notes[0]).toContain("#3845");
			expect(ui.statuses.get("zw")).toContain("STOP");
			// turn recovers
			handlers.get("turn_end")!();
			expect(ui.statuses.get("zw")).toBeUndefined();
			// detections persisted and /zw reads them
			const list = readDetections(logPath);
			expect(list.length).toBeGreaterThanOrEqual(1);
			expect(list[0].code).toBe("zombie");
			expect(list[0].sessionFile).toBe("/tmp/s.jsonl");
			expect(commands).toContain("zw");
		} finally {
			handlers.get("session_shutdown")?.();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
