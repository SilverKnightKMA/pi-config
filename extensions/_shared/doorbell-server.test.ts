import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createConnection } from "node:net";
import { dispatchBell, registerBellListener, startDoorbellServer, stopDoorbellServer, type DoorbellBell } from "./doorbell-server.ts";

let root: string;
const bells: DoorbellBell[] = [];

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "bell-srv-"));
	bells.length = 0;
});

afterEach(() => {
	stopDoorbellServer();
	rmSync(root, { recursive: true, force: true });
});

const POKE = JSON.stringify({ v: 1, sessionId: "sess-1", kind: "task-control", file: "/tmp/c.json", ts: "t1" });

describe("doorbell-server #39 Phase 2 — dispatcher", () => {
	test("registerBellListener routes by kind; disposer removes", () => {
		const got: string[] = [];
		const stop = registerBellListener(["task-control"], (b) => got.push(b.kind));
		dispatchBell({ v: 1, sessionId: "s", kind: "task-control", file: "f", ts: "t" });
		dispatchBell({ v: 1, sessionId: "s", kind: "snip-control", file: "f", ts: "t" }); // not registered
		expect(got.length).toBe(1);
		stop();
		dispatchBell({ v: 1, sessionId: "s", kind: "task-control", file: "f", ts: "t" });
		expect(got.length).toBe(1);
	});

	test("a throwing handler does not starve other handlers of the same kind", () => {
		const seen: number[] = [];
		registerBellListener(["k"], () => {
			throw new Error("boom");
		});
		registerBellListener(["k"], () => seen.push(1));
		dispatchBell({ v: 1, sessionId: "s", kind: "k", file: "", ts: "" });
		expect(seen.length).toBe(1);
	});
});

describe("doorbell-server #39 Phase 2 — session socket", () => {
	test("empty sessionId → null, no socket", () => {
		expect(startDoorbellServer("", { dir: root })).toBeNull();
	});

	test("real round-trip: poke → listener fires; socket mode 0600; stop removes", async () => {
		registerBellListener(["task-control"], (b) => bells.push(b));
		const stop = startDoorbellServer("sess-1", { dir: root });
		expect(stop).not.toBeNull();
		await new Promise((r) => setTimeout(r, 100));
		const path = join(root, "sess-1.sock");
		expect(existsSync(path)).toBe(true);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		await new Promise<void>((resolve, reject) => {
			const sock = createConnection({ path });
			sock.on("connect", () => {
				sock.write(`${POKE}\n`);
				sock.destroy();
				resolve();
			});
			sock.on("error", reject);
		});
		await new Promise((r) => setTimeout(r, 150));
		expect(bells.length).toBe(1);
		expect(bells[0].kind).toBe("task-control");
		expect(bells[0].file).toBe("/tmp/c.json");
		stop!();
		expect(existsSync(path)).toBe(false);
	});

	test("idempotent start: second start returns a stop, socket stays until stopDoorbellServer", async () => {
		const stop1 = startDoorbellServer("sess-1", { dir: root });
		const stop2 = startDoorbellServer("sess-1", { dir: root });
		expect(stop1).not.toBeNull();
		expect(stop2).not.toBeNull();
		await new Promise((r) => setTimeout(r, 100));
		expect(existsSync(join(root, "sess-1.sock"))).toBe(true);
		stop1!();
		expect(existsSync(join(root, "sess-1.sock"))).toBe(false);
		stop2!(); // no throw
	});

	test("stale socket at path is replaced (engine restart)", async () => {
		const { writeFileSync } = await import("node:fs");
		writeFileSync(join(root, "sess-1.sock"), "stale");
		const stop = startDoorbellServer("sess-1", { dir: root });
		expect(stop).not.toBeNull();
		await new Promise((r) => setTimeout(r, 100));
		stop!();
	});

	test("invalid poke lines (bad JSON / v≠1) never reach listeners", async () => {
		registerBellListener(["task-control"], (b) => bells.push(b));
		const stop = startDoorbellServer("sess-1", { dir: root });
		await new Promise((r) => setTimeout(r, 100));
		await new Promise<void>((resolve) => {
			const sock = createConnection({ path: join(root, "sess-1.sock") });
			sock.on("connect", () => {
				sock.write(`not json\n${JSON.stringify({ v: 9, sessionId: "s", kind: "task-control" })}\n`);
				sock.destroy();
				resolve();
			});
			sock.on("error", () => resolve());
		});
		await new Promise((r) => setTimeout(r, 150));
		expect(bells.length).toBe(0);
		stop!();
	});
});
