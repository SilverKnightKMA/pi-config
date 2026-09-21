// #39 step 2: wiring integration — writeTaskStatus must fire the engine->plugin bell
// #39 step 2 wiring integration — a REAL writeTaskStatus fires the bell
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";

test("writeTaskStatus pokes a bridge socket under HOME (wiring fires)", async () => {
	const home = mkdtempSync(join(tmpdir(), "wire-"));
	const bridges = join(home, ".paseo", "plugin-data", "bridges");
	mkdirSync(bridges, { recursive: true });
	const sockPath = join(bridges, "panel.sock");
	const lines: string[] = [];
	const server = createServer((conn) => {
		let buf = "";
		conn.on("data", (d) => (buf += d.toString()));
		conn.on("close", () => { for (const l of buf.split("\n")) if (l.trim()) lines.push(l); });
	});
	await new Promise<void>((r) => server.listen(sockPath, r));
	const prevHome = process.env.HOME;
	process.env.HOME = home; // pokeBridges resolves bridgesDir from HOME at call time
	try {
		const { writeTaskStatus } = await import("./status-file.ts");
		await writeTaskStatus(join(home, "ts.json"), {
			schema: 1, sessionId: "sess-wire", generatedAt: new Date().toISOString(),
			tasks: [], summary: { total: 0, done: 0, inProgress: 0, pending: 0 } as never,
		} as never);
		await new Promise((r) => setTimeout(r, 200));
		expect(lines.length).toBe(1);
		const p = JSON.parse(lines[0]);
		expect(p.kind).toBe("task-status");
		expect(p.sessionId).toBe("sess-wire");
		expect(p.file).toContain("ts.json");
	} finally {
		process.env.HOME = prevHome;
		await new Promise<void>((r) => server.close(() => r()));
		rmSync(home, { recursive: true, force: true });
	}
});
