import { describe, expect, it } from "bun:test";
import { TurnWatchdog, SettleWatch, LoopDetector, toolCallSignature, evidenceFor, isSyntheticMessage } from "./watchdog-core.js";
import { TerminationLedger } from "./termination-ledger.js";
import { mcpCall, getAgentStatus } from "./daemon.js";
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
		const timeline: { customType: string; content: string; display: boolean }[] = [];
		const pi = {
			on(ev: string, h: any) {
				handlers.set(ev, h as never);
			},
			registerCommand(name: string) {
				commands.push(name);
			},
			sendMessage(m: { customType: string; content: string; display: boolean }) {
				timeline.push(m);
			},
		} as never;

		// isolate from the REAL ~/.pi/agent/zombie-watchdog.runs: a dead process's
		// open turn on this machine would make recoverStale() prepend a
		// "crash-recovered" detection into logPath and break this test (observed
		// live 2026-09-19 after a container restart left stale records).
		const ledgerDir = join(tmpdir(), `zw-wiring-ledger-${Date.now()}`);
		const tick = wire(pi, { now: () => fakeNow, logPath, ledgerDir });
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
			// v2 (2026-09-04): timeline emission is OFF by default — custom messages
			// enter the model context and the agent must stay blind to watchdog
			// chatter. Detection visibility = jsonl + Agent Health panel (+ toast here).
			expect(timeline.length).toBe(0);
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
			rmSync(ledgerDir, { recursive: true, force: true });
		}
	});
});

