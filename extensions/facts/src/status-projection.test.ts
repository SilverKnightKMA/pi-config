/** facts-status projection + un-tombstone control tests — P4 engine side (#181). */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyUntombstone,
	buildFactsStatus,
	factsControlDir,
	factsStatusPath,
	watchFactsControl,
} from "./status-projection.ts";

let tmp: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "facts-p4-"));
	env = { HOME: tmp, FACTS_FILE: join(tmp, "facts.md"), FACTS_RUNS_DIR: join(tmp, "runs"), FACTS_STATUS_FILE: join(tmp, "facts-status.json") };
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

const STORE = [
	"[convention][2026-09-01][P1] test runner: bun (#aaa001)",
	"[convention][2026-09-05][P2] plain language first (#aaa002) tombstoned=2026-09-20 reason=curator:superseded",
	"[ops][2026-09-03][P3] port 34091 (#aaa003)",
].join("\n");

describe("buildFactsStatus", () => {
	test("counts live/tombstoned per category + thresholds echo", () => {
		writeFileSync(env.FACTS_FILE as string, STORE);
		const p = buildFactsStatus(env, tmp, { minLines: 10, minTokens: 2_000_000, minSessions: 15, floorDays: 30 });
		expect(p!.live).toBe(2);
		expect(p!.tombstoned).toBe(1);
		expect(p!.byCategory.find((c) => c.category === "convention")).toEqual({ category: "convention", live: 1, tombstoned: 1 });
		expect(p!.lastCuration).toBeNull(); // no receipts yet
		expect(p!.curatorFailing).toBe(false);
	});

	test("missing store → live 0, file path still reported", () => {
		const p = buildFactsStatus(env, tmp, { minLines: 1, minTokens: 1, minSessions: 1, floorDays: 1 });
		expect(p!.live).toBe(0);
		expect(p!.file).toBe(env.FACTS_FILE as string);
	});
});

describe("applyUntombstone (user-only door)", () => {
	test("strip tombstone keeps the line live with same id + ack applied", () => {
		writeFileSync(env.FACTS_FILE as string, STORE);
		const ctl = join(factsControlDir(env, tmp), "req-1.json");
		mkdirSync(factsControlDir(env, tmp), { recursive: true });
		writeFileSync(ctl, JSON.stringify({ action: "untombstone", id: "aaa002", ts: new Date().toISOString() }));
		const ack = applyUntombstone(ctl, env, tmp);
		expect(ack.status).toBe("applied");
		const after = readFileSync(env.FACTS_FILE!, "utf8");
		expect(after).toContain("plain language first (#aaa002)");
		expect(after).not.toContain("tombstoned=");
		// projection refreshed by the apply
		const proj = JSON.parse(readFileSync(env.FACTS_STATUS_FILE!, "utf8"));
		expect(proj.tombstoned).toBe(0);
	});

	test("unknown id → not-found ack; already live → noop; bad json → bad-request", () => {
		writeFileSync(env.FACTS_FILE as string, STORE);
		const dir = factsControlDir(env, tmp);
		mkdirSync(dir, { recursive: true });
		const a = join(dir, "a.json");
		writeFileSync(a, JSON.stringify({ action: "untombstone", id: "zzzzzz" }));
		expect(applyUntombstone(a, env, tmp).status).toBe("not-found");
		const b = join(dir, "b.json");
		writeFileSync(b, JSON.stringify({ action: "untombstone", id: "aaa001" }));
		expect(applyUntombstone(b, env, tmp).status).toBe("noop");
		const c = join(dir, "c.json");
		writeFileSync(c, "not json");
		expect(applyUntombstone(c, env, tmp).status).toBe("bad-request");
	});
});

describe("watchFactsControl", () => {
	test("watcher picks up a pending control file and applies it", async () => {
		writeFileSync(env.FACTS_FILE as string, STORE);
		const stop = watchFactsControl(env, tmp);
		try {
			const dir = factsControlDir(env, tmp);
			const ctl = join(dir, "req-watch.json");
			writeFileSync(ctl, JSON.stringify({ action: "untombstone", id: "aaa002" }));
			await new Promise((r) => setTimeout(r, 600));
			const acked = JSON.parse(readFileSync(ctl, "utf8"));
			expect(acked.status).toBe("applied");
			expect(readFileSync(env.FACTS_FILE!, "utf8")).not.toContain("tombstoned=");
			// already-acked files are not re-applied (no churn on next sweep)
			expect(readdirSync(dir)).toHaveLength(1);
		} finally {
			stop();
		}
	});
});
