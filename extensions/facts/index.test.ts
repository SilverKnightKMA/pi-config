/** facts extension wire-up tests — P1b (#175): PUSH injection at session_start
 *  + session_compact, hidden context message, budgets, escape hatches. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import factsExtension, { buildFactsInjectionBlock } from "./index.ts";

interface SentMessage {
	customType?: string;
	content?: string;
	display?: boolean;
}

function fakePi() {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	const sent: SentMessage[] = [];
	const pi = {
		on(name: string, fn: (...args: unknown[]) => unknown) {
			handlers[name] = fn;
		},
		sendMessage(msg: SentMessage) {
			sent.push(msg);
		},
		registerTool(_t: unknown) {
			/* tool wiring covered by the P1c describe block */
		},
	} as never;
	return { pi, handlers, sent };
}

let tmp: string;
let savedFile: string | undefined;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "facts-test-"));
	savedFile = process.env.FACTS_FILE;
	process.env.FACTS_FILE = join(tmp, "facts.md");
	delete process.env.FACTS_INJECT;
	delete process.env.FACTS_MAX_LINES;
	delete process.env.FACTS_MAX_CHARS;
});

afterEach(() => {
	if (savedFile === undefined) delete process.env.FACTS_FILE;
	else process.env.FACTS_FILE = savedFile;
	rmSync(tmp, { recursive: true, force: true });
});

describe("facts extension wire-up (PUSH injection)", () => {
	test("session_start with live facts → one hidden facts-context message", () => {
		writeFileSync(
			process.env.FACTS_FILE!,
			[
				"[preference][2026-09-20][P1] prefers bun over node for test runs (#f0e1d2)",
				"[convention][2026-09-21][P1] test runner is bun (#a1b2c3)",
				"garbage line — dropped",
			].join("\n"),
		);
		const { pi, handlers, sent } = fakePi();
		factsExtension(pi);
		expect(handlers["session_start"]).toBeFunction();
		expect(handlers["session_compact"]).toBeFunction();
		handlers["session_start"]({}, {});
		expect(sent).toHaveLength(1);
		expect(sent[0].customType).toBe("facts-context");
		expect(sent[0].display).toBe(false);
		expect(sent[0].content).toContain("prefers bun over node");
		expect(sent[0].content).toContain("test runner is bun");
		expect(sent[0].content).not.toContain("garbage");
	});

	test("priority order: P1 lines inject ahead of P3 even when newer", () => {
		writeFileSync(
			process.env.FACTS_FILE!,
			[
				"[ops][2026-09-21][P3] p3 newest (#cccccc)",
				"[project][2026-09-01][P1] p1 oldest (#aaaaaa)",
			].join("\n"),
		);
		const block = buildFactsInjectionBlock(process.env, () => new Date("2026-09-22T00:00:00Z"))!;
		const i1 = block.indexOf("p1 oldest");
		const i3 = block.indexOf("p3 newest");
		expect(i1).toBeGreaterThan(0);
		expect(i3).toBeGreaterThan(i1);
	});

	test("tombstoned + ttl-expired facts never inject", () => {
		writeFileSync(
			process.env.FACTS_FILE!,
			[
				"[decision][2026-09-01][P1] gone (#dead01) tombstoned=2026-09-10 reason=superseded",
				"[ops][2026-09-01][P1] expired (#dead02) ttl=2026-09-01",
				"[ops][2026-09-01][P1] alive (#a1b2c4)",
			].join("\n"),
		);
		const block = buildFactsInjectionBlock(process.env, () => new Date("2026-09-21T00:00:00Z"))!;
		expect(block).toContain("alive (#a1b2c4)");
		expect(block).not.toContain("gone (#dead01)");
		expect(block).not.toContain("expired (#dead02)");
	});

	test("line budget: FACTS_MAX_LINES=2 caps the block", () => {
		process.env.FACTS_MAX_LINES = "2";
		writeFileSync(
			process.env.FACTS_FILE!,
			[1, 2, 3, 4].map((i) => `[ops][2026-09-0${i}][P1] fact number ${i} (#aaaa0${i})`).join("\n"),
		);
		const block = buildFactsInjectionBlock(process.env)!;
		expect((block.match(/fact number/g) ?? []).length).toBe(2);
		expect(block).toContain("fact number 4"); // newest first within P1
		expect(block).not.toContain("fact number 1");
	});

	test("missing file → zero messages, no throw", () => {
		const { pi, handlers, sent } = fakePi();
		factsExtension(pi);
		expect(() => handlers["session_start"]({}, {})).not.toThrow();
		expect(sent).toHaveLength(0);
	});

	test("FACTS_INJECT=0 → no-op", () => {
		process.env.FACTS_INJECT = "0";
		writeFileSync(process.env.FACTS_FILE!, "[ops][2026-09-01][P1] hidden by hatch (#aaaa01)");
		const { pi, handlers, sent } = fakePi();
		factsExtension(pi);
		handlers["session_start"]({}, {});
		expect(sent).toHaveLength(0);
	});

	test("session_compact re-reads from disk (fresh values survive compaction)", () => {
		writeFileSync(process.env.FACTS_FILE!, "[ops][2026-09-01][P1] before (#aaaa01)");
		const { pi, handlers, sent } = fakePi();
		factsExtension(pi);
		handlers["session_start"]({}, {});
		expect(sent).toHaveLength(1);
		expect(sent[0].content).toContain("before (#aaaa01)");
		// A new fact appears on disk AFTER session_start — compact must pick it up.
		writeFileSync(
			process.env.FACTS_FILE!,
			["[ops][2026-09-01][P1] before (#aaaa01)", "[ops][2026-09-22][P1] after compaction (#bbbb02)"].join("\n"),
		);
		handlers["session_compact"]({}, {});
		expect(sent).toHaveLength(2);
		expect(sent[1].customType).toBe("facts-context");
		expect(sent[1].display).toBe(false);
		expect(sent[1].content).toContain("after compaction (#bbbb02)");
	});

	test("all facts tombstoned → no message at all", () => {
		writeFileSync(
			process.env.FACTS_FILE!,
			"[decision][2026-09-01][P1] gone (#dead01) tombstoned=2026-09-10 reason=contradicted",
		);
		const { pi, handlers, sent } = fakePi();
		factsExtension(pi);
		handlers["session_start"]({}, {});
		expect(sent).toHaveLength(0);
	});
});