describe("auto-stop (user directive 2026-09-05: zombie-class detections press STOP themselves)", () => {
	function makeHarness() {
		const dir = mkdtempSync(join(tmpdir(), "zw-autostop-"));
		const logPath = join(dir, "log.jsonl");
		const calls: Array<{ tool: string; args: any }> = [];
		const fakeFetch = (async (_url: any, init: any) => {
			const body = JSON.parse(init.body);
			calls.push({ tool: body.params.name, args: body.params.arguments });
			const sse = `data: {"result":{"content":[{"type":"text","text":"{\\"ok\\":true}"}]}}\n\n`;
			return new Response(sse, { status: 200 });
		}) as unknown as typeof fetch;
		let fakeNow = 1_000_000;
		const handlers = new Map<string, (e?: unknown, ctx?: unknown) => void>();
		const ui = {
			statuses: new Map<string, string | undefined>(),
			notify() {},
			setStatus(key: string, text: string | undefined) {
				this.statuses.set(key, text);
			},
		};
		const pi = {
			on(ev: string, h: any) {
				handlers.set(ev, h as never);
			},
			registerCommand() {},
			sendMessage() {},
		} as never;
		const endpoint = { url: "http://daemon", token: "t" };
		const tick = wire(pi, {
			now: () => fakeNow,
			logPath,
			selfAgentId: "agent-self",
			endpoint,
			fetchImpl: fakeFetch as typeof fetch,
		});
		return { dir, logPath, calls, handlers, ui, tick, advance: (ms: number) => (fakeNow += ms) };
	}

	it("in-turn zombie DEFERS cancel (absence-only) until the confirming repeat", async () => {
		const h = makeHarness();
		try {
			h.handlers.get("session_start")!(undefined, { hasUI: true, ui: h.ui, sessionFile: "/tmp/s.jsonl" });
			h.handlers.get("turn_start")!();
			h.handlers.get("message_start")!();
			h.advance(130_000);
			const sig = h.tick();
			expect(sig?.code).toBe("zombie");
			await new Promise((r) => setTimeout(r, 5));
			// #107 D: first zombie is absence-only — no STOP yet, deferred note logged
			expect(h.calls.filter((c) => c.tool === "cancel_agent").length).toBe(0);
			const list0 = readDetections(h.logPath);
			expect(list0.some((d) => d.code === "auto-stop:deferred:zombie")).toBe(true);
			expect(list0.find((d) => d.code === "zombie")?.safeToInterrupt).toBe(false);
			// confirming repeat (reNotifyMs = 300s default) licenses the STOP
			h.advance(300_000);
			const sig2 = h.tick();
			expect(sig2?.code).toBe("zombie-repeat");
			await new Promise((r) => setTimeout(r, 5));
			expect(h.calls.filter((c) => c.tool === "cancel_agent").length).toBe(1);
			expect(h.calls[0].args).toEqual({ agentId: "agent-self" });
			const list = readDetections(h.logPath);
			expect(list.some((d) => d.code === "auto-stop:ok:zombie-repeat")).toBe(true);
			expect(list.find((d) => d.code === "auto-stop:ok:zombie-repeat")?.safeToInterrupt).toBe(true);
			expect(h.ui.statuses.get("zw")).toContain("auto-stopped");
		} finally {
			h.handlers.get("session_shutdown")?.();
			rmSync(h.dir, { recursive: true, force: true });
		}
	});

	it("ZW_ABSENCE_GUARD=0 restores v1 immediate zombie stop", async () => {
		const prev = process.env.ZW_ABSENCE_GUARD;
		process.env.ZW_ABSENCE_GUARD = "0";
		const h = makeHarness();
		try {
			h.handlers.get("session_start")!(undefined, { hasUI: true, ui: h.ui, sessionFile: "/tmp/s.jsonl" });
			h.handlers.get("turn_start")!();
			h.handlers.get("message_start")!();
			h.advance(130_000);
			expect(h.tick()?.code).toBe("zombie");
			await new Promise((r) => setTimeout(r, 5));
			expect(h.calls.filter((c) => c.tool === "cancel_agent").length).toBe(1);
			expect(readDetections(h.logPath).some((d) => d.code === "auto-stop:ok:zombie")).toBe(true);
		} finally {
			h.handlers.get("session_shutdown")?.();
			rmSync(h.dir, { recursive: true, force: true });
			if (prev === undefined) delete process.env.ZW_ABSENCE_GUARD;
			else process.env.ZW_ABSENCE_GUARD = prev;
		}
	});

	it("tool-stall NEVER auto-stops (long-run tools are legitimate)", async () => {
		const h = makeHarness();
		try {
			h.handlers.get("session_start")!(undefined, { hasUI: true, ui: h.ui });
			h.handlers.get("turn_start")!();
			h.handlers.get("tool_execution_start")!();
			h.advance(601_000);
			expect(h.tick()?.code).toBe("tool-stall");
			await new Promise((r) => setTimeout(r, 5));
			expect(h.calls.filter((c) => c.tool === "cancel_agent").length).toBe(0);
		} finally {
			h.handlers.get("session_shutdown")?.();
			rmSync(h.dir, { recursive: true, force: true });
		}
	});

	it("no endpoint/selfAgentId (plain pi run) → detection only, no cancel", async () => {
		const dir = mkdtempSync(join(tmpdir(), "zw-nostop-"));
		const logPath = join(dir, "log.jsonl");
		let fakeNow = 1_000_000;
		const handlers = new Map<string, (e?: unknown, ctx?: unknown) => void>();
		const pi = { on(ev: string, hh: any) { handlers.set(ev, hh); }, registerCommand() {}, sendMessage() {} } as never;
		const tick = wire(pi, { now: () => fakeNow, logPath, selfAgentId: null, endpoint: undefined });
		try {
			handlers.get("session_start")!(undefined, { hasUI: true, ui: h0ui() });
			handlers.get("turn_start")!();
			handlers.get("message_start")!();
			fakeNow += 130_000;
			expect(tick()?.code).toBe("zombie");
			await new Promise((r) => setTimeout(r, 5));
			// zombie detection logged, no crash, no daemon call attempted
			expect(readDetections(logPath)[0].code).toBe("zombie");
		} finally {
			handlers.get("session_shutdown")?.();
			rmSync(dir, { recursive: true, force: true });
		}
		function h0ui() {
			return { notify() {}, setStatus() {} };
		}
	});
});

