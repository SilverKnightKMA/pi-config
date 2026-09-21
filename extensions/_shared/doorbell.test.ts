import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:net";
import { bridgesDir, DOORBELL_VERSION, pokeBridges } from "./doorbell.ts";

let root: string;
let servers: Server[];

function listen(name: string): Promise<{ server: Server; path: string; lines: string[] }> {
	return new Promise((resolve, reject) => {
		const path = join(root, `${name}.sock`);
		const lines: string[] = [];
		const server = createServer((conn) => {
			let buf = "";
			conn.on("data", (d) => {
				buf += d.toString("utf8");
			});
			conn.on("close", () => {
				for (const l of buf.split("\n")) if (l.trim()) lines.push(l);
			});
		});
		server.listen(path, () => resolve({ server, path, lines }));
		server.on("error", reject);
		servers.push(server);
	});
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "doorbell-"));
	servers = [];
});

afterEach(async () => {
	for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
	rmSync(root, { recursive: true, force: true });
});

describe("doorbell #39 Phase 1 — engine poke", () => {
	test("missing bridges dir = silent no-op (standalone-clean)", async () => {
		await pokeBridges("om-status", "/tmp/x.json", "sess-1", { dir: join(root, "nope") });
		// reaching here without throwing is the contract
		expect(true).toBe(true);
	});

	test("one socket receives exactly one JSON line with the v1 payload", async () => {
		const a = await listen("plugin-a");
		await pokeBridges("om-status", "/tmp/om-status.json", "sess-1", { dir: root });
		await new Promise((r) => setTimeout(r, 150));
		expect(a.lines.length).toBe(1);
		const payload = JSON.parse(a.lines[0]);
		expect(payload.v).toBe(DOORBELL_VERSION);
		expect(payload.sessionId).toBe("sess-1");
		expect(payload.kind).toBe("om-status");
		expect(payload.file).toBe("/tmp/om-status.json");
		expect(typeof payload.ts).toBe("string");
	});

	test("two sockets: both poked (fan-out), non-.sock files ignored", async () => {
		const a = await listen("plugin-a");
		const b = await listen("plugin-b");
		writeFileSync(join(root, "not-a-socket.txt"), "x");
		await pokeBridges("facts-status", "/tmp/f.json", "sess-2", { dir: root });
		await new Promise((r) => setTimeout(r, 150));
		expect(a.lines.length).toBe(1);
		expect(b.lines.length).toBe(1);
	});

	test("dead socket entry (plain file with .sock name) is skipped silently", async () => {
		writeFileSync(join(root, "dead.sock"), "not a socket");
		const a = await listen("plugin-a");
		await pokeBridges("om-status", "/tmp/x.json", "sess-3", { dir: root });
		await new Promise((r) => setTimeout(r, 150));
		expect(a.lines.length).toBe(1); // live one still poked, dead one skipped
	});

	test("bridgesDir resolves under HOME override (test isolation)", () => {
		expect(bridgesDir({ HOME: "/tmp/fake-home" })).toBe(
			join("/tmp/fake-home", ".paseo", "plugin-data", "bridges"),
		);
	});
});