describe("facts_recall tool wiring (P1c)", () => {
	function fakePiWithTools() {
		const handlers: Record<string, (...args: unknown[]) => unknown> = {};
		const tools: Array<{ name: string; execute: (id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }> }> = [];
		const sent: SentMessage[] = [];
		const pi = {
			on(name: string, fn: (...args: unknown[]) => unknown) {
				handlers[name] = fn;
			},
			sendMessage(msg: SentMessage) {
				sent.push(msg);
			},
			registerTool(t: { name: string; execute: (id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }> }) {
				tools.push(t);
			},
		} as never;
		return { pi, handlers, sent, tools };
	}

	test("tool registered, executes recall over FACTS_FILE", async () => {
		writeFileSync(
			process.env.FACTS_FILE!,
			[
				"[preference][2026-09-02][P1] user prefers bun over node for test runs (#aaa001)",
				"[ops][2026-09-01][P3] unrelated door port (#aaa003)",
			].join("\n"),
		);
		const { pi, tools } = fakePiWithTools();
		factsExtension(pi);
		expect(tools.map((t) => t.name)).toEqual(["facts_recall"]);
		const res = await tools[0].execute("t1", { query: "bun node" });
		const out = res.content[0].text;
		expect(out).toContain("mode=all-keywords");
		expect(out).toContain("[live] [preference][2026-09-02][P1] user prefers bun over node for test runs (#aaa001)");
	});

	test("missing facts file → informative result, no throw", async () => {
		rmSync(process.env.FACTS_FILE!, { force: true });
		const { pi, tools } = fakePiWithTools();
		factsExtension(pi);
		const out = (await tools[0].execute("t1", { query: "x" })).content[0].text;
		expect(out).toContain("no facts file yet");
	});
});
