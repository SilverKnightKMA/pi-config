import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lessonsExtension from "./index.ts";

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
	} as never;
	return { pi, handlers, sent };
}

let tmp: string;
let savedFile: string | undefined;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "lessons-test-"));
	savedFile = process.env.LESSONS_FILE;
	process.env.LESSONS_FILE = join(tmp, "lessons.md");
	delete process.env.LESSONS_INJECT;
});

afterEach(() => {
	if (savedFile === undefined) delete process.env.LESSONS_FILE;
	else process.env.LESSONS_FILE = savedFile;
	rmSync(tmp, { recursive: true, force: true });
});

describe("lessons extension wire-up (session_start injection)", () => {
	test("session_start with fresh lessons → hidden context message", () => {
		const iso = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10);
		writeFileSync(
			process.env.LESSONS_FILE!,
			[
				`[${iso(40)}][failure] too old — must drop`,
				`[${iso(5)}][failure] bash silent-abort — use setsid nohup bg`,
				`[${iso(2)}][preference] component-level design before build`,
				"garbage line — dropped",
			].join("\n"),
		);
		const { pi, handlers, sent } = fakePi();
		lessonsExtension(pi);
		expect(handlers["session_start"]).toBeFunction();
		handlers["session_start"]({}, {});
		expect(sent).toHaveLength(1);
		expect(sent[0].customType).toBe("lessons-context");
		expect(sent[0].display).toBe(false);
		expect(sent[0].content).toContain("[failure] bash silent-abort");
		expect(sent[0].content).toContain("[preference] component-level design");
		expect(sent[0].content).not.toContain("too old");
		expect(sent[0].content).not.toContain("garbage");
	});

	test("newest-N cap: only the last 8 lessons inject", () => {
		const lines = Array.from({ length: 12 }, (_, i) => {
			const d = new Date(Date.now() - (12 - i) * 3_600_000).toISOString().slice(0, 10);
			return `[${d}][convention] lesson number ${i}`;
		});
		writeFileSync(process.env.LESSONS_FILE!, lines.join("\n"));
		const { pi, handlers, sent } = fakePi();
		lessonsExtension(pi);
		handlers["session_start"]({}, {});
		expect(sent).toHaveLength(1);
		expect((sent[0].content!.match(/lesson number/g) ?? []).length).toBe(8);
		expect(sent[0].content).toContain("lesson number 11");
		expect(sent[0].content).not.toContain("lesson number 3");
	});

	test("missing file → zero messages, no throw", () => {
		const { pi, handlers, sent } = fakePi();
		lessonsExtension(pi);
		expect(() => handlers["session_start"]({}, {})).not.toThrow();
		expect(sent).toHaveLength(0);
	});

	test("empty file → zero messages", () => {
		writeFileSync(process.env.LESSONS_FILE!, "");
		const { pi, handlers, sent } = fakePi();
		lessonsExtension(pi);
		handlers["session_start"]({}, {});
		expect(sent).toHaveLength(0);
	});

	test("all lessons stale → zero messages", () => {
		writeFileSync(process.env.LESSONS_FILE!, "[2026-01-01][failure] ancient history");
		const { pi, handlers, sent } = fakePi();
		lessonsExtension(pi);
		handlers["session_start"]({}, {});
		expect(sent).toHaveLength(0);
	});

	test("LESSONS_INJECT=0 → no-op even with fresh lessons", () => {
		process.env.LESSONS_INJECT = "0";
		const today = new Date().toISOString().slice(0, 10);
		writeFileSync(process.env.LESSONS_FILE!, `[${today}][failure] fresh but disabled`);
		const { pi, handlers, sent } = fakePi();
		lessonsExtension(pi);
		handlers["session_start"]({}, {});
		expect(sent).toHaveLength(0);
	});

	test("session_start AND session_compact both fire → block re-injected after compaction", () => {
		const today = new Date().toISOString().slice(0, 10);
		writeFileSync(process.env.LESSONS_FILE!, `[${today}][failure] survive compaction`);
		const { pi, handlers, sent } = fakePi();
		lessonsExtension(pi);
		expect(handlers["session_compact"]).toBeFunction();
		handlers["session_start"]({}, {});
		expect(sent).toHaveLength(1);
		handlers["session_compact"]({}, {});
		expect(sent).toHaveLength(2); // re-injected, not deduped away
		expect(sent[1].customType).toBe("lessons-context");
		expect(sent[1].content).toContain("survive compaction");
	});

	test("session_compact re-reads from disk — mid-session writes are picked up", () => {
		const today = new Date().toISOString().slice(0, 10);
		writeFileSync(process.env.LESSONS_FILE!, `[${today}][failure] first lesson`);
		const { pi, handlers, sent } = fakePi();
		lessonsExtension(pi);
		handlers["session_start"]({}, {});
		// OM consolidator appends a new lesson mid-session (single writer)
		writeFileSync(process.env.LESSONS_FILE!, `[${today}][failure] first lesson\n[${today}][correction] appended later`);
		handlers["session_compact"]({}, {});
		expect(sent).toHaveLength(2);
		expect(sent[1].content).toContain("appended later");
	});

	test("session_compact respects LESSONS_INJECT=0", () => {
		process.env.LESSONS_INJECT = "0";
		const today = new Date().toISOString().slice(0, 10);
		writeFileSync(process.env.LESSONS_FILE!, `[${today}][failure] disabled`);
		const { pi, handlers, sent } = fakePi();
		lessonsExtension(pi);
		handlers["session_compact"]({}, {});
		expect(sent).toHaveLength(0);
	});

	test("secret-bearing lesson is filtered out at parse layer", () => {
		const today = new Date().toISOString().slice(0, 10);
		writeFileSync(
			process.env.LESSONS_FILE!,
			`[${today}][failure] token sk-ant-AAAAAAAAAAAAAAAAAAAA here\n[${today}][failure] safe lesson`,
		);
		const { pi, handlers, sent } = fakePi();
		lessonsExtension(pi);
		handlers["session_start"]({}, {});
		expect(sent).toHaveLength(1);
		expect(sent[0].content).toContain("safe lesson");
		expect(sent[0].content).not.toContain("sk-ant-");
	});
});