describe("SettleWatch (B2 daemon-side settle-loss)", () => {
	it("busy on both checks after turn_end → b2-settle-lost, once", () => {
		const sw = new SettleWatch({ firstCheckMs: 20_000, secondCheckMs: 45_000 });
		sw.onTurnEnd(0);
		expect(sw.dueCheck(10_000)).toBeNull();
		expect(sw.dueCheck(20_000)).toBe("first");
		expect(sw.onPoll(20_000, true)).toBeNull(); // first busy: suspicious only
		expect(sw.dueCheck(30_000)).toBeNull();
		expect(sw.onPoll(44_000, true)).toBeNull(); // before second deadline
		expect(sw.onPoll(45_000, true)).toBe("b2-settle-lost");
		expect(sw.onPoll(60_000, true)).toBeNull(); // never twice
		expect(sw.watching).toBe(false);
	});

	it("daemon settled at first check → no signal, watch disarmed", () => {
		const sw = new SettleWatch({ firstCheckMs: 20_000, secondCheckMs: 45_000 });
		sw.onTurnEnd(0);
		expect(sw.onPoll(20_000, false)).toBeNull();
		expect(sw.onPoll(45_000, true)).toBeNull(); // disarmed after clean settle
	});

	it("new turn_start cancels the watch (daemon running is legitimate)", () => {
		const sw = new SettleWatch({ firstCheckMs: 20_000, secondCheckMs: 45_000 });
		sw.onTurnEnd(0);
		sw.onTurnStart();
		expect(sw.dueCheck(20_000)).toBeNull();
		expect(sw.onPoll(20_000, true)).toBeNull();
	});

	it("poll outside due window is ignored", () => {
		const sw = new SettleWatch({ firstCheckMs: 20_000, secondCheckMs: 45_000 });
		sw.onTurnEnd(0);
		expect(sw.onPoll(5_000, true)).toBeNull();
	});
});

describe("daemon client", () => {
	it("mcpCall parses SSE-framed MCP answers (the real daemon format) and always sends a JSON-RPC id", async () => {
		const seen: any[] = [];
		const fakeFetch = (async (_url: any, init: any) => {
			seen.push(JSON.parse(init.body));
			const sse = `event: message\ndata: {"result":{"content":[{"type":"text","text":"{\\\"status\\\":\\\"idle\\\"}"}]}}\n\n`;
			return new Response(sse, { status: 200 });
		}) as unknown as typeof fetch;
		const r = await mcpCall({ url: "http://x", token: "t" }, "get_agent_status", { agentId: "a" }, 5_000, fakeFetch);
		expect(r.ok).toBe(true);
		expect(typeof seen[0].id).toBe("number");
		expect(seen[0].method).toBe("tools/call");
		const st = await getAgentStatus({ url: "http://x", token: "t" }, "a", fakeFetch);
		expect(st.status).toBe("idle");
	});

	it("mcpCall reports tool errors from isError frames", async () => {
		const fakeFetch = (async () =>
			new Response(`data: {"result":{"isError":true,"content":[{"text":"nope"}]}}\n`, { status: 200 })) as unknown as typeof fetch;
		const r = await mcpCall({ url: "http://x", token: "t" }, "x", {}, 5_000, fakeFetch);
		expect(r.ok).toBe(false);
		expect(r.error).toContain("nope");
	});
});

// ---------------------------------------------------------------------------
// v1.4.92 (#107) — the 4-port: Cline loop tiers, canonical signature,
// synthetic flag, absence-only guard, termination funnel + crash recovery.
// ---------------------------------------------------------------------------

describe("#107 B: Cline loop detection (canonical signature + 2 tiers)", () => {
	it("toolCallSignature sorts keys, strips IGNORED_PARAMS, keeps semantics", () => {
		const a = toolCallSignature("grep", { pattern: "x", path: "y", task_progress: 1 });
		const b = toolCallSignature("grep", { path: "y", pattern: "x", task_progress: 999 });
		expect(a).toBe(b);
		expect(a).toContain("grep(");
		expect(a).not.toContain("task_progress");
	});

	it("soft at 3 identical, hard at 5, reset on different signature or turn", () => {
		const ld = new LoopDetector();
		const args = { q: 1 };
		expect(ld.onToolStart("bash", args).tier).toBeNull();
		expect(ld.onToolStart("bash", args).tier).toBeNull();
		expect(ld.onToolStart("bash", { q: 1, task_progress: 7 }).tier).toBe("soft"); // ignored param ≠ different call
		expect(ld.onToolStart("bash", args).tier).toBeNull(); // 4th: between tiers
		expect(ld.onToolStart("bash", args).tier).toBe("hard"); // 5th
		ld.onTurnBoundary();
		expect(ld.onToolStart("bash", args).count).toBe(1);
		expect(ld.onToolStart("bash", { q: 2 }).count).toBe(1); // different args reset
	});
});

