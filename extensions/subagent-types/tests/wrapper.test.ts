/**
 * Blocking wrapper primitives (spawn_paseo_subagent, 2026-09-05).
 * takeMessagesFrom must be surgical: only THIS child's messages leave the
 * queue — everything else is pushed back so the normal turn-end drain still
 * delivers it. isAutoReport classifies the settle backstop ping so the
 * wrapper can fall back to the curated activity digest.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drainQueue, isAutoReport, pushToQueue, takeMessagesFrom, type ChannelMessage } from "../paseo-channel.ts";

let base: string;

function msg(from: string, text: string, id = "m"): ChannelMessage {
	return { id, from, fromRole: "scout", text, ts: "2026-09-05T07:00:00Z", kind: "message" };
}

afterEach(() => {
	if (base) rmSync(base, { recursive: true, force: true });
});

describe("takeMessagesFrom — surgical drain", () => {
	test("takes only the target child's messages, keeps the rest", () => {
		base = mkdtempSync(join(tmpdir(), "wrap-"));
		mkdirSync(join(base, "subagent-channel"), { recursive: true });
		pushToQueue("parent", msg("childA", "report A", "a1"), base);
		pushToQueue("parent", msg("childB", "report B", "b1"), base);
		pushToQueue("parent", msg("childA", "more A", "a2"), base);

		const mine = takeMessagesFrom("childA", "parent", base);
		expect(mine.map((m) => m.id)).toEqual(["a1", "a2"]);

		// childB's message must still be in the queue for the turn-end drain.
		const rest = drainQueue("parent", base);
		expect(rest.map((m) => m.id)).toEqual(["b1"]);
	});

	test("empty/missing queue → [] without touching anything", () => {
		base = mkdtempSync(join(tmpdir(), "wrap-"));
		mkdirSync(join(base, "subagent-channel"), { recursive: true });
		expect(takeMessagesFrom("childA", "parent", base)).toEqual([]);
		expect(existsSync(join(base, "subagent-channel", "parent.jsonl"))).toBe(false);
	});

	test("messages pushed between drain and re-push survive", () => {
		// Simulates the race the doc comment promises: a sibling child appends
		// while takeMessagesFrom holds the drained batch. pushToQueue appends to
		// the fresh file, so the new message is never lost.
		base = mkdtempSync(join(tmpdir(), "wrap-"));
		mkdirSync(join(base, "subagent-channel"), { recursive: true });
		pushToQueue("parent", msg("childA", "A", "a1"), base);
		// Manually emulate the interleaving: drain everything, then a new push
		// lands, then the "rest" re-push happens inside takeMessagesFrom.
		const taken = drainQueue("parent", base);
		pushToQueue("parent", msg("childB", "late B", "b-late"), base);
		for (const m of taken.filter((x) => x.from !== "childA")) pushToQueue("parent", m, base);
		const final = drainQueue("parent", base);
		expect(final.map((m) => m.id).sort()).toEqual(["b-late"]);
	});
});

describe("isAutoReport", () => {
	test("[auto-report] prefix → true (settle backstop ping)", () => {
		expect(isAutoReport(msg("c", "[auto-report] Subagent scout finished"))).toBe(true);
		expect(isAutoReport(msg("c", "  [auto-report] indented"))).toBe(true);
	});
	test("real payloads → false", () => {
		expect(isAutoReport(msg("c", "Found the bug in foo.ts:42"))).toBe(false);
		expect(isAutoReport(msg("c", "auto-report without brackets"))).toBe(false);
	});
});

describe("allowlistFor — wrapper travels with spawn_subagent", () => {
	test("worker (has spawn_subagent) also gets spawn_paseo_subagent", async () => {
		const { allowlistFor, loadRoles } = await import("../index.ts");
		const roles = loadRoles ? loadRoles() : new Map();
		const allowed = allowlistFor("worker", roles as Map<never, never>);
		expect(allowed.includes("spawn_subagent")).toBe(true);
		expect(allowed.includes("spawn_paseo_subagent")).toBe(true);
	});
	test("roles without spawn permission never gain either spawn tool", async () => {
		const { allowlistFor } = await import("../index.ts");
		const allowed = allowlistFor("scout", new Map());
		expect(allowed.includes("spawn_paseo_subagent")).toBe(false);
		expect(allowed.includes("spawn_subagent")).toBe(false);
	});
});