describe("#107 B wiring: soft warns ui-only, hard escalates to cancel", () => {
	it("5 identical tool calls fire loop-soft then loop-hard + auto-stop", async () => {
		const dir = mkdtempSync(join(tmpdir(), "zw-loop-"));
		const calls: Array<{ tool: string; args: any }> = [];
		const fakeFetch = (async (_u: any, init: any) => {
			const body = JSON.parse(init.body);
			calls.push({ tool: body.params.name, args: body.params.arguments });
			return new Response(`data: {"result":{"content":[{"type":"text","text":"{\\"ok\\":true}"}]}}\n`, { status: 200 });
		}) as unknown as typeof fetch;
		const notes: string[] = [];
		const handlers = new Map<string, (e?: unknown, ctx?: unknown) => void>();
		const pi = { on(ev: string, h: any) { handlers.set(ev, h); }, registerCommand() {}, sendMessage() {} } as never;
		const tick = wire(pi, {
			now: () => 1_000_000,
			logPath: join(dir, "log.jsonl"),
			ledgerDir: join(dir, "runs"),
			selfAgentId: "agent-loop",
			endpoint: { url: "http://d", token: "t" },
			fetchImpl: fakeFetch,
		});
		try {
			handlers.get("session_start")!(undefined, { hasUI: true, ui: { notify: (m: string) => notes.push(m), setStatus() {} } });
			handlers.get("turn_start")!();
			for (let i = 0; i < 5; i++) handlers.get("tool_execution_start")!({ toolName: "bash", args: { command: "ls /tmp/x" } });
			await new Promise((r) => setTimeout(r, 5));
			const list = readDetections(join(dir, "log.jsonl"));
			expect(list.filter((d) => d.code === "loop-soft").length).toBe(1);
			expect(list.some((d) => d.code === "loop-hard")).toBe(true);
			expect(calls.filter((c) => c.tool === "cancel_agent").length).toBe(1); // hard tier = positive evidence → STOP licensed
			expect(list.find((d) => d.code === "loop-hard")?.confirmedFailure).toBe(true);
		} finally {
			handlers.get("session_shutdown")?.();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("#107 C: synthetic flag (watchdog never feeds itself)", () => {
	it("zw-* custom messages are synthetic; others are not", () => {
		expect(isSyntheticMessage({ customType: "zw-timeline" })).toBe(true);
		expect(isSyntheticMessage({ customType: "zw-resume" })).toBe(true);
		expect(isSyntheticMessage({ role: "user", content: "hi" })).toBe(false);
		expect(isSyntheticMessage(undefined)).toBe(false);
	});

	it("a zw-* message_start does NOT reset the zombie clock", () => {
		const dir = mkdtempSync(join(tmpdir(), "zw-syn-"));
		const handlers = new Map<string, (e?: unknown, ctx?: unknown) => void>();
		const pi = { on(ev: string, h: any) { handlers.set(ev, h); }, registerCommand() {}, sendMessage() {} } as never;
		let t = 1_000_000;
		const tick = wire(pi, { now: () => t, logPath: join(dir, "log.jsonl"), ledgerDir: join(dir, "runs") });
		try {
			handlers.get("session_start")!(undefined, { hasUI: false });
			handlers.get("turn_start")!();
			handlers.get("message_start")!();
			t += 100_000;
			// our own emission arrives — must NOT count as activity
			handlers.get("message_start")!({ message: { customType: "zw-timeline" } });
			t += 30_000;
			expect(tick()?.code).toBe("zombie"); // still silent 130s → zombie fired (not reset by synthetic)
		} finally {
			handlers.get("session_shutdown")?.();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("#107 D: absence-only evidence guard", () => {
	it("evidence matrix: b2/loop-hard positive; zombie absence; repeat licenses STOP; guard-off restores", () => {
		expect(evidenceFor("b2-settle-lost").safeToInterrupt).toBe(true);
		expect(evidenceFor("b2-settle-lost").confirmedFailure).toBe(true);
		expect(evidenceFor("loop-hard").safeToInterrupt).toBe(true);
		const z = evidenceFor("zombie");
		expect(z.confirmedFailure).toBe(false);
		expect(z.safeToInterrupt).toBe(false);
		expect(evidenceFor("zombie-repeat").safeToInterrupt).toBe(true);
		expect(evidenceFor("tool-stall").safeToInterrupt).toBe(false);
		expect(evidenceFor("zombie", { absenceGuard: false }).safeToInterrupt).toBe(true);
	});
});

describe("#107 A: termination funnel + crash recovery ledger", () => {
	it("first finalize wins; later finalize no-ops (idempotent funnel)", () => {
		const dir = mkdtempSync(join(tmpdir(), "zw-led-"));
		try {
			const led = new TerminationLedger(dir);
			led.open("t1", "/tmp/s.jsonl", new Date(0).toISOString());
			led.recordDetection("t1", "zombie");
			expect(led.finalize("t1", "stall-stopped", new Date(1000).toISOString())).toBe(true);
			expect(led.finalize("t1", "completed", new Date(2000).toISOString())).toBe(false); // one-shot
			const r = led.read("t1")!;
			expect(r.reason).toBe("stall-stopped");
			expect(r.detections).toEqual(["zombie"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("recoverStale stamps crash-recovered + recovered:true exactly once", () => {
		const dir = mkdtempSync(join(tmpdir(), "zw-rec-"));
		try {
			const led = new TerminationLedger(dir);
			led.open("t-open", "/tmp/s.jsonl", new Date(0).toISOString());
			led.open("t-done", "/tmp/s.jsonl", new Date(0).toISOString());
			expect(led.finalize("t-done", "completed", new Date(1).toISOString())).toBe(true);
			const recovered = led.recoverStale(Date.now());
			expect(recovered.map((r) => r.turnId)).toEqual(["t-open"]);
			expect(recovered[0].reason).toBe("crash-recovered");
			expect(recovered[0].recovered).toBe(true);
			expect(led.recoverStale(Date.now())).toEqual([]); // exactly once — now finalized
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("turn lifecycle funnels to exactly one reason per turn", async () => {
		const dir = mkdtempSync(join(tmpdir(), "zw-fun-"));
		const handlers = new Map<string, (e?: unknown, ctx?: unknown) => void>();
		const pi = { on(ev: string, h: any) { handlers.set(ev, h); }, registerCommand() {}, sendMessage() {} } as never;
		let t = 1_000_000;
		const led = new TerminationLedger(join(dir, "runs"));
		// reuse wire with same ledgerDir to observe end-to-end
		const tick = wire(pi, { now: () => t, logPath: join(dir, "log.jsonl"), ledgerDir: join(dir, "runs") });
		try {
			handlers.get("session_start")!(undefined, { hasUI: false, sessionFile: "/tmp/s.jsonl" });
			handlers.get("turn_start")!();
			handlers.get("message_start")!();
			t += 130_000;
			tick(); // zombie (deferred — absence guard)
			handlers.get("turn_end")!(); // completes normally → funnel "completed"
			void led; // ledger observed via wire's own instance below
			const { readdirSync, readFileSync } = await import("node:fs");
			const files = readdirSync(join(dir, "runs")).filter((f) => f.endsWith(".json"));
			expect(files.length).toBe(1);
			const rec = JSON.parse(readFileSync(join(dir, "runs", files[0]), "utf8"));
			expect(rec.reason).toBe("completed");
			expect(rec.detections).toContain("zombie");
			// session dies mid-turn → shutdown reason
			handlers.get("turn_start")!();
			handlers.get("message_start")!();
			handlers.get("session_shutdown")!();
			const files2 = readdirSync(join(dir, "runs")).filter((f) => f.endsWith(".json"));
			const rec2 = JSON.parse(readFileSync(join(dir, "runs", files2[1]), "utf8"));
			expect(rec2.reason).toBe("shutdown");
		} finally {
			handlers.get("session_shutdown")?.();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
